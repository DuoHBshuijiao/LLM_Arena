import pLimit from "p-limit";
import { userFacingEvaluationError } from "./errorUtils";
import { stripCompleteRedactedThinking } from "./inlineThinking";
import { streamChat } from "./openaiStream";
import { getPreset } from "./settingsHelpers";
import type {
  FailedPipelineStep,
  GenerationResult,
  GlobalSettings,
  JudgeRunResult,
  JudgeStreamingSlot,
  RunSession,
} from "./types";

/** 整轮评测 flush 前：把 store 里已完成线程列写回共享 gens，避免并行 resume 被主线程过时快照覆盖 */
function syncCompletedGensFromStore(
  gens: GenerationResult[],
  completed: ReadonlySet<number>,
  getLastRun: () => RunSession | null,
): void {
  const lr = getLastRun();
  if (!lr || lr.generations.length !== gens.length) return;
  for (const j of completed) {
    const gStore = lr.generations[j];
    const gLocal = gens[j];
    if (gStore && gLocal && gStore.id === gLocal.id) {
      gens[j] = { ...gStore };
    }
  }
}

/** 将同一帧内多次流式 onUpdate 合并为一次，减轻多线程卡片时的 React 重绘压力 */
function createSessionUpdateBatcher(onUpdate: (s: RunSession) => void) {
  let pending: RunSession | null = null;
  let raf = 0;
  return {
    schedule(s: RunSession) {
      pending = s;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          const p = pending;
          pending = null;
          if (p) onUpdate(p);
        });
      }
    },
    flush(s: RunSession) {
      pending = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      onUpdate(s);
    },
  };
}

function presetOrThrow(settings: GlobalSettings, presetId: string) {
  const p = getPreset(settings, presetId);
  if (!p) throw new Error(`未找到 API 预设：${presetId}`);
  return p;
}

/** 每个 API 预设一条并发槽（本次评测内共享） */
function buildPresetLimiters(
  settings: GlobalSettings,
): Map<string, ReturnType<typeof pLimit>> {
  const m = new Map<string, ReturnType<typeof pLimit>>();
  for (const p of settings.apiPresets) {
    m.set(p.id, pLimit(Math.max(1, p.concurrency)));
  }
  return m;
}

function runLimited<T>(
  limiters: Map<string, ReturnType<typeof pLimit>>,
  presetId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lim = limiters.get(presetId);
  if (!lim) throw new Error(`未找到预设 limiter：${presetId}`);
  return lim(fn);
}

/** 仅包含已填写的采样参数，空则省略键 */
function samplingParams(settings: GlobalSettings): {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
} {
  const o: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
  } = {};
  const { temperature, maxTokens, topP } = settings;
  if (temperature !== undefined && !Number.isNaN(temperature)) {
    o.temperature = temperature;
  }
  if (maxTokens !== undefined && !Number.isNaN(maxTokens)) {
    o.max_tokens = maxTokens;
  }
  if (topP !== undefined && !Number.isNaN(topP)) {
    o.top_p = topP;
  }
  return o;
}

function judgeScratchKey(
  gi: number,
  judgeId: string,
  reviewIndex: number,
): string {
  return `${gi}|${judgeId}|${reviewIndex}`;
}

/** 槽位键（不含线程索引），用于并行 judge 的 Set / AbortController Map */
function encodeJudgeSlotKey(judgeId: string, reviewIndex: number): string {
  return `${judgeId}\u001f${reviewIndex}`;
}

function decodeJudgeSlotKey(k: string): JudgeStreamingSlot {
  const i = k.indexOf("\u001f");
  return {
    judgeId: k.slice(0, i),
    reviewIndex: Number(k.slice(i + 1)),
  };
}

function judgeSlotsFromKeySet(keys: ReadonlySet<string>): JudgeStreamingSlot[] {
  return [...keys].map(decodeJudgeSlotKey);
}

function hasJudgeRunForSlot(
  g: GenerationResult,
  judgeId: string,
  reviewIndex: number,
): boolean {
  return g.judgeRuns.some(
    (jr) => jr.judgeId === judgeId && jr.reviewIndex === reviewIndex,
  );
}

function clearJudgeScratchForThread(
  gi: number,
  scratch: Map<string, { raw: string; reasoning: string }>,
  settings: GlobalSettings,
) {
  for (const judge of settings.judges) {
    for (let r = 0; r < Math.max(1, judge.reviewCount); r++) {
      scratch.delete(judgeScratchKey(gi, judge.id, r));
    }
  }
}

function rebuildJudgeRunsFromScratch(
  gi: number,
  scratch: Map<string, { raw: string; reasoning: string }>,
  settings: GlobalSettings,
): JudgeRunResult[] {
  const out: JudgeRunResult[] = [];
  for (const judge of settings.judges) {
    for (let r = 0; r < Math.max(1, judge.reviewCount); r++) {
      const key = judgeScratchKey(gi, judge.id, r);
      const s = scratch.get(key);
      if (s && (s.raw.length > 0 || s.reasoning.length > 0)) {
        out.push({
          judgeId: judge.id,
          judgeName: judge.name,
          reviewIndex: r,
          rawText: s.raw,
          reasoningText: s.reasoning ? s.reasoning : undefined,
        });
      }
    }
  }
  out.sort((a, b) => {
    const c = a.judgeId.localeCompare(b.judgeId);
    if (c !== 0) return c;
    return a.reviewIndex - b.reviewIndex;
  });
  return out;
}

function appendStrippedReasoning(
  existing: string,
  strippedReasoning: string,
): string {
  if (!strippedReasoning) return existing;
  return existing ? `${existing}\n${strippedReasoning}` : strippedReasoning;
}

/** 合并多个 AbortSignal（兼容无 AbortSignal.any 的环境） */
export function anyAbortSignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === "function") {
    return anyFn(signals);
  }
  const c = new AbortController();
  const onAbort = () => {
    c.abort();
  };
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      return c.signal;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return c.signal;
}

function isGlobalAbort(e: unknown, globalSignal: AbortSignal): boolean {
  return (
    e instanceof DOMException &&
    e.name === "AbortError" &&
    globalSignal.aborted
  );
}

/** 用户点击「暂停 / 取消本线程」时由 UI 触发，与流水线内 threadAc 分离 */
type ThreadInteractive = {
  pause: AbortController;
  cancel: AbortController;
  judgeSlots: Map<string, AbortController>;
  /** requestAbortJudgeSlot 触发，用于与线程级 pause 区分 */
  userSlotAbortKeys: Set<string>;
};
const threadInteractiveControllers = new Map<string, ThreadInteractive>();

export function requestPauseThread(genId: string): void {
  threadInteractiveControllers.get(genId)?.pause.abort();
}

/** 终止本线程剩余流程并标记为弃用（0 分） */
export function requestCancelThread(genId: string): void {
  threadInteractiveControllers.get(genId)?.cancel.abort();
}

/** 仅中止某一 judge 槽位的流式请求（不暂停整条线程上其它并行 judge） */
export function requestAbortJudgeSlot(
  genId: string,
  judgeId: string,
  reviewIndex: number,
): void {
  const key = encodeJudgeSlotKey(judgeId, reviewIndex);
  const t = threadInteractiveControllers.get(genId);
  if (!t) return;
  t.userSlotAbortKeys.add(key);
  t.judgeSlots.get(key)?.abort();
}

export async function executeEvaluation(
  settings: GlobalSettings,
  prompt: string,
  onUpdate: (s: RunSession) => void,
  signal: AbortSignal,
  /** 与 Zustand 同步：在 flush 前从 store 回填已完成线程列（与单线程 resume 并行时必需） */
  getLastRunSync?: () => RunSession | null,
): Promise<void> {
  const base: RunSession = {
    id: crypto.randomUUID(),
    prompt,
    startedAt: Date.now(),
    phase: "running",
    generations: [],
  };

  const tasks: { modelId: string; sampleIndex: number; presetId: string }[] =
    [];
  for (const m of settings.models) {
    for (let i = 0; i < Math.max(1, m.sampleCount); i++) {
      tasks.push({
        modelId: m.modelId,
        sampleIndex: i,
        presetId: m.presetId,
      });
    }
  }

  const gens: GenerationResult[] = tasks.map((t) => ({
    id: crypto.randomUUID(),
    modelId: t.modelId,
    sampleIndex: t.sampleIndex,
    text: "",
    judgeRuns: [],
    aggregateText: "",
    threadPhase: "generating",
  }));

  const limiters = buildPresetLimiters(settings);
  const judgeScratch = new Map<string, { raw: string; reasoning: string }>();

  const completedThreadIndices = new Set<number>();
  const wrappedOnUpdate =
    getLastRunSync != null
      ? (s: RunSession) => {
          syncCompletedGensFromStore(
            gens,
            completedThreadIndices,
            getLastRunSync,
          );
          onUpdate({ ...s, generations: [...gens] });
        }
      : onUpdate;

  const batch = createSessionUpdateBatcher(wrappedOnUpdate);
  batch.flush({ ...base, generations: [...gens] });

  const runThread = async (i: number) => {
    try {
      await runOneThreadPipeline({
        mode: { mode: "full" },
        i,
        tasks,
        gens,
        settings,
        prompt,
        signal,
        limiters,
        judgeScratch,
        base,
        batch,
      });
    } finally {
      completedThreadIndices.add(i);
    }
  };

  await Promise.allSettled(tasks.map((_, i) => runThread(i)));

  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  if (getLastRunSync) {
    syncCompletedGensFromStore(
      gens,
      completedThreadIndices,
      getLastRunSync,
    );
  }

  batch.flush({
    ...base,
    phase: "done",
    generations: [...gens],
  });
}

type ThreadPipelineMode =
  | { mode: "full" }
  | { mode: "resume"; failedStep: FailedPipelineStep };

type ThreadPipelineCtx = {
  mode: ThreadPipelineMode;
  i: number;
  tasks: { modelId: string; sampleIndex: number; presetId: string }[];
  gens: GenerationResult[];
  settings: GlobalSettings;
  prompt: string;
  signal: AbortSignal;
  limiters: Map<string, ReturnType<typeof pLimit>>;
  judgeScratch: Map<string, { raw: string; reasoning: string }>;
  base: RunSession;
  batch: ReturnType<typeof createSessionUpdateBatcher>;
};

async function runOneThreadPipeline(ctx: ThreadPipelineCtx): Promise<void> {
  const {
    mode,
    i,
    tasks,
    gens,
    settings,
    prompt,
    signal,
    limiters,
    judgeScratch,
    base,
    batch,
  } = ctx;

  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const threadAc = new AbortController();
  const userPauseAc = new AbortController();
  const userCancelAc = new AbortController();
  const threadInteractive: ThreadInteractive = {
    pause: userPauseAc,
    cancel: userCancelAc,
    judgeSlots: new Map(),
    userSlotAbortKeys: new Set(),
  };
  threadInteractiveControllers.set(gens[i].id, threadInteractive);

  let pauseRequested = false;
  let cancelRequested = false;
  userPauseAc.signal.addEventListener(
    "abort",
    () => {
      pauseRequested = true;
    },
    { once: true },
  );
  userCancelAc.signal.addEventListener(
    "abort",
    () => {
      cancelRequested = true;
    },
    { once: true },
  );

  const threadSignal = anyAbortSignal([
    signal,
    threadAc.signal,
    userPauseAc.signal,
    userCancelAc.signal,
  ]);

  const pauseStepRef = { current: { step: "gen" } as FailedPipelineStep };
  let interactiveHandled = false;

  const markError = (e: unknown, step: FailedPipelineStep) => {
    if (isGlobalAbort(e, signal)) {
      threadAc.abort();
      throw e;
    }
    const msg = userFacingEvaluationError(e);
    gens[i] = {
      ...gens[i],
      pipelineError: msg,
      failedPipelineStep: step,
      threadOutcome: "error",
      threadPhase: "error",
      streamingCard: undefined,
      judgeStreamingSlots: undefined,
      pausedPipelineStep: undefined,
    };
    batch.flush({ ...base, phase: "running", generations: [...gens] });
    threadAc.abort();
  };

  const markPaused = (step: FailedPipelineStep) => {
    if (interactiveHandled) return;
    interactiveHandled = true;
    gens[i] = {
      ...gens[i],
      threadPhase: "paused",
      pausedPipelineStep: step,
      streamingCard: undefined,
      judgeStreamingSlots: undefined,
      pipelineError: undefined,
      failedPipelineStep: undefined,
      threadOutcome: undefined,
    };
    batch.flush({ ...base, phase: "running", generations: [...gens] });
    threadAc.abort();
  };

  const markAbandoned = () => {
    if (interactiveHandled) return;
    interactiveHandled = true;
    gens[i] = {
      ...gens[i],
      threadPhase: "done",
      threadOutcome: "abandoned",
      streamingCard: undefined,
      judgeStreamingSlots: undefined,
      pipelineError: undefined,
      failedPipelineStep: undefined,
      pausedPipelineStep: undefined,
    };
    batch.flush({ ...base, phase: "running", generations: [...gens] });
    threadAc.abort();
  };

  const t = tasks[i];
  const preset = presetOrThrow(settings, t.presetId);

  if (mode.mode === "resume") {
    const fs = mode.failedStep;
    if (fs.step === "gen") {
      gens[i] = {
        ...gens[i],
        text: "",
        reasoningText: undefined,
        judgeRuns: [],
        aggregateText: "",
        aggregateReasoningText: undefined,
        pipelineError: undefined,
        failedPipelineStep: undefined,
        pausedPipelineStep: undefined,
        threadOutcome: undefined,
        threadPhase: "generating",
        streamingCard: undefined,
      };
      clearJudgeScratchForThread(i, judgeScratch, settings);
      batch.flush({ ...base, phase: "running", generations: [...gens] });
    } else if (fs.step === "judge") {
      const { judgeId, reviewIndex } = fs;
      const skResume = judgeScratchKey(i, judgeId, reviewIndex);
      judgeScratch.delete(skResume);
      gens[i] = {
        ...gens[i],
        judgeRuns: gens[i].judgeRuns.filter(
          (jr) => !(jr.judgeId === judgeId && jr.reviewIndex === reviewIndex),
        ),
        aggregateText: "",
        aggregateReasoningText: undefined,
        pipelineError: undefined,
        failedPipelineStep: undefined,
        pausedPipelineStep: undefined,
        threadOutcome: undefined,
        threadPhase: "judging",
        streamingCard: undefined,
        judgeStreamingSlots: undefined,
      };
      batch.flush({ ...base, phase: "running", generations: [...gens] });
    } else if (fs.step === "aggregate") {
      gens[i] = {
        ...gens[i],
        aggregateText: "",
        aggregateReasoningText: undefined,
        pipelineError: undefined,
        failedPipelineStep: undefined,
        pausedPipelineStep: undefined,
        threadOutcome: undefined,
        threadPhase: "aggregating",
        streamingCard: undefined,
      };
      batch.flush({ ...base, phase: "running", generations: [...gens] });
    }
  }

  const resumeStep =
    mode.mode === "resume" ? mode.failedStep : undefined;

  const startFromGen = mode.mode === "full" || resumeStep?.step === "gen";
  const startFromJudge =
    mode.mode === "full" ||
    resumeStep?.step === "gen" ||
    resumeStep?.step === "judge";
  const startFromAggregate =
    mode.mode === "full" ||
    resumeStep?.step === "gen" ||
    resumeStep?.step === "judge" ||
    resumeStep?.step === "aggregate";

  try {
    if (startFromGen) {
      let text = gens[i].text;
      let reasoningText = gens[i].reasoningText ?? "";

      gens[i] = {
        ...gens[i],
        streamingCard: { kind: "gen" },
        threadPhase: "generating",
      };
      batch.schedule({ ...base, phase: "running", generations: [...gens] });

      pauseStepRef.current = { step: "gen" };
      try {
        await runLimited(limiters, t.presetId, async () => {
          await streamChat(
            preset.baseUrl,
            preset.apiKey,
            {
              model: t.modelId,
              messages: [{ role: "user", content: prompt }],
              ...samplingParams(settings),
            },
            (d) => {
              text += d.content;
              reasoningText += d.reasoning;
              gens[i] = {
                ...gens[i],
                text,
                reasoningText: reasoningText || undefined,
                threadPhase: "generating",
                streamingCard: { kind: "gen" },
              };
              batch.schedule({
                ...base,
                phase: "running",
                generations: [...gens],
              });
            },
            threadSignal,
          );
        });
      } catch (e) {
        if (isGlobalAbort(e, signal)) {
          threadAc.abort();
          throw e;
        }
        if (cancelRequested) {
          markAbandoned();
          return;
        }
        if (pauseRequested) {
          markPaused(pauseStepRef.current);
          return;
        }
        markError(e, { step: "gen" });
        return;
      }

      {
        const s = stripCompleteRedactedThinking(text);
        text = s.content;
        reasoningText = appendStrippedReasoning(reasoningText, s.reasoning);
      }

      gens[i] = {
        ...gens[i],
        text,
        reasoningText: reasoningText || undefined,
        threadPhase: "judging",
        streamingCard: undefined,
        judgeStreamingSlots: undefined,
      };
      batch.flush({ ...base, phase: "running", generations: [...gens] });
    }

    if (!startFromJudge) {
      if (startFromAggregate && settings.aggregator.enabled) {
        await runAggregatePhase(
          i,
          ctx,
          threadSignal,
          threadAc,
          markError,
          {
            pauseRequested: () => pauseRequested,
            cancelRequested: () => cancelRequested,
            pauseStepRef,
            markPaused,
            markAbandoned,
          },
        );
      }
      return;
    }

    if (settings.judges.length > 0) {
      const judgeSlotsToRun: {
        judge: (typeof settings.judges)[number];
        r: number;
      }[] = [];
      for (const judge of settings.judges) {
        for (let r = 0; r < Math.max(1, judge.reviewCount); r++) {
          if (!hasJudgeRunForSlot(gens[i], judge.id, r)) {
            judgeSlotsToRun.push({ judge, r });
          }
        }
      }

      if (judgeSlotsToRun.length > 0) {
        const activeJudgeStreamingKeys = new Set<string>();
        let pendingInterruptSlot: FailedPipelineStep | null = null;

        const judgePromises: Promise<void>[] = [];
        for (const { judge, r } of judgeSlotsToRun) {
          judgePromises.push(
            runLimited(limiters, judge.presetId, async () => {
              const slotKey = encodeJudgeSlotKey(judge.id, r);
              const sk = judgeScratchKey(i, judge.id, r);
              const slotAc = new AbortController();
              threadInteractive.judgeSlots.set(slotKey, slotAc);
              const streamSig = anyAbortSignal([threadSignal, slotAc.signal]);
              try {
                const jp = presetOrThrow(settings, judge.presetId);
                const userContent = judge.userPromptTemplate.replace(
                  /\{\{candidate\}\}/g,
                  gens[i].text,
                );
                if (!judgeScratch.has(sk)) {
                  judgeScratch.set(sk, { raw: "", reasoning: "" });
                }
                activeJudgeStreamingKeys.add(slotKey);
                gens[i] = {
                  ...gens[i],
                  judgeStreamingSlots: judgeSlotsFromKeySet(
                    activeJudgeStreamingKeys,
                  ),
                  streamingCard: undefined,
                };
                batch.schedule({
                  ...base,
                  phase: "running",
                  generations: [...gens],
                });

                pauseStepRef.current = {
                  step: "judge",
                  judgeId: judge.id,
                  reviewIndex: r,
                };
                let jr = "";
                let jrReason = "";
                await streamChat(
                  jp.baseUrl,
                  jp.apiKey,
                  {
                    model: judge.model,
                    messages: [
                      { role: "system", content: judge.systemPrompt },
                      { role: "user", content: userContent },
                    ],
                    ...samplingParams(settings),
                  },
                  (d) => {
                    jr += d.content;
                    jrReason += d.reasoning;
                    const slot = judgeScratch.get(sk)!;
                    slot.raw = jr;
                    slot.reasoning = jrReason;
                    gens[i] = {
                      ...gens[i],
                      judgeRuns: rebuildJudgeRunsFromScratch(
                        i,
                        judgeScratch,
                        settings,
                      ),
                      judgeStreamingSlots: judgeSlotsFromKeySet(
                        activeJudgeStreamingKeys,
                      ),
                      streamingCard: undefined,
                    };
                    batch.schedule({
                      ...base,
                      phase: "running",
                      generations: [...gens],
                    });
                  },
                  streamSig,
                );
                {
                  const s = stripCompleteRedactedThinking(jr);
                  jr = s.content;
                  jrReason = appendStrippedReasoning(jrReason, s.reasoning);
                }
                const slot = judgeScratch.get(sk)!;
                slot.raw = jr;
                slot.reasoning = jrReason;
                gens[i] = {
                  ...gens[i],
                  judgeRuns: rebuildJudgeRunsFromScratch(
                    i,
                    judgeScratch,
                    settings,
                  ),
                  judgeStreamingSlots: judgeSlotsFromKeySet(
                    activeJudgeStreamingKeys,
                  ),
                  streamingCard: undefined,
                };
                batch.flush({
                  ...base,
                  phase: "running",
                  generations: [...gens],
                });
              } catch (e) {
                if (isGlobalAbort(e, signal)) throw e;
                if (cancelRequested) {
                  markAbandoned();
                  return;
                }
                if (pauseRequested) {
                  markPaused({
                    step: "judge",
                    judgeId: judge.id,
                    reviewIndex: r,
                  });
                  return;
                }
                if (e instanceof DOMException && e.name === "AbortError") {
                  if (
                    gens[i].threadOutcome === "error" ||
                    gens[i].threadPhase === "paused"
                  ) {
                    return;
                  }
                  if (threadInteractive.userSlotAbortKeys.delete(slotKey)) {
                    pendingInterruptSlot = {
                      step: "judge",
                      judgeId: judge.id,
                      reviewIndex: r,
                    };
                    return;
                  }
                  markError(e, {
                    step: "judge",
                    judgeId: judge.id,
                    reviewIndex: r,
                  });
                  return;
                }
                markError(e, {
                  step: "judge",
                  judgeId: judge.id,
                  reviewIndex: r,
                });
                return;
              } finally {
                activeJudgeStreamingKeys.delete(slotKey);
                threadInteractive.judgeSlots.delete(slotKey);
                gens[i] = {
                  ...gens[i],
                  judgeStreamingSlots:
                    activeJudgeStreamingKeys.size === 0
                      ? undefined
                      : judgeSlotsFromKeySet(activeJudgeStreamingKeys),
                  streamingCard: undefined,
                };
                batch.schedule({
                  ...base,
                  phase: "running",
                  generations: [...gens],
                });
              }
            }),
          );
        }

        const settled = await Promise.allSettled(judgePromises);
        const failed = settled.find((s) => s.status === "rejected");
        if (failed) {
          if (
            failed.status === "rejected" &&
            isGlobalAbort(failed.reason, signal)
          ) {
            throw failed.reason;
          }
          return;
        }
        if (pendingInterruptSlot && !interactiveHandled) {
          markPaused(pendingInterruptSlot);
        }
      }
    }

    if (!settings.aggregator.enabled) {
      gens[i] = {
        ...gens[i],
        threadPhase: "done",
        threadOutcome: "ok",
        streamingCard: undefined,
        judgeStreamingSlots: undefined,
      };
      batch.flush({ ...base, phase: "running", generations: [...gens] });
      return;
    }

    if (!startFromAggregate) return;

    await runAggregatePhase(i, ctx, threadSignal, threadAc, markError, {
      pauseRequested: () => pauseRequested,
      cancelRequested: () => cancelRequested,
      pauseStepRef,
      markPaused,
      markAbandoned,
    });
  } catch (e) {
    if (isGlobalAbort(e, signal)) throw e;
    throw e;
  } finally {
    threadInteractiveControllers.delete(gens[i].id);
  }
}

async function runAggregatePhase(
  i: number,
  ctx: ThreadPipelineCtx,
  threadSignal: AbortSignal,
  threadAc: AbortController,
  markError: (e: unknown, step: FailedPipelineStep) => void,
  interactive: {
    pauseRequested: () => boolean;
    cancelRequested: () => boolean;
    pauseStepRef: { current: FailedPipelineStep };
    markPaused: (s: FailedPipelineStep) => void;
    markAbandoned: () => void;
  },
) {
  const { gens, settings, limiters, base, batch } = ctx;

  interactive.pauseStepRef.current = { step: "aggregate" };

  gens[i] = {
    ...gens[i],
    threadPhase: "aggregating",
    streamingCard: { kind: "aggregate" },
    judgeStreamingSlots: undefined,
  };
  batch.flush({ ...base, phase: "running", generations: [...gens] });

  const g = gens[i];
  const reviewsText = g.judgeRuns
    .map(
      (jr) => `[${jr.judgeName} #${jr.reviewIndex + 1}]\n${jr.rawText}`,
    )
    .join("\n\n---\n\n");
  const userContent = settings.aggregator.userPromptTemplate
    .replace(/\{\{candidate\}\}/g, g.text)
    .replace(/\{\{reviews\}\}/g, reviewsText);

  const aggPreset = presetOrThrow(settings, settings.aggregator.presetId);
  let agg = "";
  let aggReason = "";

  try {
    await runLimited(limiters, settings.aggregator.presetId, async () => {
      await streamChat(
        aggPreset.baseUrl,
        aggPreset.apiKey,
        {
          model: settings.aggregator.model,
          messages: [
            { role: "system", content: settings.aggregator.systemPrompt },
            { role: "user", content: userContent },
          ],
          ...samplingParams(settings),
        },
        (d) => {
          agg += d.content;
          aggReason += d.reasoning;
          gens[i] = {
            ...gens[i],
            aggregateText: agg,
            aggregateReasoningText: aggReason || undefined,
            streamingCard: { kind: "aggregate" },
          };
          batch.schedule({ ...base, phase: "running", generations: [...gens] });
        },
        threadSignal,
      );
    });
  } catch (e) {
    if (isGlobalAbort(e, ctx.signal)) {
      threadAc.abort();
      throw e;
    }
    if (interactive.cancelRequested()) {
      interactive.markAbandoned();
      return;
    }
    if (interactive.pauseRequested()) {
      interactive.markPaused(interactive.pauseStepRef.current);
      return;
    }
    markError(e, { step: "aggregate" });
    return;
  }

  {
    const s = stripCompleteRedactedThinking(agg);
    agg = s.content;
    aggReason = appendStrippedReasoning(aggReason, s.reasoning);
  }

  gens[i] = {
    ...gens[i],
    aggregateText: agg,
    aggregateReasoningText: aggReason || undefined,
    threadPhase: "done",
    threadOutcome: "ok",
    streamingCard: undefined,
    judgeStreamingSlots: undefined,
  };
  batch.flush({ ...base, phase: "running", generations: [...gens] });
}

/** 重试单条失败线程（从 failedPipelineStep 指示的步骤恢复） */
export async function resumeSingleThread(
  settings: GlobalSettings,
  prompt: string,
  onUpdate: (s: RunSession) => void,
  signal: AbortSignal,
  session: RunSession,
  genId: string,
  /** 在终态 flush 时查询；整轮仍在跑则保持 phase: running（避免快照在整轮结束后仍误判） */
  isFullRunActive?: () => boolean,
): Promise<void> {
  const idx = session.generations.findIndex((g) => g.id === genId);
  if (idx < 0) throw new Error("未找到该生成线程");

  const g = session.generations[idx];
  const resumeStep = g.failedPipelineStep ?? g.pausedPipelineStep;
  const canResume =
    (g.threadOutcome === "error" && g.failedPipelineStep) ||
    (g.threadPhase === "paused" && g.pausedPipelineStep);
  if (!resumeStep || !canResume) {
    throw new Error("该线程当前不可重试");
  }

  const tasks: { modelId: string; sampleIndex: number; presetId: string }[] =
    [];
  for (const m of settings.models) {
    for (let i = 0; i < Math.max(1, m.sampleCount); i++) {
      tasks.push({
        modelId: m.modelId,
        sampleIndex: i,
        presetId: m.presetId,
      });
    }
  }
  if (idx >= tasks.length) throw new Error("线程索引与当前模型列表不一致");

  const gens: GenerationResult[] = session.generations.map((x) => ({ ...x }));
  const judgeScratch = new Map<string, { raw: string; reasoning: string }>();
  for (let gi = 0; gi < gens.length; gi++) {
    for (const run of gens[gi].judgeRuns) {
      const key = judgeScratchKey(gi, run.judgeId, run.reviewIndex);
      judgeScratch.set(key, {
        raw: run.rawText,
        reasoning: run.reasoningText ?? "",
      });
    }
  }

  const base: RunSession = {
    ...session,
    phase: "running",
    error: undefined,
  };

  const limiters = buildPresetLimiters(settings);
  const batch = createSessionUpdateBatcher(onUpdate);
  batch.flush({ ...base, generations: [...gens] });

  await runOneThreadPipeline({
    mode: { mode: "resume", failedStep: resumeStep },
    i: idx,
    tasks,
    gens,
    settings,
    prompt,
    signal,
    limiters,
    judgeScratch,
    base,
    batch,
  });

  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const fullRunActive = isFullRunActive?.() ?? false;
  batch.flush({
    ...base,
    phase: fullRunActive ? "running" : "done",
    generations: [...gens],
  });
}

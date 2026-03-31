import pLimit from "p-limit";
import { streamChat } from "./openaiStream";
import { getPreset } from "./settingsHelpers";
import type {
  GenerationResult,
  GlobalSettings,
  JudgeRunResult,
  RunSession,
} from "./types";

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

export async function executeEvaluation(
  settings: GlobalSettings,
  prompt: string,
  onUpdate: (s: RunSession) => void,
  signal: AbortSignal,
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

  onUpdate({ ...base, generations: [...gens] });

  const runThread = async (i: number) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const t = tasks[i];
    const preset = presetOrThrow(settings, t.presetId);

    let text = "";
    let reasoningText = "";

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
          };
          onUpdate({ ...base, phase: "running", generations: [...gens] });
        },
        signal,
      );
    });

    gens[i] = {
      ...gens[i],
      text,
      reasoningText: reasoningText || undefined,
      threadPhase: "judging",
    };
    onUpdate({ ...base, phase: "running", generations: [...gens] });

    const judgePromises: Promise<void>[] = [];
    for (const judge of settings.judges) {
      for (let r = 0; r < Math.max(1, judge.reviewCount); r++) {
        judgePromises.push(
          runLimited(limiters, judge.presetId, async () => {
            const jp = presetOrThrow(settings, judge.presetId);
            const userContent = judge.userPromptTemplate.replace(
              /\{\{candidate\}\}/g,
              gens[i].text,
            );
            const sk = judgeScratchKey(i, judge.id, r);
            if (!judgeScratch.has(sk)) {
              judgeScratch.set(sk, { raw: "", reasoning: "" });
            }
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
                };
                onUpdate({ ...base, phase: "running", generations: [...gens] });
              },
              signal,
            );
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
            };
            onUpdate({ ...base, phase: "running", generations: [...gens] });
          }),
        );
      }
    }
    await Promise.all(judgePromises);

    if (!settings.aggregator.enabled) {
      gens[i] = { ...gens[i], threadPhase: "done" };
      onUpdate({ ...base, phase: "running", generations: [...gens] });
      return;
    }

    gens[i] = { ...gens[i], threadPhase: "aggregating" };
    onUpdate({ ...base, phase: "running", generations: [...gens] });

    const g = gens[i];
    const reviewsText = g.judgeRuns
      .map(
        (jr) =>
          `[${jr.judgeName} #${jr.reviewIndex + 1}]\n${jr.rawText}`,
      )
      .join("\n\n---\n\n");
    const userContent = settings.aggregator.userPromptTemplate
      .replace(/\{\{candidate\}\}/g, g.text)
      .replace(/\{\{reviews\}\}/g, reviewsText);

    const aggPreset = presetOrThrow(settings, settings.aggregator.presetId);
    let agg = "";
    let aggReason = "";

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
          };
          onUpdate({ ...base, phase: "running", generations: [...gens] });
        },
        signal,
      );
    });

    gens[i] = {
      ...gens[i],
      aggregateText: agg,
      aggregateReasoningText: aggReason || undefined,
      threadPhase: "done",
    };
    onUpdate({ ...base, phase: "running", generations: [...gens] });
  };

  await Promise.all(tasks.map((_, i) => runThread(i)));

  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  onUpdate({
    ...base,
    phase: "done",
    generations: [...gens],
  });
}

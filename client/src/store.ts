/**
 * 全局状态：评测配置持久化、单次运行会话、线程分与混合权重。
 * 与 pipeline 协作通过 AbortController 区分「整轮取消」与「单线程 resume」。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userFacingEvaluationError } from "./errorUtils";
import {
  applyEvaluationPreset,
  applyPoetryJudgePrompts,
  DEFAULT_EVALUATION_PRESET_ID,
  getEvaluationPresetById,
  getPoetryAggregatorPartial,
} from "./evaluationPresets";
import {
  executeEvaluation,
  requestAbortJudgeSlot,
  requestCancelThread,
  requestPauseThread,
  resumeSingleThread,
} from "./pipeline";
import { DEFAULT_BLEND_WEIGHTS, normalizeBlendWeights } from "./scoreCalculations";
import type {
  BlendWeights,
  CustomEvaluationPresetEntry,
  GenerationResult,
  GlobalSettings,
  RunSession,
  ThreadScoreInput,
  ThreadPhase,
} from "./types";

function newId(): string {
  return crypto.randomUUID();
}

/** 用户已取消时，流水线仍可能通过 RAF 推送 phase:running，强制合并为已结束 */
function mergeSessionIfAborted(
  session: RunSession,
  signal: AbortSignal,
  /** 整轮评测仍在跑时，单线程 resume 被取消不得把会话打成 done */
  fullRunActive?: boolean,
): RunSession {
  if (!signal.aborted) return session;
  if (fullRunActive) {
    return {
      ...session,
      phase: "running",
      error: undefined,
    };
  }
  return {
    ...session,
    phase: "done",
    error: "已取消",
  };
}

/** resume 的 onUpdate 快照含整表拷贝，仅合并目标 genId 对应列，避免覆盖其它仍在跑的线程 */
function mergeResumeIntoLastRun(
  current: RunSession | null,
  incoming: RunSession,
  genId: string,
): RunSession | null {
  if (!current) return incoming;
  const idx = current.generations.findIndex((g) => g.id === genId);
  if (idx < 0) return incoming;
  const inc = incoming.generations[idx];
  const cur = current.generations[idx];
  if (!inc || !cur || inc.id !== cur.id) return incoming;
  const nextGens = current.generations.map((g, i) => (i === idx ? inc : g));
  return {
    ...current,
    ...incoming,
    generations: nextGens,
  };
}

function createDefaultSettings(): GlobalSettings {
  const pid = newId();
  const agg = getPoetryAggregatorPartial();
  const base: GlobalSettings = {
    apiPresets: [
      {
        id: pid,
        name: "默认",
        baseUrl: "https://api.openai.com",
        apiKey: "",
        manualModelIds: [],
        fetchedModelIds: [],
        concurrency: 4,
      },
    ],
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    models: [
      {
        id: newId(),
        presetId: pid,
        modelId: "gpt-4o-mini",
        sampleCount: 1,
      },
    ],
    judges: [
      {
        id: newId(),
        name: "评委 A",
        presetId: pid,
        model: "gpt-4o-mini",
        systemPrompt: "",
        userPromptTemplate: "",
        reviewCount: 1,
      },
    ],
    aggregator: {
      enabled: true,
      presetId: pid,
      model: "gpt-4o-mini",
      systemPrompt: agg.systemPrompt,
      userPromptTemplate: agg.userPromptTemplate,
    },
    taskPrompt: "",
    evaluationPresetId: DEFAULT_EVALUATION_PRESET_ID,
    customEvaluationPresets: [],
  };
  const withJudges = applyPoetryJudgePrompts(base);
  return applyEvaluationPreset(withJudges, DEFAULT_EVALUATION_PRESET_ID);
}

const defaultSettings: GlobalSettings = createDefaultSettings();

/** 整轮「开始评测」的取消信号 */
let abortRef: AbortController | null = null;
/** 单线程「重试 / 恢复」专用，勿与 abortRef 混用，否则会误取消整轮评测 */
let resumeAbortRef: AbortController | null = null;

interface ArenaState {
  settings: GlobalSettings;
  lastRun: RunSession | null;
  /** 每个 modelId 一条人工「生成分」（图表页） */
  humanScores: Record<string, number>;
  /** 按 generation.id 存每线程填写的评委分与人类分 */
  threadScores: Record<string, ThreadScoreInput>;
  /** 分数计算器：各评委权重 + 人类分权重 */
  blendWeights: BlendWeights;
  setSettings: (s: GlobalSettings) => void;
  updateHumanScore: (modelId: string, score: number | undefined) => void;
  /** 图表页「整体验收」人工分：一键清空当前已保存的全部模型分（不影响线程内评委分） */
  clearAllHumanScores: () => void;
  /**
   * 按顺序对当前会话中仍处于失败且可恢复（含 failedPipelineStep）的线程依次调用恢复。
   * 与单线程「重试」共用同一套 resume 逻辑，避免并行 resume 争抢 resumeAbortRef。
   */
  resumeAllFailedThreads: () => Promise<void>;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
  setJudgeBlendWeight: (judgeId: string, w: number) => void;
  setHumanBlendWeight: (w: number) => void;
  runEvaluation: (prompt: string) => Promise<void>;
  resumeThreadEvaluation: (genId: string) => Promise<void>;
  pauseThread: (genId: string) => void;
  /** 仅中止某一 judge 槽位的流式请求（并行 judge 时其它槽位继续） */
  abortJudgeSlot: (
    genId: string,
    judgeId: string,
    reviewIndex: number,
  ) => void;
  cancelThread: (genId: string) => void;
  abandonThread: (genId: string) => void;
  cancelRun: () => void;
  clearLastRun: () => void;
}

export const useArenaStore = create<ArenaState>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      lastRun: null,
      humanScores: {},
      threadScores: {},
      blendWeights: { ...DEFAULT_BLEND_WEIGHTS },

      setSettings: (settings) => set({ settings }),

      setThreadJudgeScore: (genId, judgeId, score) =>
        set((state) => {
          const cur = state.threadScores[genId] ?? { judgeScores: {} };
          const judgeScores = { ...cur.judgeScores };
          if (score === undefined || Number.isNaN(score)) {
            delete judgeScores[judgeId];
          } else {
            judgeScores[judgeId] = score;
          }
          return {
            threadScores: {
              ...state.threadScores,
              [genId]: { ...cur, judgeScores },
            },
          };
        }),

      setThreadHumanScore: (genId, score) =>
        set((state) => {
          const cur = state.threadScores[genId] ?? { judgeScores: {} };
          const human =
            score === undefined || Number.isNaN(score) ? undefined : score;
          return {
            threadScores: {
              ...state.threadScores,
              [genId]: { ...cur, human },
            },
          };
        }),

      setJudgeBlendWeight: (judgeId, w) =>
        set((state) => {
          const jw = state.blendWeights.judgeWeights ?? {};
          return {
            blendWeights: {
              ...state.blendWeights,
              judgeWeights: { ...jw, [judgeId]: w },
            },
          };
        }),

      setHumanBlendWeight: (w) =>
        set((state) => ({
          blendWeights: { ...state.blendWeights, humanWeight: w },
        })),

      updateHumanScore: (modelId, score) =>
        set((state) => {
          const next = { ...state.humanScores };
          if (score === undefined || Number.isNaN(score)) {
            delete next[modelId];
          } else {
            next[modelId] = score;
          }
          return { humanScores: next };
        }),

      clearAllHumanScores: () => set({ humanScores: {} }),

      clearLastRun: () => set({ lastRun: null, threadScores: {} }),

      abandonThread: (genId) =>
        set((state) => {
          const lr = state.lastRun;
          if (!lr) return state;
          return {
            lastRun: {
              ...lr,
              generations: lr.generations.map((g) =>
                g.id === genId
                  ? {
                      ...g,
                      threadOutcome: "abandoned",
                      threadPhase: "done",
                      pipelineError: undefined,
                      failedPipelineStep: undefined,
                      pausedPipelineStep: undefined,
                      streamingCard: undefined,
                    }
                  : g,
              ),
            },
          };
        }),

      pauseThread: (genId) => {
        requestPauseThread(genId);
      },

      abortJudgeSlot: (genId, judgeId, reviewIndex) => {
        requestAbortJudgeSlot(genId, judgeId, reviewIndex);
      },

      cancelThread: (genId) => {
        requestCancelThread(genId);
      },

      cancelRun: () => {
        abortRef?.abort();
        resumeAbortRef?.abort();
        abortRef = null;
        resumeAbortRef = null;
        set((state) => {
          const lr = state.lastRun;
          if (!lr || lr.phase !== "running") return state;
          return {
            lastRun: {
              ...lr,
              phase: "done",
              error: "已取消",
            },
          };
        });
      },

      resumeAllFailedThreads: async () => {
        const lr0 = get().lastRun;
        if (!lr0?.generations.length) return;
        const ids = lr0.generations
          .filter(
            (g) =>
              g.threadOutcome === "error" &&
              g.failedPipelineStep !== undefined,
          )
          .map((g) => g.id);
        for (const genId of ids) {
          await get().resumeThreadEvaluation(genId);
        }
      },

      resumeThreadEvaluation: async (genId) => {
        const settings = get().settings;
        const lastRun = get().lastRun;
        if (!lastRun?.generations.length) return;

        resumeAbortRef?.abort();
        const resumeController = new AbortController();
        resumeAbortRef = resumeController;
        const signal = resumeController.signal;

        try {
          await resumeSingleThread(
            settings,
            lastRun.prompt,
            (session) =>
              set((state) => ({
                lastRun: mergeResumeIntoLastRun(
                  state.lastRun,
                  mergeSessionIfAborted(
                    session,
                    signal,
                    abortRef !== null,
                  ),
                  genId,
                ),
              })),
            signal,
            lastRun,
            genId,
            () => abortRef !== null,
          );
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") {
            set((st) => {
              const cur = st.lastRun;
              if (!cur) return { lastRun: null };
              if (abortRef !== null) {
                return {
                  lastRun: {
                    ...cur,
                    phase: "running",
                    error: undefined,
                  },
                };
              }
              return {
                lastRun: {
                  ...cur,
                  phase: "done",
                  error: "已取消",
                },
              };
            });
            return;
          }
          const msg = userFacingEvaluationError(e);
          set((st) => {
            if (!st.lastRun) return { lastRun: null };
            if (abortRef !== null) {
              const idx = st.lastRun.generations.findIndex((g) => g.id === genId);
              if (idx < 0) {
                return {
                  lastRun: {
                    ...st.lastRun,
                    phase: "running",
                    error: undefined,
                  },
                };
              }
              const nextGens = [...st.lastRun.generations];
              nextGens[idx] = {
                ...nextGens[idx],
                pipelineError: msg,
                threadOutcome: "error",
                threadPhase: "error",
                streamingCard: undefined,
              };
              return {
                lastRun: {
                  ...st.lastRun,
                  phase: "running",
                  error: undefined,
                  generations: nextGens,
                },
              };
            }
            return {
              lastRun: {
                ...st.lastRun,
                phase: "error",
                error: msg,
              },
            };
          });
        } finally {
          if (resumeAbortRef === resumeController) resumeAbortRef = null;
        }
      },

      runEvaluation: async (prompt) => {
        const settings = get().settings;
        if (!settings.models.length) {
          set({
            lastRun: {
              id: newId(),
              prompt,
              startedAt: Date.now(),
              phase: "error",
              generations: [],
              error: "请先在「设置」中添加至少一个模型。",
            },
          });
          return;
        }

        resumeAbortRef?.abort();
        resumeAbortRef = null;
        abortRef?.abort();
        abortRef = new AbortController();
        const signal = abortRef.signal;

        set({
          lastRun: {
            id: newId(),
            prompt,
            startedAt: Date.now(),
            phase: "running",
            generations: [],
          },
          threadScores: {},
        });

        try {
          await executeEvaluation(
            settings,
            prompt,
            (session) => {
              set({ lastRun: mergeSessionIfAborted(session, signal) });
            },
            signal,
            () => get().lastRun,
          );
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") {
            set((st) => {
              const cur = st.lastRun;
              if (!cur) return { lastRun: null };
              return {
                lastRun: {
                  ...cur,
                  phase: "done",
                  error: "已取消",
                },
              };
            });
            return;
          }
          const msg = userFacingEvaluationError(e);
          set((st) => ({
            lastRun: st.lastRun
              ? {
                  ...st.lastRun,
                  phase: "error",
                  error: msg,
                }
              : {
                  id: newId(),
                  prompt,
                  startedAt: Date.now(),
                  phase: "error",
                  generations: [],
                  error: msg,
                },
          }));
        } finally {
          abortRef = null;
        }
      },
    }),
    {
      name: "llm-arena",
      version: 13,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, fromVersion) => {
        const p = persisted as {
          settings?: GlobalSettings & {
            baseUrl?: string;
            apiKey?: string;
            concurrency?: number;
          };
        };
        if (fromVersion < 2 && p.settings && !p.settings.apiPresets) {
          const s = p.settings;
          const pid = crypto.randomUUID();
          p.settings = {
            ...s,
            apiPresets: [
              {
                id: pid,
                name: "默认",
                baseUrl: s.baseUrl ?? "https://api.openai.com",
                apiKey: s.apiKey ?? "",
                manualModelIds: [],
                fetchedModelIds: [],
                concurrency: Math.max(1, s.concurrency ?? 4),
              },
            ],
            models: (s.models ?? []).map((m) => ({
              ...m,
              presetId: "presetId" in m && (m as { presetId?: string }).presetId
                ? (m as { presetId: string }).presetId
                : pid,
            })),
            judges: (s.judges ?? []).map((j) => ({
              ...j,
              presetId:
                "presetId" in j && (j as { presetId?: string }).presetId
                  ? (j as { presetId: string }).presetId
                  : pid,
            })),
            aggregator: {
              ...s.aggregator,
              presetId:
                s.aggregator &&
                "presetId" in s.aggregator &&
                (s.aggregator as { presetId?: string }).presetId
                  ? (s.aggregator as { presetId: string }).presetId
                  : pid,
            },
          };
          delete (p.settings as { baseUrl?: string }).baseUrl;
          delete (p.settings as { apiKey?: string }).apiKey;
        }
        if (p.settings?.apiPresets) {
          p.settings.apiPresets = p.settings.apiPresets.map((ap) => ({
            ...ap,
            manualModelIds: Array.isArray(
              (ap as { manualModelIds?: string[] }).manualModelIds,
            )
              ? (ap as { manualModelIds: string[] }).manualModelIds
              : [],
            fetchedModelIds: Array.isArray(
              (ap as { fetchedModelIds?: string[] }).fetchedModelIds,
            )
              ? (ap as { fetchedModelIds: string[] }).fetchedModelIds
              : [],
          }));
        }
        if (fromVersion < 4) {
          const st = persisted as Record<string, unknown>;
          if (!st.threadScores) st.threadScores = {};
          if (!st.blendWeights) {
            st.blendWeights = { ...DEFAULT_BLEND_WEIGHTS };
          }
        }
        if (fromVersion < 6) {
          const st = persisted as Record<string, unknown>;
          const rawBw = st.blendWeights;
          if (
            rawBw &&
            typeof rawBw === "object" &&
            !("judgeWeights" in rawBw)
          ) {
            const m = rawBw as Record<string, unknown>;
            st.blendWeights = {
              judgeWeights: {},
              humanWeight:
                typeof m.humanWeight === "number" && !Number.isNaN(m.humanWeight)
                  ? m.humanWeight
                  : 1,
            };
          }
        }
        if (fromVersion < 7) {
          const st = persisted as Record<string, unknown>;
          st.blendWeights = normalizeBlendWeights(
            st.blendWeights as BlendWeights | undefined,
          );
        }
        if (fromVersion < 8 && p.settings) {
          const s = p.settings as GlobalSettings;
          const apiPid = s.apiPresets?.[0]?.id ?? "";
          let next: GlobalSettings = {
            ...s,
            taskPrompt:
              typeof s.taskPrompt === "string" && s.taskPrompt.trim()
                ? s.taskPrompt
                : "",
            evaluationPresetId:
              typeof s.evaluationPresetId === "string" &&
              getEvaluationPresetById(s.evaluationPresetId)
                ? s.evaluationPresetId
                : DEFAULT_EVALUATION_PRESET_ID,
            aggregator: {
              enabled: s.aggregator?.enabled ?? true,
              presetId: s.aggregator?.presetId ?? apiPid,
              model: s.aggregator?.model ?? "",
              ...getPoetryAggregatorPartial(),
            },
          };
          next = applyPoetryJudgePrompts(next);
          const presetId =
            getEvaluationPresetById(next.evaluationPresetId)?.id ??
            DEFAULT_EVALUATION_PRESET_ID;
          next = applyEvaluationPreset(next, presetId);
          next = {
            ...next,
            aggregator: {
              ...next.aggregator,
              ...getPoetryAggregatorPartial(),
            },
          };
          p.settings = next;
        }
        if (fromVersion < 5 && p.settings) {
          const oldGlobal =
            typeof (p.settings as { concurrency?: number }).concurrency ===
            "number"
              ? Math.max(
                  1,
                  (p.settings as { concurrency: number }).concurrency,
                )
              : 4;
          p.settings.apiPresets = (p.settings.apiPresets ?? []).map((ap) => ({
            ...ap,
            concurrency:
              typeof (ap as { concurrency?: number }).concurrency === "number"
                ? Math.max(1, (ap as { concurrency: number }).concurrency)
                : oldGlobal,
          }));
          delete (p.settings as { concurrency?: number }).concurrency;
        }
        if (fromVersion < 5) {
          const raw = persisted as Record<string, unknown>;
          const lr = raw.lastRun as RunSession | null | undefined;
          if (lr?.generations?.length) {
            lr.generations = lr.generations.map((g) => ({
              ...(g as GenerationResult),
              threadPhase:
                (g as GenerationResult).threadPhase ?? ("done" as ThreadPhase),
            }));
          }
          const ph = lr?.phase as string | undefined;
          if (
            lr &&
            (ph === "generating" || ph === "judging" || ph === "aggregating")
          ) {
            lr.phase = "done";
          }
        }
        if (fromVersion < 10 && p.settings) {
          const s = p.settings as GlobalSettings;
          const raw = (s as { customEvaluationPresets?: unknown })
            .customEvaluationPresets;
          const customEvaluationPresets: CustomEvaluationPresetEntry[] =
            Array.isArray(raw)
              ? (raw as CustomEvaluationPresetEntry[]).map((x) => ({
                  id:
                    typeof x.id === "string" && x.id.trim()
                      ? x.id
                      : crypto.randomUUID(),
                  name:
                    typeof x.name === "string" && x.name.trim()
                      ? x.name
                      : "自定义题目",
                  taskPrompt:
                    typeof x.taskPrompt === "string" ? x.taskPrompt : "",
                }))
              : [];
          let next: GlobalSettings = { ...s, customEvaluationPresets };
          if (
            !getEvaluationPresetById(
              next.evaluationPresetId,
              customEvaluationPresets,
            )
          ) {
            next = applyEvaluationPreset(next, DEFAULT_EVALUATION_PRESET_ID);
          }
          p.settings = next;
        }
        if (fromVersion < 12) {
          const st = persisted as Record<string, unknown>;
          if (!Array.isArray(st.scoreHistory)) st.scoreHistory = [];
        }
        if (fromVersion < 13) {
          const st = persisted as Record<string, unknown>;
          delete st.scoreHistory;
        }
        return persisted as typeof persisted;
      },
      partialize: (state) => ({
        settings: state.settings,
        humanScores: state.humanScores,
        lastRun: state.lastRun,
        threadScores: state.threadScores,
        blendWeights: state.blendWeights,
      }),
      merge: (persistedState, currentState) => {
        const merged = {
          ...currentState,
          ...(persistedState as Record<string, unknown>),
        };
        const s = merged.settings as GlobalSettings | undefined;
        if (s && s.customEvaluationPresets === undefined) {
          merged.settings = {
            ...s,
            customEvaluationPresets: [],
          };
        }
        delete (merged as Record<string, unknown>).scoreHistory;
        return merged as typeof currentState;
      },
    },
  ),
);

export { defaultSettings, newId };

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { executeEvaluation } from "./pipeline";
import { DEFAULT_BLEND_WEIGHTS } from "./scoreCalculations";
import type {
  BlendWeights,
  GenerationResult,
  GlobalSettings,
  RunSession,
  ThreadScoreInput,
  ThreadPhase,
} from "./types";

function newId(): string {
  return crypto.randomUUID();
}

function createDefaultSettings(): GlobalSettings {
  const pid = newId();
  return {
    apiPresets: [
      {
        id: pid,
        name: "默认",
        baseUrl: "https://api.openai.com",
        apiKey: "",
        manualModelIds: [],
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
        systemPrompt:
          "你是向量检索与系统架构方向的评测专家。候选内容应针对「向量数据库 / ANN 近似最近邻」类算法与系统设计题。请从：问题边界是否清晰、索引与数据结构选型、插入/查询/更新的复杂度与量级、并行与分片、延迟与吞吐权衡、增量更新与可运维性等维度分析。先用自然语言分条写出分析，最后单独一行「综合分：X/10」（X 为 0–10）。",
        userPromptTemplate:
          "下面是对「向量数据库 / ANN 检索、性能优先」设计题的回答，请按 system 要求评价。\n\n【候选回答】\n{{candidate}}",
        reviewCount: 1,
      },
    ],
    aggregator: {
      enabled: true,
      presetId: pid,
      model: "gpt-4o-mini",
      systemPrompt:
        "你是技术评审秘书。阅读各评委对同一道「向量数据库 / ANN、性能优先」设计题的全文评价后，用不超过200字的中文：分述每位评委给出的分数与意见，并概括共识与分歧。",
      userPromptTemplate:
        "【题目类型】向量数据库 / ANN 检索系统设计（性能优先）。\n\n【候选答案】\n{{candidate}}\n\n【各评委原始输出】\n{{reviews}}\n\n请在200字以内按 system 要求汇总。",
    },
  };
}

const defaultSettings: GlobalSettings = createDefaultSettings();

let abortRef: AbortController | null = null;

interface ArenaState {
  settings: GlobalSettings;
  lastRun: RunSession | null;
  /** 每个 modelId 一条人工「生成分」（图表页） */
  humanScores: Record<string, number>;
  /** 按 generation.id 存每线程填写的评委分与人类分 */
  threadScores: Record<string, ThreadScoreInput>;
  /** 分数计算器：各参赛模型权重 + 人类分权重 */
  blendWeights: BlendWeights;
  setSettings: (s: GlobalSettings) => void;
  updateHumanScore: (modelId: string, score: number | undefined) => void;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
  setModelBlendWeight: (modelId: string, w: number) => void;
  setHumanBlendWeight: (w: number) => void;
  runEvaluation: (prompt: string) => Promise<void>;
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

      setModelBlendWeight: (modelId, w) =>
        set((state) => ({
          blendWeights: {
            ...state.blendWeights,
            modelWeights: {
              ...state.blendWeights.modelWeights,
              [modelId]: w,
            },
          },
        })),

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

      clearLastRun: () => set({ lastRun: null, threadScores: {} }),

      cancelRun: () => {
        abortRef?.abort();
        abortRef = null;
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
          await executeEvaluation(settings, prompt, (session) => {
            set({ lastRun: session });
          }, signal);
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") {
            set((st) => ({
              lastRun: st.lastRun
                ? {
                    ...st.lastRun,
                    phase: "done",
                    error: "已取消",
                  }
                : null,
            }));
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
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
      version: 5,
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
          }));
        }
        if (fromVersion < 4) {
          const st = persisted as Record<string, unknown>;
          if (!st.threadScores) st.threadScores = {};
          if (!st.blendWeights) {
            st.blendWeights = { ...DEFAULT_BLEND_WEIGHTS };
          }
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
        return persisted as typeof persisted;
      },
      partialize: (state) => ({
        settings: state.settings,
        humanScores: state.humanScores,
        lastRun: state.lastRun,
        threadScores: state.threadScores,
        blendWeights: state.blendWeights,
      }),
    },
  ),
);

export { defaultSettings, newId };

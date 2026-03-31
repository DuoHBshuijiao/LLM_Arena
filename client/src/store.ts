import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { executeEvaluation } from "./pipeline";
import type { GlobalSettings, RunSession } from "./types";

function newId(): string {
  return crypto.randomUUID();
}

const defaultSettings: GlobalSettings = {
  baseUrl: "https://api.openai.com",
  apiKey: "",
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  concurrency: 4,
  models: [
    {
      id: newId(),
      modelId: "gpt-4o-mini",
      sampleCount: 1,
    },
  ],
  judges: [
    {
      id: newId(),
      name: "评委 A",
      model: "gpt-4o-mini",
      systemPrompt:
        "你是严谨的评测助手。请严格按用户要求只输出一段 JSON，不要输出其它文字。",
      userPromptTemplate:
        '请评价下面「候选回复」的质量，输出 JSON，字段：overall（0-10 数字）、dimensions（对象，键为维度名、值为 0-10）、brief_reason（简短字符串）。\n\n候选回复：\n{{candidate}}',
      reviewCount: 1,
    },
  ],
  aggregator: {
    enabled: true,
    model: "gpt-4o-mini",
    systemPrompt:
      "你是汇总助手。将多条评审合并为一条结论，只输出 JSON，不要其它文字。",
    userPromptTemplate:
      '下面是一条「候选回复」以及多条评委的原始输出。请汇总为综合分数与简短说明。输出 JSON：overall（0-10）、dimensions（对象）、summary（字符串）。\n\n【候选】\n{{candidate}}\n\n【各评委输出】\n{{reviews}}',
  },
};

let abortRef: AbortController | null = null;

interface ArenaState {
  settings: GlobalSettings;
  lastRun: RunSession | null;
  /** 每个 modelId 一条人工「生成分」 */
  humanScores: Record<string, number>;
  setSettings: (s: GlobalSettings) => void;
  updateHumanScore: (modelId: string, score: number | undefined) => void;
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

      setSettings: (settings) => set({ settings }),

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

      clearLastRun: () => set({ lastRun: null }),

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
            phase: "generating",
            generations: [],
          },
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
                    streamPreview: undefined,
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
                  streamPreview: undefined,
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
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        settings: state.settings,
        humanScores: state.humanScores,
        lastRun: state.lastRun,
      }),
    },
  ),
);

export { defaultSettings, newId };

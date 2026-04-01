import type {
  BlendWeights,
  GenerationResult,
  ThreadScoreInput,
} from "./types";

export const DEFAULT_BLEND_WEIGHTS: BlendWeights = {
  judgeWeights: {},
  humanWeight: 1,
};

/** 兼容持久化/旧版：保证 judgeWeights 为对象，避免 undefined/null 导致运行时崩溃 */
export function normalizeBlendWeights(
  bw: BlendWeights | null | undefined,
): BlendWeights {
  if (!bw || typeof bw !== "object") {
    return { ...DEFAULT_BLEND_WEIGHTS };
  }
  const raw = bw as unknown as Record<string, unknown>;
  const jw = raw.judgeWeights;
  const judgeWeights =
    jw != null && typeof jw === "object" && !Array.isArray(jw)
      ? { ...(jw as Record<string, number>) }
      : {};
  const hw = raw.humanWeight;
  return {
    judgeWeights,
    humanWeight:
      typeof hw === "number" && !Number.isNaN(hw) ? hw : 1,
  };
}

export function clampBlendWeight(w: number): number {
  if (Number.isNaN(w)) return 1;
  if (w < 0.1) return 0.1;
  if (w > 1) return 1;
  return w;
}

/** 单线程综合分（≤10）：各评委分按评委权重加权平均，再与人类分按 denJ 与 humanWeight 混合 */
export function threadCompositeScore(
  input: ThreadScoreInput | undefined,
  judgeIds: string[],
  blend: BlendWeights,
  generation?: GenerationResult,
): number | undefined {
  if (generation?.threadOutcome === "abandoned") return 0;

  let numJ = 0;
  let denJ = 0;
  for (const jid of judgeIds) {
    const v = input?.judgeScores?.[jid];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const w = clampBlendWeight(
      (blend.judgeWeights ?? {})[jid] ?? 1,
    );
    numJ += v * w;
    denJ += w;
  }
  const H = input?.human;
  const Hok = typeof H === "number" && !Number.isNaN(H) ? H : undefined;
  const Wh = clampBlendWeight(blend.humanWeight ?? 1);

  if (denJ <= 0 && Hok === undefined) return undefined;
  if (denJ <= 0) return Math.min(10, Hok!);
  if (Hok === undefined) return Math.min(10, numJ / denJ);
  return Math.min(10, (numJ + Hok * Wh) / (denJ + Wh));
}

/** 按模型聚合：同一 modelId 多条样本时对综合分取平均 */
export function averageCompositeByModel(
  generations: GenerationResult[],
  threadScores: Record<string, ThreadScoreInput | undefined>,
  judgeIds: string[],
  blend: BlendWeights,
): Record<string, number | undefined> {
  const sums: Record<string, { sum: number; n: number }> = {};
  for (const g of generations) {
    const c = threadCompositeScore(threadScores[g.id], judgeIds, blend, g);
    if (c === undefined) continue;
    if (!sums[g.modelId]) sums[g.modelId] = { sum: 0, n: 0 };
    sums[g.modelId].sum += c;
    sums[g.modelId].n += 1;
  }
  const out: Record<string, number | undefined> = {};
  for (const [k, v] of Object.entries(sums)) {
    out[k] = v.n ? v.sum / v.n : undefined;
  }
  return out;
}

import type { BlendWeights, GenerationResult, ThreadScoreInput } from "./types";

export const DEFAULT_BLEND_WEIGHTS: BlendWeights = {
  modelWeights: {},
  humanWeight: 1,
};

export function clampBlendWeight(w: number): number {
  if (Number.isNaN(w)) return 1;
  if (w < 0.1) return 0.1;
  if (w > 1) return 1;
  return w;
}

/** 单线程综合分（≤10）：评委均分与人类分按模型权重、人类权重混合 */
export function threadCompositeScore(
  input: ThreadScoreInput | undefined,
  judgeIds: string[],
  modelId: string,
  blend: BlendWeights,
): number | undefined {
  const Wm = clampBlendWeight(blend.modelWeights[modelId] ?? 1);
  const Wh = clampBlendWeight(blend.humanWeight ?? 1);

  const filled: number[] = [];
  for (const jid of judgeIds) {
    const v = input?.judgeScores?.[jid];
    if (typeof v === "number" && !Number.isNaN(v)) filled.push(v);
  }
  const avgJ = filled.length
    ? filled.reduce((a, b) => a + b, 0) / filled.length
    : undefined;
  const H = input?.human;
  const Hok = typeof H === "number" && !Number.isNaN(H) ? H : undefined;

  if (avgJ === undefined && Hok === undefined) return undefined;
  if (avgJ === undefined) return Math.min(10, Hok!);
  if (Hok === undefined) return Math.min(10, avgJ);
  return Math.min(10, (avgJ * Wm + Hok * Wh) / (Wm + Wh));
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
    const c = threadCompositeScore(
      threadScores[g.id],
      judgeIds,
      g.modelId,
      blend,
    );
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

/** 全会话加权最终分：各线程综合分按模型权重加权平均 */
export function sessionWeightedFinal(
  generations: GenerationResult[],
  threadScores: Record<string, ThreadScoreInput | undefined>,
  judgeIds: string[],
  blend: BlendWeights,
): number | undefined {
  let num = 0;
  let den = 0;
  for (const g of generations) {
    const c = threadCompositeScore(
      threadScores[g.id],
      judgeIds,
      g.modelId,
      blend,
    );
    if (c === undefined) continue;
    const w = clampBlendWeight(blend.modelWeights[g.modelId] ?? 1);
    num += c * w;
    den += w;
  }
  if (den <= 0) return undefined;
  return Math.min(10, num / den);
}

import type { GenerationResult } from "./types";

/** 同一 modelId 多条样本时，对 overall 取平均 */
export function averageAutoScoreByModel(
  generations: GenerationResult[],
): Record<string, number | undefined> {
  const sums: Record<string, { sum: number; n: number }> = {};
  for (const g of generations) {
    const o = g.aggregateParsed?.overall;
    if (typeof o !== "number" || Number.isNaN(o)) continue;
    if (!sums[g.modelId]) sums[g.modelId] = { sum: 0, n: 0 };
    sums[g.modelId].sum += o;
    sums[g.modelId].n += 1;
  }
  const out: Record<string, number | undefined> = {};
  for (const [k, v] of Object.entries(sums)) {
    out[k] = v.n ? v.sum / v.n : undefined;
  }
  return out;
}

export function uniqueModelIds(generations: GenerationResult[]): string[] {
  const s = new Set<string>();
  for (const g of generations) s.add(g.modelId);
  return [...s].sort();
}

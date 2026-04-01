import { averageCompositeByModel } from "./scoreCalculations";
import type { BlendWeights, GenerationResult, ThreadScoreInput } from "./types";

/** 同一 modelId 多条样本时，对线程综合分取平均（基于人工填分与计算器权重） */
export function averageAutoScoreByModel(
  generations: GenerationResult[],
  threadScores: Record<string, ThreadScoreInput | undefined>,
  judgeIds: string[],
  blend: BlendWeights,
): Record<string, number | undefined> {
  return averageCompositeByModel(generations, threadScores, judgeIds, blend);
}

export function uniqueModelIds(generations: GenerationResult[]): string[] {
  const s = new Set<string>();
  for (const g of generations) s.add(g.modelId);
  return [...s].sort();
}

export type SortDirection = "asc" | "desc";

function isMissingScore(v: number | null | undefined): boolean {
  return v === undefined || v === null || Number.isNaN(v);
}

/** 按数值排序 modelId；缺失分置底，同分按 modelId 字典序稳定次序。 */
export function sortModelIdsByValue(
  modelIds: string[],
  getValue: (id: string) => number | undefined | null,
  direction: SortDirection,
): string[] {
  return [...modelIds].sort((a, b) => {
    const va = getValue(a);
    const vb = getValue(b);
    const ma = isMissingScore(va);
    const mb = isMissingScore(vb);
    if (ma && mb) return a.localeCompare(b);
    if (ma) return 1;
    if (mb) return -1;
    const cmp = (va as number) - (vb as number);
    if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
    return a.localeCompare(b);
  });
}

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

import {
  averageCompositeByModel,
  normalizeBlendWeights,
  threadCompositeScore,
} from "./scoreCalculations";
import type {
  BlendWeights,
  RunSession,
  SavedScoreSnapshot,
  ThreadScoreInput,
} from "./types";

export function buildSavedScoreSnapshot(params: {
  session: RunSession;
  threadScores: Record<string, ThreadScoreInput>;
  humanScores: Record<string, number>;
  blendWeights: BlendWeights;
  judgeIds: string[];
}): SavedScoreSnapshot {
  const { session, threadScores, humanScores, blendWeights, judgeIds } = params;
  const perThread: Record<string, number | undefined> = {};
  for (const g of session.generations) {
    perThread[g.id] = threadCompositeScore(
      threadScores[g.id],
      judgeIds,
      blendWeights,
      g,
    );
  }
  const byModel = averageCompositeByModel(
    session.generations,
    threadScores,
    judgeIds,
    blendWeights,
  );
  return {
    exportVersion: 1,
    id: crypto.randomUUID(),
    savedAt: Date.now(),
    prompt: session.prompt,
    session,
    threadScores: JSON.parse(JSON.stringify(threadScores)) as Record<
      string,
      ThreadScoreInput
    >,
    humanScores: { ...humanScores },
    blendWeights: normalizeBlendWeights(blendWeights),
    judgeIds: [...judgeIds],
    computed: { perThread, byModel },
  };
}

export function sanitizeFilenameBase(raw: string, maxLen: number): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .replace(/\s+/g, "_");
  if (!cleaned) return "untitled";
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen);
}

export function formatTimestampForFilename(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function triggerJsonDownload(
  data: unknown,
  filename: string,
): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

import type { SavedScoreSnapshot, ScoreHistoryExportFile } from "./types";

/** 经 Vite 代理到本地 Node 服务，写入仓库根目录下 data/scores */
const BASE = "/api";

export async function saveScoreSnapshot(
  snapshot: SavedScoreSnapshot,
): Promise<void> {
  const r = await fetch(`${BASE}/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!r.ok) {
    let detail = "";
    try {
      const j = (await r.json()) as { error?: string };
      detail = j.error ?? "";
    } catch {
      detail = await r.text();
    }
    throw new Error(detail || `保存失败（HTTP ${r.status}）`);
  }
}

export async function fetchScoreHistory(): Promise<SavedScoreSnapshot[]> {
  const r = await fetch(`${BASE}/scores`);
  if (!r.ok) {
    let detail = "";
    try {
      const j = (await r.json()) as { error?: string };
      detail = j.error ?? "";
    } catch {
      detail = await r.text();
    }
    throw new Error(detail || `读取历史失败（HTTP ${r.status}）`);
  }
  const data = (await r.json()) as { entries?: SavedScoreSnapshot[] };
  return Array.isArray(data.entries) ? data.entries : [];
}

export function downloadSnapshotJson(
  snapshot: SavedScoreSnapshot,
  filename: string,
): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadBundleJson(
  bundle: ScoreHistoryExportFile,
  filename: string,
): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

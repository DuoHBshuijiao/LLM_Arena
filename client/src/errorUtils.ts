/** 评测流水线等场景：把底层异常转成用户可读、且不会撑爆界面的文案 */
export function userFacingEvaluationError(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") {
    return "已取消";
  }
  const msg = e instanceof Error ? e.message : String(e);
  const trimmed = msg.trim();
  if (!trimmed) {
    return "发生未知错误，请重试。";
  }
  if (
    /failed to fetch|networkerror|network error|load failed|err_network|econnrefused/i.test(
      trimmed,
    )
  ) {
    return "网络请求失败：请检查网络，并确认本地代理已启动（例如在项目根目录执行 npm run dev）。";
  }
  const max = 2000;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 线程 / 图表人工分输入：钳制到 0–10，步长 0.5 由调用方处理 */
export function clampScore10(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(10, Math.max(0, n));
}

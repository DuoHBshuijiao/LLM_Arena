/** 与 server/index.mjs 中 normalizeProxyBase 一致，避免重复 /v1 */
export function normalizeProxyBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (u.endsWith("/v1")) {
    u = u.slice(0, -3).replace(/\/+$/, "");
  }
  return u;
}

/** 仅一条本地代理路径，避免把「上游 502」误当成「换条本地路径再试」 */
const MODEL_PROXY_PATH = "/api/proxy/v1/models";

function tryParseJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessageFromBody(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const o = json as Record<string, unknown>;
  const err = o.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  if (typeof o.message === "string") return o.message;
  return undefined;
}

function extractModelIds(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const o = json as Record<string, unknown>;
  const rawList =
    (Array.isArray(o.data) ? o.data : null) ??
    (Array.isArray(o.models) ? o.models : null) ??
    (Array.isArray(o.model_ids) ? o.model_ids.map((id) => ({ id })) : null);
  if (!Array.isArray(rawList)) return [];
  const ids: string[] = [];
  for (const item of rawList) {
    if (typeof item === "string") {
      ids.push(item);
    } else if (typeof item === "object" && item !== null && "id" in item) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return [...new Set(ids)].filter(Boolean);
}

function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (a.aborted || b.aborted) {
    forward();
    return controller.signal;
  }
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return controller.signal;
}

/** 经本地代理拉取模型 ID */
export async function fetchModelsList(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const normalized = normalizeProxyBaseUrl(baseUrl);
  const headers: Record<string, string> = {
    "X-Proxy-Base-URL": normalized,
    ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const timeoutMs = 45_000;
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs);
  const combined = combineAbortSignals(signal, timeoutController.signal);

  const tryPaths = [MODEL_PROXY_PATH, "/api/proxy/models"];

  try {
    for (let i = 0; i < tryPaths.length; i++) {
      const path = tryPaths[i];
      const res = await fetch(path, { method: "GET", headers, signal: combined });
      const text = await res.text();

      const parsed = tryParseJson(text);
      const fromApi = parsed !== undefined ? errorMessageFromBody(parsed) : undefined;

      /* 上游无列表：服务端返回 502 + JSON，或旧版返回 404 + JSON — 一律展示 error.message，不换本地路径 */
      if (!res.ok && fromApi) {
        throw new Error(fromApi);
      }

      /* 仅当明显是「本地 Express 未注册该路由」时再试备用路径 */
      const looksLikeLocalRouteMissing =
        res.status === 404 &&
        (text.includes("Cannot GET") ||
          text.includes("<!DOCTYPE") ||
          text.includes("<html"));

      if (looksLikeLocalRouteMissing && i < tryPaths.length - 1) {
        continue;
      }

      if (!res.ok) {
        throw new Error(
          text.slice(0, 800) || `HTTP ${res.status}（${path}）`,
        );
      }

      if (!parsed) {
        throw new Error(text.slice(0, 500) || "无法解析 JSON");
      }

      const ids = extractModelIds(parsed);
      if (ids.length === 0) {
        throw new Error(
          "响应中未找到模型列表（支持 data / models / model_ids 数组）。",
        );
      }
      return ids.sort((a, b) => a.localeCompare(b));
    }

    throw new Error("拉取模型列表失败");
  } finally {
    clearTimeout(timeoutId);
  }
}

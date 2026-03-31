import cors from "cors";
import express from "express";

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "8mb" }));

/**
 * 用户填写的 Base URL 可能已含 `/v1` 或仅到域名。
 * 统一成「不含尾部斜杠、不含末尾 /v1」的根，再由本服务拼接路径。
 */
function normalizeProxyBase(raw) {
  let u = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (u.endsWith("/v1")) {
    u = u.slice(0, -3).replace(/\/+$/, "");
  }
  return u;
}

/** 常见 OpenAI 兼容路径（优先标准 /v1/...） */
const CHAT_COMPLETION_PATHS = [
  "/v1/chat/completions",
  "/chat/completions",
];

/** 上游模型列表（在 normalize 后的 base 上拼接） */
const MODELS_LIST_PATHS = ["/v1/models", "/api/v1/models", "/models"];

/** OpenAI-compatible streaming proxy — 若首条路径 404 则尝试其它 chat 路径 */
app.post("/proxy/v1/chat/completions", async (req, res) => {
  const raw = req.headers["x-proxy-base-url"];
  const baseUrl = normalizeProxyBase(raw);
  if (!baseUrl) {
    res.status(400).json({ error: "Missing X-Proxy-Base-URL header" });
    return;
  }

  const authorization = req.headers.authorization;
  const payload = { ...req.body, stream: true };
  const headers = {
    "Content-Type": "application/json",
    ...(authorization ? { Authorization: authorization } : {}),
  };

  let upstream = null;
  let last404Body = "";

  for (const path of CHAT_COMPLETION_PATHS) {
    const url = `${baseUrl}${path}`;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: "Upstream fetch failed", detail: msg });
      return;
    }
    if (upstream.status !== 404) {
      break;
    }
    last404Body = await upstream.text();
  }

  if (!upstream || upstream.status === 404) {
    res.status(404).type("application/json").send(
      JSON.stringify({
        error: {
          message: `上游未找到 chat 接口（已尝试：${CHAT_COMPLETION_PATHS.join(", ")}）。最后 404 片段：${last404Body.slice(0, 400)}`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  res.status(upstream.status);

  if (!upstream.body) {
    const text = await upstream.text();
    res.send(text);
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    res.send(text);
    return;
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    if (!res.headersSent) res.status(502);
    res.end();
    return;
  }
  res.end();
});

async function handleModelsList(req, res) {
  const raw = req.headers["x-proxy-base-url"];
  const baseUrl = normalizeProxyBase(raw);
  if (!baseUrl) {
    res.status(400).json({ error: "Missing X-Proxy-Base-URL header" });
    return;
  }

  const authorization = req.headers.authorization;
  const hdr = {
    ...(authorization ? { Authorization: authorization } : {}),
  };

  let saw404 = false;
  let lastErr = null;

  for (const path of MODELS_LIST_PATHS) {
    const url = `${baseUrl}${path}`;
    try {
      const r = await fetch(url, { method: "GET", headers: hdr });
      if (r.status !== 404) {
        const text = await r.text();
        res.status(r.status);
        const ct = r.headers.get("content-type");
        if (ct) res.setHeader("Content-Type", ct);
        res.send(text);
        return;
      }
      saw404 = true;
      await r.text();
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  if (lastErr) {
    res.status(502).json({ error: "Upstream fetch failed", detail: lastErr });
    return;
  }

  /* 用 502 而非 404，避免浏览器端把「上游无此接口」误判成「本地代理路由不存在」 */
  if (saw404) {
    res.status(502).type("application/json").send(
      JSON.stringify({
        error: {
          message: `上游未找到模型列表（已尝试：${MODELS_LIST_PATHS.join(", ")}）。请把 Base URL 填成网关根地址（能拼出 /v1/chat/completions 的那一段）；若厂商不提供列表 API，请改用其它方式记下 model id 后手动在界面外维护（本工具依赖 OpenAI 兼容 GET 模型列表）。`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  res.status(502).json({ error: "No upstream response" });
}

app.get("/proxy/v1/models", handleModelsList);
/** 兼容旧路由或省略 v1 的代理配置 */
app.get("/proxy/models", handleModelsList);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[llm-arena] proxy http://localhost:${PORT}`);
});

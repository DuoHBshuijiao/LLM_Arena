import cors from "cors";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录下的 data/scores（与 server 目录同级） */
const SCORES_DIR = path.resolve(__dirname, "..", "data", "scores");

const PORT = Number(process.env.PORT) || 9400;
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

  /**
   * 须在「上游 fetch 已返回」后再监听客户端断开。
   * 若在 await fetch(上游) 之前就 req.on('close')，某些环境（Vite 反代、连接复用等）
   * 会在仍等待上游首包时误触发 close，导致 AbortSignal 取消 fetch，报
   * "This operation was aborted"；而 GET /models 很快结束不易复现。
   */
  const upstreamAbort = new AbortController();
  const onClientGone = () => upstreamAbort.abort();

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
        signal: upstreamAbort.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[proxy] upstream fetch failed:", url, msg);
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

  req.on("close", onClientGone);
  req.on("aborted", onClientGone);

  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  res.status(upstream.status);

  if (!upstream.body) {
    const text = await upstream.text();
    res.send(text);
    req.off("close", onClientGone);
    req.off("aborted", onClientGone);
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    res.send(text);
    req.off("close", onClientGone);
    req.off("aborted", onClientGone);
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
    req.off("close", onClientGone);
    req.off("aborted", onClientGone);
    return;
  }
  req.off("close", onClientGone);
  req.off("aborted", onClientGone);
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

/** 成绩快照：写入 data/scores/{id}.json */
app.post("/scores", async (req, res) => {
  try {
    const snapshot = req.body;
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      typeof snapshot.id !== "string" ||
      !snapshot.id.trim()
    ) {
      res.status(400).json({ error: "Invalid snapshot: missing id" });
      return;
    }
    await fs.mkdir(SCORES_DIR, { recursive: true });
    const safeName = `${snapshot.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
    const filePath = path.join(SCORES_DIR, safeName);
    await fs.writeFile(
      filePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    res.json({ ok: true, id: snapshot.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[scores] POST failed:", msg);
    res.status(500).json({ error: msg });
  }
});

app.get("/scores", async (_req, res) => {
  try {
    await fs.mkdir(SCORES_DIR, { recursive: true });
    let names = [];
    try {
      names = await fs.readdir(SCORES_DIR);
    } catch {
      names = [];
    }
    const jsonFiles = names.filter((n) => n.endsWith(".json"));
    const entries = [];
    for (const name of jsonFiles) {
      try {
        const raw = await fs.readFile(path.join(SCORES_DIR, name), "utf8");
        entries.push(JSON.parse(raw));
      } catch (e) {
        console.warn("[scores] skip invalid file:", name, e);
      }
    }
    entries.sort((a, b) => (b?.savedAt ?? 0) - (a?.savedAt ?? 0));
    res.json({ entries });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[scores] GET failed:", msg);
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`[llm-arena] proxy http://localhost:${PORT}`);
  console.log(`[llm-arena] score snapshots dir: ${SCORES_DIR}`);
});

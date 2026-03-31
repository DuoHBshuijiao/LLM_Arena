import cors from "cors";
import express from "express";

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "8mb" }));

/** OpenAI-compatible streaming proxy (generation, judge, aggregator — all stream: true). */
app.post("/proxy/v1/chat/completions", async (req, res) => {
  const raw = req.headers["x-proxy-base-url"];
  const baseUrl = typeof raw === "string" ? raw.replace(/\/$/, "") : "";
  if (!baseUrl) {
    res.status(400).json({ error: "Missing X-Proxy-Base-URL header" });
    return;
  }

  const authorization = req.headers.authorization;
  const url = `${baseUrl}/v1/chat/completions`;
  const payload = { ...req.body, stream: true };

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({ error: "Upstream fetch failed", detail: msg });
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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[llm-arena] proxy http://localhost:${PORT}`);
});

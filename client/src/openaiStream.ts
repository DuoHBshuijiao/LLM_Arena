import type { ChatCompletionCreateParams } from "./openaiTypes";
import { normalizeProxyBaseUrl } from "./apiModels";
import {
  createInlineThinkingState,
  flushInlineThinking,
  parseInlineThinkingFull,
  processInlineThinkingChunk,
  stripCompleteRedactedThinking,
} from "./inlineThinking";

const PROXY_PATH = "/api/proxy/v1/chat/completions";

/** 本地代理 4xx/502 常返回 JSON，把 detail 展示给用户便于排查网络/Base URL */
function messageFromProxyErrorBody(text: string, status: number): string {
  const trimmed = text.trim();
  let detail = "";
  let main = "";
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof j.detail === "string") detail = j.detail;
    const err = j.error;
    if (typeof err === "string") main = err;
    else if (err && typeof err === "object" && err !== null && "message" in err) {
      const m = (err as { message?: unknown }).message;
      if (typeof m === "string") main = m;
    }
    if (typeof j.message === "string" && !main) main = j.message;
  } catch {
    /* 非 JSON */
  }
  if (main || detail) {
    const s = [main, detail].filter(Boolean).join(": ");
    return s.slice(0, 2000) || `HTTP ${status}`;
  }
  return trimmed.slice(0, 2000) || `HTTP ${status}`;
}

export type StreamRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: StreamRole;
  content: string;
}

export interface StreamDelta {
  content: string;
  reasoning: string;
}

function deltaReasoningPiece(delta: Record<string, unknown>): string {
  const r = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (typeof r === "string") return r;
  if (
    r &&
    typeof r === "object" &&
    "text" in r &&
    typeof (r as { text: unknown }).text === "string"
  ) {
    return (r as { text: string }).text;
  }
  return "";
}

/** OpenAI 兼容：content 可为 string 或 [{ type, text }] */
function deltaStringContent(delta: Record<string, unknown>): string {
  const c = delta.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const part of c) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const t = typeof p.type === "string" ? p.type.toLowerCase() : "";
    if (t === "reasoning" || t === "thinking") continue;
    const text = typeof p.text === "string" ? p.text : "";
    out += text;
  }
  return out;
}

function reasoningFromContentArray(delta: Record<string, unknown>): string {
  const c = delta.content;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const part of c) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const t = typeof p.type === "string" ? p.type.toLowerCase() : "";
    if (t !== "reasoning" && t !== "thinking") continue;
    const text = typeof p.text === "string" ? p.text : "";
    out += text;
  }
  return out;
}

function emitDelta(
  onDelta: (chunk: StreamDelta) => void,
  fullContent: { v: string },
  fullReasoning: { v: string },
  content: string,
  reasoning: string,
): void {
  if (content) {
    fullContent.v += content;
    onDelta({ content, reasoning: "" });
  }
  if (reasoning) {
    fullReasoning.v += reasoning;
    onDelta({ content: "", reasoning });
  }
}

/** Accumulate assistant delta text + reasoning from OpenAI-compatible SSE. */
export async function streamChat(
  baseUrl: string,
  apiKey: string,
  body: Omit<ChatCompletionCreateParams, "stream">,
  onDelta: (chunk: StreamDelta) => void,
  signal?: AbortSignal,
): Promise<StreamDelta> {
  const res = await fetch(PROXY_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Base-URL": normalizeProxyBaseUrl(baseUrl),
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  return readSSEText(res, onDelta, signal);
}

async function readSSEText(
  res: Response,
  onDelta: (chunk: StreamDelta) => void,
  signal?: AbortSignal,
): Promise<StreamDelta> {
  const fullContent = { v: "" };
  const fullReasoning = { v: "" };

  if (!res.body) {
    const t = await res.text();
    if (!res.ok) throw new Error(messageFromProxyErrorBody(t, res.status));
    const parsed = parseInlineThinkingFull(t);
    return { content: parsed.content, reasoning: parsed.reasoning };
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(messageFromProxyErrorBody(t, res.status));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const inlineAcc = createInlineThinkingState();

  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{
              delta?: Record<string, unknown>;
            }>;
          };
          const delta = json.choices?.[0]?.delta;
          if (!delta || typeof delta !== "object") continue;
          const d = delta as Record<string, unknown>;
          const rawContent = deltaStringContent(d);
          const split = processInlineThinkingChunk(rawContent, inlineAcc);
          emitDelta(onDelta, fullContent, fullReasoning, split.content, split.reasoning);

          const fromArray = reasoningFromContentArray(d);
          const fromFields = deltaReasoningPiece(d);
          emitDelta(onDelta, fullContent, fullReasoning, "", fromArray + fromFields);
        } catch {
          /* ignore partial JSON lines */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const tail = flushInlineThinking(inlineAcc);
  emitDelta(onDelta, fullContent, fullReasoning, tail.content, tail.reasoning);

  {
    const s = stripCompleteRedactedThinking(fullContent.v);
    fullContent.v = s.content;
    if (s.reasoning) {
      fullReasoning.v = fullReasoning.v
        ? `${fullReasoning.v}\n${s.reasoning}`
        : s.reasoning;
    }
  }

  return { content: fullContent.v, reasoning: fullReasoning.v };
}

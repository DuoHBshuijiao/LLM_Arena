import type { ChatCompletionCreateParams } from "./openaiTypes";
import { normalizeProxyBaseUrl } from "./apiModels";

const PROXY_PATH = "/api/proxy/v1/chat/completions";

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
  return typeof r === "string" ? r : "";
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

  const out = await readSSEText(res, onDelta);
  if (!res.ok) {
    throw new Error(
      (out.content + out.reasoning).slice(0, 2000) || `HTTP ${res.status}`,
    );
  }
  return out;
}

async function readSSEText(
  res: Response,
  onDelta: (chunk: StreamDelta) => void,
): Promise<StreamDelta> {
  let fullContent = "";
  let fullReasoning = "";

  if (!res.body) {
    const t = await res.text();
    if (!res.ok) throw new Error(t.slice(0, 2000) || `HTTP ${res.status}`);
    return { content: t, reasoning: "" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
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
          const content =
            typeof d.content === "string" ? d.content : "";
          const reasoning = deltaReasoningPiece(d);
          if (content) {
            fullContent += content;
            onDelta({ content, reasoning: "" });
          }
          if (reasoning) {
            fullReasoning += reasoning;
            onDelta({ content: "", reasoning });
          }
        } catch {
          /* ignore partial JSON lines */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!res.ok) {
    throw new Error(
      (fullContent + fullReasoning).slice(0, 2000) || `HTTP ${res.status}`,
    );
  }
  return { content: fullContent, reasoning: fullReasoning };
}

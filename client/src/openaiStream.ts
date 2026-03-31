import type { ChatCompletionCreateParams } from "./openaiTypes";

const PROXY_PATH = "/api/proxy/v1/chat/completions";

export type StreamRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: StreamRole;
  content: string;
}

/** Accumulate assistant delta text from OpenAI-compatible SSE. */
export async function streamChat(
  baseUrl: string,
  apiKey: string,
  body: Omit<ChatCompletionCreateParams, "stream">,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(PROXY_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Base-URL": baseUrl.replace(/\/$/, ""),
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  const text = await readSSEText(res, onDelta);
  if (!res.ok) {
    throw new Error(text.slice(0, 2000) || `HTTP ${res.status}`);
  }
  return text;
}

async function readSSEText(
  res: Response,
  onDelta: (chunk: string) => void,
): Promise<string> {
  if (!res.body) {
    const t = await res.text();
    if (!res.ok) throw new Error(t.slice(0, 2000) || `HTTP ${res.status}`);
    return t;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

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
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const piece = json.choices?.[0]?.delta?.content ?? "";
          if (piece) {
            full += piece;
            onDelta(piece);
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
    throw new Error(full.slice(0, 2000) || `HTTP ${res.status}`);
  }
  return full;
}

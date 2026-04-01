/**
 * 将流式 delta.content 中内联的 <redacted_thinking>...</redacted_thinking>
 * 拆到 reasoning 侧，避免污染正文；支持分片跨 chunk 的标签边界。
 * 开标签允许属性：<redacted_thinking foo="bar">。
 */

const OPEN_TAG_PREFIX = "<redacted_thinking";
const OPEN_AT_START = /^<redacted_thinking\b[^>]*>/i;
const CLOSE_RE = /<\/redacted_thinking>/i;

const OPEN_LOWER = "<redacted_thinking>";
const CLOSE_LOWER = "</redacted_thinking>";

/** 完整闭合块：用于流结束后的兜底，防止漏进 judge / 聚合 */
const REDACTED_BLOCK_RE =
  /<redacted_thinking\b[^>]*>([\s\S]*?)<\/redacted_thinking>/gi;

export interface InlineThinkingState {
  buf: string;
  inThinking: boolean;
}

export function createInlineThinkingState(): InlineThinkingState {
  return { buf: "", inThinking: false };
}

/** 最长后缀长度：可能是 OPEN_LOWER 的不完整前缀，暂不输出 */
function holdSuffix(buf: string, targetLower: string): number {
  const b = buf.toLowerCase();
  let max = 0;
  for (
    let len = Math.min(buf.length, targetLower.length - 1);
    len >= 1;
    len--
  ) {
    if (targetLower.startsWith(b.slice(-len))) max = len;
  }
  return max;
}

/** 缓冲区末尾可能是不完整的开标签（含属性），暂不输出 */
function holdIncompleteOpenTag(buf: string): number {
  const lower = buf.toLowerCase();
  let pos = 0;
  let lastIncompleteStart = -1;
  for (;;) {
    const idx = lower.indexOf(OPEN_TAG_PREFIX, pos);
    if (idx === -1) break;
    const rest = buf.slice(idx);
    const m = rest.match(OPEN_AT_START);
    if (m) {
      pos = idx + m[0].length;
      continue;
    }
    lastIncompleteStart = idx;
    break;
  }
  if (lastIncompleteStart !== -1) return buf.length - lastIncompleteStart;
  return 0;
}

function emissionHoldPlain(buf: string): number {
  return Math.max(
    holdSuffix(buf, OPEN_LOWER),
    holdSuffix(buf, OPEN_TAG_PREFIX + ">"),
    holdIncompleteOpenTag(buf),
  );
}

/** 非流式或流结束兜底：按正则剥离所有完整闭合块，正文外内容并入 reasoning */
export function stripCompleteRedactedThinking(text: string): {
  content: string;
  reasoning: string;
} {
  REDACTED_BLOCK_RE.lastIndex = 0;
  const parts: string[] = [];
  const content = text.replace(REDACTED_BLOCK_RE, (_full, inner: string) => {
    parts.push(inner);
    return "";
  });
  return {
    content,
    reasoning: parts.join("\n"),
  };
}

export function processInlineThinkingChunk(
  chunk: string,
  acc: InlineThinkingState,
): { content: string; reasoning: string } {
  acc.buf += chunk;
  let outContent = "";
  let outReasoning = "";

  while (acc.buf.length > 0) {
    if (!acc.inThinking) {
      const lower = acc.buf.toLowerCase();
      const idx = lower.indexOf(OPEN_TAG_PREFIX);
      if (idx === -1) {
        const hold = emissionHoldPlain(acc.buf);
        const emitLen = acc.buf.length - hold;
        if (emitLen > 0) {
          outContent += acc.buf.slice(0, emitLen);
          acc.buf = acc.buf.slice(emitLen);
        }
        break;
      }
      outContent += acc.buf.slice(0, idx);
      acc.buf = acc.buf.slice(idx);
      const m = acc.buf.match(OPEN_AT_START);
      if (!m) break;
      acc.buf = acc.buf.slice(m[0].length);
      acc.inThinking = true;
      continue;
    }

    const lower = acc.buf.toLowerCase();
    const idx = lower.indexOf(CLOSE_LOWER);
    if (idx === -1) {
      const hold = holdSuffix(acc.buf, CLOSE_LOWER);
      const emitLen = acc.buf.length - hold;
      if (emitLen > 0) {
        outReasoning += acc.buf.slice(0, emitLen);
        acc.buf = acc.buf.slice(emitLen);
      }
      break;
    }
    outReasoning += acc.buf.slice(0, idx);
    acc.buf = acc.buf.slice(idx);
    const m = acc.buf.match(CLOSE_RE);
    if (!m || m.index !== 0) break;
    acc.buf = acc.buf.slice(m[0].length);
    acc.inThinking = false;
  }

  return { content: outContent, reasoning: outReasoning };
}

/** 流结束：缓冲区剩余全部按当前模式计入正文或思考 */
export function flushInlineThinking(acc: InlineThinkingState): {
  content: string;
  reasoning: string;
} {
  if (acc.buf.length === 0) {
    return { content: "", reasoning: "" };
  }
  if (!acc.inThinking) {
    const c = acc.buf;
    acc.buf = "";
    return { content: c, reasoning: "" };
  }
  const r = acc.buf;
  acc.buf = "";
  return { content: "", reasoning: r };
}

/** 非流式整段解析（如无 body 时的一次性响应） */
export function parseInlineThinkingFull(text: string): {
  content: string;
  reasoning: string;
} {
  return stripCompleteRedactedThinking(text);
}

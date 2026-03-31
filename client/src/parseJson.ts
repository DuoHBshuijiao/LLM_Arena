import type { ParsedScore } from "./types";

/** Extract JSON object from model output (markdown fence or first `{...}`). */
export function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{")) return inner;
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJudgeScore(text: string): { parsed?: ParsedScore; error?: string } {
  const raw = extractJsonObject(text);
  if (!raw) return { error: "未找到 JSON" };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const overall =
      typeof obj.overall === "number"
        ? obj.overall
        : typeof obj.score === "number"
          ? obj.score
          : undefined;
    let dimensions: Record<string, number> | undefined;
    if (obj.dimensions && typeof obj.dimensions === "object" && obj.dimensions !== null) {
      dimensions = {};
      for (const [k, v] of Object.entries(obj.dimensions as Record<string, unknown>)) {
        if (typeof v === "number") dimensions[k] = v;
      }
    }
    return { parsed: { overall, dimensions, raw: obj } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function parseAggregatorScore(text: string): { parsed?: ParsedScore; error?: string } {
  return parseJudgeScore(text);
}

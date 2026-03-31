import pLimit from "p-limit";
import { streamChat } from "./openaiStream";
import { parseAggregatorScore, parseJudgeScore } from "./parseJson";
import type {
  GenerationResult,
  GlobalSettings,
  JudgeRunResult,
  RunSession,
} from "./types";

function upsertJudgeRun(
  runs: JudgeRunResult[],
  judgeId: string,
  judgeName: string,
  reviewIndex: number,
  rawText: string,
  parsed?: import("./types").ParsedScore,
  parseError?: string,
): JudgeRunResult[] {
  const key = `${judgeId}:${reviewIndex}`;
  const rest = runs.filter((r) => `${r.judgeId}:${r.reviewIndex}` !== key);
  rest.push({
    judgeId,
    judgeName,
    reviewIndex,
    rawText,
    parsed,
    parseError,
  });
  rest.sort((a, b) => {
    const c = a.judgeId.localeCompare(b.judgeId);
    if (c !== 0) return c;
    return a.reviewIndex - b.reviewIndex;
  });
  return rest;
}

export async function executeEvaluation(
  settings: GlobalSettings,
  prompt: string,
  onUpdate: (s: RunSession) => void,
  signal: AbortSignal,
): Promise<void> {
  const base: RunSession = {
    id: crypto.randomUUID(),
    prompt,
    startedAt: Date.now(),
    phase: "generating",
    generations: [],
  };

  const tasks: { modelId: string; sampleIndex: number }[] = [];
  for (const m of settings.models) {
    for (let i = 0; i < Math.max(1, m.sampleCount); i++) {
      tasks.push({ modelId: m.modelId, sampleIndex: i });
    }
  }

  const gens: GenerationResult[] = tasks.map((t) => ({
    id: crypto.randomUUID(),
    modelId: t.modelId,
    sampleIndex: t.sampleIndex,
    text: "",
    judgeRuns: [],
    aggregateText: "",
  }));

  onUpdate({ ...base, generations: [...gens] });

  const limit = pLimit(Math.max(1, settings.concurrency));

  await Promise.all(
    tasks.map((t, i) =>
      limit(async () => {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        let text = "";
        await streamChat(
          settings.baseUrl,
          settings.apiKey,
          {
            model: t.modelId,
            messages: [{ role: "user", content: prompt }],
            temperature: settings.temperature,
            max_tokens: settings.maxTokens,
            top_p: settings.topP,
          },
          (c) => {
            text += c;
            const next = gens.map((g, gi) =>
              gi === i ? { ...g, text } : g,
            );
            onUpdate({
              ...base,
              phase: "generating",
              generations: next,
              streamPreview: text.slice(-600),
            });
          },
          signal,
        );
        gens[i] = { ...gens[i], text };
        onUpdate({
          ...base,
          phase: "generating",
          generations: [...gens],
        });
      }),
    ),
  );

  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  onUpdate({ ...base, phase: "judging", generations: [...gens], streamPreview: undefined });

  for (let gi = 0; gi < gens.length; gi++) {
    for (const judge of settings.judges) {
      for (let r = 0; r < Math.max(1, judge.reviewCount); r++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const userContent = judge.userPromptTemplate.replace(
          /\{\{candidate\}\}/g,
          gens[gi].text,
        );
        let jr = "";
        await streamChat(
          settings.baseUrl,
          settings.apiKey,
          {
            model: judge.model,
            messages: [
              { role: "system", content: judge.systemPrompt },
              { role: "user", content: userContent },
            ],
            temperature: settings.temperature,
            max_tokens: settings.maxTokens,
            top_p: settings.topP,
          },
          (c) => {
            jr += c;
            const cur = gens[gi];
            const runs = upsertJudgeRun(
              cur.judgeRuns,
              judge.id,
              judge.name,
              r,
              jr,
            );
            gens[gi] = { ...cur, judgeRuns: runs };
            onUpdate({
              ...base,
              phase: "judging",
              generations: [...gens],
              streamPreview: jr.slice(-500),
            });
          },
          signal,
        );
        const pr = parseJudgeScore(jr);
        gens[gi] = {
          ...gens[gi],
          judgeRuns: upsertJudgeRun(
            gens[gi].judgeRuns,
            judge.id,
            judge.name,
            r,
            jr,
            pr.parsed,
            pr.error,
          ),
        };
        onUpdate({ ...base, phase: "judging", generations: [...gens] });
      }
    }
  }

  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  if (!settings.aggregator.enabled) {
    onUpdate({
      ...base,
      phase: "done",
      generations: [...gens],
      streamPreview: undefined,
    });
    return;
  }

  onUpdate({ ...base, phase: "aggregating", generations: [...gens], streamPreview: undefined });

  for (let gi = 0; gi < gens.length; gi++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const g = gens[gi];
    const reviewsText = g.judgeRuns
      .map(
        (jr) =>
          `[${jr.judgeName} #${jr.reviewIndex + 1}]\n${jr.rawText}`,
      )
      .join("\n\n---\n\n");
    const userContent = settings.aggregator.userPromptTemplate
      .replace(/\{\{candidate\}\}/g, g.text)
      .replace(/\{\{reviews\}\}/g, reviewsText);

    let agg = "";
    await streamChat(
      settings.baseUrl,
      settings.apiKey,
      {
        model: settings.aggregator.model,
        messages: [
          { role: "system", content: settings.aggregator.systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        top_p: settings.topP,
      },
      (c) => {
        agg += c;
        const pr = parseAggregatorScore(agg);
        gens[gi] = {
          ...gens[gi],
          aggregateText: agg,
          aggregateParsed: pr.parsed,
          aggregateParseError: pr.error,
        };
        onUpdate({
          ...base,
          phase: "aggregating",
          generations: [...gens],
          streamPreview: agg.slice(-500),
        });
      },
      signal,
    );
    const pr = parseAggregatorScore(agg);
    gens[gi] = {
      ...gens[gi],
      aggregateText: agg,
      aggregateParsed: pr.parsed,
      aggregateParseError: pr.error,
    };
    onUpdate({ ...base, phase: "aggregating", generations: [...gens] });
  }

  onUpdate({
    ...base,
    phase: "done",
    generations: [...gens],
    streamPreview: undefined,
  });
}

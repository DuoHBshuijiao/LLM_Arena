export interface ModelEntry {
  id: string;
  modelId: string;
  sampleCount: number;
}

export interface JudgeConfig {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
  reviewCount: number;
}

export interface AggregatorConfig {
  enabled: boolean;
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
}

export interface GlobalSettings {
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  concurrency: number;
  models: ModelEntry[];
  judges: JudgeConfig[];
  aggregator: AggregatorConfig;
}

export interface ParsedScore {
  overall?: number;
  dimensions?: Record<string, number>;
  raw?: Record<string, unknown>;
}

export interface JudgeRunResult {
  judgeId: string;
  judgeName: string;
  reviewIndex: number;
  rawText: string;
  parsed?: ParsedScore;
  parseError?: string;
}

export interface GenerationResult {
  id: string;
  modelId: string;
  sampleIndex: number;
  text: string;
  judgeRuns: JudgeRunResult[];
  aggregateText: string;
  aggregateParsed?: ParsedScore;
  aggregateParseError?: string;
}

export type RunPhase =
  | "idle"
  | "generating"
  | "judging"
  | "aggregating"
  | "done"
  | "error";

export interface RunSession {
  id: string;
  prompt: string;
  startedAt: number;
  phase: RunPhase;
  generations: GenerationResult[];
  error?: string;
  /** Live progress text for current streaming op */
  streamPreview?: string;
}

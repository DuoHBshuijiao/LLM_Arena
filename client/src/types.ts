/** 可命名的厂商 API 预设（Base URL + Key） */
export interface ApiPreset {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 该预设下同时进行的流式请求上限（参赛 / Judge / 汇总共用） */
  concurrency: number;
  /** 手动保存的模型 ID，与「获取模型列表」结果合并到下拉框 */
  manualModelIds: string[];
  /** 最近一次「获取模型列表」成功返回的 ID（持久化，与手动列表一并展示为标签） */
  fetchedModelIds: string[];
}

export interface ModelEntry {
  id: string;
  /** 使用哪一套 API 预设 */
  presetId: string;
  modelId: string;
  sampleCount: number;
}

export interface JudgeConfig {
  id: string;
  name: string;
  presetId: string;
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
  reviewCount: number;
}

export interface AggregatorConfig {
  enabled: boolean;
  presetId: string;
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
}

export interface GlobalSettings {
  apiPresets: ApiPreset[];
  /** 留空则不传给 API，由上游默认值决定 */
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  models: ModelEntry[];
  judges: JudgeConfig[];
  aggregator: AggregatorConfig;
  /** 运行页评测题目全文（持久化） */
  taskPrompt: string;
  /** 当前选中的内置评测命题预设 ID（诗歌 / 算法设计 / 数学 / 硬件优化等） */
  evaluationPresetId: string;
}

export interface JudgeRunResult {
  judgeId: string;
  judgeName: string;
  reviewIndex: number;
  /** 评委输出正文（传给汇总，不含思考） */
  rawText: string;
  /** 思考过程（展示用，不传下游） */
  reasoningText?: string;
}

/** 单条生成线程在流水线中的阶段 */
export type ThreadPhase =
  | "generating"
  | "judging"
  | "aggregating"
  | "done";

export interface GenerationResult {
  id: string;
  modelId: string;
  sampleIndex: number;
  /** 模型回答正文（传给 Judge/汇总，不含思考） */
  text: string;
  /** 思考内容（展示用） */
  reasoningText?: string;
  judgeRuns: JudgeRunResult[];
  /** 汇总正文 */
  aggregateText: string;
  /** 汇总思考（展示用） */
  aggregateReasoningText?: string;
  threadPhase: ThreadPhase;
}

/** 单线程人工填分：每个评委一条 + 人类分 */
export interface ThreadScoreInput {
  judgeScores: Record<string, number | undefined>;
  human?: number;
}

/** 分数计算器：各评委（Judge）填分权重 + 人类分权重（均 0.1–1） */
export interface BlendWeights {
  judgeWeights: Record<string, number>;
  humanWeight: number;
}

export type RunPhase =
  | "idle"
  | "running"
  | "done"
  | "error";

export interface RunSession {
  id: string;
  prompt: string;
  startedAt: number;
  phase: RunPhase;
  generations: GenerationResult[];
  error?: string;
}

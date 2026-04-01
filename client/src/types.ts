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

/** 用户自定义评测命题（名称可改，题目正文持久化在本条内） */
export interface CustomEvaluationPresetEntry {
  id: string;
  name: string;
  taskPrompt: string;
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
  /** 当前选中的评测命题预设 ID（内置含诗歌、算法、数学、硬件优化、命题作文等，或自定义） */
  evaluationPresetId: string;
  /** 用户自定义题目列表（内置题不在此列） */
  customEvaluationPresets: CustomEvaluationPresetEntry[];
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
  | "paused"
  | "done"
  | "error";

/** 当前正在流式输出的卡片（用于 UI 角标） */
export type StreamingCard =
  | { kind: "gen" }
  | { kind: "judge"; judgeId: string; reviewIndex: number }
  | { kind: "aggregate" };

/** 流水线失败时的步骤（用于重试与 UI 定位） */
export type FailedPipelineStep =
  | { step: "gen" }
  | { step: "judge"; judgeId: string; reviewIndex: number }
  | { step: "aggregate" };

/** 单线程终态：进行中不填或视为未完成 */
export type ThreadOutcome = "ok" | "error" | "abandoned";

/** 并行 judge 时可能有多个槽位同时流式输出，用于角标（单槽 streamingCard 会竞态） */
export interface JudgeStreamingSlot {
  judgeId: string;
  reviewIndex: number;
}

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
  /** 当前流式卡片（仅运行中有值） */
  streamingCard?: StreamingCard;
  /** 正在流式输出的 judge 槽位（并行 judge 时可能多项） */
  judgeStreamingSlots?: JudgeStreamingSlot[];
  /** 单线程失败时的可读错误 */
  pipelineError?: string;
  /** 失败步骤，供重试 */
  failedPipelineStep?: FailedPipelineStep;
  /** 用户暂停时的步骤，供恢复（与 failedPipelineStep 语义相同） */
  pausedPipelineStep?: FailedPipelineStep;
  /** 单线程终态；未结束时可省略 */
  threadOutcome?: ThreadOutcome;
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

/** 保存成绩 / 历史快照 / 导出 JSON 共用结构 */
export interface ScoreSnapshotComputed {
  /** generation.id -> 单线程综合分 */
  perThread: Record<string, number | undefined>;
  /** modelId -> 本会话按模型均值 */
  byModel: Record<string, number | undefined>;
}

export interface SavedScoreSnapshot {
  /** 导出格式版本，便于以后演进 */
  exportVersion: 1;
  id: string;
  savedAt: number;
  prompt: string;
  session: RunSession;
  threadScores: Record<string, ThreadScoreInput>;
  humanScores: Record<string, number>;
  blendWeights: BlendWeights;
  judgeIds: string[];
  computed: ScoreSnapshotComputed;
}

/** 「下载全部数据」外层包装 */
export interface ScoreHistoryExportFile {
  exportBundleVersion: 1;
  exportedAt: number;
  entries: SavedScoreSnapshot[];
}

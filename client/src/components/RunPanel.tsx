import { useMemo, useState } from "react";
import { clampBlendWeight, sessionWeightedFinal } from "../scoreCalculations";
import { settingsReadyForRun } from "../settingsHelpers";
import type { BlendWeights, GlobalSettings, RunSession, ThreadScoreInput } from "../types";
import { RunCanvas } from "./RunCanvas";

function phaseLabel(phase: string): string {
  switch (phase) {
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "error":
      return "错误";
    case "idle":
      return "空闲";
    default:
      return phase;
  }
}

interface Props {
  settings: GlobalSettings;
  session: RunSession | null;
  threadScores: Record<string, ThreadScoreInput | undefined>;
  blendWeights: BlendWeights;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
  setModelBlendWeight: (modelId: string, w: number) => void;
  setHumanBlendWeight: (w: number) => void;
  onRun: (prompt: string) => void;
  onCancel: () => void;
  onClearSession: () => void;
  running: boolean;
  phase: string;
}

function estimateCalls(s: GlobalSettings): number {
  let gen = 0;
  for (const m of s.models) {
    gen += Math.max(1, m.sampleCount);
  }
  const judgeCalls =
    gen *
    s.judges.reduce(
      (acc, j) => acc + Math.max(1, j.reviewCount),
      0,
    );
  const aggCalls = s.aggregator.enabled ? gen : 0;
  return gen + judgeCalls + aggCalls;
}

export function RunPanel({
  settings,
  session,
  threadScores,
  blendWeights,
  setThreadJudgeScore,
  setThreadHumanScore,
  setModelBlendWeight,
  setHumanBlendWeight,
  onRun,
  onCancel,
  onClearSession,
  running,
  phase,
}: Props) {
  const [prompt, setPrompt] = useState(
    [
      "你是一名后端/基础设施工程师。请完成下面这道与「向量数据库 / 近似最近邻（ANN）检索」相关的算法与系统设计题，要求性能优先、可落地。",
      "",
      "【题目】",
      "为在线推荐场景设计一套向量检索组件：约 500 万条稠密向量（维度 768）、需支持 Top-K（K≤100）近似最近邻查询；峰值 QPS 较高，P99 查询延迟需尽量低；允许一定召回损失以换取速度。",
      "",
      "【请输出】",
      "1）整体架构与关键数据结构（索引类型及选型理由，如 IVF、HNSW、PQ 等，说明取舍）",
      "2）插入、查询、（可选）删除/更新的主流程与伪代码或关键步骤",
      "3）时空复杂度或量级估计，以及为降延迟做的工程优化（批处理、并行、缓存、分片等）",
      "4）增量更新与冷启动、故障降级各一条策略",
      "",
      "请用中文作答，避免空泛概念堆砌，给出可实现的方案。",
    ].join("\n"),
  );
  const est = useMemo(() => estimateCalls(settings), [settings]);
  const ready = useMemo(() => settingsReadyForRun(settings), [settings]);

  const modelIdsForWeights = useMemo(() => {
    const s = new Set<string>();
    for (const m of settings.models) s.add(m.modelId);
    return [...s].sort();
  }, [settings.models]);

  const judgeIds = useMemo(
    () => settings.judges.map((j) => j.id),
    [settings.judges],
  );

  const finalSessionScore = useMemo(() => {
    if (!session?.generations.length) return undefined;
    return sessionWeightedFinal(
      session.generations,
      threadScores,
      judgeIds,
      blendWeights,
    );
  }, [session, threadScores, judgeIds, blendWeights]);

  return (
    <div className="run-page">
      <div className="panel run-page__controls">
        <h2>运行与结果</h2>
        <p className="muted">
          同一条评测提示词按 API 预设的并发上限流式调用：各线程生成完成后立即进入 Judge（多评委限流并行），再按需汇总。并发上限在「设置」的每个 API
          预设中配置，同一预设下的参赛 / Judge / 汇总共享。默认题目为向量库/ANN
          系统设计（性能优先）。评测结束后在线程下方填入人工分数，并在下方用权重计算器得到最终得分（≤10）。
        </p>
        <p className="muted">
          预估 API 调用次数（约）：<strong>{est}</strong>
        </p>

        <div className="field">
          <label>提示词</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={running}
          />
        </div>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-primary"
            disabled={running || !ready}
            onClick={() => onRun(prompt)}
          >
            {running ? "进行中…" : "开始评测"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={!running}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={running}
            onClick={onClearSession}
          >
            清空结果
          </button>
          {(running || session) && (
            <span className="badge">
              {running
                ? `阶段：${phaseLabel(phase)}`
                : `上次阶段：${phaseLabel(session?.phase ?? "idle")}`}
            </span>
          )}
        </div>
        {!ready && (
          <p className="warn">
            请先在「设置」中为各 API 预设填写 Key，并选择参赛模型与 Judge
            / 汇总所用模型（若已拉取列表请从下拉框选择）。
          </p>
        )}
        {session?.error && (
          <p className="warn" style={{ marginTop: "0.5rem" }}>
            {session.error}
          </p>
        )}
        {session && (
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.75rem" }}>
            提示词：<span className="prompt-inline">{session.prompt}</span>
          </p>
        )}

        <div className="score-calculator panel-inset">
          <h3 className="score-calculator__title">分数计算器</h3>
          <p className="muted score-calculator__hint">
            为每个参赛模型与人类分设置权重（0.1–1）。结合各线程底部填入的分数，按权重混合得到单线程综合分；本会话「最终得分」为各线程综合分按模型权重加权平均（≤10）。
          </p>
          {modelIdsForWeights.length === 0 ? (
            <p className="muted">请先在设置中添加参赛模型。</p>
          ) : (
            <div className="score-calculator__grid">
              {modelIdsForWeights.map((mid) => (
                <label key={mid} className="score-calculator__field">
                  <span className="score-calculator__label" title={mid}>
                    模型权重 · {mid.length > 28 ? `${mid.slice(0, 26)}…` : mid}
                  </span>
                  <input
                    type="number"
                    min={0.1}
                    max={1}
                    step={0.1}
                    className="score-calculator__input"
                    value={blendWeights.modelWeights[mid] ?? 1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isNaN(v)) return;
                      setModelBlendWeight(mid, clampBlendWeight(v));
                    }}
                  />
                </label>
              ))}
              <label className="score-calculator__field score-calculator__field--human">
                <span className="score-calculator__label">人类分权重</span>
                <input
                  type="number"
                  min={0.1}
                  max={1}
                  step={0.1}
                  className="score-calculator__input"
                  value={blendWeights.humanWeight}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isNaN(v)) return;
                    setHumanBlendWeight(clampBlendWeight(v));
                  }}
                />
              </label>
            </div>
          )}
          <div className="score-calculator__final">
            <span className="score-calculator__final-label">本会话最终得分</span>
            <strong className="score-calculator__final-value">
              {finalSessionScore !== undefined
                ? `${finalSessionScore.toFixed(2)} / 10`
                : "—（需在线程中填写分数）"}
            </strong>
          </div>
        </div>
      </div>

      <RunCanvas
        session={session}
        settings={settings}
        threadScores={threadScores}
        setThreadJudgeScore={setThreadJudgeScore}
        setThreadHumanScore={setThreadHumanScore}
      />
    </div>
  );
}

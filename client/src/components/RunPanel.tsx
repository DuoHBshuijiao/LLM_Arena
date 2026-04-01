import { useMemo, useState } from "react";
import { uniqueModelIds } from "../chartUtils";
import { averageCompositeByModel, clampBlendWeight } from "../scoreCalculations";
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
      return "失败";
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
  setJudgeBlendWeight: (judgeId: string, w: number) => void;
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
  setJudgeBlendWeight,
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

  const judgeIds = useMemo(
    () => settings.judges.map((j) => j.id),
    [settings.judges],
  );

  const finalScoreByModel = useMemo(() => {
    if (!session?.generations.length) return {};
    return averageCompositeByModel(
      session.generations,
      threadScores,
      judgeIds,
      blendWeights,
    );
  }, [session, threadScores, judgeIds, blendWeights]);

  const modelIdsForFinalRows = useMemo(
    () => (session ? uniqueModelIds(session.generations) : []),
    [session],
  );

  return (
    <div className="run-page">
      <div className="panel run-page__controls">
        <h2>运行与结果</h2>
        <div className="run-page__meta">
          <p className="muted run-page__lede">
            填写提示词后点击「开始评测」。画布按线程展示：生成 → Judge →（若开启）汇总；线程卡片下方填写各评委与人工分，按模型均分可在下方展开「分数计算器」查看。
          </p>
          <p className="muted run-page__est">
            预估 API 调用次数（约）：<strong>{est}</strong>
          </p>
        </div>

        <div className="field">
          <label>提示词</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={running}
          />
        </div>

        <div className="run-page__actions">
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
            请先在「设置」里为每个 API 预设填写 Key，并选好参赛模型以及 Judge /
            汇总模型（若已获取模型列表，请从下拉框选择，勿留空）。
          </p>
        )}
        {session?.error && (
          <p className="warn warn--block" role="alert">
            {session.error}
          </p>
        )}
        {session && (
          <p className="muted run-page__prompt-preview">
            提示词：<span className="prompt-inline">{session.prompt}</span>
          </p>
        )}

        <details className="run-disclosure">
          <summary className="run-disclosure__summary">
            评测流程说明（并发、Judge、汇总与人工分）
          </summary>
          <div className="run-disclosure__body">
            <p className="muted">
              同一条评测提示词按 API 预设的并发上限流式调用：各线程生成完成后立即进入
              Judge（多评委限流并行），再按需汇总。并发上限在「设置」的每个 API
              预设中配置，同一预设下的参赛 / Judge / 汇总共享。默认题目为向量库/ANN
              系统设计（性能优先）。评测结束后在线程下方填入人工分，并在「分数计算器」中查看按模型的最终得分（≤10）。与按模型的整体验收对比见「人工分与图表」标签页。
            </p>
          </div>
        </details>

        <details className="run-disclosure">
          <summary className="run-disclosure__summary">
            分数计算器（评委权重与本会话最终得分）
          </summary>
          <div className="run-disclosure__body run-disclosure__body--calculator">
            <div className="score-calculator">
              <h3 className="score-calculator__title">分数计算器</h3>
              <p className="muted score-calculator__hint">
                为每位评委（Judge）的填分与<strong>人工分</strong>设置权重（0.1–1）。单线程综合分：先按评委权重对各评委分加权平均，再与人工分按权重混合（满分 10）。本会话按<strong>参赛模型</strong>一行一条最终分：同一模型多条线程的综合分取<strong>算术平均</strong>。
              </p>
              <div className="score-calculator__grid">
                {settings.judges.map((j) => (
                  <label key={j.id} className="score-calculator__field">
                    <span className="score-calculator__label" title={j.name}>
                      评委权重 · {j.name.length > 20 ? `${j.name.slice(0, 18)}…` : j.name}
                    </span>
                    <input
                      type="number"
                      min={0.1}
                      max={1}
                      step={0.1}
                      className="score-calculator__input"
                      value={(blendWeights.judgeWeights ?? {})[j.id] ?? 1}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isNaN(v)) return;
                        setJudgeBlendWeight(j.id, clampBlendWeight(v));
                      }}
                    />
                  </label>
                ))}
                <label className="score-calculator__field score-calculator__field--human">
                  <span className="score-calculator__label">人工分权重</span>
                  <input
                    type="number"
                    min={0.1}
                    max={1}
                    step={0.1}
                    className="score-calculator__input"
                    value={blendWeights.humanWeight ?? 1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isNaN(v)) return;
                      setHumanBlendWeight(clampBlendWeight(v));
                    }}
                  />
                </label>
              </div>
              {settings.judges.length === 0 && (
                <p className="muted score-calculator__empty-judges">
                  未配置评委时，仅使用各线程内已填的<strong>人工分</strong>参与综合（若也未填则无分）。
                </p>
              )}
              <div className="score-calculator__final score-calculator__final--table-wrap">
                <div className="score-calculator__final-heading">本会话最终得分（按模型）</div>
                {modelIdsForFinalRows.length === 0 ? (
                  <p className="muted score-calculator__final-empty">
                    完成评测并在线程中填写分数后显示。
                  </p>
                ) : (
                  <table className="score-calculator__final-table">
                    <thead>
                      <tr>
                        <th>参赛模型</th>
                        <th>得分（均值 / 10）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelIdsForFinalRows.map((mid) => {
                        const v = finalScoreByModel[mid];
                        return (
                          <tr key={mid}>
                            <td className="score-calculator__final-model" title={mid}>
                              {mid.length > 36 ? `${mid.slice(0, 34)}…` : mid}
                            </td>
                            <td>
                              {v !== undefined && !Number.isNaN(v)
                                ? v.toFixed(2)
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </details>
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

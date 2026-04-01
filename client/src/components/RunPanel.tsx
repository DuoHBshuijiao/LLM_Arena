import { useMemo } from "react";
import { uniqueModelIds } from "../chartUtils";
import { BUILTIN_EVALUATION_PRESETS } from "../evaluationPresets";
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
  onTaskPromptChange: (taskPrompt: string) => void;
  onEvaluationPresetChange: (presetId: string) => void;
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
  onTaskPromptChange,
  onEvaluationPresetChange,
  running,
  phase,
}: Props) {
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

        <div className="field run-page__preset-field">
          <label htmlFor="run-eval-preset">预设题目（诗歌评测）</label>
          <select
            id="run-eval-preset"
            value={settings.evaluationPresetId}
            onChange={(e) => onEvaluationPresetChange(e.target.value)}
            disabled={running}
          >
            {BUILTIN_EVALUATION_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.description ? ` — ${p.description}` : ""}
              </option>
            ))}
          </select>
          <p className="muted small run-page__preset-hint">
            切换后将载入该题全文并同步评委提示词；可在下方继续微调题目。汇总模型提示词不随此处切换（见「设置」）。
          </p>
        </div>

        <div className="field">
          <label>提示词（评测题目与要求）</label>
          <textarea
            value={settings.taskPrompt}
            onChange={(e) => onTaskPromptChange(e.target.value)}
            disabled={running}
          />
        </div>

        <div className="run-page__actions">
          <button
            type="button"
            className="btn-primary"
            disabled={running || !ready}
            onClick={() => onRun(settings.taskPrompt)}
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
              预设中配置，同一预设下的参赛 / Judge / 汇总共享。本主题为诗歌评测，可在上方切换三套预设题目。评测结束后在线程下方填入人工分，并在「分数计算器」中查看按模型的最终得分（≤10）。与按模型的整体验收对比见「人工分与图表」标签页。
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

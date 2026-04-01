import { useId, useMemo, useState } from "react";
import { uniqueModelIds } from "../chartUtils";
import {
  customEvaluationPresetsSafe,
  getEvaluationPresetSelectOptions,
  getEvaluationThemeLabel,
} from "../evaluationPresets";
import { averageCompositeByModel, clampBlendWeight } from "../scoreCalculations";
import { saveScoreSnapshot } from "../scoreApi";
import { buildSavedScoreSnapshot } from "../scoreSnapshot";
import { settingsReadyForRun } from "../settingsHelpers";
import { useArenaStore } from "../store";
import type { BlendWeights, GlobalSettings, RunSession, ThreadScoreInput } from "../types";
import { ConfirmModal } from "./ConfirmModal";
import { CustomSelect } from "./CustomSelect";
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
  onRetryThread: (genId: string) => void;
  onAbandonThread: (genId: string) => void;
  onPauseThread: (genId: string) => void;
  onAbortJudgeSlot: (
    genId: string,
    judgeId: string,
    reviewIndex: number,
  ) => void;
  onCancelThread: (genId: string) => void;
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
  onRetryThread,
  onAbandonThread,
  onPauseThread,
  onAbortJudgeSlot,
  onCancelThread,
  onClearSession,
  onTaskPromptChange,
  onEvaluationPresetChange,
  running,
  phase,
}: Props) {
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [savingScores, setSavingScores] = useState(false);
  const [saveScoreMessage, setSaveScoreMessage] = useState<string | null>(null);
  const taskPromptFieldId = useId();
  const est = useMemo(() => estimateCalls(settings), [settings]);
  const ready = useMemo(() => settingsReadyForRun(settings), [settings]);
  const customEvalList = customEvaluationPresetsSafe(settings);
  const runEvalPresetOptions = useMemo(
    () => getEvaluationPresetSelectOptions(customEvalList, "emdash"),
    [customEvalList],
  );

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

  const canSaveScores =
    !!session &&
    session.phase === "done" &&
    session.generations.length > 0;

  const onSaveScores = async () => {
    if (!session || session.phase !== "done" || !session.generations.length) {
      return;
    }
    setSaveScoreMessage(null);
    const st = useArenaStore.getState();
    const snapshot = buildSavedScoreSnapshot({
      session,
      threadScores: st.threadScores as Record<string, ThreadScoreInput>,
      humanScores: st.humanScores,
      blendWeights,
      judgeIds,
    });
    setSavingScores(true);
    try {
      await saveScoreSnapshot(snapshot);
      setSaveScoreMessage("已保存到本地 data/scores（请在「人工分与图表」中查看或下载）。");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveScoreMessage(`保存失败：${msg}（请确认本地代理已启动）`);
    } finally {
      setSavingScores(false);
    }
  };

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
          <label htmlFor="run-eval-preset">
            预设题目（
            {getEvaluationThemeLabel(
              settings.evaluationPresetId,
              customEvalList,
            )}
            ）
          </label>
          <CustomSelect
            id="run-eval-preset"
            value={settings.evaluationPresetId}
            onChange={onEvaluationPresetChange}
            disabled={running}
            options={runEvalPresetOptions}
          />
          <p className="muted small run-page__preset-hint">
            切换内置题将载入该题全文与家族默认评委模板；切换自定义题会清空评委模板。汇总模型提示词不随题目切换被覆盖；可在下方继续编辑题目，或在「设置」中管理自定义题与汇总文案。
          </p>
        </div>

        <div className="field">
          <label htmlFor={taskPromptFieldId}>
            提示词（评测题目与要求）
          </label>
          <textarea
            id={taskPromptFieldId}
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
            onClick={() => setCancelConfirmOpen(true)}
          >
            取消
          </button>
          {cancelConfirmOpen ? (
            <ConfirmModal
              title="确认取消评测？"
              message="将立即中断所有流式请求；已显示在画布上的生成与评委内容会保留。"
              confirmLabel="确认取消"
              cancelLabel="继续运行"
              onConfirm={() => {
                onCancel();
                setCancelConfirmOpen(false);
              }}
              onCancel={() => setCancelConfirmOpen(false)}
            />
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            disabled={running}
            onClick={onClearSession}
          >
            清空结果
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={running || !canSaveScores || savingScores}
            onClick={() => void onSaveScores()}
            title={
              canSaveScores
                ? "将线程原始数据与计算后的成绩保存到项目 data/scores 目录（需本地代理）"
                : "评测完成后且存在生成线程时可保存"
            }
          >
            {savingScores ? "保存中…" : "保存成绩"}
          </button>
          {(running || session) && (
            <span className="badge">
              {running
                ? `阶段：${phaseLabel(phase)}`
                : `上次阶段：${phaseLabel(session?.phase ?? "idle")}`}
            </span>
          )}
        </div>
        {saveScoreMessage ? (
          <p
            className={
              saveScoreMessage.startsWith("保存失败")
                ? "warn warn--block"
                : "muted"
            }
            role={saveScoreMessage.startsWith("保存失败") ? "alert" : "status"}
          >
            {saveScoreMessage}
          </p>
        ) : null}
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

        <details className="run-disclosure">
          <summary className="run-disclosure__summary">
            评测流程说明（并发、Judge、汇总与人工分）
          </summary>
          <div className="run-disclosure__body">
            <p className="muted">
              同一条评测提示词按 API 预设的并发上限流式调用：各线程生成完成后立即进入
              Judge（多评委限流并行），再按需汇总。并发上限在「设置」的每个 API
              预设中配置，同一预设下的参赛 / Judge / 汇总共享。
              {`当前评测主题为「${getEvaluationThemeLabel(settings.evaluationPresetId, customEvalList)}」，可在上方切换预设题目。`}
              评测结束后在线程下方填入人工分，并在「分数计算器」中查看按模型的最终得分（≤10）。与按模型的整体验收对比见「人工分与图表」标签页。
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
        onRetryThread={onRetryThread}
        onAbandonThread={onAbandonThread}
        onPauseThread={onPauseThread}
        onAbortJudgeSlot={onAbortJudgeSlot}
        onCancelThread={onCancelThread}
      />
    </div>
  );
}

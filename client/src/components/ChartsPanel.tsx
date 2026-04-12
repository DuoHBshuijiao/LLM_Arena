import { useMemo, useState } from "react";
import { clampScore10 } from "../errorUtils";
import { ConfirmModal } from "./ConfirmModal";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  averageAutoScoreByModel,
  sortModelIdsByValue,
  uniqueModelIds,
  type SortDirection,
} from "../chartUtils";
import {
  downloadBundleJson,
  downloadSnapshotJson,
} from "../scoreApi";
import {
  formatTimestampForFilename,
  sanitizeFilenameBase,
} from "../scoreSnapshot";
import type {
  BlendWeights,
  GenerationResult,
  SavedScoreSnapshot,
  ScoreHistoryExportFile,
  ThreadScoreInput,
} from "../types";

export interface ChartsHistoryPanelProps {
  entries: SavedScoreSnapshot[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface Props {
  generations: GenerationResult[];
  humanScores: Record<string, number>;
  onHumanChange: (modelId: string, score: number | undefined) => void;
  /** 批量清空「整体验收」列（图表页专用，不影响线程内评委分） */
  onClearAllHumanScores?: () => void;
  threadScores: Record<string, ThreadScoreInput | undefined>;
  blendWeights: BlendWeights;
  judgeIds: string[];
  /** 查看历史快照时为 true，不写入 store */
  readOnly?: boolean;
  historyPanel?: ChartsHistoryPanelProps | null;
}

function promptSnippet(prompt: string, max = 48): string {
  const t = prompt.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

type ChartsSortKey = "auto" | "human" | "model";

export function ChartsPanel({
  generations,
  humanScores,
  onHumanChange,
  onClearAllHumanScores,
  threadScores,
  blendWeights,
  judgeIds,
  readOnly = false,
  historyPanel,
}: Props) {
  const [chartsSortKey, setChartsSortKey] = useState<ChartsSortKey>("model");
  const [chartsSortDir, setChartsSortDir] = useState<SortDirection>("asc");
  const [clearHumanOpen, setClearHumanOpen] = useState(false);

  const modelIds = uniqueModelIds(generations);
  const autoMap = averageAutoScoreByModel(
    generations,
    threadScores,
    judgeIds,
    blendWeights,
  );

  const sortedModelIds = useMemo(() => {
    if (chartsSortKey === "model") {
      return [...modelIds].sort((a, b) =>
        chartsSortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a),
      );
    }
    if (chartsSortKey === "auto") {
      return sortModelIdsByValue(
        modelIds,
        (id) => autoMap[id] ?? null,
        chartsSortDir,
      );
    }
    return sortModelIdsByValue(
      modelIds,
      (id) => humanScores[id] ?? null,
      chartsSortDir,
    );
  }, [modelIds, chartsSortKey, chartsSortDir, autoMap, humanScores]);

  const rows = sortedModelIds.map((id) => ({
    model: id.length > 24 ? `${id.slice(0, 22)}…` : id,
    modelId: id,
    auto: autoMap[id],
    human: humanScores[id],
  }));

  const chartData = sortedModelIds.map((id) => ({
    name: id.length > 16 ? `${id.slice(0, 14)}…` : id,
    自动汇总: autoMap[id] ?? null,
    人工分: humanScores[id] ?? null,
  }));

  const hasAny = modelIds.length > 0;

  const humanFilledCount = useMemo(
    () =>
      modelIds.filter((id) => {
        const v = humanScores[id];
        return v !== undefined && !Number.isNaN(v);
      }).length,
    [modelIds, humanScores],
  );

  return (
    <div className="panel">
      <h2>人工分与图表</h2>

      {historyPanel ? (
        <div className="charts-history">
          <div className="charts-history__head">
            <h3 className="charts-history__title">历史成绩</h3>
            <div className="charts-history__actions">
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={historyPanel.loading}
                onClick={() => historyPanel.onRetry()}
              >
                刷新
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={
                  !historyPanel.selectedId ||
                  historyPanel.loading ||
                  !!historyPanel.error
                }
                onClick={() => {
                  const id = historyPanel.selectedId;
                  if (!id) return;
                  const e = historyPanel.entries.find((x) => x.id === id);
                  if (!e) return;
                  downloadSnapshotJson(
                    e,
                    `${sanitizeFilenameBase(e.prompt, 60)}_${formatTimestampForFilename()}.json`,
                  );
                }}
              >
                下载数据
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={
                  historyPanel.entries.length === 0 ||
                  historyPanel.loading ||
                  !!historyPanel.error
                }
                onClick={() => {
                  const bundle: ScoreHistoryExportFile = {
                    exportBundleVersion: 1,
                    exportedAt: Date.now(),
                    entries: historyPanel.entries,
                  };
                  downloadBundleJson(
                    bundle,
                    `score-history-all_${formatTimestampForFilename()}.json`,
                  );
                }}
              >
                下载全部数据
              </button>
              {historyPanel.selectedId ? (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => historyPanel.onSelect(null)}
                >
                  查看当前会话
                </button>
              ) : null}
            </div>
          </div>
          {historyPanel.loading ? (
            <p className="muted charts-history__status">正在从本地 data/scores 加载…</p>
          ) : null}
          {historyPanel.error ? (
            <p className="warn charts-history__status" role="alert">
              {historyPanel.error}{" "}
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => historyPanel.onRetry()}
              >
                重试
              </button>
            </p>
          ) : null}
          {!historyPanel.loading &&
          !historyPanel.error &&
          historyPanel.entries.length === 0 ? (
            <p className="muted charts-history__status">
              暂无保存的成绩。请在「运行与结果」评测完成后点击「保存成绩」（需本地代理已连接）。
            </p>
          ) : null}
          {!historyPanel.loading && !historyPanel.error && historyPanel.entries.length > 0 ? (
            <ul className="charts-history__list" role="list">
              {historyPanel.entries.map((e) => {
                const sel = historyPanel.selectedId === e.id;
                const label = new Date(e.savedAt).toLocaleString(undefined, {
                  dateStyle: "short",
                  timeStyle: "short",
                });
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      className={
                        sel
                          ? "charts-history__item charts-history__item--selected"
                          : "charts-history__item"
                      }
                      onClick={() =>
                        historyPanel.onSelect(sel ? null : e.id)
                      }
                    >
                      <span className="charts-history__time">{label}</span>
                      <span className="charts-history__prompt" title={e.prompt}>
                        {promptSnippet(e.prompt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {readOnly ? (
        <p className="charts-banner charts-banner--readonly" role="status">
          正在查看历史记录，不会修改当前运行会话。
        </p>
      ) : null}

      <p className="muted">
        此处按<strong>模型</strong>填一条<strong>整体验收</strong>人工分（0–10），用于与下方「自动汇总」柱状图对比。
      </p>
      <p className="muted charts-panel__lede-follow">
        线程内的<strong>评委分</strong>与<strong>人工分</strong>请在「运行与结果」页填写。图中「自动汇总」= 按评委权重与人工分权重混合后的综合分（同一模型多线程取平均）。
      </p>

      {!hasAny && (
        <p className="muted">
          {readOnly
            ? "该条历史记录没有可展示的生成结果。"
            : "还没有可对比的生成结果。请先到「运行与结果」完成一次评测。"}
        </p>
      )}

      {hasAny && (
        <>
          <div className="charts-panel__batch-row">
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={readOnly || !onClearAllHumanScores || humanFilledCount === 0}
              title="清空本页表格中所有模型的整体验收人工分（可重新填写）"
              onClick={() => setClearHumanOpen(true)}
            >
              清空全部整体验收分
            </button>
            {clearHumanOpen && onClearAllHumanScores ? (
              <ConfirmModal
                title="清空整体验收人工分？"
                message="将移除当前会话中所有模型行的整体验收分，不会改动「运行与结果」里各线程的评委分与线程人工分。"
                confirmLabel="确认清空"
                cancelLabel="取消"
                onConfirm={() => {
                  onClearAllHumanScores();
                  setClearHumanOpen(false);
                }}
                onCancel={() => setClearHumanOpen(false)}
              />
            ) : null}
          </div>
          <div className="charts-panel__sort-row">
            <label className="charts-panel__sort-label" htmlFor="charts-sort-key">
              排序
            </label>
            <select
              id="charts-sort-key"
              className="charts-panel__sort-select"
              disabled={readOnly}
              value={chartsSortKey}
              onChange={(e) =>
                setChartsSortKey(e.target.value as ChartsSortKey)
              }
            >
              <option value="model">按模型</option>
              <option value="auto">按自动汇总</option>
              <option value="human">按整体验收人工分</option>
            </select>
            <div
              className="charts-panel__sort-dir"
              role="group"
              aria-label="升序或降序"
            >
              <button
                type="button"
                className={
                  chartsSortDir === "asc"
                    ? "btn-ghost btn-sm charts-panel__sort-btn charts-panel__sort-btn--active"
                    : "btn-ghost btn-sm charts-panel__sort-btn"
                }
                disabled={readOnly}
                onClick={() => setChartsSortDir("asc")}
              >
                升序
              </button>
              <button
                type="button"
                className={
                  chartsSortDir === "desc"
                    ? "btn-ghost btn-sm charts-panel__sort-btn charts-panel__sort-btn--active"
                    : "btn-ghost btn-sm charts-panel__sort-btn"
                }
                disabled={readOnly}
                onClick={() => setChartsSortDir("desc")}
              >
                降序
              </button>
            </div>
          </div>
          <div className="table-wrap charts-panel__table-wrap">
            <table>
              <caption className="visually-hidden">
                按模型填写整体验收人工分，与自动汇总对比
              </caption>
              <thead>
                <tr>
                  <th scope="col">模型</th>
                  <th scope="col">整体验收人工分（0–10）</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.modelId}>
                    <td className="table-cell-id">{r.modelId}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.5}
                        readOnly={readOnly}
                        aria-label={`整体验收人工分（0–10），模型：${r.modelId}`}
                        className={
                          readOnly
                            ? "charts-panel__human-input charts-panel__human-input--readonly"
                            : "charts-panel__human-input"
                        }
                        value={
                          r.human !== undefined && !Number.isNaN(r.human)
                            ? String(r.human)
                            : ""
                        }
                        placeholder="0–10"
                        onChange={(e) => {
                          if (readOnly) return;
                          const raw = e.target.value.trim();
                          if (raw === "") {
                            onHumanChange(r.modelId, undefined);
                            return;
                          }
                          const v = Number(raw);
                          if (!Number.isNaN(v)) {
                            onHumanChange(r.modelId, clampScore10(v));
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            className="charts-panel__chart"
            role="img"
            aria-label="柱状图：各模型自动汇总与整体验收人工分对比（数值见 Tooltip）"
          >
            <ResponsiveContainer>
              <BarChart
                data={chartData}
                margin={{ top: 8, right: 8, left: 8, bottom: 48 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="name"
                  tick={{
                    fill: "var(--color-muted)",
                    fontSize: "var(--text-caption)",
                  }}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  domain={[0, 10]}
                  tick={{
                    fill: "var(--color-muted)",
                    fontSize: "var(--text-caption)",
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                  }}
                />
                <Legend />
                <Bar dataKey="自动汇总" fill="var(--color-chart-a)" />
                <Bar dataKey="人工分" fill="var(--color-chart-b)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

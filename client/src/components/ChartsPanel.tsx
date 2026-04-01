import { clampScore10 } from "../errorUtils";
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
import { averageAutoScoreByModel, uniqueModelIds } from "../chartUtils";
import type {
  BlendWeights,
  GenerationResult,
  ThreadScoreInput,
} from "../types";

interface Props {
  generations: GenerationResult[];
  humanScores: Record<string, number>;
  onHumanChange: (modelId: string, score: number | undefined) => void;
  threadScores: Record<string, ThreadScoreInput | undefined>;
  blendWeights: BlendWeights;
  judgeIds: string[];
}

export function ChartsPanel({
  generations,
  humanScores,
  onHumanChange,
  threadScores,
  blendWeights,
  judgeIds,
}: Props) {
  const modelIds = uniqueModelIds(generations);
  const autoMap = averageAutoScoreByModel(
    generations,
    threadScores,
    judgeIds,
    blendWeights,
  );

  const rows = modelIds.map((id) => ({
    model: id.length > 24 ? `${id.slice(0, 22)}…` : id,
    modelId: id,
    auto: autoMap[id],
    human: humanScores[id],
  }));

  const chartData = modelIds.map((id) => ({
    name: id.length > 16 ? `${id.slice(0, 14)}…` : id,
    自动汇总: autoMap[id] ?? null,
    人工分: humanScores[id] ?? null,
  }));

  const hasAny = modelIds.length > 0;

  return (
    <div className="panel">
      <h2>人工分与图表</h2>
      <p className="muted">
        此处按<strong>模型</strong>填一条<strong>整体验收</strong>人工分（0–10），用于与下方「自动汇总」柱状图对比。
      </p>
      <p className="muted charts-panel__lede-follow">
        线程内的<strong>评委分</strong>与<strong>人工分</strong>请在「运行与结果」页填写。图中「自动汇总」= 按评委权重与人工分权重混合后的综合分（同一模型多线程取平均）。
      </p>

      {!hasAny && (
        <p className="muted">还没有可对比的生成结果。请先到「运行与结果」完成一次评测。</p>
      )}

      {hasAny && (
        <>
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
                        aria-label={`整体验收人工分（0–10），模型：${r.modelId}`}
                        className="charts-panel__human-input"
                        value={
                          r.human !== undefined && !Number.isNaN(r.human)
                            ? String(r.human)
                            : ""
                        }
                        placeholder="0–10"
                        onChange={(e) => {
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

          <div className="charts-panel__chart">
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

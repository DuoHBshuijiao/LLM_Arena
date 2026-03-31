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
import type { GenerationResult } from "../types";

interface Props {
  generations: GenerationResult[];
  humanScores: Record<string, number>;
  onHumanChange: (modelId: string, score: number | undefined) => void;
}

export function ChartsPanel({
  generations,
  humanScores,
  onHumanChange,
}: Props) {
  const modelIds = uniqueModelIds(generations);
  const autoMap = averageAutoScoreByModel(generations);

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
        每个<strong>模型</strong>填写一条人工「生成分」（与计划中「每模型一条」一致）；图表对比
        自动汇总 overall（多样本取平均）与人工分。
      </p>

      {!hasAny && (
        <p className="muted">暂无生成结果；请先完成一次评测。</p>
      )}

      {hasAny && (
        <>
          <div className="table-wrap" style={{ marginBottom: "1rem" }}>
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>人工生成分（0–10）</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.modelId}>
                    <td>{r.modelId}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.5}
                        style={{ maxWidth: 120 }}
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
                          if (!Number.isNaN(v)) onHumanChange(r.modelId, v);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ width: "100%", height: 360 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 48 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3140" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#9aa4b5", fontSize: 11 }}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  domain={[0, 10]}
                  tick={{ fill: "#9aa4b5", fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    background: "#161a22",
                    border: "1px solid #2a3140",
                    color: "#e8eaed",
                  }}
                />
                <Legend />
                <Bar dataKey="自动汇总" fill="#5b8fd4" />
                <Bar dataKey="人工分" fill="#6fd4a5" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

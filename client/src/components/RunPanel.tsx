import { useMemo, useState } from "react";
import type { GlobalSettings } from "../types";

interface Props {
  settings: GlobalSettings;
  onRun: (prompt: string) => void;
  onCancel: () => void;
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
  onRun,
  onCancel,
  running,
  phase,
}: Props) {
  const [prompt, setPrompt] = useState(
    "用三句话解释什么是 RAG，并给出一个应用场景。",
  );
  const est = useMemo(() => estimateCalls(settings), [settings]);

  return (
    <div className="panel">
      <h2>运行</h2>
      <p className="muted">
        同一条提示词对多个模型并发生成（受并发上限约束）；随后对每个生成结果跑全部
        Judge（含 review 次数）；若启用汇总则每条生成再调一次汇总模型。
        全部为 OpenAI 兼容流式调用。
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
          disabled={running || !settings.apiKey.trim()}
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
        {running && (
          <span className="badge">
            阶段：{phase}
          </span>
        )}
      </div>
      {!settings.apiKey.trim() && (
        <p className="warn">请先在「设置」中填写 API Key。</p>
      )}
    </div>
  );
}

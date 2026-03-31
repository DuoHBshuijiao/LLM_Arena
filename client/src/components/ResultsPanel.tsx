import type { RunSession } from "../types";

interface Props {
  session: RunSession | null;
}

export function ResultsPanel({ session }: Props) {
  if (!session) {
    return (
      <div className="panel">
        <h2>结果</h2>
        <p className="muted">尚未运行评测，或上次结果被清空。</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>结果</h2>
      <p className="muted">
        阶段：<strong>{session.phase}</strong>
        {session.error && (
          <span className="err"> — {session.error}</span>
        )}
      </p>
      {session.streamPreview && (
        <details open style={{ marginBottom: "0.75rem" }}>
          <summary className="muted">当前流式片段（尾部预览）</summary>
          <pre
            style={{
              fontSize: "0.78rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {session.streamPreview}
          </pre>
        </details>
      )}
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        提示词：<span style={{ color: "#c8d0e0" }}>{session.prompt}</span>
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>#</th>
              <th>生成 / 评审 / 汇总</th>
            </tr>
          </thead>
          <tbody>
            {session.generations.map((g) => (
              <tr key={g.id}>
                <td>{g.modelId}</td>
                <td>{g.sampleIndex + 1}</td>
                <td>
                  <details className="gen">
                    <summary>生成文本</summary>
                    <pre>{g.text || "—"}</pre>
                  </details>
                  {g.judgeRuns.length > 0 && (
                    <details className="gen">
                      <summary>
                        Judge（{g.judgeRuns.length} 条）
                      </summary>
                      {g.judgeRuns.map((jr) => (
                        <div key={`${jr.judgeId}-${jr.reviewIndex}`}>
                          <div className="muted">
                            {jr.judgeName} · 第 {jr.reviewIndex + 1} 轮
                            {jr.parsed?.overall != null && (
                              <span>
                                {" "}
                                · overall:{" "}
                                <strong>{jr.parsed.overall}</strong>
                              </span>
                            )}
                            {jr.parseError && (
                              <span className="err"> · 解析: {jr.parseError}</span>
                            )}
                          </div>
                          <pre style={{ fontSize: "0.78rem" }}>
                            {jr.rawText}
                          </pre>
                        </div>
                      ))}
                    </details>
                  )}
                  {g.aggregateText && (
                    <details className="gen" open>
                      <summary>汇总</summary>
                      <div className="muted">
                        {g.aggregateParsed?.overall != null ? (
                          <span>
                            overall:{" "}
                            <strong>{g.aggregateParsed.overall}</strong>
                          </span>
                        ) : (
                          <span className="err">
                            {g.aggregateParseError ?? "未解析 overall"}
                          </span>
                        )}
                      </div>
                      <pre>{g.aggregateText}</pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

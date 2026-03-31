import { useEffect, useState } from "react";
import { ChartsPanel } from "./components/ChartsPanel";
import { ResultsPanel } from "./components/ResultsPanel";
import { RunPanel } from "./components/RunPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { useArenaStore } from "./store";

type Tab = "settings" | "run" | "results" | "charts";

export default function App() {
  const [tab, setTab] = useState<Tab>("settings");
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);

  const settings = useArenaStore((s) => s.settings);
  const setSettings = useArenaStore((s) => s.setSettings);
  const lastRun = useArenaStore((s) => s.lastRun);
  const humanScores = useArenaStore((s) => s.humanScores);
  const updateHumanScore = useArenaStore((s) => s.updateHumanScore);
  const runEvaluation = useArenaStore((s) => s.runEvaluation);
  const cancelRun = useArenaStore((s) => s.cancelRun);
  const clearLastRun = useArenaStore((s) => s.clearLastRun);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.ok)
      .then(setProxyOk)
      .catch(() => setProxyOk(false));
  }, []);

  const running =
    lastRun !== null &&
    lastRun.phase !== "done" &&
    lastRun.phase !== "error";

  return (
    <div className="app">
      <header className="app-header">
        <h1>LLM Arena</h1>
        <span className="badge">
          代理：{" "}
          {proxyOk === null
            ? "检测中…"
            : proxyOk
              ? "已连接"
              : "未连接（请 npm run dev 启动后端）"}
        </span>
        <nav className="app-nav">
          {(
            [
              ["settings", "设置"],
              ["run", "运行"],
              ["results", "结果"],
              ["charts", "人工与图表"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {tab === "settings" && (
        <SettingsPanel settings={settings} onChange={setSettings} />
      )}
      {tab === "run" && (
        <RunPanel
          settings={settings}
          onRun={async (p) => {
            await runEvaluation(p);
            setTab("results");
          }}
          onCancel={cancelRun}
          running={running}
          phase={lastRun?.phase ?? "idle"}
        />
      )}
      {tab === "results" && (
        <>
          <div style={{ marginBottom: "0.5rem" }}>
            <button type="button" className="btn-ghost" onClick={clearLastRun}>
              清空结果（同步 localStorage）
            </button>
          </div>
          <ResultsPanel session={lastRun} />
        </>
      )}
      {tab === "charts" && (
        <ChartsPanel
          generations={lastRun?.generations ?? []}
          humanScores={humanScores}
          onHumanChange={updateHumanScore}
        />
      )}
    </div>
  );
}

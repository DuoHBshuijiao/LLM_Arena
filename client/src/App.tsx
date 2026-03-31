import { useEffect, useState } from "react";
import { ChartsPanel } from "./components/ChartsPanel";
import { RunPanel } from "./components/RunPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { useArenaStore } from "./store";

type Tab = "settings" | "run" | "charts";

export default function App() {
  const [tab, setTab] = useState<Tab>("settings");
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);

  const settings = useArenaStore((s) => s.settings);
  const setSettings = useArenaStore((s) => s.setSettings);
  const lastRun = useArenaStore((s) => s.lastRun);
  const humanScores = useArenaStore((s) => s.humanScores);
  const threadScores = useArenaStore((s) => s.threadScores);
  const blendWeights = useArenaStore((s) => s.blendWeights);
  const updateHumanScore = useArenaStore((s) => s.updateHumanScore);
  const setThreadJudgeScore = useArenaStore((s) => s.setThreadJudgeScore);
  const setThreadHumanScore = useArenaStore((s) => s.setThreadHumanScore);
  const setModelBlendWeight = useArenaStore((s) => s.setModelBlendWeight);
  const setHumanBlendWeight = useArenaStore((s) => s.setHumanBlendWeight);
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
    <div className={`app ${tab === "run" ? "app--wide" : ""}`}>
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
              ["run", "运行与结果"],
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
          session={lastRun}
          threadScores={threadScores}
          blendWeights={blendWeights}
          setThreadJudgeScore={setThreadJudgeScore}
          setThreadHumanScore={setThreadHumanScore}
          setModelBlendWeight={setModelBlendWeight}
          setHumanBlendWeight={setHumanBlendWeight}
          onRun={(p) => runEvaluation(p)}
          onCancel={cancelRun}
          onClearSession={clearLastRun}
          running={running}
          phase={lastRun?.phase ?? "idle"}
        />
      )}
      {tab === "charts" && (
        <ChartsPanel
          generations={lastRun?.generations ?? []}
          humanScores={humanScores}
          onHumanChange={updateHumanScore}
          threadScores={threadScores}
          blendWeights={blendWeights}
          judgeIds={settings.judges.map((j) => j.id)}
        />
      )}
    </div>
  );
}

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { SettingsPanel } from "./components/SettingsPanel";
import { applyEvaluationPreset } from "./evaluationPresets";
import { useArenaStore } from "./store";

const RunPanel = lazy(() =>
  import("./components/RunPanel").then((m) => ({ default: m.RunPanel })),
);
const ChartsPanel = lazy(() =>
  import("./components/ChartsPanel").then((m) => ({ default: m.ChartsPanel })),
);

function prefetchRunPanel() {
  void import("./components/RunPanel");
}
function prefetchChartsPanel() {
  void import("./components/ChartsPanel");
}

type Tab = "settings" | "run" | "charts";

export default function App() {
  const [tab, setTab] = useState<Tab>("settings");
  const [proxyHealth, setProxyHealth] = useState<
    "checking" | "ok" | "offline"
  >("checking");

  const checkProxyHealth = useCallback(() => {
    setProxyHealth("checking");
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), 8000);
    fetch("/api/health", { signal: ac.signal })
      .then((r) => {
        clearTimeout(t);
        setProxyHealth(r.ok ? "ok" : "offline");
      })
      .catch(() => {
        clearTimeout(t);
        setProxyHealth("offline");
      });
  }, []);

  useEffect(() => {
    checkProxyHealth();
  }, [checkProxyHealth]);

  const settings = useArenaStore((s) => s.settings);
  const setSettings = useArenaStore((s) => s.setSettings);
  const lastRun = useArenaStore((s) => s.lastRun);
  const humanScores = useArenaStore((s) => s.humanScores);
  const threadScores = useArenaStore((s) => s.threadScores);
  const blendWeights = useArenaStore((s) => s.blendWeights);
  const updateHumanScore = useArenaStore((s) => s.updateHumanScore);
  const setThreadJudgeScore = useArenaStore((s) => s.setThreadJudgeScore);
  const setThreadHumanScore = useArenaStore((s) => s.setThreadHumanScore);
  const setJudgeBlendWeight = useArenaStore((s) => s.setJudgeBlendWeight);
  const setHumanBlendWeight = useArenaStore((s) => s.setHumanBlendWeight);
  const runEvaluation = useArenaStore((s) => s.runEvaluation);
  const cancelRun = useArenaStore((s) => s.cancelRun);
  const clearLastRun = useArenaStore((s) => s.clearLastRun);

  const running =
    lastRun !== null &&
    lastRun.phase !== "done" &&
    lastRun.phase !== "error";

  return (
    <div className={`app ${tab === "run" ? "app--wide" : ""}`}>
      <header className="app-header">
        <h1 className="app-title">
          <span className="app-title__mark">LLM</span>{" "}
          <span className="app-title__rest">Arena</span>
        </h1>
        <span className="badge badge--health">
          本地代理：{" "}
          {proxyHealth === "checking" && "检测中…"}
          {proxyHealth === "ok" && "已连接"}
          {proxyHealth === "offline" && (
            <>
              <span className="badge__health-msg">未连接</span>
              <button
                type="button"
                className="badge__retry"
                onClick={checkProxyHealth}
              >
                重试
              </button>
            </>
          )}
        </span>
        <nav className="app-nav" aria-label="主导航">
          {(
            [
              ["settings", "设置"],
              ["run", "运行与结果"],
              ["charts", "人工分与图表"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
              onMouseEnter={() => {
                if (id === "run") prefetchRunPanel();
                if (id === "charts") prefetchChartsPanel();
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="app-tab-panel" key={tab}>
        {tab === "settings" && (
          <SettingsPanel settings={settings} onChange={setSettings} />
        )}
        {tab === "run" && (
          <Suspense
            fallback={
              <div className="panel panel-loading">
                <p className="muted">加载运行面板…</p>
              </div>
            }
          >
            <RunPanel
              settings={settings}
              session={lastRun}
              threadScores={threadScores}
              blendWeights={blendWeights}
              setThreadJudgeScore={setThreadJudgeScore}
              setThreadHumanScore={setThreadHumanScore}
              setJudgeBlendWeight={setJudgeBlendWeight}
              setHumanBlendWeight={setHumanBlendWeight}
              onRun={(p) => runEvaluation(p)}
              onCancel={cancelRun}
              onClearSession={clearLastRun}
              onTaskPromptChange={(taskPrompt) =>
                setSettings({
                  ...useArenaStore.getState().settings,
                  taskPrompt,
                })
              }
              onEvaluationPresetChange={(presetId) =>
                setSettings(
                  applyEvaluationPreset(
                    useArenaStore.getState().settings,
                    presetId,
                  ),
                )
              }
              running={running}
              phase={lastRun?.phase ?? "idle"}
            />
          </Suspense>
        )}
        {tab === "charts" && (
          <Suspense
            fallback={
              <div className="panel panel-loading">
                <p className="muted">加载图表…</p>
              </div>
            }
          >
            <ChartsPanel
              generations={lastRun?.generations ?? []}
              humanScores={humanScores}
              onHumanChange={updateHumanScore}
              threadScores={threadScores}
              blendWeights={blendWeights}
              judgeIds={settings.judges.map((j) => j.id)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

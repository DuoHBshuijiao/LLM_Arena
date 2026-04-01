import { lazy, Suspense, useMemo } from "react";
import { SettingsPanel } from "./SettingsPanel";
import {
  applyEvaluationPreset,
  patchTaskPromptWithCustomStore,
} from "../evaluationPresets";
import { useArenaStore } from "../store";

const RunPanel = lazy(() =>
  import("./RunPanel").then((m) => ({ default: m.RunPanel })),
);
const ChartsPanel = lazy(() =>
  import("./ChartsPanel").then((m) => ({ default: m.ChartsPanel })),
);

function panelLoading(message: string) {
  return (
    <div
      className="panel panel-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="muted">{message}</p>
    </div>
  );
}

/** 仅在「设置」标签挂载时订阅 settings，避免运行中任务更新拖慢壳层 */
export function SettingsTabPane() {
  const settings = useArenaStore((s) => s.settings);
  const setSettings = useArenaStore((s) => s.setSettings);
  return <SettingsPanel settings={settings} onChange={setSettings} />;
}

/** 仅在「运行与结果」标签挂载时订阅会话与线程分等 */
export function RunTabPane() {
  const settings = useArenaStore((s) => s.settings);
  const setSettings = useArenaStore((s) => s.setSettings);
  const lastRun = useArenaStore((s) => s.lastRun);
  const threadScores = useArenaStore((s) => s.threadScores);
  const blendWeights = useArenaStore((s) => s.blendWeights);
  const setThreadJudgeScore = useArenaStore((s) => s.setThreadJudgeScore);
  const setThreadHumanScore = useArenaStore((s) => s.setThreadHumanScore);
  const setJudgeBlendWeight = useArenaStore((s) => s.setJudgeBlendWeight);
  const setHumanBlendWeight = useArenaStore((s) => s.setHumanBlendWeight);
  const runEvaluation = useArenaStore((s) => s.runEvaluation);
  const cancelRun = useArenaStore((s) => s.cancelRun);
  const clearLastRun = useArenaStore((s) => s.clearLastRun);

  const running = useMemo(
    () =>
      lastRun !== null &&
      lastRun.phase !== "done" &&
      lastRun.phase !== "error",
    [lastRun],
  );

  return (
    <Suspense fallback={panelLoading("加载运行面板…")}>
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
          setSettings(
            patchTaskPromptWithCustomStore(
              useArenaStore.getState().settings,
              taskPrompt,
            ),
          )
        }
        onEvaluationPresetChange={(presetId) =>
          setSettings(
            applyEvaluationPreset(useArenaStore.getState().settings, presetId),
          )
        }
        running={running}
        phase={lastRun?.phase ?? "idle"}
      />
    </Suspense>
  );
}

/** 预取 chunk，供顶栏 Tab hover 时调用 */
export function prefetchRunPanel() {
  void import("./RunPanel");
}
export function prefetchChartsPanel() {
  void import("./ChartsPanel");
}

/** 仅在「人工分与图表」标签挂载时订阅图表相关状态 */
export function ChartsTabPane() {
  const lastRun = useArenaStore((s) => s.lastRun);
  const humanScores = useArenaStore((s) => s.humanScores);
  const threadScores = useArenaStore((s) => s.threadScores);
  const blendWeights = useArenaStore((s) => s.blendWeights);
  const updateHumanScore = useArenaStore((s) => s.updateHumanScore);
  const judges = useArenaStore((s) => s.settings.judges);
  const judgeIds = useMemo(() => judges.map((j) => j.id), [judges]);

  return (
    <Suspense fallback={panelLoading("加载图表…")}>
      <ChartsPanel
        generations={lastRun?.generations ?? []}
        humanScores={humanScores}
        onHumanChange={updateHumanScore}
        threadScores={threadScores}
        blendWeights={blendWeights}
        judgeIds={judgeIds}
      />
    </Suspense>
  );
}

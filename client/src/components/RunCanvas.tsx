import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { clampScore10 } from "../errorUtils";
import type {
  GenerationResult,
  GlobalSettings,
  RunSession,
  ThreadScoreInput,
} from "../types";

/** 灰粉 + 玫瑰金：线程与评委框色，低饱和区分、避免荧光粉 */
const THREAD_FRAME = [
  "#9a8790",
  "#a89096",
  "#b89a8f",
  "#b5a399",
  "#c4a090",
  "#ad8892",
  "#a89888",
  "#c9a8a0",
];

const JUDGE_FRAME = [
  "#b8957a",
  "#a89096",
  "#9a8790",
  "#c4a090",
  "#ad8892",
  "#b89a8f",
  "#c9a574",
  "#8b7278",
];

const SUMMARY_FRAME = "#735560";

const COLS = 4;
const CARD_MIN_W = 248;

const CANVAS_SCALE_MIN = 0.25;
const CANVAS_SCALE_MAX = 2.5;

function isCanvasBlankWheelTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".run-canvas-card")) return false;
  if (target.closest(".thread-score-bar")) return false;
  if (target.closest("button, a, input, textarea, select, summary")) {
    return false;
  }
  return true;
}

function judgeSlotsFromSettings(settings: GlobalSettings) {
  const slots: { judgeId: string; judgeName: string; reviewIndex: number }[] =
    [];
  for (const j of settings.judges) {
    for (let r = 0; r < Math.max(1, j.reviewCount); r++) {
      slots.push({ judgeId: j.id, judgeName: j.name, reviewIndex: r });
    }
  }
  return slots;
}

function findJudgeRun(
  g: GenerationResult,
  judgeId: string,
  reviewIndex: number,
) {
  return g.judgeRuns.find(
    (r) => r.judgeId === judgeId && r.reviewIndex === reviewIndex,
  );
}

function FlowArrow({ color }: { color: string }) {
  const uid = useId().replace(/:/g, "");
  const mid = `flow-m-${uid}`;
  const lineLen = 22;
  return (
    <div className="run-flow-arrow" aria-hidden>
      <svg width="24" height="28" viewBox="0 0 24 28" className="run-flow-arrow__svg">
        <defs>
          <marker
            id={mid}
            markerWidth="8"
            markerHeight="8"
            refX="4"
            refY="4"
            orient="auto"
          >
            <polygon
              className="run-flow-arrow__marker-shape"
              points="0 0, 8 4, 0 8"
              fill={color}
            />
          </marker>
        </defs>
        <line
          className="run-flow-arrow__line"
          x1="12"
          y1="0"
          x2="12"
          y2="22"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={lineLen}
          strokeDashoffset={lineLen}
          markerEnd={`url(#${mid})`}
        />
      </svg>
    </div>
  );
}

interface RunCanvasProps {
  session: RunSession | null;
  settings: GlobalSettings;
  threadScores: Record<string, ThreadScoreInput | undefined>;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
}

export function RunCanvas({
  session,
  settings,
  threadScores,
  setThreadJudgeScore,
  setThreadHumanScore,
}: RunCanvasProps) {
  const [pan, setPan] = useState({ x: 80, y: 48 });
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{
    active: boolean;
    sx: number;
    sy: number;
    px: number;
    py: number;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef(pan);
  const scaleRef = useRef(scale);

  const judgeSlots = useMemo(
    () => judgeSlotsFromSettings(settings),
    [settings],
  );

  const sessionId = session?.id;
  useEffect(() => {
    setPan({ x: 80, y: 48 });
    setScale(1);
  }, [sessionId]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!isCanvasBlankWheelTarget(e.target)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const vx = e.clientX - rect.left;
      const vy = e.clientY - rect.top;
      const p = panRef.current;
      const s = scaleRef.current;
      const delta = -e.deltaY;
      const factor = Math.exp(delta * 0.001);
      let nextScale = Math.min(
        CANVAS_SCALE_MAX,
        Math.max(CANVAS_SCALE_MIN, s * factor),
      );
      if (Math.abs(nextScale - s) < 1e-6) return;
      const cx = (vx - p.x) / s;
      const cy = (vy - p.y) / s;
      setPan({ x: vx - cx * nextScale, y: vy - cy * nextScale });
      setScale(nextScale);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const t = e.target as HTMLElement;
      if (
        t.closest(
          ".run-canvas-card, button, a, input, textarea, select, summary",
        )
      ) {
        return;
      }
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setPanning(true);
      drag.current = {
        active: true,
        sx: e.clientX,
        sy: e.clientY,
        px: pan.x,
        py: pan.y,
      };
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d?.active) return;
    e.preventDefault();
    setPan({
      x: d.px + (e.clientX - d.sx),
      y: d.py + (e.clientY - d.sy),
    });
  }, []);

  const endDrag = useCallback(() => {
    if (drag.current) drag.current.active = false;
    setPanning(false);
  }, []);

  if (!session) {
    return (
      <div className="run-canvas run-canvas--empty">
        <p className="muted">
          开始评测后，此处将显示可拖动的流程画布（线程卡片、Judge 与汇总）。
        </p>
      </div>
    );
  }

  if (session.generations.length === 0) {
    return (
      <div className="run-canvas run-canvas--empty">
        <p className="muted">
          {session.error
            ? "本次运行未产生生成结果。"
            : "暂无生成线程。"}
        </p>
      </div>
    );
  }

  const gens = session.generations;

  return (
    <div className="run-canvas">
      <div className="run-canvas-toolbar">
        <span className="muted run-canvas-hint">
          空白处拖动平移 · 空白处滚轮缩放 · 线程一行最多 {COLS} 列
        </span>
      </div>
      <div
        ref={viewportRef}
        className={
          panning
            ? "run-canvas-viewport run-canvas-viewport--panning"
            : "run-canvas-viewport"
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="run-canvas-surface"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: "0 0",
          }}
        >
          <div
            className="run-canvas-grid"
            style={{
              gridTemplateColumns: `repeat(${COLS}, minmax(${CARD_MIN_W}px, 320px))`,
            }}
          >
            {gens.map((g, gi) => (
              <ThreadColumn
                key={g.id}
                generation={g}
                threadIndex={gi}
                session={session}
                judgeSlots={judgeSlots}
                aggregatorEnabled={settings.aggregator.enabled}
                judges={settings.judges}
                threadScores={threadScores}
                setThreadJudgeScore={setThreadJudgeScore}
                setThreadHumanScore={setThreadHumanScore}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function isWaitingAggregate(
  g: GenerationResult,
  aggregatorEnabled: boolean,
) {
  if (!aggregatorEnabled || g.aggregateText.length > 0) return false;
  return g.threadPhase === "aggregating";
}

function ThreadColumn({
  generation: g,
  threadIndex,
  session,
  judgeSlots,
  aggregatorEnabled,
  judges,
  threadScores,
  setThreadJudgeScore,
  setThreadHumanScore,
}: {
  generation: GenerationResult;
  threadIndex: number;
  session: RunSession;
  judgeSlots: { judgeId: string; judgeName: string; reviewIndex: number }[];
  aggregatorEnabled: boolean;
  judges: { id: string; name: string }[];
  threadScores: Record<string, ThreadScoreInput | undefined>;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
}) {
  const frame = THREAD_FRAME[threadIndex % THREAD_FRAME.length];
  const genStreamingDone = g.threadPhase !== "generating";

  const judgesComplete =
    judgeSlots.length === 0 ||
    judgeSlots.every((s) => findJudgeRun(g, s.judgeId, s.reviewIndex));

  const sessionDone = session.phase === "done";

  const showSummaryCard =
    aggregatorEnabled &&
    judgesComplete &&
    (g.aggregateText.length > 0 ||
      isWaitingAggregate(g, aggregatorEnabled) ||
      sessionDone);

  const summaryDone =
    !aggregatorEnabled ||
    (g.aggregateText.trim().length > 0 && sessionDone);
  const showScoreBar =
    sessionDone && summaryDone && judgesComplete;

  const tIn = threadScores[g.id];
  const running = session.phase === "running";

  return (
    <div
      className="thread-column thread-column--animate"
      style={
        {
          "--thread-frame": frame,
          "--thread-stagger": threadIndex,
        } as React.CSSProperties
      }
    >
      <div className="thread-column__title">
        线程 {threadIndex + 1} · {g.modelId}
        <span className="thread-column__meta">样本 #{g.sampleIndex + 1}</span>
      </div>
      <div className="thread-column__flow">
        {g.reasoningText ? (
          <div className="run-canvas-card run-canvas-card--think run-canvas-card--think-gen run-canvas-card--pop">
            <div className="run-canvas-card__head">思考</div>
            <pre className="run-canvas-think-card__body">{g.reasoningText}</pre>
          </div>
        ) : null}
        <div className="run-canvas-card run-canvas-card--gen">
          <div className="run-canvas-card__head">参赛生成</div>
          <pre className="run-canvas-card__body">
            {g.text ||
              (g.threadPhase === "generating" && running
                ? "生成中…"
                : "—")}
          </pre>
        </div>

        {judgeSlots.length > 0 && genStreamingDone && (
          <div className="run-canvas-flow-block run-canvas-flow-block--judge">
            <FlowArrow color={frame} />
            <div className="judge-row">
              {judgeSlots.map((slot, ji) => {
                const jr = findJudgeRun(g, slot.judgeId, slot.reviewIndex);
                const jc = JUDGE_FRAME[ji % JUDGE_FRAME.length];
                return (
                  <div
                    key={`${slot.judgeId}-${slot.reviewIndex}`}
                    className="judge-slot"
                  >
                    {jr?.reasoningText ? (
                      <div
                        className="run-canvas-card run-canvas-card--think run-canvas-card--think-judge"
                        style={
                          {
                            "--card-frame": jc,
                          } as React.CSSProperties
                        }
                      >
                        <div className="run-canvas-card__head">思考</div>
                        <pre className="run-canvas-think-card__body run-canvas-think-card__body--sm">
                          {jr.reasoningText}
                        </pre>
                      </div>
                    ) : null}
                    <div
                      className="run-canvas-card run-canvas-card--judge"
                      style={
                        {
                          "--card-frame": jc,
                        } as React.CSSProperties
                      }
                    >
                      <div className="run-canvas-card__head">
                        Judge · {slot.judgeName}
                        <span className="run-canvas-card__sub">
                          第 {slot.reviewIndex + 1} 轮
                        </span>
                      </div>
                      <pre className="run-canvas-card__body run-canvas-card__body--sm">
                        {jr?.rawText ?? ""}
                      </pre>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {showSummaryCard && (
          <div className="run-canvas-flow-block run-canvas-flow-block--summary">
            <FlowArrow color={frame} />
            {g.aggregateReasoningText ? (
              <div
                className="run-canvas-card run-canvas-card--think run-canvas-card--think-summary"
                style={
                  {
                    "--card-frame": SUMMARY_FRAME,
                  } as React.CSSProperties
                }
              >
                <div className="run-canvas-card__head">思考</div>
                <pre className="run-canvas-think-card__body">
                  {g.aggregateReasoningText}
                </pre>
              </div>
            ) : null}
            <div
              className="run-canvas-card run-canvas-card--summary"
              style={
                {
                  "--card-frame": SUMMARY_FRAME,
                } as React.CSSProperties
              }
            >
              <div className="run-canvas-card__head">汇总</div>
              <pre className="run-canvas-card__body">
                {g.aggregateText || ""}
              </pre>
            </div>
          </div>
        )}
      </div>

      {showScoreBar && (
        <div className="thread-score-bar thread-score-bar--animate">
          <div className="thread-score-bar__title">人工填分（0–10）</div>
          <div className="thread-score-bar__inputs">
            {judges.map((j) => (
              <label key={j.id} className="thread-score-bar__field">
                <span className="thread-score-bar__label">{j.name}</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  className="thread-score-bar__input"
                  value={
                    tIn?.judgeScores?.[j.id] !== undefined &&
                    !Number.isNaN(tIn.judgeScores[j.id] as number)
                      ? String(tIn.judgeScores[j.id])
                      : ""
                  }
                  placeholder="—"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === "") {
                      setThreadJudgeScore(g.id, j.id, undefined);
                      return;
                    }
                    const v = Number(raw);
                    if (!Number.isNaN(v)) {
                      setThreadJudgeScore(g.id, j.id, clampScore10(v));
                    }
                  }}
                />
              </label>
            ))}
            <label className="thread-score-bar__field thread-score-bar__field--human">
              <span className="thread-score-bar__label">人工</span>
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                className="thread-score-bar__input"
                value={
                  tIn?.human !== undefined && !Number.isNaN(tIn.human)
                    ? String(tIn.human)
                    : ""
                }
                placeholder="—"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === "") {
                    setThreadHumanScore(g.id, undefined);
                    return;
                  }
                    const v = Number(raw);
                    if (!Number.isNaN(v)) {
                      setThreadHumanScore(g.id, clampScore10(v));
                    }
                }}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

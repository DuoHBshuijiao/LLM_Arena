import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clampScore10 } from "../errorUtils";
import type {
  GenerationResult,
  GlobalSettings,
  JudgeConfig,
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

/** 线程网格单列：下限保证可读，上限与双评委并列所需宽度一致（见 threadMinWidthPx） */
const THREAD_GRID_COL_MIN = 360;
const THREAD_GRID_COL_MAX = 600;
/** 无限画布：每行固定线程树数量，超过则自动换行 */
const THREADS_PER_ROW = 4;
const THREAD_GRID_GAP_PX = 48;
/** 与 .judge-column 固定宽度一致，用于多评委时计算 thread-column 最小宽度 */
const JUDGE_COL_WIDTH_PX = 260;

const CANVAS_SCALE_MIN = 0.25;
const CANVAS_SCALE_MAX = 2.5;

/** 滚轮缩放画布：空白处直接缩放；卡片/流式区域上需 Ctrl/⌘+滚轮（避免抢走卡片内纵向滚动）。 */
function isCanvasWheelZoomAllowed(
  e: WheelEvent,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("button, a, input, textarea, select, summary")) {
    return false;
  }
  if (e.ctrlKey || e.metaKey) {
    return true;
  }
  if (target.closest(".run-canvas-card")) return false;
  if (target.closest(".thread-score-bar")) return false;
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

/** 将子元素锚点换算为线程树容器内未缩放坐标（与 offsetWidth/offsetHeight 一致） */
function anchorInTree(
  el: HTMLElement,
  tree: HTMLElement,
  anchor: "bottom" | "top",
): { x: number; y: number } {
  const tr = tree.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const sx = tr.width / tree.offsetWidth || 1;
  const sy = tr.height / tree.offsetHeight || 1;
  const x = (er.left + er.width / 2 - tr.left) / sx;
  const y =
    anchor === "bottom"
      ? (er.bottom - tr.top) / sy
      : (er.top - tr.top) / sy;
  return { x, y };
}

function cubicBezierPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  const dist = Math.abs(y1 - y0);
  const dy = Math.max(52, Math.min(160, dist * 0.55));
  return `M ${x0} ${y0} C ${x0} ${y0 + dy}, ${x1} ${y1 - dy}, ${x1} ${y1}`;
}

type EdgeSeg = { d: string; key: string };

function judgeThinkKey(ji: number, ri: number) {
  return `${ji}-${ri}`;
}

function buildThreadPipelineEdges(
  tree: HTMLElement,
  genEl: HTMLElement,
  summaryEl: HTMLElement | null,
  summaryThinkEl: HTMLElement | null,
  judgeCardRefs: Map<string, HTMLElement | null>,
  judgeThinkRefs: Map<string, HTMLElement | null>,
  roundsPerJudge: number[],
  showSummary: boolean,
  hasJudgeSection: boolean,
): EdgeSeg[] {
  const out: EdgeSeg[] = [];

  if (hasJudgeSection) {
    for (let ji = 0; ji < roundsPerJudge.length; ji++) {
      const n = roundsPerJudge[ji];
      for (let ri = 0; ri < n; ri++) {
        const think = judgeThinkRefs.get(judgeThinkKey(ji, ri));
        const judge = judgeCardRefs.get(judgeThinkKey(ji, ri));
        const topEl = think ?? judge;
        if (!topEl) continue;

        if (ri === 0) {
          const a0 = anchorInTree(genEl, tree, "bottom");
          const b0 = anchorInTree(topEl, tree, "top");
          out.push({
            key: `g-${ji}`,
            d: cubicBezierPath(a0.x, a0.y, b0.x, b0.y),
          });
        } else {
          const prevJudge = judgeCardRefs.get(judgeThinkKey(ji, ri - 1));
          if (!prevJudge) continue;
          const a = anchorInTree(prevJudge, tree, "bottom");
          const b = anchorInTree(topEl, tree, "top");
          out.push({
            key: `j-${ji}-up-${ri}`,
            d: cubicBezierPath(a.x, a.y, b.x, b.y),
          });
        }

        if (think && judge) {
          const a = anchorInTree(think, tree, "bottom");
          const b = anchorInTree(judge, tree, "top");
          out.push({
            key: `j-${ji}-tk-${ri}`,
            d: cubicBezierPath(a.x, a.y, b.x, b.y),
          });
        }
      }
    }

    if (showSummary && summaryEl) {
      for (let ji = 0; ji < roundsPerJudge.length; ji++) {
        const lastRi = roundsPerJudge[ji] - 1;
        const last = judgeCardRefs.get(judgeThinkKey(ji, lastRi));
        if (!last) continue;
        if (summaryThinkEl) {
          const a = anchorInTree(last, tree, "bottom");
          const b = anchorInTree(summaryThinkEl, tree, "top");
          out.push({
            key: `s-${ji}-t`,
            d: cubicBezierPath(a.x, a.y, b.x, b.y),
          });
          const a2 = anchorInTree(summaryThinkEl, tree, "bottom");
          const b2 = anchorInTree(summaryEl, tree, "top");
          out.push({
            key: `s-${ji}-b`,
            d: cubicBezierPath(a2.x, a2.y, b2.x, b2.y),
          });
        } else {
          const a = anchorInTree(last, tree, "bottom");
          const b = anchorInTree(summaryEl, tree, "top");
          out.push({
            key: `s-${ji}`,
            d: cubicBezierPath(a.x, a.y, b.x, b.y),
          });
        }
      }
    }
  } else if (showSummary && summaryEl) {
    const a = anchorInTree(genEl, tree, "bottom");
    if (summaryThinkEl) {
      const b = anchorInTree(summaryThinkEl, tree, "top");
      out.push({
        key: "g-sum-t",
        d: cubicBezierPath(a.x, a.y, b.x, b.y),
      });
      const a2 = anchorInTree(summaryThinkEl, tree, "bottom");
      const b2 = anchorInTree(summaryEl, tree, "top");
      out.push({
        key: "g-sum-b",
        d: cubicBezierPath(a2.x, a2.y, b2.x, b2.y),
      });
    } else {
      const b = anchorInTree(summaryEl, tree, "top");
      out.push({
        key: "g-sum",
        d: cubicBezierPath(a.x, a.y, b.x, b.y),
      });
    }
  }

  return out;
}

function ThreadPipelineEdges({
  treeRef,
  genRef,
  summaryRef,
  summaryThinkRef,
  judgeCardRefs,
  judgeThinkRefs,
  roundsPerJudge,
  showSummary,
  hasJudgeSection,
  strokeColor,
  layoutRevision,
}: {
  treeRef: React.RefObject<HTMLDivElement | null>;
  genRef: React.RefObject<HTMLDivElement | null>;
  summaryRef: React.RefObject<HTMLDivElement | null> | null;
  summaryThinkRef: React.RefObject<HTMLDivElement | null> | null;
  judgeCardRefs: React.MutableRefObject<Map<string, HTMLElement | null>>;
  judgeThinkRefs: React.MutableRefObject<Map<string, HTMLElement | null>>;
  roundsPerJudge: number[];
  showSummary: boolean;
  hasJudgeSection: boolean;
  strokeColor: string;
  layoutRevision: number;
}) {
  const uid = useId().replace(/:/g, "");
  const markerId = `flow-edge-m-${uid}`;
  const [segments, setSegments] = useState<EdgeSeg[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const recompute = useCallback(() => {
    const tree = treeRef.current;
    const genEl = genRef.current;
    if (!tree || !genEl) {
      setSegments([]);
      return;
    }
    const summaryEl = summaryRef?.current ?? null;
    const summaryThinkEl = summaryThinkRef?.current ?? null;
    const next = buildThreadPipelineEdges(
      tree,
      genEl,
      summaryEl,
      summaryThinkEl,
      judgeCardRefs.current,
      judgeThinkRefs.current,
      roundsPerJudge,
      showSummary,
      hasJudgeSection,
    );
    setSegments(next);
  }, [
    treeRef,
    genRef,
    summaryRef,
    summaryThinkRef,
    judgeCardRefs,
    judgeThinkRefs,
    roundsPerJudge,
    showSummary,
    hasJudgeSection,
  ]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, layoutRevision]);

  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const sync = () => {
      const w = Math.max(tree.offsetWidth, tree.scrollWidth);
      const h = Math.max(tree.offsetHeight, tree.scrollHeight);
      setBox({ w, h });
      requestAnimationFrame(recompute);
    };
    sync();
    const ro = new ResizeObserver(() => sync());
    ro.observe(tree);
    return () => ro.disconnect();
  }, [treeRef, recompute]);

  const w = box.w;
  const h = box.h;

  if (w <= 0 || h <= 0) {
    return null;
  }

  return (
    <svg
      className="thread-thread-tree__edges"
      aria-hidden
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      overflow="visible"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="4"
          refY="4"
          orient="auto"
        >
          <polygon points="0 0, 8 4, 0 8" fill={strokeColor} />
        </marker>
      </defs>
      {segments.map((s) => (
        <path
          key={s.key}
          d={s.d}
          fill="none"
          stroke={strokeColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeOpacity={0.88}
          markerEnd={`url(#${markerId})`}
        />
      ))}
    </svg>
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
      if (!isCanvasWheelZoomAllowed(e, e.target)) return;
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
          {session.error ? "本次运行未产生生成结果。" : "暂无生成线程。"}
        </p>
      </div>
    );
  }

  const gens = session.generations;

  return (
    <div className="run-canvas">
      <div className="run-canvas-toolbar">
        <span className="muted run-canvas-hint">
          空白处拖动平移画布 · 空白处滚轮缩放 · 卡片上 Ctrl/⌘+滚轮缩放 ·
          每行最多 {THREADS_PER_ROW} 个线程、超出自动换行 ·
          每线程为松散树形流水线（评委分列、多轮串联、汇总汇聚）
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
              gridTemplateColumns: `repeat(${THREADS_PER_ROW}, minmax(${THREAD_GRID_COL_MIN}px, ${THREAD_GRID_COL_MAX}px))`,
              gap: `${THREAD_GRID_GAP_PX}px`,
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

type ThreadColumnProps = {
  generation: GenerationResult;
  threadIndex: number;
  session: RunSession;
  judgeSlots: { judgeId: string; judgeName: string; reviewIndex: number }[];
  aggregatorEnabled: boolean;
  judges: JudgeConfig[];
  threadScores: Record<string, ThreadScoreInput | undefined>;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
};

function threadColumnPropsEqual(
  prev: Readonly<ThreadColumnProps>,
  next: Readonly<ThreadColumnProps>,
): boolean {
  if (prev.generation !== next.generation) return false;
  if (prev.threadIndex !== next.threadIndex) return false;
  if (prev.judgeSlots !== next.judgeSlots) return false;
  if (prev.aggregatorEnabled !== next.aggregatorEnabled) return false;
  if (prev.judges !== next.judges) return false;
  if (prev.session.id !== next.session.id) return false;
  if (prev.session.phase !== next.session.phase) return false;
  if (prev.session.error !== next.session.error) return false;
  const id = prev.generation.id;
  if (prev.threadScores[id] !== next.threadScores[id]) return false;
  return true;
}

function ThreadColumnInner({
  generation: g,
  threadIndex,
  session,
  judgeSlots,
  aggregatorEnabled,
  judges,
  threadScores,
  setThreadJudgeScore,
  setThreadHumanScore,
}: ThreadColumnProps) {
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
    !aggregatorEnabled || (g.aggregateText.trim().length > 0 && sessionDone);
  const showScoreBar = sessionDone && summaryDone && judgesComplete;

  const tIn = threadScores[g.id];
  const running = session.phase === "running";

  const treeRef = useRef<HTMLDivElement | null>(null);
  const genRef = useRef<HTMLDivElement | null>(null);
  const summaryCardRef = useRef<HTMLDivElement | null>(null);
  const summaryThinkRef = useRef<HTMLDivElement | null>(null);
  const judgeCardRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const judgeThinkRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  const roundsPerJudge = useMemo(
    () => judges.map((j) => Math.max(1, j.reviewCount)),
    [judges],
  );

  const setJudgeCardRef = useCallback(
    (ji: number, ri: number) => (el: HTMLElement | null) => {
      const key = `${ji}-${ri}`;
      if (el) judgeCardRefs.current.set(key, el);
      else judgeCardRefs.current.delete(key);
    },
    [],
  );

  const setJudgeThinkRef = useCallback(
    (ji: number, ri: number) => (el: HTMLElement | null) => {
      const key = `${ji}-${ri}`;
      if (el) judgeThinkRefs.current.set(key, el);
      else judgeThinkRefs.current.delete(key);
    },
    [],
  );

  const hasJudgeSection = judgeSlots.length > 0 && genStreamingDone;

  const [edgeLayoutTick, setEdgeLayoutTick] = useState(0);
  useLayoutEffect(() => {
    setEdgeLayoutTick((t) => t + 1);
  }, [g, session.phase]);

  /** 多评委并列：理想宽度；不超过网格单列上限，超出部分由 .judge-columns 横向滚动 */
  const threadMinWidthPx =
    judges.length > 1
      ? Math.min(
          THREAD_GRID_COL_MAX,
          36 +
            JUDGE_COL_WIDTH_PX * judges.length +
            20 * Math.max(0, judges.length - 1),
        )
      : undefined;

  return (
    <div
      className="thread-column thread-column--animate"
      style={
        {
          "--thread-frame": frame,
          "--thread-stagger": threadIndex,
          ...(threadMinWidthPx !== undefined
            ? { minWidth: `${threadMinWidthPx}px` }
            : {}),
        } as React.CSSProperties
      }
    >
      <div className="thread-column__title">
        线程 {threadIndex + 1} · {g.modelId}
        <span className="thread-column__meta">样本 #{g.sampleIndex + 1}</span>
      </div>
      <div className="thread-column__flow">
        <div className="thread-thread-tree" ref={treeRef}>
          <ThreadPipelineEdges
            layoutRevision={edgeLayoutTick}
            treeRef={treeRef}
            genRef={genRef}
            summaryRef={showSummaryCard ? summaryCardRef : null}
            summaryThinkRef={
              showSummaryCard && g.aggregateReasoningText
                ? summaryThinkRef
                : null
            }
            judgeCardRefs={judgeCardRefs}
            judgeThinkRefs={judgeThinkRefs}
            roundsPerJudge={roundsPerJudge}
            showSummary={!!showSummaryCard}
            hasJudgeSection={hasJudgeSection}
            strokeColor={frame}
          />
          <div className="thread-thread-tree__nodes">
            {g.reasoningText ? (
              <div className="run-canvas-card run-canvas-card--think run-canvas-card--think-gen run-canvas-card--pop">
                <div className="run-canvas-card__head">思考</div>
                <pre className="run-canvas-think-card__body">
                  {g.reasoningText}
                </pre>
              </div>
            ) : null}
            <div ref={genRef} className="thread-thread-tree__anchor">
              <div className="run-canvas-card run-canvas-card--gen">
                <div className="run-canvas-card__head">参赛生成</div>
                <pre className="run-canvas-card__body">
                  {g.text ||
                    (g.threadPhase === "generating" && running
                      ? "生成中…"
                      : "—")}
                </pre>
              </div>
            </div>

            {hasJudgeSection && (
              <div className="judge-columns">
                {judges.map((judge, ji) => {
                  const jc = JUDGE_FRAME[ji % JUDGE_FRAME.length];
                  const rc = Math.max(1, judge.reviewCount);
                  return (
                    <div key={judge.id} className="judge-column">
                      <div className="judge-column__title">{judge.name}</div>
                      <div className="judge-column__stack">
                        {Array.from({ length: rc }, (_, ri) => {
                          const jr = findJudgeRun(g, judge.id, ri);
                          return (
                            <div
                              key={`${judge.id}-${ri}`}
                              className="judge-column__round"
                            >
                              {jr?.reasoningText ? (
                                <div
                                  ref={setJudgeThinkRef(ji, ri)}
                                  className="run-canvas-card run-canvas-card--think run-canvas-card--think-judge"
                                  style={
                                    {
                                      "--card-frame": jc,
                                    } as React.CSSProperties
                                  }
                                >
                                  <div className="run-canvas-card__head">
                                    思考
                                  </div>
                                  <pre className="run-canvas-think-card__body run-canvas-think-card__body--sm">
                                    {jr.reasoningText}
                                  </pre>
                                </div>
                              ) : null}
                              <div
                                ref={setJudgeCardRef(ji, ri)}
                                className="run-canvas-card run-canvas-card--judge"
                                style={
                                  {
                                    "--card-frame": jc,
                                  } as React.CSSProperties
                                }
                              >
                                <div className="run-canvas-card__head">
                                  Judge · {judge.name}
                                  <span className="run-canvas-card__sub">
                                    第 {ri + 1} 轮
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
                  );
                })}
              </div>
            )}

            {showSummaryCard && (
              <div className="thread-thread-tree__summary">
                {g.aggregateReasoningText ? (
                  <div
                    ref={summaryThinkRef}
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
                  ref={summaryCardRef}
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
        </div>
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

const ThreadColumn = memo(ThreadColumnInner, threadColumnPropsEqual);

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { toPng } from "html-to-image";
import { clampScore10 } from "../errorUtils";
import {
  formatTimestampForFilename,
  sanitizeFilenameBase,
} from "../scoreSnapshot";
import type {
  GenerationResult,
  GlobalSettings,
  JudgeConfig,
  RunSession,
  ThreadScoreInput,
} from "../types";

/** 与 App.css 中 `--run-frame-thread-*` token 一一对应 */
const THREAD_FRAME = [
  "var(--run-frame-thread-0)",
  "var(--run-frame-thread-1)",
  "var(--run-frame-thread-2)",
  "var(--run-frame-thread-3)",
  "var(--run-frame-thread-4)",
  "var(--run-frame-thread-5)",
  "var(--run-frame-thread-6)",
  "var(--run-frame-thread-7)",
] as const;

/** 与 App.css 中 `--run-frame-judge-*` token 一一对应 */
const JUDGE_FRAME = [
  "var(--run-frame-judge-0)",
  "var(--run-frame-judge-1)",
  "var(--run-frame-judge-2)",
  "var(--run-frame-judge-3)",
  "var(--run-frame-judge-4)",
  "var(--run-frame-judge-5)",
  "var(--run-frame-judge-6)",
  "var(--run-frame-judge-7)",
] as const;

const SUMMARY_FRAME = "var(--run-frame-summary)";

/** 线程网格单列：与 `--thread-column-max-width` 数值一致（px） */
const THREAD_GRID_COL_MIN = 360;
const THREAD_GRID_COL_MAX = 600;
/** 宽屏：每行最多线程树数量，窄屏由 canvasGridLayoutForWidth 减小 */
const THREADS_PER_ROW_MAX = 4;
const THREAD_GRID_GAP_PX = 48;
/** 与 App.css `--run-canvas-inside-pad-x` 一致 */
const RUN_CANVAS_PAD_X_PX = 56;
const THREAD_COL_ABS_MAX_PX = 1200;

type CanvasGridLayout = {
  threadsPerRow: number;
  colMin: number;
  colMax: number;
  gap: number;
};

function canvasGridLayoutForWidth(width: number): CanvasGridLayout {
  if (width <= 520) {
    return {
      threadsPerRow: 1,
      colMin: 256,
      colMax: THREAD_GRID_COL_MAX,
      gap: 20,
    };
  }
  if (width <= 800) {
    return {
      threadsPerRow: 2,
      colMin: 300,
      colMax: THREAD_GRID_COL_MAX,
      gap: 28,
    };
  }
  if (width <= 1180) {
    return {
      threadsPerRow: 3,
      colMin: 330,
      colMax: THREAD_GRID_COL_MAX,
      gap: 36,
    };
  }
  return {
    threadsPerRow: THREADS_PER_ROW_MAX,
    colMin: THREAD_GRID_COL_MIN,
    colMax: THREAD_GRID_COL_MAX,
    gap: THREAD_GRID_GAP_PX,
  };
}

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function getViewportWidthSnapshot() {
  return window.innerWidth;
}

function useCanvasGridLayout(): CanvasGridLayout {
  const width = useSyncExternalStore(
    subscribeResize,
    getViewportWidthSnapshot,
    () => 1280,
  );
  return useMemo(() => canvasGridLayoutForWidth(width), [width]);
}
/**
 * 与 App.css `--judge-column-width` 的像素数值一致（用于布局公式）。
 */
const JUDGE_COL_WIDTH_PX = 260;

function neededThreadMinWidthPx(judgeCount: number): number {
  if (judgeCount <= 1) return 0;
  return (
    36 +
    JUDGE_COL_WIDTH_PX * judgeCount +
    20 * Math.max(0, judgeCount - 1)
  );
}

function computeEffectiveGap(
  viewportWidth: number,
  threadsPerRow: number,
  colMinEff: number,
  gapMin: number,
  gapMax: number,
): number {
  if (threadsPerRow <= 1) return gapMin;
  const available = Math.max(0, viewportWidth - 2 * RUN_CANVAS_PAD_X_PX);
  const minRow = threadsPerRow * colMinEff + (threadsPerRow - 1) * gapMin;
  if (available <= minRow) return Math.max(12, Math.floor(gapMin * 0.75));
  const slack = (available - threadsPerRow * colMinEff) / (threadsPerRow - 1);
  return Math.round(Math.min(gapMax, Math.max(gapMin, slack)));
}

function RunCardStreamBadge({
  sessionRunning,
  streaming,
  failed,
  paused,
}: {
  sessionRunning: boolean;
  streaming: boolean;
  failed: boolean;
  paused?: boolean;
}) {
  const label = failed
    ? "失败"
    : paused
      ? "已暂停"
      : streaming && sessionRunning
        ? "生成中"
        : "已完成";
  const cls = [
    "run-canvas-card__stream-status",
    failed && "run-canvas-card__stream-status--fail",
    paused && "run-canvas-card__stream-status--paused",
    streaming &&
      sessionRunning &&
      !failed &&
      !paused &&
      "run-canvas-card__stream-status--live",
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={cls}>{label}</span>;
}

const CANVAS_SCALE_MIN = 0.25;
const CANVAS_SCALE_MAX = 2.5;
const CANVAS_PAN_KEYBOARD_PX = 48;
const CANVAS_ZOOM_KEY_FACTOR = 1.12;
const CANVAS_DEFAULT_PAN = { x: 80, y: 48 } as const;

/** 滚轮缩放画布：空白处直接缩放；卡片/流式区域上需 Ctrl/⌘+滚轮（避免抢走卡片内纵向滚动）。 */
function isCanvasKeyboardTargetInteractive(el: Element | null): boolean {
  return Boolean(
    el?.closest(
      "button, a, input, textarea, select, summary, [contenteditable]",
    ),
  );
}

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
  /** 避免布局抖动时 offset 短暂为 0 导致 SVG 卸载、或线段被清空 */
  const lastGoodBoxRef = useRef({ w: 0, h: 0 });

  const recompute = useCallback(() => {
    const tree = treeRef.current;
    const genEl = genRef.current;
    if (!tree) {
      return;
    }
    if (!genEl) {
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
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      recompute();
      raf2 = requestAnimationFrame(() => recompute());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [recompute, layoutRevision]);

  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const sync = () => {
      const w = Math.max(tree.offsetWidth, tree.scrollWidth);
      const h = Math.max(tree.offsetHeight, tree.scrollHeight);
      if (w > 0 && h > 0) {
        lastGoodBoxRef.current = { w, h };
        setBox({ w, h });
      } else if (lastGoodBoxRef.current.w > 0 && lastGoodBoxRef.current.h > 0) {
        setBox({ ...lastGoodBoxRef.current });
      } else {
        setBox({ w, h });
      }
      requestAnimationFrame(recompute);
    };
    sync();
    const ro = new ResizeObserver(() => sync());
    ro.observe(tree);
    return () => ro.disconnect();
  }, [treeRef, recompute]);

  const w =
    box.w > 0 && box.h > 0 ? box.w : lastGoodBoxRef.current.w;
  const h =
    box.h > 0 && box.w > 0 ? box.h : lastGoodBoxRef.current.h;

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

/** 导出 PNG 前移除入场动画类，避免 html-to-image 在动画首帧把 opacity:0 内联进快照。 */
function stripRunCanvasEntryAnimationsForExport(root: HTMLElement) {
  root.querySelectorAll(".thread-column--animate").forEach((el) => {
    el.classList.remove("thread-column--animate");
  });
  root.querySelectorAll(".run-canvas-card--pop").forEach((el) => {
    el.classList.remove("run-canvas-card--pop");
  });
  root.querySelectorAll(".thread-score-bar--animate").forEach((el) => {
    el.classList.remove("thread-score-bar--animate");
  });
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
  onRetryThread: (genId: string) => void;
  /** 依次恢复所有「可重试」的失败线程（与单线程重试互斥，由 store 串行化） */
  onRetryAllFailedThreads?: () => Promise<void>;
  /** 批量重试进行中，禁用按钮 */
  retryAllFailedBusy?: boolean;
  /** 整轮评测运行中时不提供批量重试，避免与流水线状态冲突 */
  running?: boolean;
  onAbandonThread: (genId: string) => void;
  onPauseThread: (genId: string) => void;
  onAbortJudgeSlot: (
    genId: string,
    judgeId: string,
    reviewIndex: number,
  ) => void;
  onCancelThread: (genId: string) => void;
}

export function RunCanvas({
  session,
  settings,
  threadScores,
  setThreadJudgeScore,
  setThreadHumanScore,
  onRetryThread,
  onRetryAllFailedThreads,
  retryAllFailedBusy = false,
  running = false,
  onAbandonThread,
  onPauseThread,
  onAbortJudgeSlot,
  onCancelThread,
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
  const gridRef = useRef<HTMLDivElement>(null);
  const panRef = useRef(pan);
  const scaleRef = useRef(scale);
  const [exportingPng, setExportingPng] = useState(false);

  const judgeSlots = useMemo(
    () => judgeSlotsFromSettings(settings),
    [settings],
  );

  const gridLayout = useCanvasGridLayout();

  const [viewportWidth, setViewportWidth] = useState(1280);

  const canvasGridMetrics = useMemo(() => {
    const jc = settings.judges.length;
    const neededMin = neededThreadMinWidthPx(jc);
    const colMinEff = Math.max(gridLayout.colMin, neededMin);
    const colMaxEff = Math.min(
      THREAD_COL_ABS_MAX_PX,
      Math.max(gridLayout.colMax, colMinEff),
    );
    const gapMax = Math.max(gridLayout.gap + 32, 48);
    const effectiveGap = computeEffectiveGap(
      viewportWidth,
      gridLayout.threadsPerRow,
      colMinEff,
      gridLayout.gap,
      gapMax,
    );
    return { colMinEff, colMaxEff, effectiveGap };
  }, [gridLayout, viewportWidth, settings.judges.length]);

  const sessionId = session?.id;

  const failedRetryableCount = useMemo(() => {
    if (!session?.generations.length) return 0;
    return session.generations.filter(
      (g) =>
        g.threadOutcome === "error" && g.failedPipelineStep !== undefined,
    ).length;
  }, [session]);

  useEffect(() => {
    setPan({ ...CANVAS_DEFAULT_PAN });
    setScale(1);
  }, [sessionId]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [sessionId]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const zoomAtViewportCenter = useCallback((nextScale: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vx = rect.width / 2;
    const vy = rect.height / 2;
    const p = panRef.current;
    const s = scaleRef.current;
    const clamped = Math.min(
      CANVAS_SCALE_MAX,
      Math.max(CANVAS_SCALE_MIN, nextScale),
    );
    if (Math.abs(clamped - s) < 1e-6) return;
    const cx = (vx - p.x) / s;
    const cy = (vy - p.y) / s;
    setPan({ x: vx - cx * clamped, y: vy - cy * clamped });
    setScale(clamped);
  }, []);

  const zoomIn = useCallback(() => {
    zoomAtViewportCenter(scaleRef.current * CANVAS_ZOOM_KEY_FACTOR);
  }, [zoomAtViewportCenter]);

  const zoomOut = useCallback(() => {
    zoomAtViewportCenter(scaleRef.current / CANVAS_ZOOM_KEY_FACTOR);
  }, [zoomAtViewportCenter]);

  const exportCanvasPng = useCallback(async () => {
    const grid = gridRef.current;
    if (!grid || !session) return;
    setExportingPng(true);
    const pad = 36;
    const gw = grid.scrollWidth;
    const gh = grid.scrollHeight;
    const w = gw + pad * 2;
    const h = gh + pad * 2;
    const wrap = document.createElement("div");
    wrap.style.boxSizing = "border-box";
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;
    wrap.style.padding = `${pad}px`;
    const canvasHost = grid.closest(".run-canvas");
    const bg =
      canvasHost instanceof HTMLElement
        ? getComputedStyle(canvasHost).backgroundColor
        : "";
    wrap.style.backgroundColor =
      bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "oklch(0.22 0.02 260)";
    const clone = grid.cloneNode(true) as HTMLElement;
    wrap.appendChild(clone);
    stripRunCanvasEntryAnimationsForExport(clone);
    document.body.appendChild(wrap);
    try {
      const dataUrl = await toPng(wrap, {
        pixelRatio: 1,
        width: w,
        height: h,
        cacheBust: true,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `canvas-${sanitizeFilenameBase(session.prompt, 50)}_${formatTimestampForFilename()}.png`;
      a.click();
    } finally {
      document.body.removeChild(wrap);
      setExportingPng(false);
    }
  }, [session]);

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

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!el.contains(document.activeElement)) return;
      if (isCanvasKeyboardTargetInteractive(document.activeElement)) return;

      const p = panRef.current;
      const s = scaleRef.current;
      let handled = false;

      if (e.key === "ArrowLeft") {
        setPan({ x: p.x - CANVAS_PAN_KEYBOARD_PX, y: p.y });
        handled = true;
      } else if (e.key === "ArrowRight") {
        setPan({ x: p.x + CANVAS_PAN_KEYBOARD_PX, y: p.y });
        handled = true;
      } else if (e.key === "ArrowUp") {
        setPan({ x: p.x, y: p.y - CANVAS_PAN_KEYBOARD_PX });
        handled = true;
      } else if (e.key === "ArrowDown") {
        setPan({ x: p.x, y: p.y + CANVAS_PAN_KEYBOARD_PX });
        handled = true;
      } else if (e.key === "+" || e.key === "=") {
        zoomAtViewportCenter(s * CANVAS_ZOOM_KEY_FACTOR);
        handled = true;
      } else if (e.key === "-" || e.key === "_") {
        zoomAtViewportCenter(s / CANVAS_ZOOM_KEY_FACTOR);
        handled = true;
      } else if (e.key === "0") {
        setPan({ ...CANVAS_DEFAULT_PAN });
        setScale(1);
        handled = true;
      }

      if (handled) e.preventDefault();
    };

    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [zoomAtViewportCenter]);

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
      const host = e.currentTarget as HTMLElement;
      host.setPointerCapture(e.pointerId);
      host.focus();
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
        <div className="run-canvas-toolbar__controls">
          <button
            type="button"
            className="btn-ghost btn-sm run-canvas-toolbar__btn"
            onClick={zoomOut}
            aria-label="缩小画布"
            title="缩小"
          >
            −
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm run-canvas-toolbar__btn"
            onClick={zoomIn}
            aria-label="放大画布"
            title="放大"
          >
            +
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm run-canvas-toolbar__btn"
            onClick={() => void exportCanvasPng()}
            disabled={exportingPng}
            aria-label="将线程画布导出为 PNG"
            title="导出为 PNG（100% 布局尺寸，含边距）"
          >
            {exportingPng ? "导出中…" : "导出 PNG"}
          </button>
          {onRetryAllFailedThreads ? (
            <button
              type="button"
              className="btn-ghost btn-sm run-canvas-toolbar__btn"
              disabled={
                running ||
                failedRetryableCount === 0 ||
                retryAllFailedBusy
              }
              aria-label={`批量重试失败线程，当前可恢复 ${failedRetryableCount} 条`}
              title={
                failedRetryableCount === 0
                  ? "当前没有可从失败点恢复的线程"
                  : `按顺序重试 ${failedRetryableCount} 条失败线程（与单线程「重试」相同逻辑）`
              }
              onClick={() => void onRetryAllFailedThreads()}
            >
              {retryAllFailedBusy
                ? "批量重试中…"
                : `批量重试失败（${failedRetryableCount}）`}
            </button>
          ) : null}
        </div>
        <span className="muted run-canvas-hint">
          空白处拖动平移画布 · 空白处滚轮缩放 · 卡片上 Ctrl/⌘+滚轮缩放 ·
          点击空白处后可使用键盘：方向键平移 · +/− 缩放 · 0 重置视图 ·
          每行最多 {gridLayout.threadsPerRow} 个线程、超出自动换行 ·
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
        role="region"
        aria-label="评测流程画布，可拖动与缩放"
        tabIndex={0}
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
            ref={gridRef}
            className="run-canvas-grid"
            style={
              {
                gridTemplateColumns: `repeat(${gridLayout.threadsPerRow}, minmax(${canvasGridMetrics.colMinEff}px, ${canvasGridMetrics.colMaxEff}px))`,
                gap: `${canvasGridMetrics.effectiveGap}px`,
                "--thread-column-max-width": `${canvasGridMetrics.colMaxEff}px`,
              } as CSSProperties
            }
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
                gridColMax={canvasGridMetrics.colMaxEff}
                setThreadJudgeScore={setThreadJudgeScore}
                setThreadHumanScore={setThreadHumanScore}
                onRetryThread={onRetryThread}
                onAbandonThread={onAbandonThread}
                onPauseThread={onPauseThread}
                onAbortJudgeSlot={onAbortJudgeSlot}
                onCancelThread={onCancelThread}
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
  /** 与当前视口下列宽上限一致，用于多评委时 thread-column 最小宽度 */
  gridColMax: number;
  setThreadJudgeScore: (
    genId: string,
    judgeId: string,
    score: number | undefined,
  ) => void;
  setThreadHumanScore: (genId: string, score: number | undefined) => void;
  onRetryThread: (genId: string) => void;
  onAbandonThread: (genId: string) => void;
  onPauseThread: (genId: string) => void;
  onAbortJudgeSlot: (
    genId: string,
    judgeId: string,
    reviewIndex: number,
  ) => void;
  onCancelThread: (genId: string) => void;
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
  if (prev.gridColMax !== next.gridColMax) return false;
  if (prev.session.id !== next.session.id) return false;
  if (prev.session.phase !== next.session.phase) return false;
  if (prev.session.error !== next.session.error) return false;
  const id = prev.generation.id;
  if (prev.threadScores[id] !== next.threadScores[id]) return false;
  if (prev.onRetryThread !== next.onRetryThread) return false;
  if (prev.onAbandonThread !== next.onAbandonThread) return false;
  if (prev.onPauseThread !== next.onPauseThread) return false;
  if (prev.onAbortJudgeSlot !== next.onAbortJudgeSlot) return false;
  if (prev.onCancelThread !== next.onCancelThread) return false;
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
  gridColMax,
  setThreadJudgeScore,
  setThreadHumanScore,
  onRetryThread,
  onAbandonThread,
  onPauseThread,
  onAbortJudgeSlot,
  onCancelThread,
}: ThreadColumnProps) {
  const frame = THREAD_FRAME[threadIndex % THREAD_FRAME.length];
  const pausedAtGen =
    g.threadPhase === "paused" && g.pausedPipelineStep?.step === "gen";
  const genStreamingDone =
    g.threadPhase !== "generating" && !pausedAtGen;

  const judgesComplete =
    judgeSlots.length === 0 ||
    judgeSlots.every((s) => findJudgeRun(g, s.judgeId, s.reviewIndex));

  const sessionDone = session.phase === "done";

  const failedAtAggregate =
    g.threadOutcome === "error" && g.failedPipelineStep?.step === "aggregate";
  const pausedAtAggregate =
    g.threadPhase === "paused" && g.pausedPipelineStep?.step === "aggregate";

  const showSummaryCard =
    aggregatorEnabled &&
    judgesComplete &&
    (g.aggregateText.length > 0 ||
      isWaitingAggregate(g, aggregatorEnabled) ||
      sessionDone ||
      failedAtAggregate ||
      pausedAtAggregate);

  const summaryDone =
    !aggregatorEnabled || (g.aggregateText.trim().length > 0 && sessionDone);
  const threadScorable =
    g.threadOutcome !== "error" &&
    g.threadOutcome !== "abandoned" &&
    g.threadPhase !== "paused";
  const showScoreBar =
    sessionDone && summaryDone && judgesComplete && threadScorable;

  const tIn = threadScores[g.id];
  const running = session.phase === "running";

  const threadPipelineActive =
    running &&
    (g.threadPhase === "generating" ||
      g.threadPhase === "judging" ||
      g.threadPhase === "aggregating");

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

  /** 多评委并列：理想宽度；不超过网格单列上限 */
  const threadMinWidthPx =
    judges.length > 1
      ? Math.min(
          gridColMax,
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
        } as CSSProperties
      }
    >
      <div className="thread-column__title thread-column__title--with-toolbar">
        <div className="thread-column__title-main">
          <span className="thread-column__title-line">
            线程 {threadIndex + 1} · {g.modelId}
          </span>
          <span className="thread-column__meta">样本 #{g.sampleIndex + 1}</span>
        </div>
        {running &&
        (threadPipelineActive ||
          g.threadPhase === "paused" ||
          (g.threadOutcome === "error" && g.failedPipelineStep)) ? (
          <div
            className="thread-column__toolbar"
            role="toolbar"
            aria-label="本线程流水线控制"
          >
            {g.threadOutcome === "error" && g.failedPipelineStep ? (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => onRetryThread(g.id)}
              >
                重试
              </button>
            ) : null}
            {threadPipelineActive ? (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => onPauseThread(g.id)}
              >
                暂停
              </button>
            ) : null}
            {g.threadPhase === "paused" ? (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => onRetryThread(g.id)}
              >
                恢复
              </button>
            ) : null}
            {threadPipelineActive || g.threadPhase === "paused" ? (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => onCancelThread(g.id)}
              >
                取消
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {g.pipelineError && g.threadOutcome === "error" ? (
        <div className="thread-column__thread-error" role="alert">
          <p className="thread-column__thread-error-msg">{g.pipelineError}</p>
          <div className="thread-column__thread-error-actions">
            {g.failedPipelineStep ? (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => onRetryThread(g.id)}
              >
                重试此线程
              </button>
            ) : null}
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => onAbandonThread(g.id)}
            >
              弃用线程（0 分）
            </button>
          </div>
        </div>
      ) : null}
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
                <div className="run-canvas-card__head run-canvas-card__head--with-status">
                  <span className="run-canvas-card__head-main">参赛生成</span>
                  <RunCardStreamBadge
                    sessionRunning={running}
                    streaming={g.streamingCard?.kind === "gen"}
                    paused={
                      g.threadPhase === "paused" &&
                      g.pausedPipelineStep?.step === "gen"
                    }
                    failed={
                      g.threadOutcome === "error" &&
                      g.failedPipelineStep?.step === "gen"
                    }
                  />
                </div>
                <pre className="run-canvas-card__body">
                  {g.text ||
                    (g.threadPhase === "generating" && running
                      ? "生成中…"
                      : g.threadPhase === "paused"
                        ? "已暂停"
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
                          const slotStreaming =
                            g.judgeStreamingSlots?.some(
                              (s) =>
                                s.judgeId === judge.id &&
                                s.reviewIndex === ri,
                            ) ?? false;
                          const pausedAtJudgeSlot =
                            g.threadPhase === "paused" &&
                            g.pausedPipelineStep?.step === "judge" &&
                            g.pausedPipelineStep.judgeId === judge.id &&
                            g.pausedPipelineStep.reviewIndex === ri;
                          const errorAtJudgeSlot =
                            g.threadOutcome === "error" &&
                            g.failedPipelineStep?.step === "judge" &&
                            g.failedPipelineStep.judgeId === judge.id &&
                            g.failedPipelineStep.reviewIndex === ri;
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
                                <div className="run-canvas-card__head run-canvas-card__head--with-status">
                                  <span className="run-canvas-card__head-main">
                                    Judge · {judge.name}
                                    <span className="run-canvas-card__sub">
                                      第 {ri + 1} 轮
                                    </span>
                                  </span>
                                  <div className="run-canvas-card__head-status-row">
                                    <RunCardStreamBadge
                                      sessionRunning={running}
                                      streaming={slotStreaming}
                                      paused={pausedAtJudgeSlot}
                                      failed={errorAtJudgeSlot}
                                    />
                                    {threadPipelineActive &&
                                    running &&
                                    slotStreaming ? (
                                      <button
                                        type="button"
                                        className="btn-ghost btn-sm"
                                        title="中止本槽位请求（其它并行 Judge 继续）"
                                        onClick={() =>
                                          onAbortJudgeSlot(
                                            g.id,
                                            judge.id,
                                            ri,
                                          )
                                        }
                                      >
                                        中断
                                      </button>
                                    ) : null}
                                    {pausedAtJudgeSlot || errorAtJudgeSlot ? (
                                      <button
                                        type="button"
                                        className="btn-primary btn-sm"
                                        title="仅重试本 Judge 槽位"
                                        onClick={() => onRetryThread(g.id)}
                                      >
                                        重试
                                      </button>
                                    ) : null}
                                  </div>
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
                  <div className="run-canvas-card__head run-canvas-card__head--with-status">
                    <span className="run-canvas-card__head-main">汇总</span>
                    <RunCardStreamBadge
                      sessionRunning={running}
                      streaming={g.streamingCard?.kind === "aggregate"}
                      paused={pausedAtAggregate}
                      failed={
                        g.threadOutcome === "error" &&
                        g.failedPipelineStep?.step === "aggregate"
                      }
                    />
                  </div>
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

/**
 * GraphView — renders an already-computed RenderGraph: measure → ELK layout → positioned boxes.
 *
 * STATIC LAYOUT: every node renders twice — once as a structure-only SKELETON in a hidden
 * measuring layer (no values, no states, no picker), once positioned at its laid-out box with
 * the painted instance's states and values. The skeleton layer is a pure function of the graph's
 * structure (`structureOf`), so it re-renders, and the view re-measures, only when the structure
 * changes; a selection, a progress tick or a value repaints the positioned layer on the existing
 * layout. Painted boxes take the laid-out size and every value line is clamped (styles.css), so
 * no value can push a box past it. A ResizeObserver on the skeletons still catches font loads.
 *
 * ROW DOCKS: the skeleton marks each operand row and the result row with `data-port`; their
 * measured centres become the leaf's port positions, so a wire lands on the row it feeds.
 *
 * Each layout request takes a generation number and only the latest one lands. Paint order is
 * areas (outer → inner, the graph's parents-first order), then the wire layer, then wire labels,
 * transforms and step cards — a wire deep inside an area never vanishes under a shallower area,
 * and cards sit above the wires that dock on them.
 *
 * ZOOM is view-only: the laid-out canvas sits in a scaler (`transform: scale(s)`) inside a spacer
 * sized `layout × s`, so the scroll extents follow the zoom and nothing relayouts. The measuring
 * layer stays outside the scaler and measures at scale 1. Ctrl/Meta+wheel and Safari's pinch zoom
 * around the cursor; a plain wheel scrolls. The dot grid sits behind everything, covering the
 * scroll area, with its origin on the graph's (0,0).
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DotGrid } from "./DotGrid.js";
import { isPair, kindOf, listItems, listLength } from "./datum.js";
import { defaultEngine, type ElkEngine } from "./elk-engine.js";
import { edgeLabel, edgeText, FRAME_RADIUS, isPage, isStub, layout, PORT_CHAR } from "./layout.js";
import {
  type Box,
  edgeLabelKey,
  type GraphMode,
  type InstanceRef,
  type LaidOutGraph,
  paintedState,
  type Point,
  portBase,
  portIds,
  portKey,
  type RenderFrame,
  type RenderEdge,
  type RenderGraph,
  type RenderInstance,
  type RenderNode,
  type RenderState,
  type RenderStep,
  type RenderTransform,
  type Size,
  type SkippedBecause,
} from "./types.js";

export interface StepContentProps {
  symbol: string;
  input: RenderStep["input"];
  output: RenderStep["output"];
  state: RenderState;
  mode: GraphMode;
  instance: InstanceRef;
  /** Why a `skipped` step did not run. */
  skippedBecause?: SkippedBecause;
}

export interface GraphViewProps {
  graph: RenderGraph;
  mode: GraphMode;
  /** Renders a step card's CONTENTS; the card chrome (border, state bar), ports and wires stay
   *  ours. Measured with values absent: mark operand rows `data-port="in:<slot>"` and the result
   *  row `data-port="out"` to dock wires on them; contents past the measured box are clipped. */
  renderNode?: (p: StepContentProps) => ReactNode;
  /** A picker tab was chosen (`ordinal`), or the "live" control asked to follow the run again
   *  (`undefined`). `frameId` is the z-frame's id. */
  onSelect?: (frameId: string, ordinal: number | undefined) => void;
  /** Defaults to the main-thread `elk.bundled.js` engine; `createWorkerEngine` moves layout off it. */
  engine?: ElkEngine;
  /** Called after each relayout lands, with its duration in ms (measure + ELK + apply). */
  onLayout?: (ms: number) => void;
}

const RELAYOUT_DEBOUNCE_MS = 50;
/** A structure that keeps changing still lands at least this often. */
const RELAYOUT_MAX_WAIT_MS = 250;
/** Past this many instances the picker is a stepper `‹ k/N ›`. */
export const TAB_CAP = 16;
/** The zoom range. */
export const SCALE_MIN = 0.2;
export const SCALE_MAX = 4;
/** One −/+ click. */
const SCALE_STEP = 1.25;
/** Ctrl/Meta+wheel: scale change per pixel of `deltaY` (here.build's canvas rate). */
const WHEEL_ZOOM_RATE = 0.005;

const clampScale = (s: number): number => Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));

// ── Values ───────────────────────────────────────────────────────────────────

const PREVIEW_MAX = 120;

/** Arrival's own print protocol: every AValue answers `["arrival/print"]()`. */
const isPrintable = (v: unknown): v is { "arrival/print": () => string } =>
  v != null && typeof (v as Record<string, unknown>)["arrival/print"] === "function";

/** A JS string, a boxed `String`, or arrival's string box. */
const isString = (v: unknown): boolean =>
  typeof v === "string" || Object.prototype.toString.call(v) === "[object String]" || kindOf(v) === "string";

/** The host JS value behind arrival's membrane box (`AJSObject`, `AJSArray`), if `v` is one. */
function hostSource(v: unknown): object | undefined {
  const source = (v as { source?: unknown }).source;
  const kind = kindOf(v);
  if (kind === "object" && typeof source === "object" && source !== null) return source;
  return kind === "vector" && Array.isArray(source) ? source : undefined;
}

/** `v` written as data: scheme values in their written form, strings quoted, host objects and
 *  arrays as `{key: value}` / `[a, b]`. Past the top level a sequence reads as its length and
 *  past the second a record as `{…}`; a long collection stops once the preview is full. */
function valueText(v: unknown, depth: number): string {
  if (isString(v)) return JSON.stringify(String(v));
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return String(v);
  const host = hostSource(v);
  if (host) return valueText(host, depth);
  if (isPair(v) && listLength(v) !== undefined) return sequenceText("(", " ", ")", listItems(v), depth);
  if (kindOf(v) === "vector") return sequenceText("#(", " ", ")", (v as { __vector__: unknown[] }).__vector__, depth);
  if (isPrintable(v)) return v["arrival/print"]();
  if (typeof v === "function") return "#<procedure>";
  if (Array.isArray(v)) return sequenceText("[", ", ", "]", v, depth);
  if (depth >= 2) return "{…}";
  const fields = joined(Object.keys(v), ", ", (k) => {
    const key = /^[$_a-z][\w$]*$/i.test(k) ? k : JSON.stringify(k);
    return `${key}: ${valueText((v as Record<string, unknown>)[k], depth + 1)}`;
  });
  return `{${fields}}`;
}

function sequenceText(open: string, sep: string, close: string, items: readonly unknown[], depth: number): string {
  if (depth >= 1) return `${open}${items.length} ${plural(items.length, "item")}${close}`;
  return open + joined(items, sep, (x) => valueText(x, depth + 1)) + close;
}

/** `items` written and joined, ending in `…` once the preview is full. */
function joined<T>(items: readonly T[], sep: string, text: (x: T) => string): string {
  const parts: string[] = [];
  let length = 0;
  for (const x of items) {
    if (length > PREVIEW_MAX) {
      parts.push("…");
      break;
    }
    const part = text(x);
    parts.push(part);
    length += part.length + sep.length;
  }
  return parts.join(sep);
}

/** One-line preview of a runtime value, truncated. */
export function preview(v: unknown): string {
  const text = valueText(v, 0);
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/** A result value: prose for a string (as harness reads an answer), mono data for the rest. */
function ValueText({ value }: { value: unknown }) {
  const prose = isString(value);
  const text = prose ? String(value) : preview(value);
  return (
    <span className="eg-value" data-type={prose ? "prose" : "data"} title={text}>
      {text.length > 400 ? `${text.slice(0, 399)}…` : text}
    </span>
  );
}

// ── States → words ───────────────────────────────────────────────────────────

const SKIP_REASON: Record<SkippedBecause, string> = {
  "not-taken": "not taken",
  "not-reached": "not reached",
};

/** The small-caps verb a state adds to a card's head (a resolved card says nothing). */
function verbOf(state: RenderState, skippedBecause: SkippedBecause | undefined): string {
  switch (state) {
    case "running":
      return "running";
    case "rejected":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return skippedBecause ? SKIP_REASON[skippedBecause] : "skipped";
    default:
      return "";
  }
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

const isDeviation = (s: RenderState): boolean => s === "running" || s === "rejected" || s === "cancelled";

// ── Step cards ───────────────────────────────────────────────────────────────

/** The card as a sentence: symbol · verb; the operands, one muted line each; a hairline; the
 *  result. The result row exists in actual mode whatever the state, so a card's rows — and its
 *  size — depend only on the mode and the operands. */
export function DefaultStepContent({
  symbol,
  input,
  output,
  state,
  mode,
  skippedBecause,
}: StepContentProps): ReactNode {
  const verb = verbOf(state, skippedBecause);
  let result: ReactNode = (
    <span className="eg-value" data-empty="">
      {" "}
    </span>
  );
  if (output.hasValue) result = <ValueText value={output.value} />;
  else if (output.error !== undefined)
    result = (
      <span
        className="eg-value"
        {...(state === "cancelled" ? { "data-empty": "" } : { "data-tone": "danger" })}
        title={output.error}
      >
        {output.error}
      </span>
    );
  return (
    <>
      <div className="eg-head" data-anchor="head">
        <span className="eg-symbol">{symbol}</span>
        <span className="eg-verb eg-label">
          {verb}
          {state === "running" && <span className="eg-spinner" aria-hidden />}
        </span>
      </div>
      {input.map((a) => {
        // A keyword argument is one row, `:key value`, in both modes.
        const key = a.slot.startsWith(":") ? `${a.slot} ` : "";
        const text = key + (mode === "actual" && a.hasValue ? preview(a.value) : a.source);
        return (
          <span key={a.slot} className="eg-row" data-port={`in:${a.slot}`} title={text}>
            {text}
          </span>
        );
      })}
      {mode === "actual" && (
        <div className="eg-result" data-port="out">
          {result}
        </div>
      )}
    </>
  );
}

interface StepBoxProps {
  step: RenderStep;
  mode: GraphMode;
  renderNode: (p: StepContentProps) => ReactNode;
  style?: React.CSSProperties;
}

function StepBox({ step, mode, renderNode, style }: StepBoxProps) {
  const { symbol, input, output, state, instance, skippedBecause } = step;
  return (
    <div className="eg-step" style={style} data-state={state} {...(step.unplanned ? { "data-unplanned": "" } : {})}>
      {renderNode({ symbol, input, output, state, mode, instance, ...(skippedBecause ? { skippedBecause } : {}) })}
    </div>
  );
}

// ── Transforms ───────────────────────────────────────────────────────────────

function TransformBox({ t, mode, style }: { t: RenderTransform; mode: GraphMode; style?: React.CSSProperties }) {
  return (
    <div className="eg-transform" style={style} data-state={t.state} title={t.text}>
      <span className="eg-label">{t.op}</span>
      <span className="eg-expr">{t.text}</span>
      {mode === "actual" && (
        <span className="eg-value-line" data-port="out">
          {t.hasValue ? (
            preview(t.value)
          ) : (
            <span className="eg-value" data-empty="">
              —
            </span>
          )}
        </span>
      )}
    </div>
  );
}

// ── Areas ────────────────────────────────────────────────────────────────────

/** What an area says about how its passes run — the render graph's caption, else the kind's. */
function captionOf(f: RenderFrame): string | undefined {
  if (f.caption !== undefined) return f.caption;
  switch (f.frame) {
    case "par":
      return "in parallel";
    case "loop":
      return "in loop";
    case "callback":
      return `×? via ${f.label}`;
    default:
      return undefined;
  }
}

const paramsOf = (f: RenderFrame): string[] =>
  f.ports.filter((p) => p.side === "in").map((p) => p.label ?? portBase(p.id).replace(/^in:/, ""));

/** The program's own top-level sequence says nothing: it is the page. */
const hasHead = (f: RenderFrame): boolean => !(f.frame === "seq" && isPage(f));

/** The structural half of an area's head: caption, name, function tab. Measured. */
function HeadTitle({ frame }: { frame: RenderFrame }) {
  const caption = captionOf(frame);
  if (frame.frame === "call") {
    return (
      <>
        <span className="eg-fn-tab">
          <span className="eg-frame-title">ƒ</span>
          {frame.symbol === undefined ? (
            <span className="eg-frame-title">{frame.label}</span>
          ) : (
            <span className="eg-symbol">{frame.symbol}</span>
          )}
          <span className="eg-frame-title">({paramsOf(frame).join(" ")})</span>
        </span>
        {caption !== undefined && <span className="eg-label">{caption}</span>}
      </>
    );
  }
  // A callback's caption already names its host.
  const name = frame.frame === "callback" && frame.caption === undefined ? undefined : frame.label;
  return (
    <>
      {frame.symbol !== undefined && <span className="eg-symbol">{frame.symbol}</span>}
      {caption !== undefined && <span className="eg-label">{caption}</span>}
      {name && (
        <span className="eg-frame-title">{frame.frame === "branch" && !frame.caption ? `? ${name}` : name}</span>
      )}
    </>
  );
}

function countText(f: RenderFrame): string | undefined {
  const p = f.progress;
  if (!p) return undefined;
  const settled = p.resolved + p.rejected + (p.cancelled ?? 0);
  return p.total === undefined ? `${settled} done` : `${settled} of ${p.total}`;
}

interface PickerProps {
  frame: RenderFrame & { instances: RenderInstance[] };
  onSelect: GraphViewProps["onSelect"];
}

/** The instance picker: tabs `#k` (a dot for deviations only), a stepper past `TAB_CAP`; follows
 *  the run until a click pins it, and a "live" control unpins. Arrow keys move along. */
function Picker({ frame, onSelect }: PickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const all = frame.instances;
  const selected = frame.selected ?? all.at(-1)?.ordinal;
  const at = Math.max(
    0,
    all.findIndex((i) => i.ordinal === selected),
  );
  const pick = (index: number) => {
    onSelect?.(frame.id, all[Math.max(0, Math.min(all.length - 1, index))]!.ordinal);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const moves: Partial<Record<string, number>> = {
      ArrowLeft: at - 1,
      ArrowRight: at + 1,
      Home: 0,
      End: all.length - 1,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    pick(next);
    requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLElement>(`[data-index="${Math.max(0, Math.min(all.length - 1, next))}"], .eg-stepper-text`)
        ?.focus(),
    );
  };
  const live = frame.pinned && (
    <button type="button" className="eg-live" title="Follow the run" onClick={() => onSelect?.(frame.id, undefined)}>
      live
    </button>
  );
  // What can widen the strip: the dots (deviation states) and the live control.
  const content = `${all.map((i) => (isDeviation(i.state) ? "•" : "")).join(",")}|${frame.pinned === true}`;
  const stepper = useStepper(ref, all.length, content);
  if (stepper) {
    const cur = all[at]!;
    return (
      <div ref={ref} className="eg-tabs" role="group" aria-label="instance" onKeyDown={onKeyDown}>
        <button
          type="button"
          className="eg-step-btn"
          aria-label="previous"
          disabled={at === 0}
          onClick={() => pick(at - 1)}
        >
          ‹
        </button>
        <span className="eg-stepper-text" tabIndex={0} aria-live="polite">
          {at + 1}/{all.length}
        </span>
        {isDeviation(cur.state) && <span className="eg-dot" data-state={cur.state} />}
        <button
          type="button"
          className="eg-step-btn"
          aria-label="next"
          disabled={at === all.length - 1}
          onClick={() => pick(at + 1)}
        >
          ›
        </button>
        {live}
      </div>
    );
  }
  return (
    <div ref={ref} className="eg-tabs" role="tablist" aria-label="instance" onKeyDown={onKeyDown}>
      {all.map((inst, i) => (
        <button
          key={inst.ordinal}
          type="button"
          role="tab"
          className="eg-tab"
          data-index={i}
          aria-selected={i === at}
          tabIndex={i === at ? 0 : -1}
          onClick={() => pick(i)}
        >
          #{inst.ordinal + 1}
          {isDeviation(inst.state) && <span className="eg-dot" data-state={inst.state} />}
        </button>
      ))}
      {live}
    </div>
  );
}

/**
 * Tabs or the stepper: past `TAB_CAP`, or when the tabs overflow the head's tail (the area's
 * width is static, the instance count is not). An overflow at `n` instances and tail width `w`
 * keeps the stepper for every count ≥ n at width ≤ w; a wider tail tries tabs again. Paint-only:
 * the measured head reserves a constant picker room the stepper always fits in.
 */
function useStepper(ref: React.RefObject<HTMLDivElement | null>, count: number, content: string): boolean {
  const [width, setWidth] = useState(0);
  const [overflowed, setOverflowed] = useState<{ count: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const tail = ref.current?.parentElement;
    if (!tail || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(tail.clientWidth));
    ro.observe(tail);
    return () => ro.disconnect();
  }, [ref]);
  const stepper = count > TAB_CAP || (overflowed !== null && count >= overflowed.count && width <= overflowed.width);
  useLayoutEffect(() => {
    const tail = ref.current?.parentElement;
    if (stepper || !tail) return;
    // A layout measurement: the overflow is only known after the tabs paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tail.scrollWidth > tail.clientWidth + 1) setOverflowed({ count, width: tail.clientWidth });
  }, [ref, stepper, count, width, content]);
  return stepper;
}

interface FrameBoxProps {
  frame: RenderFrame;
  mode: GraphMode;
  first?: boolean;
  onSelect?: GraphViewProps["onSelect"];
  style?: React.CSSProperties;
}

/** An area: a whisper box with its head above the border; an arm is a lane titled by its guard;
 *  a collapsed frame (a recursion stub) is a pill. */
function FrameBox({ frame, mode, first, onSelect, style }: FrameBoxProps) {
  const attrs = {
    className: "eg-frame",
    style,
    "data-state": frame.state,
    "data-frame": frame.frame,
    ...(isStub(frame) ? { "data-collapsed": "" } : {}),
    ...(first ? { "data-first": "" } : {}),
  };
  if (frame.frame === "arm") {
    return (
      <div {...attrs}>
        <div className="eg-lane-title">
          <span>{frame.label}</span>
          {frame.state === "skipped" && <span className="eg-label">{verbOf("skipped", frame.skippedBecause)}</span>}
        </div>
      </div>
    );
  }
  if (frame.collapsed) {
    return (
      <div {...attrs}>
        <StubTitle frame={frame} />
      </div>
    );
  }
  const count = countText(frame);
  const picker = mode === "actual" && frame.instances && frame.instances.length > 0;
  if (!hasHead(frame)) return <div {...attrs} />;
  return (
    <div {...attrs}>
      <div className="eg-frame-head">
        <HeadTitle frame={frame} />
        <div className="eg-frame-tail">
          {picker && <Picker frame={frame as PickerProps["frame"]} onSelect={onSelect} />}
          {count !== undefined && <span className="eg-count">{count}</span>}
          {frame.state === "skipped" && <span className="eg-label">{verbOf("skipped", frame.skippedBecause)}</span>}
        </div>
      </div>
    </div>
  );
}

/** `↺ name` — a recursion stub (the glyph leads, whether or not the label already carries it). */
function StubTitle({ frame }: { frame: RenderFrame }) {
  const name = (frame.symbol ?? frame.label).replaceAll("↺", "").trim();
  return (
    <>
      <span className="eg-frame-title">{frame.frame === "call" ? "↺" : "▸"}</span>
      <span className={frame.symbol === undefined ? "eg-frame-title" : "eg-symbol"}>{name}</span>
    </>
  );
}

/** The measured half of a frame: its head (or lane title, or pill) — structure only. */
function FrameSkeleton({ frame, mode }: { frame: RenderFrame; mode: GraphMode }) {
  if (frame.frame === "arm") {
    return (
      <div className="eg-frame" data-frame="arm">
        <div className="eg-lane-title">
          <span>{frame.label}</span>
        </div>
      </div>
    );
  }
  if (frame.collapsed) {
    return (
      <div className="eg-frame" data-frame={frame.frame} data-collapsed="">
        <StubTitle frame={frame} />
      </div>
    );
  }
  return (
    <div className="eg-frame" data-frame={frame.frame}>
      {hasHead(frame) && (
        <div className="eg-frame-head">
          <HeadTitle frame={frame} />
          {/* A z-frame's picker gets a constant room, whatever its instance count: the stepper,
              the count and the "live" control always fit, and tabs are used when they fit too. */}
          {mode === "actual" && frame.instances !== undefined && <span className="eg-picker-room" />}
        </div>
      )}
    </div>
  );
}

const EdgeLabel = ({ edge, style }: { edge: RenderEdge; style?: React.CSSProperties }) => {
  const label = edgeLabel(edge);
  return (
    label && (
      <span className="eg-edge-label" data-label={label.kind} style={style} title={label.text}>
        {label.text}
      </span>
    )
  );
};

// ── Wires ────────────────────────────────────────────────────────────────────

const toward = (p: Point, q: Point, len: number): Point => {
  const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: p.x + ((q.x - p.x) / l) * len, y: p.y + ((q.y - p.y) / l) * len };
};

/** A polyline with rounded corners (radius clamped to half of each adjacent segment). */
function roundedPath(pts: Point[], radius: number): string {
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const p1 = toward(b, a, r);
    const p2 = toward(b, c, r);
    d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
  }
  const last = pts.at(-1)!;
  return `${d} L${last.x},${last.y}`;
}

const horizontal = (a: Point, b: Point): boolean => Math.abs(a.y - b.y) < 0.5;

/** At most one jog, leaving and entering horizontally, left to right. */
function isSimple(pts: Point[]): boolean {
  const [a, b] = [pts[0]!, pts.at(-1)!];
  return (pts.length === 2 || pts.length === 4) && b.x > a.x && horizontal(a, pts[1]!) && horizontal(pts.at(-2)!, b);
}

/** Whether a curve between the route's ends would cross a card: its bounding box (inset by a
 *  hair, so the two docked cards themselves do not count) meets any leaf box. */
function curveHitsBox(pts: Point[], obstacles: readonly Box[]): boolean {
  const [a, b] = [pts[0]!, pts.at(-1)!];
  const [x0, x1, y0, y1] = [Math.min(a.x, b.x) + 1, Math.max(a.x, b.x) - 1, Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return obstacles.some((o) => o.x < x1 && o.x + o.width > x0 && o.y < y1 + 1 && o.y + o.height > y0 - 1);
}

/**
 * A wire's shape. ELK routes orthogonally (that is what spaces the channels); a SIMPLE route — at
 * most one jog, leaving and entering horizontally, running left to right — is redrawn as
 * harness's horizontal-tangent S-curve between the two docks. Such a curve stays inside the
 * jog's own bounding box, which ELK kept clear between two adjacent layers, so it crosses no box
 * the route did not. Longer routes (around areas, into a `control` port from above, backwards)
 * keep ELK's channels, with soft corners.
 */
function wirePath(pts: Point[], obstacles: readonly Box[]): string {
  const [a, b] = [pts[0]!, pts.at(-1)!];
  if (!isSimple(pts) || curveHitsBox(pts, obstacles)) return roundedPath(pts, 10);
  const dx = Math.abs(b.x - a.x);
  if (dx < 48) {
    const mx = (a.x + b.x) / 2;
    return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
  }
  const h = Math.max(24, Math.min(dx / 2, 90));
  return `M${a.x},${a.y} C${a.x + h},${a.y} ${b.x - h},${b.y} ${b.x},${b.y}`;
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Where `p` lies along the route, as a distance from its start; undefined when off it. */
function alongRoute(pts: Point[], p: Point): number | undefined {
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len || 1)));
    if (Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))) < 0.75) return run + t * len;
    run += len;
  }
  return undefined;
}

/** The part of a route after `from` (a distance along it). */
function routeAfter(pts: Point[], from: number): Point[] {
  const out: Point[] = [];
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (run + len > from) {
      if (out.length === 0) out.push(toward(a, b, from - run));
      out.push(b);
    }
    run += len;
  }
  return out.length >= 2 ? out : pts;
}

/** Where a wire's label pill sits: on the wire — the curve's midpoint for a simple S-curve,
 *  else the middle of the route's longest segment. ELK's label box only reserves the room. A
 *  branch of a bus (`forks`: the bus's fork points) carries it on its own part, after the last
 *  fork, never on the trunk it shares. */
function labelCentre(pts: Point[], obstacles: readonly Box[], forks?: readonly Point[]): Point {
  const [a, b] = [pts[0]!, pts.at(-1)!];
  if (!forks && isSimple(pts) && !curveHitsBox(pts, obstacles)) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const last = Math.max(0, ...(forks ?? []).map((f) => alongRoute(pts, f) ?? 0));
  const own = forks ? routeAfter(pts, last) : pts;
  const len = (i: number): number => Math.hypot(own[i + 1]!.x - own[i]!.x, own[i + 1]!.y - own[i]!.y);
  let best = 0;
  for (let i = 1; i < own.length - 1; i++) if (len(i) > len(best)) best = i;
  // The pill rides a horizontal run when there is a roomy one: a vertical run hugs the cards.
  if (!horizontal(own[best]!, own[best + 1]!)) {
    for (let i = 0; i < own.length - 1; i++)
      if (
        horizontal(own[i]!, own[i + 1]!) &&
        len(i) >= 56 &&
        (!horizontal(own[best]!, own[best + 1]!) || len(i) > len(best))
      )
        best = i;
  }
  return { x: (own[best]!.x + own[best + 1]!.x) / 2, y: (own[best]!.y + own[best + 1]!.y) / 2 };
}

/** Where an edge's label pill is centred: a loop return's where the layout put it (on the contour's
 *  bottom run), any other wire's on the wire. */
function labelAnchor(e: RenderEdge, pts: Point[], laid: LaidOutGraph, obstacles: readonly Box[]): Point {
  if (e.kind !== "recur") return labelCentre(pts, obstacles, laid.bus.get(e.id));
  const box = laid.labels.get(e.id);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : midpoint(pts.at(-3)!, pts.at(-2)!);
}

function arrowHead(pts: Point[]): string {
  const tip = pts.at(-1)!;
  const from = pts.at(-2)!;
  const l = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const [ux, uy] = [(tip.x - from.x) / l, (tip.y - from.y) / l];
  const [bx, by] = [tip.x - ux * 6, tip.y - uy * 6];
  return `M${tip.x},${tip.y} L${bx - uy * 3},${by + ux * 3} L${bx + uy * 3},${by - ux * 3} Z`;
}

/** Where a port label lands, as its x and anchor: outside the area by default (so it never
 *  overprints a child's content), inside the border when the outside would leave the canvas. */
function portLabelAt(
  pt: Point,
  side: "in" | "out",
  text: string,
  width: number,
): { x: number; anchor: "start" | "end" } {
  const room = text.length * PORT_CHAR + 5;
  const outwards = side === "out" ? pt.x + room <= width : pt.x - room >= 0;
  return outwards === (side === "out") ? { x: pt.x + 5, anchor: "start" } : { x: pt.x - 5, anchor: "end" };
}

const RESULT_STUB = 14;

/** Where the nodes feeding the page's own `out` (the program's result) end: the stub starts there. */
function resultEnds(graph: RenderGraph, laid: LaidOutGraph): Map<string, Point> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const result = new Map<string, Point>();
  for (const e of graph.edges) {
    if (!isPage(byId.get(e.to.node)) || e.to.port !== portIds.out || isPage(byId.get(e.from.node))) continue;
    const key = portKey(e.from.node, e.from.port);
    const box = laid.boxes.get(e.from.node);
    const at = laid.ports.get(key) ?? (box && { x: box.x + box.width, y: box.y + box.height / 2 });
    if (at && !result.has(key)) result.set(key, at);
  }
  return result;
}

/** The right edge of the result terminals (stub, cap and word), 0 when there are none. */
const resultReach = (result: ReadonlyMap<string, Point>): number =>
  Math.max(0, ...[...result.values()].map((at) => at.x + RESULT_STUB + 7 + 6 * PORT_CHAR + 2));

/** The canvas as drawn: the layout plus the result terminal that hangs past its right edge. This
 *  is what the scroll extent and "fit" measure. */
export const canvasSize = (graph: RenderGraph, laid: LaidOutGraph): Size => ({
  width: Math.max(laid.width, resultReach(resultEnds(graph, laid))),
  height: laid.height,
});

/** Wires carry `data-kind` and `data-state`; styles.css dims the not-yet-real ones. Area ports
 *  that a wire crosses and continues past get a hollow ring. The node feeding the page's own
 *  `out` (the program's result; that wire is not routed) ends in a short stub and a "result" cap.
 *  Only the loop return has an arrowhead. */
function EdgeLayer({ graph, laid, obstacles }: { graph: RenderGraph; laid: LaidOutGraph; obstacles: readonly Box[] }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const routed = graph.edges.filter((e) => laid.edges.has(e.id));
  const wired = new Set(routed.flatMap((e) => [portKey(e.from.node, e.from.port), portKey(e.to.node, e.to.port)]));
  // a wire that leaves an out port: the ring says "the value crosses here and goes on"
  const leaving = new Set(routed.map((e) => portKey(e.from.node, e.from.port)));
  const result = resultEnds(graph, laid);
  // the cap and its word may reach into the canvas's right margin: the svg grows to hold them
  const reach = resultReach(result);
  // crossings: where a bus enters an area through a layout-only port (absent in older layouts)
  const crossings = (laid as { crossings?: readonly Point[] }).crossings ?? [];
  return (
    <svg className="eg-edges" width={Math.max(laid.width, reach)} height={laid.height}>
      {graph.edges.map((e) => {
        const pts = laid.edges.get(e.id);
        if (!pts || pts.length < 2) return null;
        const recur = e.kind === "recur";
        // A branch of a bus stays orthogonal (a curve would leave the trunk it shares) and dots
        // every fork on its route.
        const forks = laid.bus.get(e.id);
        let d = wirePath(pts, obstacles);
        if (recur) d = roundedPath(pts, FRAME_RADIUS);
        else if (forks) d = roundedPath(pts, 10);
        const state = paintedState(e, byId);
        return (
          <g key={e.id} className="eg-edge" data-kind={e.kind} {...(state ? { "data-state": state } : {})}>
            <path className="eg-edge-line" d={d} />
            {recur && <path className="eg-arrow" d={arrowHead(pts)} />}
            {forks
              ?.filter((f) => alongRoute(pts, f) !== undefined)
              .map((f) => (
                <circle key={`${f.x},${f.y}`} className="eg-fork" cx={f.x} cy={f.y} r={2.5} />
              ))}
          </g>
        );
      })}
      {crossings.map((c) => (
        <circle key={`${c.x},${c.y}`} className="eg-port" cx={c.x} cy={c.y} r={2.5} />
      ))}
      {[...result].map(([key, at]) => {
        const end = at.x + RESULT_STUB;
        return (
          <g key={key} className="eg-final">
            <path className="eg-final-line" d={`M${at.x},${at.y} L${end},${at.y}`} />
            <circle className="eg-final-cap" cx={end} cy={at.y} r={3} />
            <text className="eg-final-label" x={end + 7} y={at.y + 4}>
              result
            </text>
          </g>
        );
      })}
      {graph.nodes.flatMap((n) => {
        if (n.kind !== "frame" || isPage(n)) return [];
        return n.ports.map((p) => {
          const k = portKey(n.id, p.id);
          const pt = laid.ports.get(k);
          if (!pt || !wired.has(k) || (p.side === "out" && !leaving.has(k))) return null;
          const at =
            p.label && (p.side === "in" || p.side === "out") ? portLabelAt(pt, p.side, p.label, laid.width) : undefined;
          return (
            <g key={k}>
              <circle className="eg-port" cx={pt.x} cy={pt.y} r={2.5} />
              {/* beside the ring, so it never overprints a child's content; a call's tab
                  already names its params */}
              {at && p.label && n.frame !== "call" && (
                <text className="eg-port-label" x={at.x} y={pt.y - 5} textAnchor={at.anchor}>
                  {p.label}
                </text>
              )}
            </g>
          );
        });
      })}
    </svg>
  );
}

// ── Structure ────────────────────────────────────────────────────────────────

const boxStyle = (b: Box): React.CSSProperties => ({ left: b.x, top: b.y, width: b.width, height: b.height });

const sameSizes = (a: ReadonlyMap<string, number | Size>, b: ReadonlyMap<string, number | Size>): boolean =>
  a.size === b.size && [...a].every(([k, s]) => JSON.stringify(b.get(k)) === JSON.stringify(s));

/** Everything that can move a box or a wire: ids, nesting, ports, the text a skeleton prints
 *  (symbols, operand sources, captions, labels, transform expressions), wire endpoints and
 *  labels, collapse, and the mode (which decides whether a card has a result row). Selection,
 *  instances, states and values are not in it — they repaint on the existing layout. */
export function structureOf(graph: RenderGraph, mode: GraphMode): string {
  return JSON.stringify([
    mode,
    graph.nodes.map((n) => {
      const common = [n.kind, n.id, n.parent, n.ports];
      if (n.kind === "step") return [...common, n.symbol, n.input.map((a) => [a.slot, a.source])];
      if (n.kind === "transform") return [...common, n.op, n.text];
      return [...common, n.frame, n.label, n.symbol, n.caption, n.collapsed === true, n.instances !== undefined];
    }),
    graph.edges.map((e) => [e.id, e.kind, e.from, e.to, edgeText(e)]),
  ]);
}

/** A node as the skeleton layer draws it: its structure, none of its run. */
function Skeleton({
  node,
  mode,
  renderNode,
}: {
  node: RenderNode;
  mode: GraphMode;
  renderNode: (p: StepContentProps) => ReactNode;
}) {
  if (node.kind === "frame") return <FrameSkeleton frame={node} mode={mode} />;
  const state: RenderState = mode === "actual" ? "pending" : "potential";
  if (node.kind === "transform")
    return <TransformBox t={{ ...node, state, hasValue: false, value: undefined }} mode={mode} />;
  return (
    <StepBox
      step={{
        ...node,
        state,
        input: node.input.map(({ slot, source }) => ({ slot, source, hasValue: false })),
        output: { hasValue: false },
        unplanned: false,
      }}
      mode={mode}
      renderNode={renderNode}
    />
  );
}

/** The element whose box is a node's measured size: a step or transform box, an area's head, an
 *  arm's lane title, a stub pill. */
const MEASURED = ".eg-step, .eg-transform, .eg-frame[data-collapsed], .eg-frame-head, .eg-lane-title";

// ── Zoom ─────────────────────────────────────────────────────────────────────

/** A viewport point (from the scroll area's top-left) and the canvas point, in layout units,
 *  that must land under it once the new scale commits. */
interface ZoomAnchor {
  at: Point;
  canvas: Point;
}

/**
 * View-only zoom over the scroll area `viewport` holding the scaled `extent` (both refs are the
 * hook's own, for the caller to attach). A change keeps the
 * canvas point under the cursor (or the viewport's centre) fixed by adjusting the scroll once the
 * new extent commits. Several changes before a commit keep the first one's canvas point.
 */
function useZoom(size: Size | undefined) {
  const viewport = useRef<HTMLDivElement>(null);
  const extent = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const current = useRef(1);
  const anchor = useRef<ZoomAnchor | null>(null);

  const scrollTo = useCallback(
    (a: ZoomAnchor, s: number) => {
      const v = viewport.current;
      const e = extent.current;
      if (!v || !e) return;
      v.scrollLeft = e.offsetLeft + a.canvas.x * s - a.at.x;
      v.scrollTop = e.offsetTop + a.canvas.y * s - a.at.y;
    },
    [viewport, extent],
  );

  const commit = useCallback(
    (next: number, a: ZoomAnchor) => {
      const s = clampScale(next);
      if (s === current.current) {
        if (!anchor.current) scrollTo(a, s);
        return;
      }
      anchor.current = a;
      current.current = s;
      setScale(s);
    },
    [scrollTo],
  );

  /** Zoom to `next` around the client point `client`, else the viewport's centre. */
  const zoomTo = useCallback(
    (next: number, client?: Point) => {
      const v = viewport.current;
      const e = extent.current;
      if (!v || !e) return;
      const vr = v.getBoundingClientRect();
      const at = client
        ? { x: client.x - vr.left, y: client.y - vr.top }
        : { x: v.clientWidth / 2, y: v.clientHeight / 2 };
      const s = current.current;
      const canvas = anchor.current?.canvas ?? {
        x: (v.scrollLeft + at.x - e.offsetLeft) / s,
        y: (v.scrollTop + at.y - e.offsetTop) / s,
      };
      commit(next, { at, canvas });
    },
    [viewport, extent, commit],
  );

  /** The whole graph in the viewport (within the zoom range), scrolled to its top-left. */
  const fit = useCallback(() => {
    const v = viewport.current;
    const e = extent.current;
    if (!v || !e || !size) return;
    const width = v.clientWidth - 2 * e.offsetLeft;
    const height = v.clientHeight - e.offsetTop - e.offsetLeft;
    const at = { x: e.offsetLeft, y: e.offsetTop };
    commit(Math.min(width / size.width, height / size.height), { at, canvas: { x: 0, y: 0 } });
  }, [viewport, extent, size, commit]);

  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (a) scrollTo(a, scale);
  }, [scale, scrollTo]);

  // Ctrl/Meta+wheel and Safari's pinch; both must cancel the page zoom, so neither is passive.
  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(current.current * (1 - e.deltaY * WHEEL_ZOOM_RATE), { x: e.clientX, y: e.clientY });
    };
    let start = 1;
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      start = current.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      zoomTo(start * g.scale, { x: g.clientX, y: g.clientY });
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    v.addEventListener("wheel", onWheel, { passive: false });
    v.addEventListener("gesturestart", onGestureStart);
    v.addEventListener("gesturechange", onGestureChange);
    v.addEventListener("gestureend", onGestureEnd);
    return () => {
      v.removeEventListener("wheel", onWheel);
      v.removeEventListener("gesturestart", onGestureStart);
      v.removeEventListener("gesturechange", onGestureChange);
      v.removeEventListener("gestureend", onGestureEnd);
    };
  }, [viewport, zoomTo]);

  return { viewport, extent, scale, zoomTo, fit };
}

/** −, the percentage (click: back to 100%), +, fit. */
function ZoomControl({ scale, zoomTo, fit }: Pick<ReturnType<typeof useZoom>, "scale" | "zoomTo" | "fit">) {
  return (
    <div className="eg-zoom" role="group" aria-label="zoom">
      <button
        type="button"
        className="eg-step-btn"
        aria-label="zoom out"
        disabled={scale <= SCALE_MIN}
        onClick={() => zoomTo(scale / SCALE_STEP)}
      >
        −
      </button>
      <button
        type="button"
        className="eg-step-btn eg-zoom-readout"
        aria-label="reset zoom to 100%"
        onClick={() => zoomTo(1)}
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        className="eg-step-btn"
        aria-label="zoom in"
        disabled={scale >= SCALE_MAX}
        onClick={() => zoomTo(scale * SCALE_STEP)}
      >
        +
      </button>
      <button type="button" className="eg-step-btn" aria-label="fit to view" onClick={fit}>
        fit
      </button>
    </div>
  );
}

export function GraphView({
  graph,
  mode,
  renderNode = DefaultStepContent,
  onSelect,
  engine,
  onLayout,
}: GraphViewProps) {
  const [laid, setLaid] = useState<LaidOutGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  const measureEls = useRef(new Map<string, HTMLElement>());
  const sizes = useRef<Map<string, Size>>(new Map());
  const anchors = useRef<Map<string, number>>(new Map());
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSince = useRef<number | null>(null);
  const measureMs = useRef(0);
  const landing = useRef<number | null>(null);
  const latest = useRef({ graph, engine, onLayout });
  useLayoutEffect(() => {
    latest.current = { graph, engine, onLayout };
  }, [graph, engine, onLayout]);

  const relayout = useCallback(async () => {
    const gen = ++generation.current;
    const started = performance.now() - measureMs.current;
    const { graph: g, engine: e } = latest.current;
    try {
      const out = await layout(g, sizes.current, e ?? defaultEngine, anchors.current);
      if (gen !== generation.current) return; // a newer request superseded this one
      landing.current = started;
      setLaid(out);
      setError(null);
    } catch (error_: unknown) {
      if (gen === generation.current) setError(error_ instanceof Error ? error_.message : String(error_));
    }
  }, []);

  /** Trailing debounce with a max wait: a burst of changes settles into one relayout, but a
   *  structure that never stops changing still lands every `RELAYOUT_MAX_WAIT_MS`. */
  const schedule = useCallback(() => {
    const now = performance.now();
    pendingSince.current ??= now;
    clearTimeout(timer.current);
    const wait = Math.max(0, Math.min(RELAYOUT_DEBOUNCE_MS, pendingSince.current + RELAYOUT_MAX_WAIT_MS - now));
    timer.current = setTimeout(() => {
      pendingSince.current = null;
      void relayout();
    }, wait);
  }, [relayout]);

  /** Read every skeleton's size and row docks; schedule a relayout when any changed (or `force`). */
  const measure = useCallback(
    (force: boolean) => {
      const t0 = performance.now();
      const nextSizes = new Map<string, Size>();
      const nextAnchors = new Map<string, number>();
      for (const [id, wrapper] of measureEls.current) {
        const el = wrapper.querySelector<HTMLElement>(MEASURED) ?? wrapper;
        const r = el.getBoundingClientRect();
        nextSizes.set(id, { width: Math.ceil(r.width), height: Math.ceil(r.height) });
        if (!el.matches(".eg-step, .eg-transform")) continue;
        const head = el.querySelector<HTMLElement>("[data-anchor=head]");
        for (const row of [...el.querySelectorAll<HTMLElement>("[data-port]"), ...(head ? [head] : [])]) {
          const port = row.dataset.port ?? "out";
          const key = portKey(id, port);
          if (nextAnchors.has(key)) continue;
          const rr = row.getBoundingClientRect();
          nextAnchors.set(key, Math.round(rr.top - r.top + rr.height / 2));
        }
      }
      measureMs.current = performance.now() - t0;
      if (!force && sameSizes(nextSizes, sizes.current) && sameSizes(nextAnchors, anchors.current)) return;
      sizes.current = nextSizes;
      anchors.current = nextAnchors;
      schedule();
    },
    [schedule],
  );

  // The skeleton layer re-renders, and the view re-measures, only on a structural change.
  const structure = useMemo(() => structureOf(graph, mode), [graph, mode]);
  // The graph as of its last structural change: what the skeletons are drawn from.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const structural = useMemo(() => graph, [structure]);
  useLayoutEffect(() => measure(true), [structure, renderNode, engine, measure]);

  useLayoutEffect(() => {
    if (landing.current === null) return;
    latest.current.onLayout?.(performance.now() - landing.current);
    landing.current = null;
  }, [laid]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure(false));
    for (const el of measureEls.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [structure, renderNode, measure]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const skeletons = useMemo(() => {
    const g = structural;
    const measured = (id: string) => (el: HTMLElement | null) => {
      if (el) measureEls.current.set(id, el);
      else measureEls.current.delete(id);
    };
    return (
      <div className="eg-measure-layer" aria-hidden>
        {g.nodes.map((n) => (
          <div key={`n:${n.id}`} ref={measured(n.id)} className="eg-measured">
            <Skeleton node={n} mode={mode} renderNode={renderNode} />
          </div>
        ))}
        {g.edges.map((e) => {
          const text = edgeText(e);
          return (
            text !== undefined && (
              <div key={`l:${e.id}`} ref={measured(edgeLabelKey(e.id))} className="eg-measured">
                <EdgeLabel edge={e} />
              </div>
            )
          );
        })}
      </div>
    );
  }, [structural, mode, renderNode]);

  const drawn = useMemo(() => (laid ? canvasSize(graph, laid) : undefined), [graph, laid]);
  const zoom = useZoom(drawn);
  const { viewport, extent } = zoom;
  // Where the graph's (0,0) sits in the scroll area — the scroll area's padding: the dot grid's origin.
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const e = extent.current;
    // A layout measurement, read once the spacer is in the DOM.
    if (e) setOrigin({ x: e.offsetLeft, y: e.offsetTop });
  }, [extent]);

  const { unplacedInvocations, droppedEdges, notes, dataflow } = graph.diagnostics;
  const frames = graph.nodes.filter((n): n is RenderFrame => n.kind === "frame");
  // The first arm of each condition: the lane without a divider above it.
  const firstArms = new Set(
    new Map(
      frames
        .filter((f) => f.frame === "arm")
        .toReversed()
        .map((a) => [a.parent, a.id]),
    ).values(),
  );
  const leaves = graph.nodes.filter((n): n is RenderStep | RenderTransform => n.kind !== "frame");
  const obstacles = laid ? [...leaves, ...frames.filter(isStub)].flatMap((n) => laid.boxes.get(n.id) ?? []) : [];

  return (
    <div className="eg-graph" data-mode={mode}>
      {(unplacedInvocations > 0 || droppedEdges > 0) && (
        <div className="eg-message eg-badge" data-tone="warning" title={notes.join("\n")}>
          {unplacedInvocations > 0 && `${unplacedInvocations} unplaced`}{" "}
          {droppedEdges > 0 && `${droppedEdges} edges dropped`}
        </div>
      )}
      {dataflow && dataflow.status !== "complete" && (
        <div
          className="eg-message eg-banner"
          data-tone="warning"
          role="status"
          {...(dataflow.reason ? { title: dataflow.reason } : {})}
        >
          {dataflow.status === "unavailable"
            ? "Data edges unavailable for this program (an arrival limitation) — steps are shown without them; a missing edge does not mean independence."
            : `Dataflow partial — ${dataflow.missing} ${plural(dataflow.missing, "link")} could not be traced.`}
        </div>
      )}
      {error && (
        <div className="eg-message" data-tone="danger">
          layout failed: {error}
        </div>
      )}
      <div ref={viewport} className="eg-viewport">
        <div className="eg-scroll">
          <DotGrid scale={zoom.scale} origin={origin} />
          {skeletons}
          <div
            ref={extent}
            className="eg-extent"
            style={drawn ? { width: drawn.width * zoom.scale, height: drawn.height * zoom.scale } : undefined}
          >
            {laid && (
              // Until a new layout lands the previous one stays up; ids it lacks simply don't render.
              <div
                className="eg-canvas"
                style={{ width: laid.width, height: laid.height, transform: `scale(${zoom.scale})` }}
              >
                {frames.map((f) => {
                  const b = laid.boxes.get(f.id);
                  return (
                    b && (
                      <FrameBox
                        key={f.id}
                        frame={f}
                        mode={mode}
                        first={firstArms.has(f.id)}
                        {...(onSelect ? { onSelect } : {})}
                        style={boxStyle(b)}
                      />
                    )
                  );
                })}
                <EdgeLayer graph={graph} laid={laid} obstacles={obstacles} />
                {graph.edges.map((e) => {
                  const pts = laid.edges.get(e.id);
                  if (!pts || pts.length < 2 || edgeText(e) === undefined) return null;
                  // A routed wire's label has its room reserved by ELK; a loop return's pill sits where
                  // the layout put it, on the contour's bottom run. Either way it is centred on the wire.
                  if (!laid.labels.has(e.id) && e.kind !== "recur") return null;
                  const c = labelAnchor(e, pts, laid, obstacles);
                  // never half off the canvas: a pill on a run at the edge is pulled inside
                  const half = (laid.labels.get(e.id)?.width ?? Math.min(edgeText(e)!.length, 34) * PORT_CHAR + 10) / 2;
                  const left = Math.max(half, Math.min(c.x, laid.width - half));
                  return <EdgeLabel key={e.id} edge={e} style={{ left, top: c.y, translate: "-50% -50%" }} />;
                })}
                {leaves.map((n) => {
                  const b = laid.boxes.get(n.id);
                  if (!b) return null;
                  return n.kind === "step" ? (
                    <StepBox key={n.id} step={n} mode={mode} renderNode={renderNode} style={boxStyle(b)} />
                  ) : (
                    <TransformBox key={n.id} t={n} mode={mode} style={boxStyle(b)} />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {laid && <ZoomControl scale={zoom.scale} zoomTo={zoom.zoomTo} fit={zoom.fit} />}
    </div>
  );
}

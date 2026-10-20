/**
 * The RenderGraph contract (design spec §6) — the fusion point L4 produces and L5 (layout +
 * view) consumes. Potential and actual modes share this one vocabulary, so one layout and one
 * view serve both. `LaidOutGraph` is L5's own output: everything in absolute coordinates.
 */
import type { DataflowStatus, PathStep } from "./plan.js";

export type { PathStep } from "./plan.js";

/** `not-taken`: control flow decided against it (inside an untaken arm). `not-reached`: nothing
 *  decided against it — the run (or its enclosing instance) ended before getting there. */
export type SkippedBecause = "not-taken" | "not-reached";

export type RenderState = "potential" | "pending" | "running" | "resolved" | "rejected" | "cancelled" | "skipped";

/** Port id grammar: `"in:arg0" | "in:<param>" | "out" | "control"`, optionally followed by a
 *  subpath `"/<field|index>…"` (phase 2, e.g. `"in:arg0/:url"`, `"out/0/:text"`). Parse ids only
 *  through `portBase` / `portSubpath` below. */
export interface RenderPort {
  id: string;
  side: "in" | "out" | "control";
  label?: string;
  path?: PathStep[];
}

export interface InstanceRef {
  key: string;
  ordinals: number[];
  invocationId?: number;
  span: string;
}

export interface RenderStep {
  kind: "step";
  id: string;
  parent: string | null;
  span: string;
  symbol: string;
  instance: InstanceRef;
  input: { slot: string; source: string; value?: unknown; hasValue: boolean }[];
  output: { value?: unknown; hasValue: boolean; error?: string };
  state: RenderState;
  /** Why a `skipped` node did not run — see `SkippedBecause`. */
  skippedBecause?: SkippedBecause;
  unplanned?: boolean;
  ports: RenderPort[];
}

export type RenderFrameKind = "seq" | "par" | "loop" | "branch" | "arm" | "call" | "callback";

/** One instance of a z-frame (par track, loop iteration, callback application, recursion depth). */
export interface RenderInstance {
  ordinal: number;
  state: RenderState;
}

export interface RenderFrame {
  kind: "frame";
  id: string;
  parent: string | null;
  span: string;
  frame: RenderFrameKind;
  label: string;
  symbol?: string;
  instance?: InstanceRef;
  state: RenderState;
  /** Why a `skipped` frame did not run — see `SkippedBecause`. */
  skippedBecause?: SkippedBecause;
  ports: RenderPort[];
  /** How its passes run: "in parallel" | "in series" | "in loop" | "×? via <host>" | "on raise". */
  caption?: string;
  /** z-frames (par, loop, callback, non-tail recursive call): every instance in ordinal order —
   *  the picker strip. Absent in potential mode. */
  instances?: RenderInstance[];
  /** z-frames, actual mode: the ordinal whose instance the template is painted from. */
  selected?: number;
  /** `selected` was chosen by the user (vs following live). */
  pinned?: boolean;
  /** The key a pick of this z-frame goes under in `selection` when it is not `id`: a z-frame
   *  inside a recursion level past the outermost (`id↓depth`) — the same fan at another depth
   *  is another picker. */
  selectionKey?: string;
  /** Collapsed frames are emitted without children. */
  collapsed?: boolean;
  /** `total` is absent where the instances cannot be observed (a bare designated callback whose
   *  host's output was not captured). `cancelled` is counted apart from `rejected`. */
  progress?: {
    resolved: number;
    running: number;
    rejected: number;
    pending: number;
    cancelled?: number;
    total?: number;
  };
}

/** A compute wire as one block: producers → `in:0…in:n-1`, `out` → the consumer port. Pure. */
export interface RenderTransform {
  kind: "transform";
  id: string;
  parent: string | null;
  op: string;
  text: string;
  /** `potential`; else from the producers in the painted instance. */
  state: RenderState;
  /** The result — the consumer's captured operand value. */
  value?: unknown;
  hasValue: boolean;
  /** `in:0`…`in:n-1`, `out`. */
  ports: RenderPort[];
}

export interface RenderEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
  kind: "data" | "order" | "control" | "recur";
  label?: string;
  /** Projection label (`.url`, `[0]`). */
  path?: PathStep[];
  /** A computation over params / frame ingress only (`(+ i 1)`): a line annotated with the
   *  expression — omitted when the consumer is a step operand (its card prints it). A
   *  computation over named work is a `transform` block instead. */
  expr?: string;
  state?: RenderState;
}

export interface RenderGraph {
  /** Parents before children. */
  nodes: (RenderStep | RenderFrame | RenderTransform)[];
  edges: RenderEdge[];
  /** Conservation audit — 0/0 in tests. */
  /** `dataflow`: how much of the program's dataflow `edges` represent (absent: unknown — the plan
   *  had no dataflow attached). Anything but `complete` means missing edges are not independence. */
  diagnostics: { unplacedInvocations: number; droppedEdges: number; notes: string[]; dataflow?: DataflowStatus };
}

export type RenderNode = RenderGraph["nodes"][number];

export type GraphMode = "potential" | "actual";

// ── L5 output ────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

/** A measured footprint: a step's whole box, or a frame's chrome with only its header. For a frame
 *  with children the height becomes the top padding and the width the minimum frame width; a
 *  childless frame (collapsed recursive stub) is exactly this size. */
export interface Size {
  width: number;
  height: number;
}

export interface LaidOutGraph {
  width: number;
  height: number;
  /** node id → absolute box. */
  boxes: Map<string, Box>;
  /** `portKey(node, port)` → absolute anchor point on the node's border. */
  ports: Map<string, Point>;
  /** edge id → absolute polyline (start at the source port, end at the target port). */
  edges: Map<string, Point[]>;
  /** edge id → absolute box ELK reserved for the edge's label (edges with a measured label only). */
  labels: Map<string, Box>;
}

export const portKey = (node: string, port: string): string => `${node}::${port}`;

/** The size-map key under which an edge's measured label travels into `layout`. */
export const edgeLabelKey = (edge: string): string => `${edge}::label`;

/** Port id builders — the only place the id grammar is spelled. */
export const portIds = {
  arg: (k: number): string => `in:arg${k}`,
  param: (name: string): string => `in:${name}`,
  out: "out",
  control: "control",
  /** A sequence edge's end: leaves the predecessor's east side, enters the successor's west
   *  side (the layout declares both, at the box's vertical middle). Never a value port. */
  order: "order",
} as const;

/** `"in:arg0/:url"` → `"in:arg0"`. */
export const portBase = (id: string): string => id.split("/", 1)[0]!;

/** `"out/0/:text"` → `["0", ":text"]`; `[]` for a whole-value port. */
export const portSubpath = (id: string): string[] => id.split("/").slice(1);

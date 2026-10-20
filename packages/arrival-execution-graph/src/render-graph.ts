/**
 * L4 — fuse the static `Plan` (L1+L2) and, in actual mode, the live `Progress` (L3) into the
 * `RenderGraph` L5 lays out. Pure: same inputs, same graph.
 *
 * STRUCTURE is the plan's, in both modes: one node per plan item (id = plan key), every par /
 * loop / callback / recursion template drawn ONCE, the plan's edges, a `transform` block per
 * compute wire, and `order` edges between consecutive children of every sequential frame that
 * no data path already orders (a layered layout would otherwise stack them into one column,
 * which reads as parallel). Node ids, parents, ports, collapsed flags and edges never depend on
 * progress or selection — a run and a selection change only PAINT (states, values, counts,
 * the instance strip), so the layout never moves under the reader. The one exception is an
 * `unplanned` step: an invocation the plan does not know (see `progress.ts`, LIMIT), shown
 * where it ran.
 *
 * PAINT (actual mode) reads the instance tree top-down along one ordinal path. A z-frame — a
 * par / callback (tracks), a loop (iterations), a call frame whose function recurses non-tail
 * (depth levels) — lists every instance (`instances`) and paints its template from ONE of them
 * (`selected`): the ordinal `selection` names for its plan key, clamped to the instances there
 * are; else the follow-live policy (`followed`). Inner z-frames resolve against the SELECTED
 * outer instance, so nested selections compose. A recursive stub stays a collapsed pill painted
 * with its own instance — the next depth's state. Branch arms are always lanes: the taken arm
 * of the painted instance is painted, untaken arms `skipped` (`not-taken`), undecided arms as
 * ghosts.
 */
import { scopeId, writeForm } from "@here.build/arrival/provenance";

import { type CapturedOperand, ExecutionCapture, readOperands } from "./capture.js";
import { isPair, listLength, operandSlots } from "./datum.js";
import {
  type Plan,
  type PlanEdge,
  type PlanFrame,
  type PlanItem,
  type PlanKey,
  type PlanStep,
  type WireShape,
} from "./plan.js";
import {
  type Body,
  type FrameInstance,
  type Instance,
  type LiveState,
  type Progress,
  type StepInstance,
} from "./progress.js";
import {
  portIds,
  type RenderEdge,
  type RenderFrame,
  type RenderGraph,
  type RenderInstance,
  type RenderNode,
  type RenderPort,
  type RenderState,
  type RenderStep,
  type RenderTransform,
} from "./types.js";

export interface RenderGraphOptions {
  /** Actual mode: the ordinal painted per z-frame (track / iteration / recursion depth), by its
   *  selection key — the plan key, or `RenderFrame.selectionKey` inside a recursion level. A
   *  key without an entry follows the run (`followed`); an ordinal past the instances there
   *  are is clamped to the last. */
  selection?: ReadonlyMap<string, number>;
}

/** A z-frame's selection key: its plan key, qualified by the recursion depths it is painted at
 *  (`key↓1`, `key↓2.1` under nested recursions) once any is past the outermost — the same fan
 *  re-entered at another depth is another picker. */
export const selectionKeyOf = (key: PlanKey, depths: readonly number[]): string =>
  depths.some((d) => d > 0) ? `${key}↓${depths.join(".")}` : key;

/** Recursion depths followed before giving up (a cycle guard, not a display cap). */
const MAX_DEPTH = 10_000;

// ── step state: the one mapping ─────────────────────────────────────────────────────────────

interface StateContext {
  /** Potential mode: no progress, everything is `potential`. */
  readonly potential: boolean;
  /** The enclosing body still runs (a never-entered item may yet run). */
  readonly active: boolean;
  /** State of the nearest enclosing instance with an invocation (the root at top level). */
  readonly hostState: RenderState | undefined;
}

/**
 * The state of a step, from its instance (if it was entered) and its context:
 * - `potential` — no run;
 * - `pending` — not entered yet while its body still runs, OR entered with operands still
 *   evaluating (a call is entered BEFORE its operands — `running` here would draw two
 *   sequential steps as concurrent; `progress.stateOf` folds this in);
 * - `running` — called (operands settled) and not returned;
 * - `resolved` / `rejected` — from the invocation;
 * - `skipped` — never entered and its body is over (inside an untaken arm, or the run ended);
 * - `cancelled` — still running when the run settled `rejected` / `cancelled`.
 * A step with an instance of its own always reads it. A hosted step (`via`: a bare designated
 * symbol passed to a host — `#argK` / `#clauseK` keys — an `apply`, a call inside an untracked
 * macro) may have none: the host carries the state.
 */
export function stepState(
  progress: Progress | undefined,
  plan: PlanStep | undefined,
  inst: StepInstance | undefined,
  ctx: StateContext,
): RenderState {
  if (!progress || ctx.potential) return "potential";
  if (inst) return progress.stateOf(inst);
  // Hosted (`via`) and not entered on its own: the host's state; never `skipped` while the host
  // ran. `callback` → the par / branch calling it; `apply` → its own span is the apply call;
  // `macro` → a call the expansion builds lands on its step once it runs (`#macroStep` in the
  // projector); until then, or for a frame the expansion never enters, the nearest enclosing
  // instance stands in.
  if (plan?.via !== undefined && ctx.hostState !== undefined) return ctx.hostState;
  return ctx.active ? "pending" : "skipped";
}

type Counts = NonNullable<RenderFrame["progress"]>;

function count(states: readonly LiveState[]): Counts {
  const c: Counts = { resolved: 0, running: 0, rejected: 0, pending: 0, total: states.length };
  for (const s of states) {
    if (s === "cancelled") c.cancelled = (c.cancelled ?? 0) + 1;
    else if (s !== "skipped") c[s]++;
  }
  return c;
}

/**
 * The instance a z-frame paints when the reader picked none — follow live:
 * - `loop`: the latest iteration;
 * - `par` / `callback`: the first running track (then pending), else the first rejected, else
 *   the first cancelled, else the last resolved;
 * - `depth` (non-tail recursion): the deepest running level (its frontier), else the deepest
 *   rejected (where the raise started), else the deepest cancelled, else the outermost.
 * `undefined` for no instances.
 */
export function followed(axis: "loop" | "fan" | "depth", states: readonly LiveState[]): number | undefined {
  if (states.length === 0) return undefined;
  if (axis === "loop") return states.length - 1;
  const first = (...want: LiveState[]) => {
    const i =
      axis === "fan" ? states.findIndex((s) => want.includes(s)) : states.findLastIndex((s) => want.includes(s));
    return i === -1 ? undefined : i;
  };
  if (axis === "depth") return first("running", "pending") ?? first("rejected") ?? first("cancelled") ?? 0;
  const resolved = states.lastIndexOf("resolved");
  return (
    first("running") ?? first("pending") ?? first("rejected") ?? first("cancelled") ?? (resolved === -1 ? 0 : resolved)
  );
}

// ── plan index (per plan, cached) ───────────────────────────────────────────────────────────

interface Transform {
  readonly wire: WireShape;
  /** The plan edges sharing the wire, in param order (one `in:k` each). */
  readonly edges: PlanEdge[];
  /** The frame the block sits in: the consumer's, or the consumer itself for a wire inside it
   *  (into its `out` / `control`, or a `recur` into its param). */
  readonly parent: PlanKey;
}

interface PlanIndex {
  /** Ports plan edges name, per key. */
  readonly portsNamed: Map<PlanKey, Set<string>>;
  /** Consecutive child pairs of each sequential frame that need an `order` edge. */
  readonly orderPairs: Map<PlanKey, [PlanKey, PlanKey][]>;
  /** Plan edges whose endpoints both exist. */
  readonly edges: readonly PlanEdge[];
  readonly dropped: number;
  /** Compute wires → their block, in first-edge order. */
  readonly transforms: Map<string, Transform>;
  /** Recursion owner (a `call` frame) → the recursive stubs re-entering it, in plan order. */
  readonly stubsOf: Map<PlanKey, PlanFrame[]>;
}

const indexCache = new WeakMap<Plan, PlanIndex>();

/** Operand order is not execution order between callbacks of the same host
 *  (`with-exception-handler` lists the handler before the thunk), and a guard's on-raise branch
 *  runs only on a raise — no `order` edge for either. */
const unordered = (a: PlanItem, b: PlanItem): boolean =>
  (b.kind === "frame" && b.onRaise === true) ||
  (a.kind === "frame" && b.kind === "frame" && isFan(a) && isFan(b) && a.path === b.path && a.hostSite === b.hostSite);
const isFan = (f: PlanFrame) => f.frame === "callback" || f.frame === "par";

function within(plan: Plan, key: PlanKey, ancestor: PlanKey): boolean {
  for (let cur = plan.parentOf.get(key); cur !== undefined; cur = plan.parentOf.get(cur))
    if (cur === ancestor) return true;
  return false;
}

function orderPairsOf(plan: Plan, edges: readonly PlanEdge[]): Map<PlanKey, [PlanKey, PlanKey][]> {
  // Consecutive children (a, b) of every non-branch frame unless b is reachable from a through
  // data edges lifted to the frame's direct children.
  const orderPairs = new Map<PlanKey, [PlanKey, PlanKey][]>();
  const visit = (f: PlanFrame) => {
    for (const c of f.children) if (c.kind === "frame") visit(c);
    if (f.frame === "branch" || f.children.length < 2) return;
    const lift = (k: PlanKey): PlanKey | undefined => {
      for (let cur: PlanKey | undefined = k; cur !== undefined; cur = plan.parentOf.get(cur)) {
        if (plan.parentOf.get(cur) === f.key) return cur;
      }
      return undefined;
    };
    const adj = new Map<PlanKey, Set<PlanKey>>();
    for (const e of edges) {
      const a = lift(e.from.key);
      const b = lift(e.to.key);
      if (a === undefined || b === undefined || a === b) continue;
      const s = adj.get(a) ?? new Set<PlanKey>();
      s.add(b);
      adj.set(a, s);
    }
    const reaches = (a: PlanKey, b: PlanKey) => {
      const seen = new Set([a]);
      const stack = [a];
      while (stack.length > 0) {
        for (const n of adj.get(stack.pop()!) ?? []) {
          if (n === b) return true;
          if (seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      return false;
    };
    const pairs: [PlanKey, PlanKey][] = [];
    for (let i = 1; i < f.children.length; i++) {
      const a = f.children[i - 1]!.key;
      const b = f.children[i]!.key;
      if (!reaches(a, b) && !unordered(f.children[i - 1]!, f.children[i]!)) pairs.push([a, b]);
    }
    orderPairs.set(f.key, pairs);
  };
  visit(plan.root);
  return orderPairs;
}

/** Each recursive stub's owner: the nearest enclosing non-recursive `call` frame of the same
 *  function (same body roots, else same label) — the frame `progress` nests its instances by. */
function stubsOf(plan: Plan): Map<PlanKey, PlanFrame[]> {
  const out = new Map<PlanKey, PlanFrame[]>();
  const sameFunction = (owner: PlanFrame, stub: PlanFrame) =>
    (stub.bodyRoots.length > 0 &&
      owner.bodyRoots.length === stub.bodyRoots.length &&
      owner.bodyRoots.every((r, i) => r === stub.bodyRoots[i])) ||
    owner.label === stub.label;
  const visit = (f: PlanFrame, stack: readonly PlanFrame[]) => {
    for (const c of f.children) {
      if (c.kind !== "frame") continue;
      if (c.recursive) {
        const owner = stack.findLast((o) => sameFunction(o, c));
        if (owner?.frame === "call") out.set(owner.key, [...(out.get(owner.key) ?? []), c]);
      } else visit(c, c.frame === "call" || c.frame === "loop" ? [...stack, c] : stack);
    }
  };
  visit(plan.root, []);
  return out;
}

function indexPlan(plan: Plan): PlanIndex {
  const cached = indexCache.get(plan);
  if (cached) return cached;
  const exists = (k: PlanKey) => k === plan.root.key || plan.byKey.has(k);
  const edges = plan.edges.filter((e) => exists(e.from.key) && exists(e.to.key));

  const portsNamed = new Map<PlanKey, Set<string>>();
  const transforms = new Map<string, Transform>();
  // A compute wire is a BLOCK when it transforms named work — some producer is a step's or a
  // frame's `out`. Over params / frame ingress only (`(+ i 1)`, `(- n 1)`) it stays a line,
  // annotated with its expression.
  const overWork = new Set(edges.flatMap((e) => (e.wire && e.from.port === portIds.out ? [e.wire.id] : [])));
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      const s = portsNamed.get(end.key) ?? new Set<string>();
      s.add(end.port);
      portsNamed.set(end.key, s);
    }
    if (e.wire?.kind !== "compute" || !overWork.has(e.wire.id)) continue;
    const t = transforms.get(e.wire.id);
    if (t) t.edges.push(e);
    else {
      const inside = e.to.key === e.from.key || within(plan, e.from.key, e.to.key);
      const parent = e.wire.container ?? (inside ? e.to.key : (plan.parentOf.get(e.to.key) ?? plan.root.key));
      transforms.set(e.wire.id, { wire: e.wire, edges: [e], parent });
    }
  }

  const index: PlanIndex = {
    portsNamed,
    orderPairs: orderPairsOf(plan, edges),
    edges,
    dropped: plan.edges.length - edges.length,
    transforms,
    stubsOf: stubsOf(plan),
  };
  indexCache.set(plan, index);
  return index;
}

// ── builder ─────────────────────────────────────────────────────────────────────────────────

interface Ctx extends StateContext {
  /** The ordinal path of the painted instance (one per enclosing z-frame). */
  readonly ordinals: readonly number[];
  /** The painted depth of each enclosing recursion owner, outermost first. */
  readonly depths: readonly number[];
}

/** A z-frame instance's bodies, their states and the one painted. */
interface Painted {
  readonly bodies: readonly Body[];
  readonly states: readonly LiveState[];
  readonly selected: number | undefined;
}

const print = (form: unknown): string => {
  try {
    return writeForm(form);
  } catch {
    return "?";
  }
};

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    // `undefined` for a value JSON cannot hold (the lib types say `string`).
    return (JSON.stringify(e) as string | undefined) ?? String(e);
  } catch {
    return String(e);
  }
}

function sideOf(port: string): RenderPort["side"] {
  if (port === portIds.out || port.startsWith("out:")) return "out";
  return port === portIds.control ? "control" : "in";
}

/** How a frame's passes run (plan-only). */
function captionOf(f: PlanFrame): string | undefined {
  switch (f.frame) {
    case "par":
      return "in parallel";
    case "loop":
      return f.host === undefined ? "in loop" : "in series";
    case "callback":
      return f.host === undefined ? "×?" : `×? via ${f.host}`;
    case "branch":
      return f.onRaise ? "on raise" : undefined;
    default:
      return undefined;
  }
}

class Builder {
  readonly nodes: RenderNode[] = [];
  readonly byId = new Map<string, RenderNode>();
  readonly edges = new Map<string, RenderEdge>();
  readonly index: PlanIndex;
  readonly selection: ReadonlyMap<string, number>;

  constructor(
    readonly plan: Plan,
    readonly progress: Progress | undefined,
    opts: RenderGraphOptions,
  ) {
    this.index = indexPlan(plan);
    this.selection = opts.selection ?? new Map();
  }

  build(): RenderGraph {
    const root = this.plan.root;
    const p = this.progress;
    if (p) {
      const state = p.stateOf(p.root);
      this.#frameNode(root, state, { label: "program" });
      const body = p.root.bodies.at(0);
      this.#children(root, body, {
        potential: false,
        active: body ? !p.isSettled(body) : !p.isSettled(p.root),
        hostState: state,
        ordinals: [],
        depths: [],
      });
    } else {
      this.#frameNode(root, "potential", { label: "program" });
      this.#children(root, undefined, {
        potential: true,
        active: true,
        hostState: undefined,
        ordinals: [],
        depths: [],
      });
    }
    this.#transforms();
    this.#orderEdges(root);
    this.#planEdges();
    this.#explainSkips();
    return {
      nodes: this.nodes,
      edges: [...this.edges.values()],
      diagnostics: {
        unplacedInvocations: p?.counters.unplacedInvocations ?? 0,
        droppedEdges: this.index.dropped,
        notes: [...this.plan.diagnostics, ...(p?.notes ?? [])],
        ...(this.plan.dataflow ? { dataflow: this.plan.dataflow } : {}),
      },
    };
  }

  // ── nodes ──────────────────────────────────────────────────────────────────────────────

  /** Arms control flow decided against (ids). */
  readonly #notTaken = new Set<string>();

  /** A skipped node inside (or being) an arm control flow decided against was `not-taken`;
   *  any other skipped node was `not-reached`. */
  #explainSkips(): void {
    for (const n of this.nodes) {
      if (n.kind === "transform" || n.state !== "skipped") continue;
      let inArm = false;
      for (
        let cur: RenderNode | undefined = n;
        cur && !inArm;
        cur = cur.parent === null ? undefined : this.byId.get(cur.parent)
      ) {
        inArm = this.#notTaken.has(cur.id);
      }
      n.skippedBecause = inArm ? "not-taken" : "not-reached";
    }
  }

  #push(n: RenderNode): void {
    this.nodes.push(n);
    this.byId.set(n.id, n);
  }

  #ports(f: PlanFrame): RenderPort[] {
    const ins: RenderPort[] = [];
    const seen = new Set<string>();
    let control = false;
    let out = false;
    for (const p of f.params) {
      const id = portIds.param(p);
      if (seen.has(id)) continue;
      seen.add(id);
      ins.push({ id, side: "in", label: p });
    }
    for (const id of this.index.portsNamed.get(f.key) ?? []) {
      if (id === portIds.out) out = true;
      else if (id === portIds.control) control = true;
      else if (!seen.has(id)) {
        seen.add(id);
        ins.push({ id, side: sideOf(id), label: id.slice(id.indexOf(":") + 1) });
      }
    }
    return [
      ...ins.filter((p) => p.side === "in"),
      ...ins.filter((p) => p.side === "out"),
      ...(control ? [{ id: portIds.control, side: "control" as const }] : []),
      ...(out ? [{ id: portIds.out, side: "out" as const }] : []),
    ];
  }

  /** Frame key → the instance painted (for reading a transform's value off its consumer). */
  readonly #painted = new Map<PlanKey, FrameInstance>();

  #frameNode(
    plan: PlanFrame,
    state: RenderState,
    extra: Partial<RenderFrame> & { ordinals?: readonly number[]; inst?: FrameInstance } = {},
  ): RenderFrame {
    const { ordinals = [], inst, ...rest } = extra;
    if (inst) this.#painted.set(plan.key, inst);
    const caption = captionOf(plan);
    const node: RenderFrame = {
      kind: "frame",
      id: plan.key,
      parent: plan === this.plan.root ? null : (this.plan.parentOf.get(plan.key) ?? this.plan.root.key),
      span: plan.span,
      frame: plan.frame,
      label: plan.label,
      ...(plan.symbol === undefined ? {} : { symbol: plan.symbol }),
      ...(caption === undefined ? {} : { caption }),
      instance: {
        key: plan.key,
        ordinals: [...ordinals],
        span: plan.span,
        ...(inst?.invocation ? { invocationId: inst.invocation.id } : {}),
      },
      state,
      ports: this.#ports(plan),
      ...(plan.recursive ? { collapsed: true } : {}),
      ...rest,
    };
    this.#push(node);
    return node;
  }

  #stepNode(plan: PlanStep, inst: StepInstance | undefined, ctx: Ctx): void {
    const p = this.progress;
    const values = inst && p ? p.valuesOf(inst) : undefined;
    // `(apply f …)`: the apply invocation's operands are not the callee's arguments.
    const captured = plan.via === "apply" ? undefined : values && bySlot(values.inputs);
    const ports: RenderPort[] = plan.args.map((a) => ({ id: `in:${a.slot}`, side: "in" }));
    for (const port of this.index.portsNamed.get(plan.key) ?? []) {
      if (port !== portIds.out && !ports.some((x) => x.id === port)) ports.push({ id: port, side: sideOf(port) });
    }
    ports.push({ id: portIds.out, side: "out" });
    this.#push({
      kind: "step",
      id: plan.key,
      parent: this.plan.parentOf.get(plan.key) ?? this.plan.root.key,
      span: plan.span,
      symbol: plan.symbol,
      instance: {
        key: plan.key,
        ordinals: [...ctx.ordinals],
        span: plan.span,
        ...(inst ? { invocationId: inst.invocation.id } : {}),
      },
      input: plan.args.map((a) => {
        const v = captured?.get(a.slot);
        return v?.hasValue
          ? { slot: a.slot, source: a.source, value: v.value, hasValue: true }
          : { slot: a.slot, source: a.source, hasValue: false };
      }),
      output: outputOf(values),
      state: stepState(p, plan, inst, ctx),
      ports,
    });
  }

  #unplannedNode(inst: StepInstance, parent: string, ctx: Ctx): void {
    const values = this.progress!.valuesOf(inst);
    const node: RenderStep = {
      kind: "step",
      id: `${parent}~${inst.span}#${inst.ordinal}`,
      parent,
      span: inst.span,
      symbol: inst.symbol,
      instance: { key: inst.span, ordinals: [...ctx.ordinals], span: inst.span, invocationId: inst.invocation.id },
      input: [...bySlot(values.inputs)].map(([slot, v]) => ({
        slot,
        source: print(v.form),
        hasValue: v.hasValue,
        ...(v.hasValue ? { value: v.value } : {}),
      })),
      output: outputOf(values),
      state: stepState(this.progress, undefined, inst, ctx),
      unplanned: true,
      ports: [
        ...[...bySlot(values.inputs).keys()].map((slot): RenderPort => ({ id: `in:${slot}`, side: "in" })),
        { id: portIds.out, side: "out" },
      ],
    };
    this.#push(node);
  }

  /** The children of `template` (in plan order), painted from `body` when given. A key entered
   *  more than once in one body (a macro splicing its operand twice, a long-lived trace without
   *  `since`) paints its latest instance. */
  #children(template: PlanFrame, body: Body | undefined, ctx: Ctx): void {
    for (const c of template.children) this.#item(c, body?.byKey.get(c.key)?.at(-1), ctx);
    for (const u of body?.unplanned ?? []) this.#unplannedNode(u, template.key, ctx);
  }

  #item(item: PlanItem, inst: Instance | undefined, ctx: Ctx): void {
    if (item.kind === "step") this.#stepNode(item, inst as StepInstance | undefined, ctx);
    else if (inst?.kind === "frame") this.#instance(item, inst, ctx);
    else this.#ghost(item, ctx);
  }

  /** A frame with no instance: potential, a pending ghost while its body runs, else skipped —
   *  its children with it. */
  #ghost(item: PlanFrame, ctx: Ctx): void {
    if (!ctx.potential && ctx.hostState !== undefined && this.#inMacro(item)) {
      // A frame inside a macro use has no invocation of its own (the expansion builds unlocated
      // Pairs): the nearest enclosing instance's state.
      this.#frameNode(item, ctx.hostState, { ordinals: ctx.ordinals, ...this.#strip(item, ctx.depths, []) });
      this.#children(item, undefined, ctx);
      return;
    }
    let state: RenderState = ctx.active ? "pending" : "skipped";
    if (ctx.potential) state = "potential";
    this.#frameNode(item, state, { ordinals: ctx.ordinals, ...this.#strip(item, ctx.depths, []) });
    // A never-entered frame hosts nothing: its hosted steps are pending / skipped with it.
    if (!item.recursive) this.#children(item, undefined, { ...ctx, hostState: undefined });
  }

  readonly #macroFrames = new Map<PlanFrame, boolean>();

  /** Every step under `frame` runs inside an untracked macro use. */
  #inMacro(frame: PlanFrame): boolean {
    let r = this.#macroFrames.get(frame);
    if (r === undefined) {
      const steps: PlanStep[] = [];
      const walk = (f: PlanFrame) => {
        for (const c of f.children) {
          if (c.kind === "step") steps.push(c);
          else walk(c);
        }
      };
      walk(frame);
      r = steps.length > 0 && steps.every((s) => s.via === "macro");
      this.#macroFrames.set(frame, r);
    }
    return r;
  }

  /** The instance strip of a z-frame (actual mode only): every instance, the painted one, and
   *  whether the reader pinned it. */
  #strip(
    f: PlanFrame,
    depths: readonly number[],
    states: readonly LiveState[],
    selected?: number,
  ): Partial<RenderFrame> {
    if (!this.progress || !this.#isZ(f)) return {};
    const instances: RenderInstance[] = states.map((state, ordinal) => ({ ordinal, state }));
    const key = selectionKeyOf(f.key, depths);
    const qualified = key === f.key ? {} : { selectionKey: key };
    if (selected === undefined) return { instances, ...qualified };
    return { instances, selected, ...qualified, ...(this.selection.has(key) ? { pinned: true } : {}) };
  }

  #isZ(f: PlanFrame): boolean {
    if (f.recursive) return false;
    return f.frame === "par" || f.frame === "callback" || f.frame === "loop" || this.index.stubsOf.has(f.key);
  }

  /** The painted ordinal among `n`: the reader's selection (clamped), else `follow`. */
  #select(key: string, n: number, follow: () => number | undefined): number | undefined {
    if (n === 0) return undefined;
    const picked = this.selection.get(key);
    return picked === undefined ? follow() : Math.min(Math.max(0, Math.trunc(picked)), n - 1);
  }

  /** A fan's (or loop's) tracks / iterations and the one painted. */
  #fanPainted(f: PlanFrame, inst: FrameInstance, depths: readonly number[]): Painted {
    const p = this.progress!;
    const bodies = exitFolded(inst, p);
    const states = bodies.map((b) => p.stateOf(b));
    const axis = f.frame === "loop" ? "loop" : "fan";
    const selected = this.#select(selectionKeyOf(f.key, depths), bodies.length, () => followed(axis, states));
    return { bodies, states, selected };
  }

  readonly #depthCache = new WeakMap<FrameInstance, FrameInstance[]>();

  /** A recursion owner's depth levels along the painted path: the call instance, then at each
   *  level the stub instance its painted body re-entered (a running one first, else the first
   *  stub site in plan order) — through the painted track when the recursion runs through a fan. */
  #depths(f: PlanFrame, inst: FrameInstance, depths: readonly number[]): FrameInstance[] {
    const cached = this.#depthCache.get(inst);
    if (cached) return cached;
    const chain = [inst];
    this.#depthCache.set(inst, chain);
    const stubs = this.index.stubsOf.get(f.key) ?? [];
    for (let cur: FrameInstance | undefined = inst; cur && chain.length < MAX_DEPTH; ) {
      const body = cur.bodies.at(0);
      const level = [...depths, chain.length - 1];
      const next: FrameInstance[] = body
        ? stubs.flatMap((s) => {
            const found = this.#reach(body, f, s.key, level);
            return found?.kind === "frame" && found.template === f ? [found] : [];
          })
        : [];
      cur = next.find((n) => this.progress!.stateOf(n) === "running") ?? next.at(0);
      if (cur) chain.push(cur);
    }
    return chain;
  }

  /** The instance of `key` reached from `body` (of `template`) along the painted path. */
  #reach(body: Body, template: PlanFrame, key: PlanKey, depths: readonly number[]): Instance | undefined {
    const path: PlanFrame[] = [];
    for (let k = this.plan.parentOf.get(key); k !== undefined && k !== template.key; k = this.plan.parentOf.get(k)) {
      path.unshift(this.plan.byKey.get(k) as PlanFrame);
    }
    let cur: Body | undefined = body;
    for (const f of path) {
      const inst: Instance | undefined = cur.byKey.get(f.key)?.at(-1);
      if (inst?.kind !== "frame") return undefined;
      const painted = this.#paintedBody(f, inst, depths);
      cur = painted?.body;
      depths = painted?.depths ?? depths;
      if (!cur) return undefined;
    }
    return cur.byKey.get(key)?.at(-1);
  }

  /** The body a frame instance paints its template from, and the recursion depths inside it. */
  #paintedBody(
    f: PlanFrame,
    inst: FrameInstance,
    depths: readonly number[],
  ): { body: Body | undefined; depths: readonly number[] } | undefined {
    if (f.recursive) return undefined;
    if (f.frame === "par" || f.frame === "callback" || f.frame === "loop") {
      const { bodies, selected } = this.#fanPainted(f, inst, depths);
      return { body: selected === undefined ? undefined : bodies[selected], depths };
    }
    if (this.index.stubsOf.has(f.key)) {
      const chain = this.#depths(f, inst, depths);
      const selected = this.#depthSelected(f, chain, depths);
      return { body: chain[selected]?.bodies.at(0), depths: [...depths, selected] };
    }
    return { body: inst.bodies.at(0), depths };
  }

  #depthSelected(f: PlanFrame, chain: readonly FrameInstance[], depths: readonly number[]): number {
    const states = chain.map((c) => this.progress!.stateOf(c));
    return this.#select(selectionKeyOf(f.key, depths), chain.length, () => followed("depth", states)) ?? 0;
  }

  #instance(item: PlanFrame, inst: FrameInstance, ctx: Ctx): void {
    const p = this.progress!;
    const state = p.stateOf(inst);
    if (item.recursive) {
      // A recursive stub: a collapsed pill painted with its own instance — the next depth.
      this.#frameNode(item, state, { ordinals: ctx.ordinals, inst });
      return;
    }
    switch (item.frame) {
      case "par":
      case "callback":
      case "loop":
        return this.#fan(item, inst, ctx, state);
      case "branch":
        return this.#branch(item, inst, ctx, state);
      default: {
        if (this.index.stubsOf.has(item.key)) return this.#recursion(item, inst, ctx, state);
        this.#frameNode(item, state, { ordinals: ctx.ordinals, inst });
        this.#children(item, inst.bodies[0], {
          ...ctx,
          active: !p.isSettled(inst.bodies[0] ?? inst),
          hostState: inst.invocation ? state : ctx.hostState,
        });
      }
    }
  }

  #branch(item: PlanFrame, inst: FrameInstance, ctx: Ctx, state: RenderState): void {
    const p = this.progress!;
    this.#frameNode(item, state, { ordinals: ctx.ordinals, inst });
    const body = inst.bodies.at(0);
    const decided = typeof inst.takenArm === "number" || p.isSettled(inst);
    const armCtx: Ctx = { ...ctx, hostState: inst.invocation ? state : ctx.hostState };
    for (const arm of item.children) {
      const armInst = body?.byKey.get(arm.key)?.at(-1);
      if (arm.kind !== "frame") this.#item(arm, armInst, armCtx);
      else if (armInst?.kind === "frame") {
        const armBody = armInst.bodies.at(0);
        // An untaken arm whose clause test ran is `skipped`: its test keeps its own state, the
        // rest (a `=>` receiver included — it hosts nothing) is skipped with it.
        const armState = p.stateOf(armInst);
        const untaken = armState === "skipped";
        if (untaken) this.#notTaken.add(arm.key);
        this.#frameNode(arm, armState, { ordinals: ctx.ordinals, inst: armInst });
        this.#children(arm, armBody, {
          ...armCtx,
          active: !untaken && !p.isSettled(armBody ?? armInst),
          ...(untaken ? { hostState: undefined } : {}),
        });
      } else if (decided) {
        // Never entered once the branch decided: skipped — still a lane, its contents with it.
        if (typeof inst.takenArm === "number") this.#notTaken.add(arm.key);
        this.#frameNode(arm, "skipped", { ordinals: ctx.ordinals });
        this.#children(arm, undefined, { ...armCtx, active: false, hostState: undefined });
      } else {
        this.#ghost(arm, { ...armCtx, active: true });
      }
    }
  }

  /** par / callback (tracks) and loop (iterations): the template, painted from the selected
   *  instance; counts over all of them. */
  #fan(item: PlanFrame, inst: FrameInstance, ctx: Ctx, state: RenderState): void {
    const p = this.progress!;
    const { bodies, states, selected } = this.#fanPainted(item, inst, ctx.depths);
    const unobserved = bodies.length === 0 && !inst.unattributed?.items.length;
    const outLength = unobserved ? this.#applications(item, inst) : undefined;
    let progress: Counts | undefined = unobserved ? undefined : count(states);
    if (outLength !== undefined && outLength > 0 && state === "resolved") {
      progress = { resolved: outLength, running: 0, rejected: 0, pending: 0, total: outLength };
    }
    this.#frameNode(item, state, {
      ordinals: ctx.ordinals,
      inst,
      ...(progress ? { progress } : {}),
      ...this.#strip(item, ctx.depths, states, selected),
    });
    const host: RenderState | undefined = inst.invocation ? state : ctx.hostState;
    if (selected !== undefined) {
      const body = bodies[selected]!;
      // Hosted steps (no invocation of their own) follow THIS track / iteration, not the fan.
      this.#children(item, body, {
        ...ctx,
        ordinals: [...ctx.ordinals, selected],
        active: !p.isSettled(body),
        hostState: states[selected],
      });
      return;
    }
    const loose = inst.unattributed;
    if (loose && loose.items.length > 0) {
      // Only callback forms that never read the element param ran: their track is unknown.
      this.#children(item, loose, { ...ctx, active: !p.isSettled(loose), hostState: p.stateOf(loose) });
      return;
    }
    // Nothing started (or an empty collection): the template, as ghosts. Over a known-empty
    // output the host ran but applied nothing — its hosted steps are skipped, not its state.
    this.#children(item, undefined, {
      ...ctx,
      active: !p.isSettled(inst),
      hostState: outLength === 0 ? undefined : host,
    });
  }

  /** A call frame whose function recurses non-tail: one depth level painted. */
  #recursion(item: PlanFrame, inst: FrameInstance, ctx: Ctx, state: RenderState): void {
    const p = this.progress!;
    const chain = this.#depths(item, inst, ctx.depths);
    const selected = this.#depthSelected(item, chain, ctx.depths);
    this.#frameNode(item, state, {
      ordinals: ctx.ordinals,
      inst,
      ...this.#strip(
        item,
        ctx.depths,
        chain.map((c) => p.stateOf(c)),
        selected,
      ),
    });
    const at = chain[selected]!;
    const body = at.bodies.at(0);
    this.#children(item, body, {
      ...ctx,
      ordinals: [...ctx.ordinals, selected],
      depths: [...ctx.depths, selected],
      active: !p.isSettled(body ?? at),
      hostState: at.invocation || selected > 0 ? p.stateOf(at) : ctx.hostState,
    });
  }

  /** Applications of a fan whose tracks were not observed (a bare designated callback is
   *  applied without an invocation per element, or nothing started yet): the host's output
   *  length — an element per application. A `control` callback's host keeps only some
   *  (`filter`), an `effect`'s returns no list: their output says nothing about applications. */
  #applications(item: PlanFrame, inst: FrameInstance): number | undefined {
    const countable = item.frame !== "loop" && item.role !== "control" && item.role !== "effect";
    return countable ? this.#outputLength(inst) : undefined;
  }

  /** Element count of a resolved fan host, from its output list (captured, else the trace's
   *  value while it lasts). */
  #outputLength(inst: FrameInstance): number | undefined {
    const inv = inst.invocation;
    if (inv?.state !== "resolved") return undefined;
    const captured = this.progress!.trace instanceof ExecutionCapture ? this.progress!.trace.captured(inv) : undefined;
    return listLength(captured?.hasOutput ? captured.output : inv.value);
  }

  // ── transforms and edges ───────────────────────────────────────────────────────────────

  /** One block per compute wire, in its frame; painted from its producers and consumer. */
  #transforms(): void {
    for (const t of this.index.transforms.values()) {
      const ins = t.edges.map((_, k): RenderPort => ({ id: `in:${k}`, side: "in" }));
      const node: RenderTransform = {
        kind: "transform",
        id: transformId(t.wire),
        parent: t.parent,
        op: t.wire.op ?? "",
        text: t.wire.text,
        ...this.#transformPaint(t),
        ports: [...ins, { id: portIds.out, side: "out" }],
      };
      this.#push(node);
    }
  }

  #transformPaint(t: Transform): Pick<RenderTransform, "state" | "value" | "hasValue"> {
    if (!this.progress) return { state: "potential", hasValue: false };
    // An arm's value inside an arm the painted instance did not take never ran.
    if (t.wire.container !== undefined && this.byId.get(t.wire.container)?.state === "skipped")
      return { state: "skipped", hasValue: false };
    const to = t.edges[0]!.to;
    const consumer = this.byId.get(to.key);
    const read = this.#consumerValue(t, consumer);
    const value = read ? { value: read.value, hasValue: true } : { hasValue: false };
    // A called consumer evaluated its operands; a running frame bound its params.
    const called = consumer?.state === "running" || consumer?.state === "resolved";
    if (read || (called && (consumer?.kind === "step" || to.port.startsWith("in:"))))
      return { state: "resolved", ...value };
    const states = t.edges.map((e) => {
      const s = this.byId.get(e.from.key)?.state ?? "pending";
      // A frame's param is bound once the frame runs.
      return e.from.port.startsWith("in:") && s === "running" ? "resolved" : s;
    });
    let state: RenderState = "resolved";
    if (states.some((s) => s === "running" || s === "pending")) state = "pending";
    else if (states.includes("rejected")) state = "rejected";
    else if (states.includes("cancelled")) state = "cancelled";
    else if (states.every((s) => s === "skipped")) state = "skipped";
    return { state, ...value };
  }

  /** A transform's result, read off its consumer in the painted instance: a step operand's
   *  captured value; a frame's operand (the invocation's child for this very form, while the
   *  trace still holds it); a frame's own result for a wire into its `out`. */
  #consumerValue(t: Transform, consumer: RenderNode | undefined): { value: unknown } | undefined {
    const to = t.edges[0]!.to;
    if (consumer?.kind === "step") {
      const operand = to.port.startsWith("in:") ? consumer.input.find((i) => i.slot === to.port.slice(3)) : undefined;
      return operand?.hasValue ? { value: operand.value } : undefined;
    }
    const inv = this.#painted.get(to.key)?.invocation;
    if (!inv) return undefined;
    const trace = this.progress!.trace;
    // Settled values the trace pruned, kept by the capture (`retainedSpans`).
    const capture = trace instanceof ExecutionCapture ? trace : undefined;
    if (to.port === portIds.out) {
      if (inv.state !== "resolved") return undefined;
      return capture?.retainedValue(inv) ?? (inv.value === undefined ? undefined : { value: inv.value });
    }
    const span = t.wire.span;
    if (span === undefined) return undefined;
    const operand = readOperands(trace, inv, inv.state !== "running").find(
      (o) => isPair(o.form) && scopeId(o.form) === span,
    );
    return operand?.hasValue ? { value: operand.value } : capture?.retainedOperand(inv, span);
  }

  #edge(
    from: { node: string; port: string },
    to: { node: string; port: string },
    kind: RenderEdge["kind"],
    path?: RenderEdge["path"],
    expr?: string,
  ): void {
    const id = `${from.node}:${from.port}->${to.node}:${to.port}`;
    // A frame into itself only as a loop's own update (`i ← (+ i 1)`: a recur from its param port
    // back into it) — the view draws recur edges as the loop's contour, never routed.
    if (this.edges.has(id) || (from.node === to.node && kind !== "recur")) return;
    const producer = this.byId.get(from.node);
    this.edges.set(id, {
      id,
      from,
      to,
      kind,
      ...(path === undefined ? {} : { path }),
      ...(expr === undefined ? {} : { expr }),
      ...(producer ? { state: producer.state } : {}),
    });
  }

  /** `order` edges between consecutive children, innermost frames first. */
  #orderEdges(f: PlanFrame): void {
    for (const c of f.children) if (c.kind === "frame" && !c.recursive) this.#orderEdges(c);
    for (const [a, b] of this.index.orderPairs.get(f.key) ?? []) {
      this.#edge({ node: a, port: portIds.order }, { node: b, port: portIds.order }, "order");
    }
  }

  /** The plan's edges: identity and projection wires as lines (a projection labelled by its
   *  path), each compute wire through its block. */
  #planEdges(): void {
    const routed = new Set<string>();
    for (const e of this.index.edges) {
      const wire = e.wire;
      const t = wire && this.index.transforms.get(wire.id);
      if (!wire || !t) {
        const path = wire?.kind === "projection" && wire.path ? [...wire.path] : undefined;
        // A computation over params / ingress: its expression, unless the consumer's card prints
        // it already (a step operand).
        const consumer = this.plan.byKey.get(e.to.key);
        const expr = wire?.kind === "compute" && consumer?.kind !== "step" ? wire.text : undefined;
        this.#edge({ node: e.from.key, port: e.from.port }, { node: e.to.key, port: e.to.port }, e.kind, path, expr);
        continue;
      }
      if (routed.has(wire.id)) continue;
      routed.add(wire.id);
      const id = transformId(wire);
      for (const [k, x] of t.edges.entries()) {
        this.#edge(
          { node: x.from.key, port: x.from.port },
          { node: id, port: `in:${k}` },
          x.kind === "control" ? "control" : "data",
        );
      }
      let kind: RenderEdge["kind"] = "data";
      if (t.edges.some((x) => x.kind === "recur")) kind = "recur";
      else if (e.to.port === portIds.control) kind = "control";
      this.#edge({ node: id, port: portIds.out }, { node: e.to.key, port: e.to.port }, kind);
    }
  }
}

const transformId = (wire: WireShape): string => `ƒ${wire.id}`;

/** A `do` / `while` loop's last test evaluation (the one that ended it) starts a body holding
 *  only that test: it is the loop's exit, not an iteration — dropped once the loop settled. */
function exitFolded(inst: FrameInstance, p: Progress): readonly Body[] {
  const marker = inst.template.iterationMarker;
  const last = inst.bodies.at(-1);
  if (marker === undefined || !last || !p.isSettled(inst)) return inst.bodies;
  return last.items.every((i) => i.span === marker) && last.unplanned.length === 0
    ? inst.bodies.slice(0, -1)
    : inst.bodies;
}

/** Captured arguments by step slot, as the plan names them ({@link operandSlots}). */
function bySlot(inputs: readonly CapturedOperand[]): Map<string, CapturedOperand> {
  return new Map(operandSlots(inputs.map((v) => v.form)).map(({ slot, at }) => [slot, inputs[at]!]));
}

function outputOf(values: { hasOutput: boolean; output?: unknown; error?: unknown } | undefined): RenderStep["output"] {
  if (!values) return { hasValue: false };
  if (values.error !== undefined) return { hasValue: false, error: errorText(values.error) };
  return values.hasOutput ? { hasValue: true, value: values.output } : { hasValue: false };
}

/** The spans whose values the graph's transforms read: each compute wire's own form (its
 *  result into a frame port) and each frame a compute wire feeds the `out` of. Hand them to
 *  `ExecutionCapture.retainSpans` before the run — the trace prunes them otherwise. */
export function retainedSpans(plan: Plan): Set<string> {
  const spans = new Set<string>();
  for (const e of plan.edges) {
    if (e.wire?.kind !== "compute") continue;
    if (e.wire.span !== undefined) spans.add(e.wire.span);
    const consumer = e.to.key === plan.root.key ? undefined : plan.byKey.get(e.to.key);
    if (consumer?.kind === "frame" && e.to.port === portIds.out) spans.add(consumer.span);
  }
  return spans;
}

/** Plan (+ progress) → RenderGraph. Potential without `progress`, actual with it. */
export function toRenderGraph(plan: Plan, progress?: Progress, opts: RenderGraphOptions = {}): RenderGraph {
  return new Builder(plan, progress, opts).build();
}

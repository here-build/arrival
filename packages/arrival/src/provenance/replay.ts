/**
 * Replay drivers. R1: replay from frozen port payloads is stable — NEVER
 * re-invoke a source; retrospective mint records are authoritative.
 *
 *   1. `replayGraphEgress` — per-wire γ over a loop-free graph (`applyWireInEnv`).
 *      Binder/fan/transparent/opaque are teaching doors, not silent approximations.
 *   2. `replayProgramWithPlayback` — whole program on a silent hermetic run; membrane
 *      penetrations answered only from the recorded payload stream.
 *   3. `replayBetweenRecords` — effect tracks: pure stretches γ'd, mint events
 *      interleaved verbatim in seq order (fold requires completed region).
 *
 * D1 — Frozen ingress keyed (op, TRACK) with a per-key FIFO. A TRACK is the closure/fan-lambda
 *      call a crossing ran under — `[r_C, k, …]` relative to the run's root (§3: `r_C` = the
 *      site's node index, `k` = the call's instance among its defining window's calls of that
 *      site). Calls WITHIN a track are sequential, so FIFO inside one (op, track) is exact;
 *      ACROSS a fan's tracks the order is unobservable (P18) and never consulted — a payload
 *      reaches the demand at ITS coordinate whatever order the live tracks completed in. The
 *      A γ demand also names its static SITE (`scopeId` of the crossing's call expression — the
 *      recorder's `currentCallNode`), so a crossing γ never demands (a value-dropped call) cannot
 *      shift the queue: FIFO runs only among calls of the SAME site within a track. Residual: a
 *      value-dropped call of a site that is ALSO demanded in the same track (the same define'd
 *      function called twice, once dropped), and crossings made through an alias
 *      (`(let ((h fetch)) (h 1))` — γ cannot see the call site), stay in plain FIFO order. A record
 *      or a demand without a coordinate falls back to the plain per-op FIFO (sequential programs,
 *      offload).
 *      A crossing a host verb issues straight from a fan (`(map fetch xs)` — no lambda literal) runs
 *      in the track of the verb's apply site: the evaluator publishes that site's window for the
 *      verb's synchronous prologue (`enterCallSite`), and a fan starts its callbacks in index order.
 *      Within one track, ids are claimed at call START, so a consumer feeds each (op, track) queue in
 *      record-id ordinal order — the stream itself is in COMPLETION order (P18) and must not be used.
 * D2 — Unrecorded demand → sentinel stamp (≥ SENTINEL_BASE). Laws assert
 *      cone(egress) ∩ sentinels = ∅.
 * D3 — Mux arm: recorded decision map wins; else γ selector (closed over frozen ports).
 * D4 — binder/recur/transparent/opaque → `ReplayScopeError` with route, never a wrong value.
 * D5 — closure/fan/guard (P17): a closure node replays to a callable that instantiates its template
 *      per call; a fan applies the verb (`(op fn s…)`) to replay callables; a guard catches via the
 *      evaluator's own `guard` and routes the condition to clause wires (`slot: "condition"`).
 */
import { R7RSError } from "../errors.js";
import { currentClosureCall } from "../eval/dynamic-call-site.js";
import { execState } from "../eval/generator-exec.js";
import { type AmbientValue } from "../env/AmbientRuntime.js";
import type { LexicalScopeWithInternals } from "../eval/LexicalScope.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import { collapseProvenance } from "./provenance-collapse.js";
import { AValue, EMPTY_PROVENANCE, pointProvenance } from "../values/primitives/AValue.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { ARosettaProcedure } from "../values/primitives/ARosettaProcedure.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { toJS, jsToScheme } from "../membrane/rosetta.js";
import { CONSTANT_CTX, type RunContext, type RunEmission } from "../run/RunContext.js";
import type { CallCtx } from "../run/CallCtx.js";
import type { SchemeValue } from "../values/types.js";
import type { EnvCapability } from "../common/capability.js";
import { applyWireInEnv } from "./gamma.js";
import { hermeticEnv, leaseNestedEnv, type HermeticEnv, type IngressBindings } from "./hermetic-env.js";
import { foldRegionStream } from "./store/fold.js";
import type { Payload, PayloadStore, ProvenanceStore } from "./store/interfaces.js";
import { parseProgram } from "../eval/exec-phases.js";
import { buildWireframe, type WireframeBuildOptions } from "./wireframe/builder.js";
import type { MintRecord } from "./store/records.js";
import type { RegionId } from "./store/ids.js";
import type { EmittedWire, Wire, WireframeGraph, WireframeNode, WireframeProgram } from "./wireframe/types.js";

/** Teaching door: demand outside this driver's scope — routes, never silently wrong. */
export class ReplayScopeError extends Error {
  constructor(
    readonly nodeKind: string,
    readonly span: string,
    teach: string,
  ) {
    super(`replay: ${nodeKind} node at ${span} is outside this driver's scope — ${teach}`);
    this.name = "ReplayScopeError";
  }
}

/** Sentinel stamp base — outside eager/recorded ranges so cone∩sentinels is meaningful. */
export const SENTINEL_BASE = 1 << 30;

/** A track's coordinate relative to the run's root: `[r_C, k, r_C', k', …]`; `[]` = the root track. */
export type TrackPath = readonly number[];

/** The track a recorded mint ran under: its record id's ordinal path minus the run's root coordinate
 *  (`root`) and the trailing per-window event ordinal. */
export function trackOfRecord(ordinalPath: readonly number[], root: readonly number[]): TrackPath {
  return ordinalPath.slice(root.length, -1);
}

const trackKey = (track: TrackPath): string => track.join(".");

/** One graph INSTANCE's track state in a γ replay: where it runs, and the per-site call counters of
 *  its window (shared with the template instances it calls inline, mirroring the recorder's
 *  per-window counters). Keyed by node INDEX, as the recorder keys by `ClosureSite.rootOrdinal`:
 *  two sites with one index (from different template graphs) share a counter, so every call made
 *  from this window gets a distinct `[…track, idx, k]`. */
export interface TrackInstance {
  readonly track: TrackPath;
  readonly calls: Map<number, number>;
}

export const rootInstance = (track: TrackPath = []): TrackInstance => ({ track, calls: new Map() });

/** The window of the NEXT call of the closure/fan at node index `idx` made from `instance`:
 *  `[…track, idx, k]`. Claimed synchronously at call start — the recorder claims `k` the same way. */
export function claimCall(instance: TrackInstance, idx: number): TrackInstance {
  const k = instance.calls.get(idx) ?? 0;
  instance.calls.set(idx, k + 1);
  return rootInstance([...instance.track, idx, k]);
}

/** The γ instance whose graph is running on each hermetic run. A run executes one instance at a
 *  time (leases are exclusive; a template-ref inlines on the same instance), so a run-keyed slot,
 *  set for the instance's duration and restored after, names the CALLER of any closure applied on
 *  that run. Run-scoped side table, like `hermetic-env.ts`'s `envByRun`. */
const instanceOnRun = new WeakMap<RunContext, TrackInstance>();

/** Mark `instance` as running on `runCtx` until the returned `leave()`. */
export function enterInstance(runCtx: RunContext, instance: TrackInstance): () => void {
  const previous = instanceOnRun.get(runCtx);
  instanceOnRun.set(runCtx, instance);
  return () => {
    if (previous === undefined) instanceOnRun.delete(runCtx);
    else instanceOnRun.set(runCtx, previous);
  };
}

/** The instance a closure call is numbered on. Inside an apply site's synchronous prologue (a direct
 *  call, or a host verb starting its callbacks) it is the CALLER's: calls within one caller track are
 *  sequential, so their order cannot depend on how sibling tracks interleave. Outside one (a verb
 *  calling back after an await) it is the defining instance. The recorder applies the same rule
 *  (`openClosureCall`'s caller window in evaluator.ts). */
function callerInstance(ctx: ReplayCtx, callCtx: CallCtx): TrackInstance {
  const inPrologue = "closureCall" in callCtx.runCtx.ambient;
  return (inPrologue ? instanceOnRun.get(callCtx.runCtx) : undefined) ?? ctx.instance;
}

/** A recorded payload, optionally addressed by the track it was minted under. */
export interface PlaybackEntry extends Payload {
  readonly track?: TrackPath;
  /** The static crossing site (`scopeId` of the call expression the host verb ran under). */
  readonly site?: string;
}

/** D1: (op, track)-keyed FIFO of recorded mint payloads + D2 sentinel ledger. */
export class FrozenMints {
  private readonly queues = new Map<
    string,
    { readonly payload: Payload; readonly key: string | undefined; readonly site: string | undefined }[]
  >();
  /** Spans of every static crossing node (source / closure / fan) of the programs replayed against this
   *  ledger — the sites a γ demand can name. A recorded crossing at any OTHER site came through an
   *  alias (`(let ((h fetch)) (h 1))`) whose call site γ cannot see. */
  private readonly staticSites = new Set<string>();
  /** sentinel id → demand site (op+span). */
  readonly sentinels = new Map<number, string>();
  /** Instance state, not module-global: one `FrozenMints` per replay ⇒ two replays of the same
   *  program mint identical sentinel ids (replay is a pure function of its frozen ingress). */
  private nextSentinel = SENTINEL_BASE;

  /** Register `program`'s static crossing sites (idempotent). Drivers call this before demanding. */
  declareProgram(program: WireframeProgram): void {
    const visit = (graph: WireframeGraph): void => {
      for (const node of graph.nodes) {
        if (node.kind === "source" || node.kind === "closure" || node.kind === "fan") this.staticSites.add(node.span);
        if ((node.kind === "closure" || node.kind === "fan") && node.template !== undefined) visit(node.template);
      }
    };
    visit(program.main);
    for (const template of program.templates.values()) visit(template.graph);
  }

  push(op: string, payload: Payload, track?: TrackPath, site?: string): void {
    const entry = { payload, key: track === undefined ? undefined : trackKey(track), site };
    const q = this.queues.get(op);
    if (q === undefined) this.queues.set(op, [entry]);
    else q.push(entry);
  }

  /** The demand's payload. Within its own track, a demand that names its crossing SITE takes the first
   *  entry recorded at that site, else the first entry no static site accounts for (an alias call) —
   *  never another static site's: a crossing γ never demands (value-dropped) cannot shift the queue.
   *  A site-less demand takes the track's first entry; then the first coordinate-less record; a
   *  coordinate-less demand takes the op's first entry (plain FIFO). `undefined` ⇒ unrecorded (D2). */
  next(op: string, track?: TrackPath, site?: string): Payload | undefined {
    const q = this.queues.get(op);
    if (q === undefined) return undefined;
    const key = track === undefined ? undefined : trackKey(track);
    if (key === undefined) return q.shift()?.payload;
    let at: number;
    if (site === undefined) at = q.findIndex((e) => e.key === key);
    else {
      at = q.findIndex((e) => e.key === key && e.site === site);
      if (at < 0) at = q.findIndex((e) => e.key === key && (e.site === undefined || !this.staticSites.has(e.site)));
    }
    if (at < 0) at = q.findIndex((e) => e.key === undefined);
    return at < 0 ? undefined : q.splice(at, 1)[0].payload;
  }

  sentinel(runCtx: RunContext, desc: string): SchemeValue {
    const id = this.nextSentinel++;
    this.sentinels.set(id, desc);
    return jsToScheme(runCtx, `#sentinel:${id}`, {}, new Set([id]));
  }
}

/**
 * Mux control-dependency: taken arm carries selector cone (eager `if` + wireframe
 * selector walk). Exported so replay-walk applies the same union at yield points.
 */
export function withUnionedProvenance(value: SchemeValue, taintFrom: SchemeValue): SchemeValue {
  if (!(value instanceof AValue)) return value;
  const taint = collapseProvenance(taintFrom);
  if (taint.size === 0) return value;
  const merged = new Set<number>([...value.provenance, ...taint]);
  return value.withProvenance(merged);
}

type MuxNode = Extract<WireframeNode, { kind: "mux" }>;

/**
 * D3 arm choice from the γ'd selector — the ONE place mux slot naming is read, shared by both
 * drivers (replay.ts / replay-walk.ts). Mirrors the builder (`buildMux` / `buildAndOrMux`):
 * `if` → arm0 then / arm1 else (absent when else-less); `when` → arm0 = last body; `unless` →
 * arm0 = last body, taken on #f; `and` → arm0 (the remaining operands) taken on truthy; `or` →
 * arm0 taken on #f. `null` = the form's fallthrough: void for `if`/`when`/`unless`, the
 * SELECTOR's own value for `and`/`or` (`muxFallthrough`) — not a record gap. The sequential
 * muxes (`cond`, `case`: one selector per clause) cannot be chosen from a single selector —
 * drivers walk their `selector{k}` wires lazily (`isSequentialMux`).
 */
export function muxArmFor(node: MuxNode, selector: SchemeValue): number | null {
  const truthy = toJS(selector) !== false; // scheme truth: only #f is false
  if (node.op === "and") return truthy ? 0 : null;
  if (node.op === "or") return truthy ? null : 0;
  const takesBody = node.op === "unless" ? !truthy : truthy; // arm0 is the sole/then body
  const arm = takesBody ? 0 : 1;
  return arm < node.arms ? arm : null;
}

/** `cond` / `case` muxes: `selector0…` are the per-clause tests (non-else clauses, in order),
 *  the `else` arm (if any) is the LAST arm and has no selector. Drivers walk selectors in order,
 *  lazily, and take the first truthy. (A `cond` `=>` clause's arm is `(proc test)`, so its arm
 *  wire is exact too.) */
export function isSequentialMux(node: MuxNode): boolean {
  return node.op === "cond" || node.op === "case";
}

/** Sequential arm: the first truthy selector's index, else the `else` arm (index = selector
 *  count, present iff `node.arms` exceeds it), else `null` (value-less fallthrough). */
export function seqMuxFallbackArm(node: MuxNode, selectorCount: number): number | null {
  return node.arms > selectorCount ? selectorCount : null;
}

/** How many `selector{k}` wires feed `node` in `graph` (the sequential muxes' clause count). */
export function selectorCountOf(graph: WireframeGraph, node: number): number {
  return graph.wires.filter((w) => w.consumer.node === node && /^selector\d+$/.test(w.consumer.slot)).length;
}

/** Value when `muxArmFor` returns null: `and`/`or` yield the selector's own value (the
 *  short-circuited operand); every other mux yields void. */
export function muxFallthrough(node: MuxNode, selector: SchemeValue): SchemeValue {
  return node.op === "and" || node.op === "or" ? selector : theVoid;
}

/** Does the taken arm carry the SELECTOR's cone (control dependency)? `and`/`or` are
 *  value-select: the result is an operand value, no predicate taint (classify's rule). */
export function muxCarriesSelector(node: MuxNode): boolean {
  return node.op !== "and" && node.op !== "or";
}

// ── Closure / fan / guard — the replay half of closure nodes (P17) ────────────

export type ClosureNode = Extract<WireframeNode, { kind: "closure" }>;
export type FanNode = Extract<WireframeNode, { kind: "fan" }>;
export type GuardNode = Extract<WireframeNode, { kind: "guard" }>;

/** What a closure/fan/guard instantiation needs from the replay it lives in: the hermetic base,
 *  the program (templates), and the ONE FrozenMints ledger (shared by every instantiation). */
export interface ReplayCtx {
  readonly base: HermeticEnv;
  readonly program: WireframeProgram;
  readonly frozen: FrozenMints;
  /** The graph instance this ctx instantiates from — its track and call counters (D1). */
  readonly instance: TrackInstance;
}

const listOf = (items: readonly SchemeValue[]): SchemeValue =>
  items.reduceRight<SchemeValue>((tail, head) => new APair(head, tail), nil);

/** Formals → name-keyed ingress: positional params, the rest formal gets the remaining args as a list. */
function bindFormals(
  params: readonly string[],
  rest: string | undefined,
  args: readonly SchemeValue[],
): IngressBindings {
  const out: Record<string, AmbientValue> = {};
  params.forEach((name, i) => {
    out[name] = args[i];
  });
  if (rest !== undefined) out[rest] = listOf(args.slice(params.length));
  return out;
}

/** A recorded REJECTED crossing, re-raised: replay never consults the world, so the throw the
 *  program branched on is replayed from the `raised` payload. A scheme `guard` (in-γ) catches it as
 *  an ordinary host error; the drivers catch it around a guard body's ingress. */
export class ReplayRaise extends Error {
  constructor(
    readonly condition: string,
    readonly span: string,
  ) {
    super(condition);
    this.name = "ReplayRaise";
  }
}

/** One source demand: the recorded mint boxed, a sentinel when unrecorded (D2), or the recorded
 *  raise re-thrown. Shared by both drivers' source arms and `ref:port` closures. */
export function sourceValue(
  frozen: FrozenMints,
  op: string,
  span: string,
  runCtx: RunContext,
  track?: TrackPath,
): SchemeValue {
  // `span` is the demanding node's static site: the recorder names the same expression (`scopeId`).
  const payload = frozen.next(op, track, span);
  if (payload === undefined) return frozen.sentinel(runCtx, `source:${op}@${span}`);
  if (payload.raised === true) throw new ReplayRaise(String(payload.value), span);
  return boxPayload(payload, runCtx);
}

/** A `ref:port` closure APPLIED: the crossing itself — recorded mint (or sentinel, D2), never the world. */
function portCrossing(ctx: ReplayCtx, node: ClosureNode & { ref: { kind: "port" } }): SchemeValue {
  const { op, role } = node.ref;
  if (role === "source") {
    return sourceValue(ctx.frozen, op, node.span, ctx.base.runCtx, ctx.instance.track);
  }
  if (role === "sink") return ctx.frozen.sentinel(ctx.base.runCtx, `sink:${op}@${node.span}`);
  throw new ReplayScopeError(
    role,
    node.span,
    "a crossing with no recorded payload has nothing to be stable FROM — record it (source) or declare it pure",
  );
}

/**
 * A closure node's replay VALUE: a callable whose APPLICATION instantiates the template per call
 * (fresh node memo ⇒ ports inside demand frozen mints in call order). It closes over FROZEN data
 * only (program, ledger, base) plus the lazily γ'd capture values — never a live value; it is a
 * γ-time object (never persisted). `captures` is a lazy memoized thunk so a self-capture (letrec)
 * resolves through the enclosing node memo and a never-called closure evaluates nothing.
 */
export function closureValue(
  ctx: ReplayCtx,
  node: ClosureNode,
  idx: number,
  captures: (inner: HermeticEnv) => Promise<IngressBindings>,
): SchemeValue {
  const arity = { min: node.params.length, max: node.rest === undefined ? node.params.length : null };
  return new ANativeProcedure({
    name: `γ-closure@${node.span}`,
    arity,
    impl: async (args, callCtx) => {
      // Synchronously, before any await: this call's coordinate is its start order within the
      // caller's track.
      const caller = callerInstance(ctx, callCtx);
      const call = node.template === undefined ? undefined : claimCall(caller, idx);
      if (node.ref?.kind === "port") return portCrossing(ctx, node as ClosureNode & { ref: { kind: "port" } });
      if (node.ref?.kind === "define") {
        const template = ctx.program.templates.get(node.ref.name);
        if (template === undefined) {
          throw new ReplayScopeError("closure", node.span, `template "${node.ref.name}" is absent`);
        }
        // A sink-tail template has no value egress: calling it is an effect, its value is void
        // (LIMIT: the effect's own ports are not re-demanded — they are sinks, nothing to replay).
        if (template.graph.egress === null) return theVoid;
        const slots = bindFormals(template.params, undefined, args);
        const lease = await leaseNestedEnv(ctx.base, callCtx.runCtx);
        try {
          // A define'd function is not a track: its crossings run in the caller's window (recorder parity).
          return await replayGraphIn(lease.env, ctx.program, template.graph, ctx.frozen, slots, undefined, caller);
        } finally {
          lease.release();
        }
      }
      if (node.template === undefined) {
        throw new ReplayScopeError("closure", node.span, "closure node has neither template nor ref");
      }
      const lease = await leaseNestedEnv(ctx.base, callCtx.runCtx);
      try {
        const slots = { ...bindFormals(node.params, node.rest, args), ...(await captures(lease.env)) };
        return await replayGraphIn(lease.env, ctx.program, node.template, ctx.frozen, slots, undefined, call ?? caller);
      } finally {
        lease.release();
      }
    },
  });
}

/** Run a wire as `(op fn s0 s1 …)` — the verb's OWN semantics (provenance, order, laziness) decide
 *  how `fn` is applied; replay only supplies the callable. */
export async function applyFan(
  ctx: ReplayCtx,
  node: FanNode,
  fn: SchemeValue | undefined,
  sources: readonly SchemeValue[],
): Promise<SchemeValue> {
  const ingress: Record<string, AmbientValue> = {};
  const names = sources.map((_, i) => `__fan_s${i}`);
  sources.forEach((v, i) => {
    ingress[names[i]] = v;
  });
  if (fn === undefined && node.fnOp === undefined) {
    throw new ReplayScopeError("fan", node.span, "fan has neither a template, a by-name callback, nor an `fn` wire");
  }
  if (fn !== undefined) ingress.__fan_fn = fn;
  const callee = fn === undefined ? (node.fnOp as string) : "__fan_fn";
  const params = Object.keys(ingress);
  const wire: EmittedWire = {
    source: `(lambda (${params.join(" ")}) (${node.op} ${callee} ${names.join(" ")}))`,
    params,
    paramRefs: [],
    span: node.span,
  };
  return applyWireInEnv(ctx.base, wire, ingress);
}

/** The callable for a fan's inline lambda template (per-element instantiation; captures sealed once). */
export function fanTemplateValue(
  ctx: ReplayCtx,
  node: FanNode,
  idx: number,
  captures: (inner: HermeticEnv) => Promise<IngressBindings>,
): SchemeValue {
  const template = node.template as WireframeGraph;
  const elementParams = node.elementParams ?? [];
  return new ANativeProcedure({
    name: `γ-fan@${node.span}`,
    arity: { min: elementParams.length, max: elementParams.length },
    impl: async (args, callCtx) => {
      // Element i's call is track `[…, r_fan, i]` — claimed in start order, before any await.
      const call = claimCall(ctx.instance, idx);
      const lease = await leaseNestedEnv(ctx.base, callCtx.runCtx);
      try {
        const slots = { ...bindFormals(elementParams, undefined, args), ...(await captures(lease.env)) };
        return await replayGraphIn(lease.env, ctx.program, template, ctx.frozen, slots, undefined, call);
      } finally {
        lease.release();
      }
    },
  });
}

/** Outcome of evaluating a guard's protected body. */
export type GuardOutcome =
  | { readonly raised: false; readonly value: SchemeValue }
  | { readonly raised: true; readonly condition: SchemeValue };

/**
 * γ of a guard's `body` wire, catching a Scheme raise. The catch is done BY THE EVALUATOR (a
 * wrapper `(guard (c (#t (cons #t c))) (cons #f (body …)))`), so the original raised object is
 * recovered exactly as `guard` itself would, and containment errors (budget/abort) propagate.
 */
export async function applyGuardBody(
  base: HermeticEnv,
  wire: EmittedWire,
  ingress: IngressBindings,
): Promise<GuardOutcome> {
  const params = wire.params.join(" ");
  const wrapped: EmittedWire = {
    ...wire,
    source: `(lambda (${params}) (guard (__gc (#t (cons #t __gc))) (cons #f (${wire.source}${params.length > 0 ? ` ${params}` : ""}))))`,
  };
  const pair = await applyWireInEnv(base, wrapped, ingress);
  if (!(pair instanceof APair)) throw new ReplayScopeError("guard", wire.span, "guard wrapper returned a non-pair");
  return toJS(pair.car) === true ? { raised: true, condition: pair.cdr } : { raised: false, value: pair.cdr };
}

/** No clause matched: re-raise the condition (R7RS `guard` falls through to the outer handler). */
export async function reraise(base: HermeticEnv, span: string, condition: SchemeValue): Promise<never> {
  const wire: EmittedWire = { source: "(lambda (__gc) (raise __gc))", params: ["__gc"], paramRefs: [], span };
  await applyWireInEnv(base, wire, { __gc: condition });
  throw new ReplayScopeError("guard", span, "re-raise did not raise");
}

/** Payload → boxed scheme (live rosetta boxing idiom) with recorded stamps. `runCtx` is the
 *  replay's hermetic run; run-less construction (slots minted before any replay run) omits it. */
export function boxPayload(payload: Payload, runCtx: RunContext = CONSTANT_CTX): SchemeValue {
  return jsToScheme(runCtx, payload.value, {}, new Set(payload.stampIds));
}

/** Boxed (cone queries) + peeled (payload compare). */
export interface ReplayedValue {
  readonly boxed: SchemeValue;
  readonly value: unknown;
}

export interface ReplayGraphOptions {
  readonly program: WireframeProgram;
  /** Defaults to `program.main`; track laws pass a fan template interior. */
  readonly graph?: WireframeGraph;
  readonly frozen: FrozenMints;
  readonly slots?: IngressBindings;
  /** D3: node index → taken arm; else selector-γ. Indexes the replayed graph's own nodes only —
   *  nested template graphs replay by selector-γ. */
  readonly decisions?: ReadonlyMap<number, number>;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Face 1 — loop-free graph γ, lazy/memoized per node (untaken arms never demanded).
 */
export async function replayGraphEgress(opts: ReplayGraphOptions): Promise<ReplayedValue> {
  const { program, frozen, decisions, slots = {}, basePacks = [], config } = opts;
  const graph = opts.graph ?? program.main;
  frozen.declareProgram(program);
  // Standard-base fold is this call site's job (see hermetic-env / gamma).
  const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], program.prelude.source, {}, config);
  const boxed = await replayGraphIn(base, program, graph, frozen, slots, decisions, rootInstance());
  return { boxed, value: toJS(boxed) };
}

async function replayGraphIn(
  base: HermeticEnv,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
  instance: TrackInstance,
  goal?: GraphGoal,
): Promise<SchemeValue> {
  const leave = enterInstance(base.runCtx, instance);
  try {
    return await replayGraphInstance(base, program, graph, frozen, slots, decisions, instance, goal);
  } finally {
    leave();
  }
}

/** Alternative demand root (default: the graph's egress) — `fanCaptureSlots` demands capture wires. */
type GraphGoal = (h: {
  wireFor: (node: number, slot: string) => Wire;
  gammaWire: (w: EmittedWire) => Promise<SchemeValue>;
}) => Promise<SchemeValue>;

async function replayGraphInstance(
  base: HermeticEnv,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
  /** This graph instance's track + call counters (D1). */
  instance: TrackInstance,
  goal?: GraphGoal,
): Promise<SchemeValue> {
  const nodeMemo = new Map<number, SchemeValue>();
  /** guard idx → the caught condition (`{node: guard, slot: "condition"}` refs read it). */
  const conditions = new Map<number, SchemeValue>();
  // The hermetic base γ currently RUNS on. A run handle executes one call at a time: when a
  // closure/fan callable (a native procedure executing on the parent run) asks for this graph's
  // captures, they are γ'd on the closure's NESTED base — strictly nested, so a single mutable
  // slot (restored in `finally`) is exact.
  let current = base;
  const ctx: ReplayCtx = {
    get base() {
      return current;
    },
    program,
    frozen,
    instance,
  };

  const wireFor = (node: number, slot: string): Wire => {
    const wire = graph.wires.find((w) => w.consumer.node === node && w.consumer.slot === slot);
    if (wire === undefined) {
      const kind = graph.nodes[node]?.kind ?? "?";
      throw new ReplayScopeError(
        kind,
        graph.nodes[node]?.span ?? "?",
        `no wire feeds slot "${slot}" — record gap or builder gap; nothing to γ`,
      );
    }
    return wire;
  };

  const ingressOf = async (wire: EmittedWire): Promise<Record<string, AmbientValue>> => {
    const ingress: Record<string, AmbientValue> = {};
    for (const ref of wire.paramRefs) {
      if (ref.kind === "slot") {
        const bound = slots[ref.name];
        if (bound === undefined) {
          throw new ReplayScopeError(
            "slot",
            wire.span,
            `free slot "${ref.name}" has no caller binding — program ingress must be supplied to replay`,
          );
        }
        ingress[ref.name] = bound;
      } else if (ref.slot === "condition") {
        const cond = conditions.get(ref.node);
        if (cond === undefined) {
          throw new ReplayScopeError("guard", wire.span, "condition demanded before the guard caught — builder gap");
        }
        ingress[ref.name] = cond;
      } else {
        // `slot` = the node INPUT's value (a recur's `argK`), not the node's egress.
        ingress[ref.name] =
          ref.slot === undefined ? await nodeValue(ref.node) : await gammaWire(wireFor(ref.node, ref.slot));
      }
    }
    return ingress;
  };

  const gammaWire = async (wire: EmittedWire): Promise<SchemeValue> =>
    applyWireInEnv(current, wire, await ingressOf(wire));

  /** Lazy memoized capture γ for a node (sealed once, at first use). */
  const capturesOf = (idx: number, names: readonly string[]): ((inner: HermeticEnv) => Promise<IngressBindings>) => {
    let cap: Promise<IngressBindings> | undefined;
    return (inner) =>
      (cap ??= (async () => {
        const out: Record<string, AmbientValue> = {};
        const prev = current;
        current = inner;
        try {
          for (const name of names) out[name] = await gammaWire(wireFor(idx, `capture:${name}`));
        } finally {
          current = prev;
        }
        return out;
      })());
  };

  const nodeValue = async (idx: number): Promise<SchemeValue> => {
    const memo = nodeMemo.get(idx);
    if (memo !== undefined) return memo;
    const node = graph.nodes[idx];
    let value: SchemeValue;
    switch (node.kind) {
      case "source": {
        // R1: recorded payload is the value; unrecorded demand → sentinel (D2).
        value = sourceValue(frozen, node.op, node.span, current.runCtx, instance.track);
        break;
      }
      case "sink":
        // No egress — sequencing residue; sentinel must not flow (D2).
        value = frozen.sentinel(base.runCtx, `sink:${node.op}@${node.span}`);
        break;
      case "mux": {
        // D3: recorded arm or selector-γ; always γ selector for control-dependency taint.
        if (isSequentialMux(node)) {
          // `cond`/`case`: per-clause selectors, lazily in order; first truthy wins, else the else arm.
          const count = selectorCountOf(graph, idx);
          const forced = decisions?.get(idx);
          let arm: number | null = null;
          let taint: SchemeValue | undefined;
          for (let k = 0; k < count; k++) {
            const sel = await gammaWire(wireFor(idx, `selector${k}`));
            taint = taint === undefined ? sel : withUnionedProvenance(sel, taint);
            if (forced === undefined ? toJS(sel) !== false : forced === k) {
              arm = k;
              break;
            }
          }
          arm ??= forced ?? seqMuxFallbackArm(node, count);
          value =
            arm === null
              ? theVoid
              : await gammaWire(wireFor(idx, `arm${arm}`)).then((v) =>
                  taint === undefined ? v : withUnionedProvenance(v, taint as SchemeValue),
                );
          break;
        }
        const selBoxed = await gammaWire(wireFor(idx, "selector"));
        const arm = decisions?.get(idx) ?? muxArmFor(node, selBoxed);
        if (arm === null) value = muxFallthrough(node, selBoxed);
        else {
          const armValue = await gammaWire(wireFor(idx, `arm${arm}`));
          value = muxCarriesSelector(node) ? withUnionedProvenance(armValue, selBoxed) : armValue;
        }
        break;
      }
      case "template-ref": {
        const template = program.templates.get(node.name);
        if (template?.graph.egress == null) {
          throw new ReplayScopeError(
            "template-ref",
            node.span,
            `template "${node.name}" is absent or has no egress — nothing to replay`,
          );
        }
        const args: Record<string, AmbientValue> = {};
        for (let k = 0; k < template.params.length; k++) {
          args[template.params[k]] = await gammaWire(wireFor(idx, `arg${k}`));
        }
        // decisions index THIS graph's nodes; a template graph has its own node space (A6).
        value = await replayGraphIn(base, program, template.graph, frozen, args, undefined, instance);
        break;
      }
      case "closure":
        value = closureValue(ctx, node, idx, capturesOf(idx, node.captures));
        break;
      case "fan": {
        // The verb applies the replay callable per element (its OWN provenance/order semantics).
        const sources: SchemeValue[] = [];
        for (
          let k = 0;
          graph.wires.some((w) => w.consumer.node === idx && w.consumer.slot === (k === 0 ? "source" : `source${k}`));
          k++
        ) {
          sources.push(await gammaWire(wireFor(idx, k === 0 ? "source" : `source${k}`)));
        }
        let fn: SchemeValue | undefined;
        if (node.template !== undefined) fn = fanTemplateValue(ctx, node, idx, capturesOf(idx, node.captures));
        else if (node.fnOp === undefined) fn = await gammaWire(wireFor(idx, "fn"));
        value = await applyFan(ctx, node, fn, sources);
        break;
      }
      case "guard": {
        const body = wireFor(idx, "body");
        let outcome: GuardOutcome;
        try {
          outcome = await applyGuardBody(current, body, await ingressOf(body));
        } catch (error) {
          // A recorded rejected crossing demanded while resolving the body's ingress IS the raise.
          if (!(error instanceof ReplayRaise)) throw error;
          outcome = { raised: true, condition: new R7RSError(error.condition) as unknown as SchemeValue };
        }
        if (!outcome.raised) {
          value = outcome.value;
          break;
        }
        conditions.set(idx, outcome.condition);
        const count = selectorCountOf(graph, idx);
        let arm: number | null = null;
        let taint: SchemeValue = outcome.condition;
        for (let k = 0; k < count; k++) {
          const sel = await gammaWire(wireFor(idx, `selector${k}`));
          taint = withUnionedProvenance(sel, taint);
          if (toJS(sel) !== false) {
            arm = k;
            break;
          }
        }
        arm ??= node.clauses > count ? count : null;
        if (arm === null) return reraise(current, node.span, outcome.condition);
        value = withUnionedProvenance(await gammaWire(wireFor(idx, `arm${arm}`)), taint);
        break;
      }
      case "binder":
      case "recur":
        throw new ReplayScopeError(
          node.kind,
          node.span,
          "loops are the half wire-γ does NOT claim (widening makes loop cones non-least); exact reconstruction is one γ-step away via aggregation count + quoted body — `replayProgramWithPlayback`",
        );
      case "transparent":
      case "opaque":
        throw new ReplayScopeError(
          node.kind,
          node.span,
          "a crossing with no recorded payload has nothing to be stable FROM — record it (source) or declare it pure",
        );
      case "port":
        throw new ReplayScopeError("port", node.span, "the out-port is the egress consumer, never a value producer");
      default: {
        const never: never = node;
        throw new ReplayScopeError(String((never as { kind?: string }).kind), "?", "unhandled node kind");
      }
    }
    nodeMemo.set(idx, value);
    return value;
  };

  if (goal !== undefined) return goal({ wireFor, gammaWire: (w) => gammaWire(w) });
  if (graph.egress === null) {
    throw new ReplayScopeError(
      "port",
      "?",
      "graph has no value egress (all-defines or sink-tail program) — nothing to replay",
    );
  }
  return gammaWire(wireFor(graph.egress, "out"));
}

/**
 * The sealed CAPTURE values of fan node `fanIdx` in `graph` (default `program.main`): γ of each
 * `capture:<name>` wire from frozen ingress — the slots a manual per-track replay of
 * `fan.template` needs beside its element params (track laws bind `{ v, ...captures }`).
 */
export async function fanCaptureSlots(
  opts: ReplayGraphOptions & { readonly fanIdx: number },
): Promise<IngressBindings> {
  const { program, frozen, decisions, slots = {}, basePacks = [], config, fanIdx } = opts;
  const graph = opts.graph ?? program.main;
  frozen.declareProgram(program);
  const node = graph.nodes[fanIdx];
  if (node?.kind !== "fan") throw new ReplayScopeError(node?.kind ?? "?", "?", "fanCaptureSlots: not a fan node");
  const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], program.prelude.source, {}, config);
  const out: Record<string, AmbientValue> = {};
  await replayGraphIn(
    base,
    program,
    graph,
    frozen,
    slots,
    decisions,
    rootInstance(),
    async ({ wireFor, gammaWire }) => {
      for (const name of node.captures) out[name] = await gammaWire(wireFor(fanIdx, `capture:${name}`));
      return theVoid;
    },
  );
  return out;
}

// ── Face 2 — whole-program playback (also loop reconstruction via count + body) ─

export interface PlaybackReplayOptions {
  readonly source: string;
  /** Recorded penetrations per op, stream order — live world not bound. An entry that carries its
   *  `track` is delivered to the demand at that coordinate (D1); a bare payload is plain FIFO. */
  readonly playback: ReadonlyMap<string, readonly PlaybackEntry[]>;
  /** Opt in to coordinate-addressed delivery: the wireframe options the RECORDING host built its
   *  `closureSites` with (the replay rebuilds the same sites over its own parse). Without it every
   *  demand is coordinate-less and entries are consumed in per-op order. */
  readonly wireframe?: WireframeBuildOptions;
  /** The recording run's root coordinate path — track paths are relative to it. Default `[0]`. */
  readonly root?: readonly number[];
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/** A silent run never touches its emission sinks; a touch is a bug, not a no-op. */
function untouchable<T extends object>(what: string): T {
  return new Proxy(
    {},
    {
      get: () => {
        throw new Error(`replay: a silent run must not write to ${what}`);
      },
    },
  ) as T;
}

/**
 * Silent-region whole-program re-run; only playback sources bound. Underflow is
 * a teaching door — never live re-fetch, never silent default.
 *
 * With `wireframe`, the run opens the SAME closure-call windows the recording opened (silently), and
 * each source demand takes the payload recorded at its track — so the result cannot depend on the
 * order in which a fan's tracks happened to run, live or now (P18).
 */
export async function replayProgramWithPlayback(opts: PlaybackReplayOptions): Promise<ReplayedValue> {
  const { source, playback, wireframe, root = [0], basePacks = [], config } = opts;
  const parsed = await parseProgram(source);
  const emission: RunEmission | undefined =
    wireframe === undefined
      ? undefined
      : {
          store: untouchable("the provenance store"),
          payloads: untouchable("the payload store"),
          regionId: "replay-playback",
          coordinate: { templateHash: "replay-playback", ordinalPath: root, regionEpoch: "replay" },
          closureSites: buildWireframe(parsed.forms, wireframe).closureSites,
        };
  const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], "", {}, config, emission);
  const playbackScope = base.scope.child("provenance-playback") as LexicalScopeWithInternals<typeof base.scope>;
  const frozen = new FrozenMints();
  for (const [op, entries] of playback) for (const entry of entries) frozen.push(op, entry, entry.track, entry.site);
  for (const op of playback.keys()) {
    // ARosettaProcedure — `.bind` doors a bare host fn. Fresh source point per
    // fire (same mint as a live source crossing); recorded stamps ride in boxPayload.
    playbackScope.env.bind(
      op,
      new ARosettaProcedure({
        name: op,
        arity: { min: 0, max: null },
        contract: undefined,
        hostApply: (_schemeArgs, callCtx) => {
          const track =
            emission === undefined
              ? undefined
              : ((callCtx.closureCall ?? currentClosureCall(callCtx.runCtx))?.coordinate.ordinalPath ?? root).slice(
                  root.length,
                );
          const next = frozen.next(op, track);
          if (next === undefined) {
            throw new ReplayScopeError(
              "source",
              op,
              `playback queue for "${op}" underflowed — the replay demanded more penetrations than the record run crossed; the stream is incomplete or the program diverged (never answered live)`,
            );
          }
          const { runCtx, invocation } = callCtx;
          const inv = invocation.currentInvocation;
          let resultProvenance = EMPTY_PROVENANCE;
          if (inv && typeof inv.id === "number") {
            if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
            else inv.isProvenancePoint = true;
            resultProvenance = pointProvenance(inv.id);
          }
          if (next.raised === true) throw new ReplayRaise(String(next.value), op);
          return jsToScheme(runCtx, boxPayload(next, runCtx), undefined, resultProvenance);
        },
      }),
    );
  }
  const state = await execState(source, {
    capabilities: base.capabilities,
    config: base.config,
    scope: playbackScope,
    runCtx: base.runCtx,
    program: parsed,
  });
  const boxed = state.values.at(-1);
  if (boxed === undefined) {
    throw new ReplayScopeError("port", "program", "the program evaluated zero forms — nothing to replay");
  }
  return { boxed, value: toJS(boxed) };
}

// ── Face 3 — effect-track replay-between-records ────────────────────────────

/** Port event verbatim, or pure-stretch γ value — order is the law subject. */
export type ReplayStep =
  | { readonly kind: "port-event"; readonly record: MintRecord; readonly payload: Payload }
  | { readonly kind: "pure"; readonly value: unknown };

/** Pure stretch between events: acc = egress(Tᵢ)→ingress(Tᵢ₊₁); event = recorded payload. */
export interface EffectStretch {
  readonly wire: EmittedWire;
  readonly accParam: string;
  readonly eventParam: string;
}

interface ReplayBetweenRecordsOptions {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly stretch: EffectStretch;
  /** The chain's initial accumulator (boxed) — the fold's seed. */
  readonly initial: SchemeValue;
  readonly prelude?: string;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Effect tracks: pure stretches γ'd, mint events interleaved in seq order.
 *   1. fold first — region must complete (`pending === 0`)
 *   2. mints in stream order are the events (never re-sorted)
 *   3. between events, γ stretch(acc, recorded payload) — middle of pure-only
 *      and record-only
 */
export async function replayBetweenRecords(opts: ReplayBetweenRecordsOptions): Promise<{
  readonly steps: readonly ReplayStep[];
  readonly egress: unknown;
  readonly egressBoxed: SchemeValue;
}> {
  const { store, payloads, regionId, stretch, initial, prelude = "", basePacks = [], config } = opts;
  const stream = await store.readStream(regionId);
  const fold = foldRegionStream(stream);
  if (fold.pending !== 0) {
    throw new ReplayScopeError(
      "track",
      regionId,
      `region has ${fold.pending} pending track(s) (started ${fold.started}, completed ${fold.completed}) — replay-between-records only replays COMPLETED regions; close the region (or accept the incomplete door) first`,
    );
  }
  const mints = stream.filter((r): r is MintRecord => r.kind === "mint");

  const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], prelude, {}, config);
  const steps: ReplayStep[] = [];
  let acc: SchemeValue = initial;
  for (const record of mints) {
    const payload = await payloads.get(record.payloadHash);
    const frozen: Payload = { value: payload.value, stampIds: payload.stampIds };
    steps.push({ kind: "port-event", record, payload: frozen });
    acc = await applyWireInEnv(base, stretch.wire, {
      [stretch.accParam]: acc,
      [stretch.eventParam]: boxPayload(frozen, base.runCtx),
    });
    steps.push({ kind: "pure", value: toJS(acc) });
  }
  return { steps, egress: toJS(acc), egressBoxed: acc };
}

/**
 * Per-form evaluation trace — arrival-scheme `EvalTap`.
 *
 * Observable `Map<ASTNode, NodeRecord>` keyed by the parser's Pair identity. Per Pair visited:
 *   - `bindings` — every Invocation entered (not removed on resolve; UI reads Invocation.state)
 *   - `entered` / `exited` — lifetime counts
 * Invocation.parent walks the dynamic call stack back to the program-root form.
 *
 * Untracked: atoms, bare symbols, quoted data, macro-Pairs (no `__location__`) — the evaluator's
 * tap-firing rules already filter them.
 *
 * Provenance taxonomy invariant (mint-only-at-boundaries; pure ops union/forward; branch is an
 * edge-role NOT a node; `(:field …)` FORWARDS the producer's point, dropped key lives in static
 * carrier) → `docs/foundations/arrival-scheme/reference/provenance-model.md`.
 * READ before changing `computeProvenance`, authoritative-set forwarding, or `accessorField`.
 */
import invariant from "tiny-invariant";
import { TraceBudgetError } from "../errors.js";

import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { AString } from "../values/primitives/AString.js";
import { AutoBindings } from "../values/lineage-auto-bindings.js";
import type { EvalTap } from "../eval/evaluator.js";
import { APair } from "../values/primitives/APair.js";
import type { ASymbol } from "../values/primitives/ASymbol.js";
import type { AListAlike, SchemeValue } from "../values/types.js";

// De-MobXed hot machinery — `Invocation`/`NodeRecord` were `makeAutoObservable`. Deep TCO loop
// mints one Invocation per recursion step (tens of thousands); MobX admin (`values_`/admin symbol)
// is ~10× plain-field-bag memory — on top of that, a long/looping run retains O(n²) provenance Sets
// (see {@link EvalTrace.markAuthoritativeProvenance}'s header), and the combination GC-froze the tab.
// Chart reads plain `snapshotTrace` — objects stay plain.
//
// Class now in `@here.build/arrival` (core, mobx-free). The one reactive signal (entries counter
// TraceGraph subscribed via `reaction`) split into two overridable SEAMS:
//   - `_entries` / `bumpEntries()` — plain counter + protected mutator
//   - `entries` getter — reads `_entries`
// `enter`/`exit`/`markProvenancePoint` stay plain mutation (core touches nothing mobx-observable).
// `@here.build/arrival-provenance`'s `ObservableEvalTrace`: keeps mobx, overrides bumpEntries/entries
// to wrap `observable.box`, wraps `enter` in `action(...)`. Restores reactive semantics for
// `TraceGraph`/`arrival-chain` tests while core stays dependency-free.

export type InvocationState = "running" | "resolved" | "rejected";

/** Head symbol name (`filter`, `map`, `:verdict`, …) or null. */
function headNameOf(node: APair<SchemeValue, SchemeValue>): string | null {
  const head = (node as { car: unknown }).car;
  if (head === null || typeof head !== "object" || !("__name__" in head)) return null;
  const name = (head as { __name__: unknown }).__name__;
  return typeof name === "string" ? name : null;
}

/** Bare field name of `(:field x)` → `"verdict"`, else null. Head `":"` (no field) is not one. */
function accessorField(node: APair<SchemeValue, SchemeValue>): string | null {
  const head = (node as { car: unknown }).car;
  if (head === null || typeof head !== "object" || !("__name__" in head)) return null;
  const name = (head as { __name__: unknown }).__name__;
  return typeof name === "string" && name.length > 1 && name.startsWith(":") ? name.slice(1) : null;
}

/**
 * Provenance computation:
 *   - provenance-marked call → `{ self.id }`
 *   - else distinct non-empty child sets (by reference): 0→empty, 1→forward (preserves identity), many→union
 *   - control-flow restriction enforced by rosetta wrappers — not here
 */
function computeProvenance(inv: Invocation, trace: EvalTrace): ReadonlySet<number> {
  if (inv.isProvenancePoint) return trace.markAuthoritativeProvenance(new Set<number>([inv.id]));

  const field = accessorField(inv.node);

  // Forward already-truncated lineage across a FORWARDING boundary (fn-call return, `let`, tail pass-through,
  // empty-predicate control-flow arm). AUTHORITATIVE provenance (minted by point or `(:field …)`) is COMPLETE
  // lineage; re-unioning here is the depth-accumulation that flattened O(1)-per-hop link chain → O(history)
  // set. Field accessors EXCLUDED → reach refine branch below. Genuine combiners
  // (string-append, `if` w/ provenance predicate via `withProvenance`, not authoritative) fall through to union.
  if (field === null && inv.value instanceof AValue && trace.isAuthoritativeProvenance(inv.value.provenance)) {
    return inv.value.provenance;
  }

  const distinct = new Set<ReadonlySet<number>>();
  // Pair-children provenance (sub-expressions) — each child.provenance stamped onto its value at exit-tap.
  for (const child of inv.children) {
    if (child.provenance.size > 0) distinct.add(child.provenance);
  }
  // Symbol resolutions — provenance flows through env bindings.
  if (inv.symbolContributions) {
    for (const s of inv.symbolContributions) {
      if (s.size > 0) distinct.add(s);
    }
  }
  if (distinct.size === 0) return EMPTY_PROVENANCE;

  // Field-projection `(:verdict x)`: crosses structured-output membrane, FORWARDS each upstream point P
  // (origin/intent), lets static carrier `carrierFieldEdges` supply the dropped KEY. Marked AUTHORITATIVE
  // (complete lineage) so forwarding parent never re-unions it. `car`/`cdr` provenance attributes to the
  // right fan-out producer — chained `(:verdict (car reactions))` carries react[0]'s point. `field` ROUTES this
  // branch (excluded from plain forward above).
  if (field !== null) {
    // `(:field x)` keeps P; key lives solely in static carrier — no synthetic (P,field) id is minted.
    const out = new Set<number>();
    for (const s of distinct) for (const p of s) out.add(p);
    return trace.markAuthoritativeProvenance(out);
  }

  if (distinct.size === 1) return distinct.values().next().value!;
  const merged = new Set<number>();
  for (const s of distinct) for (const x of s) merged.add(x);
  return merged;
}

export class Invocation {
  readonly id: number;
  readonly node: APair<SchemeValue, SchemeValue>;
  readonly parent: Invocation | null;
  /** Child invocations spawned within this one's evaluation — populated on each child's `enter`.
   *  Lets exit-tap compute provenance in O(children) without scanning records. */
  readonly children: Invocation[] = [];
  state: InvocationState = "running";
  // `SchemeValue | undefined`, not `unknown`: every assignment is provably one — `unknown` under-described
  // the runtime truth (P3, docs/PRINCIPLES.md) and forced every `schemeToJs(inv.value)` reader to widen past
  // schemeToJs's honest bound.
  value: SchemeValue | undefined = undefined;
  error: unknown = undefined;
  /** Dataflow provenance: ids of provenance-point invocations whose outputs flowed into this call's inputs.
   *  Computed on exit. */
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE;
  /** Set true when rosetta wrapper / sandbox override marks this a provenance point. Read by exit-tap. */
  isProvenancePoint = false;
  /** Trace-side metadata via rosetta `resultWithProvenance(value, meta)` (e.g. `.prompt` node's
   *  `{ kind, path, model, inputs }`). Never crosses back into scheme, never synced; usually undefined. */
  metadata: unknown = undefined;
  /** `(infer …)` cache HIT (true/blue) vs fresh call (false/green). Set once at bind via
   *  `EvalTrace.markInferCached`; drives per-node cached/fresh bar. */
  cached: boolean | undefined = undefined;
  /** True when Pair evaluated in tail position (R7RS §3.5) — from evaluator's tail flag, NOT inferred.
   *  Loop detection (`traceToForest`/`traceToRegions`) is STRUCTURAL (`hasSelfAncestor`) so nothing reads
   *  this yet; kept as ground truth to LABEL proper-TCO vs stack-growing recursion. */
  tailPosition = false;
  /** Provenance contributions from symbol resolutions — populated by `onSymbolResolved`, read by
   *  `computeProvenance` alongside `inv.children`. Lazily allocated (most invocations: none). */
  symbolContributions: Set<ReadonlySet<number>> | null = null;

  constructor(id: number, node: APair<SchemeValue, SchemeValue>, parent: Invocation | null) {
    this.id = id;
    this.node = node;
    this.parent = parent;
    if (parent) parent.children.push(this);
    // Plain object — see de-MobXed note at top of file.
  }

  /** Flip {@link isProvenancePoint}. Plain field mutation (no `action` wrapper — nothing observes it).
   *  Rosetta wrapper duck-types `{ id, isProvenancePoint? }`, calls this to keep write behind a named seam. */
  markProvenancePoint(): void {
    this.isProvenancePoint = true;
  }

  /** Bind {@link metadata}. Plain field mutation, same reasoning as {@link markProvenancePoint}. */
  setMetadata(meta: unknown): void {
    this.metadata = meta;
  }

  /** Walk dynamic call chain back to program-root invocation. */
  ancestors(): Invocation[] {
    const out: Invocation[] = [];
    let cur: Invocation | null = this;
    while (cur) {
      out.push(cur);
      cur = cur.parent;
      invariant(cur !== this, "ancestors should not walk off the root");
    }
    return out;
  }
}

export class NodeRecord {
  readonly bindings = new Set<Invocation>();
  entered = 0;
  exited = 0;
  // Plain object — see de-MobXed note at top of file.
}

/** Default trace-entry cap (see {@link EvalTrace} constructor). Stops runaway loop before OOM/canvas freeze.
 *  Override via `ARRIVAL_TRACE_MAX`; pass `Infinity` for unbounded. */
export const DEFAULT_TRACE_CAP = 500_000;

/** Flat per-retained-point overhead estimate (id/state/parent-pointer/child-array/Set header
 *  weight) used by {@link EvalTrace.stats}'s `retainedValueBytes` — see that method's docstring
 *  for why this is an approximation, not a measurement. */
const STATS_PER_ENTRY_OVERHEAD_BYTES = 128;

export class EvalTrace implements EvalTap {
  readonly records = new Map<APair<SchemeValue, SchemeValue>, NodeRecord>();
  /** Task-creating invocations indexed by produced task. Lets monitor walk from live pipe → AST provenance.
   *  One task → MANY invocations when same prompt fires from different HOF iterations (content-addressed
   *  task cache merges; each iteration has distinct path). First in list is canonical (`invocationFor`). */
  readonly invocationByTask = new Map<object, Invocation[]>();
  /** Per-invocation symbol-resolution log. Symbol eval skips enter/exit — only mechanism to recover
   *  runtime value (e.g. `name` in `(string-append "hi " name)`). */
  readonly symbolValues = new WeakMap<Invocation, Map<string, unknown>>();

  /**
   * AUTO-BINDING leaf-stamp sidecar. ADDITIVE + flag-gated: undefined by default → `exit` never
   * touches it, so the trace stays byte-identical to the flag-off baseline. When attached via
   * {@link withAutoBindings}, each `exit` records symbol resolutions (already in `symbolValues`) —
   * per-consumer-invocation producer ids each read value carries. Auto-binds static carrier leaf
   * slots to the right per-invocation producer (replaces a manual `{ infer: ids }` global map),
   * WITHOUT collapsing distinct invocations of one source name. Rides ALONGSIDE `AValue.provenance`,
   * never replacing it.
   */
  autoBindings: AutoBindings | undefined = undefined;

  /** Attach a fresh (or given) {@link AutoBindings} collector — the spike flag. Off (default)=byte-identical. */
  withAutoBindings(sink: AutoBindings = new AutoBindings()): AutoBindings {
    this.autoBindings = sink;
    return sink;
  }

  #nextId = 0;

  /**
   * Monotonic enter-count — CHEAP structural signal for renderers. Every `enter` ticks it (incl. loop
   * re-entry of seen Pair, which `records.size` doesn't reflect), so observer subscribes to "trace grew"
   * without reading every invocation. Blueprint uses it to throttle O(points²) region rebuild to once per
   * animation frame — frozen tab vs responsive on a long run.
   *
   * Plain counter — see the de-MobXed note at the top of this file for the `bumpEntries`/`entries`
   * SEAM `arrival-provenance`'s `ObservableEvalTrace` overrides.
   */
  protected _entries = 0;
  get entries(): number {
    return this._entries;
  }

  /** SEAM: bump {@link _entries}. Plain increment — override in subclass to make observable. */
  protected bumpEntries(): void {
    this._entries++;
  }

  /**
   * Flat append-ordered log of every invocation in `enter` order (= ascending gap-free id, relative to
   * `#logBaseId` — see {@link clear}). Region fold slices off tail by index cursor — O(Δ) per tick —
   * instead of re-scanning records bindings. Pointer array only: Invocations live in `records`.
   *
   * `clear()` truncates this array (see its docstring) while `#nextId` keeps climbing — a position-based
   * cursor held across a `clear()` call is invalidated; the holder is responsible for resetting it.
   */
  readonly #invocationLog: Invocation[] = [];
  get invocationLog(): readonly Invocation[] {
    return this.#invocationLog;
  }

  /**
   * AUTHORITATIVE provenance sets — emitted by a point (`{self.id}`) or forwarded by `(:field …)` projection
   * (producer's own points; dropped key lives in static carrier). An authoritative set is COMPLETE lineage:
   * upstream reached by FOLLOWING the link (point → producer), never by transitive closure. `computeProvenance`
   * forwards it across a forwarding boundary (fn-call return, `let`, tail pass-through) instead of re-unioning —
   * that re-union is the depth-accumulation that turns a navigable O(1)-per-hop chain into an O(history) flat
   * set (a loop's tagline would otherwise carry every prior round's points). Keyed by Set IDENTITY
   * (WeakSet) — rides the reference `withProvenance`/size-1 forward share, GC'd with it.
   */
  readonly #authoritativeProvenance = new WeakSet<ReadonlySet<number>>();

  /** Tag freshly-minted provenance set authoritative (point / field-projection); returns it for `return`. */
  markAuthoritativeProvenance<T extends ReadonlySet<number>>(set: T): T {
    if (set.size > 0) this.#authoritativeProvenance.add(set);
    return set;
  }

  /** Whether `set` is authoritative — see {@link markAuthoritativeProvenance}. */
  isAuthoritativeProvenance(set: ReadonlySet<number>): boolean {
    return this.#authoritativeProvenance.has(set);
  }

  /** Associate task with creating invocation. Idempotent; multiple distinct invocations for one task accumulate. */
  bindTask(task: object, invocation: Invocation): void {
    let list = this.invocationByTask.get(task);
    if (!list) {
      list = [];
      this.invocationByTask.set(task, list);
    }
    if (!list.includes(invocation)) list.push(invocation);
  }

  /** `(infer …)` cache HIT (true) vs fresh call (false). Set at bind time, before await. Drives cached/fresh bar. */
  markInferCached = (invocation: Invocation, cached: boolean): void => {
    invocation.cached = cached;
  };

  /** First (canonical) invocation for task; undefined if unbound. */
  invocationFor(task: object): Invocation | undefined {
    return this.invocationByTask.get(task)?.[0];
  }

  /** Every invocation for this task — one per site/iteration. */
  invocationsFor(task: object): readonly Invocation[] {
    return this.invocationByTask.get(task) ?? [];
  }

  /** The invocation that minted provenance id `provenanceId` — the ordinal→invocation read for
   *  the ids `deepProvenance` yields (each id IS an invocation id of THIS trace; `#invocationLog`
   *  is enter-ordered and gap-free, so the id doubles as the index). `undefined` for an id this
   *  trace never minted. */
  invocationById(provenanceId: number): Invocation | undefined {
    const idx = provenanceId - this.#logBaseId;
    return idx >= 0 ? this.#invocationLog[idx] : undefined;
  }

  /**
   * Enumerate provenance-point invocations — the read surface a consumer walks BEFORE calling
   * {@link clear} to pull whatever it wants (tool name, the retained value, …) out of the graph
   * that's about to be dropped. Lazy generator over `#invocationLog` (append/enter order) so a
   * caller building its own summary can bail early without materializing every point up front.
   */
  *points(): IterableIterator<{ id: number; toolName: string | undefined; invocation: Invocation }> {
    for (const inv of this.#invocationLog) {
      if (inv.isProvenancePoint) yield { id: inv.id, toolName: this.toolNameFor(inv.id), invocation: inv };
    }
  }

  /** The verb name that minted provenance id `provenanceId` — answers "which tool produced this
   *  value?" for a `deepProvenance` ordinal (`[...deepProvenance(v)].map((id) => trace.toolNameFor(id))`).
   *  Returns the minting invocation's head symbol (`forecast-for`, `scan-output`, …); `undefined`
   *  for an id this trace never minted, or a headless form. Ids are trace-scoped: resolve them
   *  against the SAME `EvalTrace` that was the run's `tap`. */
  toolNameFor(provenanceId: number): string | undefined {
    const inv = this.invocationById(provenanceId);
    return inv === undefined ? undefined : (headNameOf(inv.node) ?? undefined);
  }

  /** Look up symbol's resolved value inside given invocation's scope. */
  symbolValueIn(inv: Invocation, name: string): unknown {
    return this.symbolValues.get(inv)?.get(name);
  }

  // `enter`/`exit`/`markProvenancePoint` mutate plain fields — see the de-MobXed note at the top of
  // this file for how `arrival-provenance`'s `ObservableEvalTrace` wraps `enter` in `action(...)`.

  /** Id of `#invocationLog[0]` — `startId` at construction; bumped forward to `#nextId` by
   *  {@link clear}, so `invocationById`'s `id - #logBaseId` index math keeps working after a
   *  clear resets the log's contents but not the id counter. */
  #logBaseId: number;

  /** Invocations minted since construction or the last {@link clear} — what `enter`'s cap check
   *  compares against `maxEntries`, DELIBERATELY separate from `#nextId` (which never resets).
   *  Coupling the cap to the raw id would make `clear()` pointless for a long-lived, periodically
   *  compacted trace (id keeps climbing past `maxEntries` even though the retained graph is empty)
   *  and would make a nonzero `startId` trip the cap on invocation one. */
  #mintedSinceReset = 0;

  /** Invocations entered but not yet exited, anywhere in the call tree — the "is a run mid-flight"
   *  signal {@link clear} guards on. Incremented in `enter`, decremented at the top of `exit`
   *  (every entered invocation exits exactly once — success or rejection — per the `EvalTap`
   *  contract this class implements). */
  #openCount = 0;

  /** Cap on invocations retained since construction/last-{@link clear} (one per invocation — `enter`
   *  mints only `#nextId`, `#mintedSinceReset` counts against the cap). Invocation retained PER
   *  reduction (value/children) — monotonic, never GC'd until `clear()` — so long/runaway loop
   *  grows trace unboundedly. `enter` throws at cap: run aborts with partial trace, instead of
   *  OOMing isolate or freezing canvas. DEFAULTS to a bound (the safe default IS the default —
   *  `new EvalTrace()` protected even if caller forgets). Pass `Infinity` for unbounded
   *  full-fidelity capture.
   *
   *  `startId` floors the id counter — the process-restart seam: a fresh `EvalTrace` built after
   *  a worker restart can be told "the previous instance last minted id N", so ids stay globally
   *  monotonic across the restart instead of colliding back at 0. Ids below `startId` were never
   *  minted by THIS instance and always resolve as unminted (`invocationById` returns `undefined`). */
  constructor(
    readonly maxEntries: number = DEFAULT_TRACE_CAP,
    startId = 0,
  ) {
    invariant(Number.isInteger(startId) && startId >= 0, "EvalTrace startId must be a non-negative integer");
    this.#nextId = startId;
    this.#logBaseId = startId;
  }

  enter = (node: AListAlike, parent: unknown, tailPosition?: boolean): Invocation => {
    if (this.#mintedSinceReset >= this.maxEntries) {
      // "budget exceeded" in message so run-isolated's detector returns partial handle.
      throw new TraceBudgetError(this.maxEntries);
    }
    // `AListAlike` admits `ANil`, but evaluator's tap-firing rules only call `enter` on a located Pair (see file
    // header: atoms/bare symbols/quoted/macro-Pairs not tracked). Assert real invariant, don't widen `node`'s type.
    invariant(node instanceof APair, "EvalTap.enter node must be a Pair");
    const inv = new Invocation(this.#nextId++, node, parent as Invocation | null);
    this.#mintedSinceReset++;
    this.#openCount++;
    if (tailPosition) inv.tailPosition = true;
    let rec = this.records.get(node);
    if (!rec) {
      rec = new NodeRecord();
      this.records.set(node, rec);
    }
    rec.bindings.add(inv);
    this.#invocationLog.push(inv);
    rec.entered += 1;
    this.bumpEntries();
    return inv;
  };

  exit = (inv: Invocation, result: Parameters<EvalTap["exit"]>[1]): ReturnType<EvalTap["exit"]> => {
    this.#openCount--;
    if (!("value" in result)) {
      inv.state = "rejected";
      inv.error = result.error;
      inv.provenance = computeProvenance(inv, this);
      this.#pruneChildProvenance(inv);
      const rec = this.records.get(inv.node);
      if (rec) rec.exited += 1;
      return;
    }

    inv.state = "resolved";
    inv.value = result.value;
    inv.provenance = computeProvenance(inv, this);
    this.#pruneChildProvenance(inv);

    // Flag-gated: capture symbol resolutions into auto-binding sidecar. No-op unless sink attached
    // (default undefined) → flag-OFF path byte-identical. Reads `symbolValues` already built; records producer ids
    // per invocation (no name-collapse). Runs after prune (never touches `symbolValues`).
    if (this.autoBindings) this.autoBindings.recordInvocation(inv.id, this.symbolValues.get(inv));

    // Stamp provenance onto AValue so it rides through env bindings, intact at next symbol resolution. Pre-AValue:
    // WeakMap snapped at primitives, lost provenance for bare scalars from `(infer …)`. Now AValue carries own field.
    //
    // Substitution-return LOAD-BEARING: `withProvenance` clones (provenance is identity). Without returning it,
    // evaluator continues with original un-stamped value → binds THAT to `define`/let/arg slot. See arrival-scheme
    // `Call.onResolve` for trampoline-side contract.
    if (inv.provenance.size > 0 && inv.value instanceof AValue) {
      const stamped = inv.value.withProvenance(inv.provenance);
      inv.value = stamped;
      const rec = this.records.get(inv.node);
      if (rec) rec.exited += 1;
      return { value: stamped };
    }

    const rec = this.records.get(inv.node);
    if (rec) rec.exited += 1;
  };

  /**
   * Free a child's provenance Set once its parent has folded it in.
   *
   * Provenance flows ONE level at exit: `computeProvenance(parent)` unions direct children's sets (plus symbol
   * contributions). Value-carried copy (`withProvenance`) handles symbol-resolution path independently, so once
   * parent's set computed, intermediate child's own Set never read again. Without this, every Invocation on a 46k-deep
   * TCO loop retains O(depth) Set forever — O(n²) blowup that GC-froze tab.
   *
   * Keep-condition mirrors `snapshotTrace`'s materialization predicate EXACTLY
   * (`inv.parent?.isProvenancePoint || isRoot || isPoint`): point's own set is `{self.id}` (tiny + read); point's
   * direct children are what snapshot reads. Else: never-read scaffolding — safe to drop.
   */
  #pruneChildProvenance(inv: Invocation): void {
    // Point's children ARE snapshot-materialized — keep.
    if (inv.isProvenancePoint) return;
    // FILTER's direct children read by region build's filter-predicate decision (pred booleans + eval'd-once
    // collection arg naming inference origins). Retention tiny; without it selection unreconstructable (the one
    // divergence from snapshot keep-predicate, deliberate, bounded to `filter` heads).
    if (headNameOf(inv.node) === "filter") return;
    for (const child of inv.children) {
      if (child.isProvenancePoint) continue;
      if (child.provenance.size > 0) child.provenance = EMPTY_PROVENANCE;
      // GC retained scheme VALUE too (not just Set). This child is pure scaffolding (neither point nor point's
      // child) so its value never read again — `Invocation.value` would pin it (+ whole object graph) for trace's
      // lifetime. On long/looping run, that retained graph IS the leak. Parent already folded child at exit; if
      // parent RETURNS child's value it holds its own reference — clearing here frees only unneeded values.
      child.value = undefined;
    }
  }

  /**
   * Explicit provenance GC — drops the ENTIRE invocation graph (`records`, `invocationByTask`,
   * `#invocationLog`, and every retained `Invocation`'s children/value/provenance Set reachable
   * only through them) while PRESERVING `#nextId`: ids minted so far, including a provenance
   * point's, are NEVER reused — a scheme value still alive elsewhere (bound in a `define`, held
   * by caller code) may carry a provenance id that must keep meaning "nothing new has claimed
   * this number" even though its originating `Invocation` is gone.
   *
   * This is the fix for the OOM driver: a provenance-point Invocation is the one case
   * {@link #pruneChildProvenance} deliberately EXEMPTS from per-exit value cleanup (points must
   * stay walkable for `invocationById`/`toolNameFor`/{@link points}), so a long task with
   * multi-MB tool responses pins the full boxed result of every point for the trace's lifetime.
   * `clear()` is the explicit release valve: call {@link points} first to extract whatever a
   * consumer needs (tool name, a capped value prefix, …) into its OWN storage, then `clear()`.
   *
   * GUARD: only legal BETWEEN evals. Throws (does not silently no-op) if any invocation entered
   * so far hasn't exited yet (`#openCount > 0`) — clearing mid-eval would null out a value a
   * still-running ancestor invocation's `computeProvenance`/`exit` is about to read, corrupting
   * the in-flight run instead of just losing history. A throw surfaces caller misuse immediately;
   * a silent no-op would hide it as "GC happened" when it didn't.
   *
   * `symbolValues` (WeakMap<Invocation, …>) and `#authoritativeProvenance` (WeakSet<Set>) are not
   * touched directly — neither type exposes `.clear()`, and neither holds a STRONG reference of
   * its own, so once the graph above drops the last strong reference to an `Invocation`/`Set`, GC
   * reclaims the weak-collection entry too.
   *
   * CAVEAT for other analysis consumers: a position-based cursor into `invocationLog` held across
   * a `clear()` call (e.g. `TraceRegionFold`'s `#logCursor`) is invalidated — `clear()` truncates
   * the array out from under it. This class has no such cursor; a consumer that keeps one is
   * responsible for resetting it (or simply not calling `clear()` while one is live).
   */
  clear(): void {
    invariant(
      this.#openCount === 0,
      "EvalTrace.clear() called while an invocation is still running — only legal between evals " +
        "(call it after a run's exec/execState promise resolves, not from inside a tap callback).",
    );
    this.records.clear();
    this.invocationByTask.clear();
    this.#invocationLog.length = 0;
    this.#logBaseId = this.#nextId;
    this.#mintedSinceReset = 0;
  }

  /**
   * Arm the cap for ONE run: zero the against-cap counter and the open-invocation count, WITHOUT
   * touching the retained graph. Call at the top of every run, before the first `enter`.
   *
   * ─── WHY THIS EXISTS (a session-killing bug, found in benchmark trajectories 2026-07-14) ─────
   *
   * `maxEntries` is documented as a RUNAWAY-LOOP guard — "run produced too many steps" — but it was
   * enforced against `#mintedSinceReset`, which only resets in {@link clear}. In a long-lived
   * session (the MCP runner shares ONE tap across every REPL call, deliberately, so provenance
   * resolves across calls) the counter is therefore a SESSION-LIFETIME budget wearing a per-run
   * guard's error message.
   *
   * That alone would merely be misleading. What made it fatal:
   *
   *   1. A program legitimately exceeds the cap. `enter` THROWS mid-eval.
   *   2. The eval unwinds — so the invocations already entered NEVER `exit`. `#openCount` stays > 0.
   *   3. The runner's per-call GC calls `clear()` — which asserts `#openCount === 0`, and throws.
   *      That throw is swallowed (it was written for a different case: an abandoned TIMEOUT eval,
   *      still running, whose "the next call's clear() takes it" promise is true only because that
   *      eval eventually exits. On the budget path nothing ever exits — the frames are gone).
   *   4. `#mintedSinceReset` is now pinned at the cap forever. EVERY subsequent `enter` throws.
   *
   * The session was dead: `(+ 1 2)` threw "trace step budget exceeded", and with it every MCP tool
   * call, for the rest of the conversation. One model burned 24 of its 36 rounds probing for a
   * recovery door that did not exist, and scored 0.00 on a task it had the data for.
   *
   * A guard against a runaway loop must not be able to outlive the loop. Zeroing the counter per RUN
   * makes the cap mean what its error message has always claimed it means, and makes step 4
   * unreachable: a budget error can end a program, never a session.
   *
   * `#openCount` is zeroed too, and that is the point rather than a side effect: after an unwind the
   * count is GARBAGE — it counts frames that no longer exist and can never exit. Carrying it forward
   * is what jammed `clear()`. A straggler `exit` from an abandoned timeout eval may drive it
   * negative afterwards; that is harmless (nothing reads it but `clear`'s guard, and a spurious
   * "already zero" only ever permits a GC that was going to be correct anyway), and infinitely
   * preferable to a count that can never reach zero.
   *
   * The retained graph is deliberately NOT touched: that is what `clear()` is for, and provenance
   * must survive across calls (a value minted in call 1, read back in call 3).
   */
  beginRun(): void {
    this.#mintedSinceReset = 0;
    this.#openCount = 0;
  }

  /**
   * Honest memory estimate over the CURRENTLY RETAINED graph — no `sizeof` exists in JS, so this
   * is a documented approximation, not a measurement: `entries`/`points` count live invocations
   * (from `#invocationLog`, so both read 0 right after {@link clear}); `retainedValueBytes` sums,
   * over provenance-POINT invocations only (the ones {@link #pruneChildProvenance} exempts from
   * value cleanup — everything else's `.value` is already `undefined`), a flat per-entry overhead
   * constant plus 2 bytes per UTF-16 code unit for a string-valued (`AString` or plain JS string)
   * point. A non-string point's boxed value contributes only the flat overhead — its real
   * footprint is real but not estimated here (no generic byte-size walk over an arbitrary AValue
   * graph; string dominance is the actual OOM driver this exists to surface).
   */
  stats(): { entries: number; points: number; retainedValueBytes: number } {
    let points = 0;
    let retainedValueBytes = 0;
    for (const inv of this.#invocationLog) {
      if (!inv.isProvenancePoint) continue;
      points++;
      retainedValueBytes += STATS_PER_ENTRY_OVERHEAD_BYTES;
      const text =
        inv.value instanceof AString ? inv.value.valueOf() : typeof inv.value === "string" ? inv.value : undefined;
      if (text !== undefined) retainedValueBytes += text.length * 2;
    }
    return { entries: this.#invocationLog.length, points, retainedValueBytes };
  }

  /** Flag invocation as provenance point. Called by rosetta wrappers (`provenance: true`) + sandbox overrides.
   *  Set before `exit` → exit-tap emits `{ self.id }` instead of union. */
  markProvenancePoint = (invocation: Invocation): void => {
    invocation.isProvenancePoint = true;
  };

  /**
   * Set true after first onSymbolResolved throw — evaluator swallows tap exceptions (user code doesn't see;
   * that silence hides tap bugs). Warn once per session.
   */
  #symbolTapWarned = false;

  onSymbolResolved = (invocation: Invocation | null, symbol: ASymbol, value: unknown): void => {
    try {
      if (!invocation) return;
      let map = this.symbolValues.get(invocation);
      if (!map) {
        map = new Map<string, unknown>();
        this.symbolValues.set(invocation, map);
      }
      const name = (symbol as { __name__?: unknown }).__name__;
      if (typeof name === "string") map.set(name, value);

      // Provenance contribution: read off value — producing exit-tap stamped it via `withProvenance`, so every
      // AValue carries origin. Symbols don't carry provenance; producing invocation's provenance flows through
      // at resolve time.
      if (value instanceof AValue && value.provenance.size > 0) {
        if (!invocation.symbolContributions) invocation.symbolContributions = new Set();
        invocation.symbolContributions.add(value.provenance);
      }
    } catch (error) {
      if (!this.#symbolTapWarned) {
        this.#symbolTapWarned = true;

        console.warn("EvalTrace.onSymbolResolved threw; tap data may be incomplete:", error);
      }
    }
  };
}

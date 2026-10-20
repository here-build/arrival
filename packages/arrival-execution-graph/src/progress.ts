/**
 * L3 — project a live arrival `EvalTrace` onto the static `Plan`: an instance tree that says
 * what is done and what is in progress, keyed by plan keys so L4 can copy the plan's templates
 * per instance.
 *
 * The tree mirrors the plan, not the call stack:
 *
 *   FrameInstance ── bodies[] ── Body ── byKey: plan child key → Instance[] (ordinal = index)
 *
 * One `Body` per run of a frame's interior: a par TRACK, a loop ITERATION, the single body of
 * a seq / call / arm / root. A tail-recursive chain, nested once per iteration in the trace,
 * is flattened into sibling iterations; non-tail recursion stays nested (recursive `call`
 * instances, each with `depth`).
 *
 * Placement reads only what the trace states. A frame's invocation (fan form, branch form,
 * named-let / `do` form, call site) opens the instance; its children whose span is one of the
 * template's `bodyRoots` start the interior, every other child is an operand and stays in the
 * enclosing body. A child of a loop's recur call whose span is a body root starts the next
 * iteration. Each `do`/`while` test occurrence (`iterationMarker`) starts an iteration. Par
 * tracks open per occurrence of the first body root (arrival enters each track's first form in
 * element order); later roots of a multi-form callback join their track by the identity of
 * the element-param value they read. A key is `callPath + span`; the call path comes from the
 * body (the inlined call frame the invocation runs in).
 *
 * Incremental: a cursor over `trace.invocationLog` (ids monotonic). States and values are not
 * copied — they are read live from the `Invocation` objects, so `update()` only attaches the
 * invocations entered since the last call (plus the few par roots still waiting for their
 * element value, and branches still undecided).
 *
 * States: `stateOf` is the one authority on the state of anything that ran. It folds in what
 * the raw invocation state gets wrong —
 *   - a step is entered before its operands evaluate: `pending` until its operands settled;
 *   - the trampoline keeps every collapsed tail frame `running` until the whole loop returns:
 *     in a tail loop, the chain that led to the next iteration's recur call reads `resolved`;
 *   - the trace cannot tell that a run ended: after `settle("rejected" | "cancelled")` a
 *     still-running invocation reads `cancelled`;
 *   - aborting the run's signal REJECTS every parked call with the abort reason: under a
 *     `cancelled` outcome such a rejection (an `AbortError`, or the `signal` option's reason)
 *     reads `cancelled`; genuine errors stay `rejected`.
 * A frame with its own invocation takes that invocation's state (`guard`/`try` leave rejected
 * steps inside a resolved frame). An arm the branch did not take is `skipped` (its test ran
 * inside it). A par TRACK is its template run: done once every template item it holds settled,
 * while its siblings still run. Iterations, other arms and the root fold their items.
 *
 * Contract: one fresh trace per run. Closures capture the tap at DEFINITION time, so a
 * function defined by an earlier run on the same scope reports its body into that run's trace
 * — those steps are absent here, not even `unplanned`. For a long-lived trace pass `since`
 * (the first invocation id of this run).
 *
 * LIMIT — designation is by NAME here, by lexical resolution in the plan. An internal define
 * named like a designated symbol (`(define (f) (define (ask x) …) (ask "y"))`) is no step
 * in the plan but reads `ask` to the capture, so it shows up as an `unplanned` step. Value
 * identity (the vocabulary entry / the top-level binding) is the real fix, in L1 and L2.
 */
import { type EvalTrace, type Invocation, scopeId } from "@here.build/arrival/provenance";

import { type Captured, type CapturedOperand, designatedName, ExecutionCapture, readArguments } from "./capture.js";
import { isPair, operandForms, symbolName } from "./datum.js";
import {
  type FrameKind,
  parentFrame,
  type Plan,
  type PlanFrame,
  type PlanItem,
  type PlanKey,
  type PlanStep,
} from "./plan.js";

/** How the run ended, as reported by the caller (the trace cannot tell). */
export type RunOutcome = "running" | "resolved" | "rejected" | "cancelled";

/**
 * Live state of an instance or body.
 * - `pending` — entered but not yet called (a step evaluating its operands), or a body /
 *   virtual frame that has not started.
 * - `cancelled` — still running in the trace after the run settled abnormally, or rejected by
 *   the abort of a `cancelled` run.
 * - `skipped` — an arm whose test ran but whose branch took another arm.
 * Never-entered plan items have no instance: L4 renders them `pending` while their body is
 * active and `skipped` once it settled (`isSettled(body)`).
 */
export type LiveState = "pending" | "running" | "resolved" | "rejected" | "cancelled" | "skipped";

export type Instance = StepInstance | FrameInstance;

export interface StepInstance {
  readonly kind: "step";
  /** Plan key; `undefined` for an unplanned step. */
  readonly key: PlanKey | undefined;
  readonly plan: PlanStep | undefined;
  readonly span: string;
  /** Plan symbol, or the resolved callee name for an unplanned step. */
  readonly symbol: string;
  /** The call's invocation. For `(apply f …)` steps it is the `apply` invocation (the plan
   *  keys those by the host span) — all-or-nothing, no per-operand values. */
  readonly invocation: Invocation;
  /** A designated invocation whose span the plan lacks, attached to the nearest instance. */
  readonly unplanned: boolean;
  /** Body holding this instance. Moves once, from a par's `unattributed` body to its track,
   *  when the element value is read after the root was attached. */
  parent: Body;
  /** Index in `parent.byKey.get(key)`; for unplanned steps, index in `parent.unplanned`. */
  ordinal: number;
}

export interface FrameInstance {
  readonly kind: "frame";
  readonly key: PlanKey;
  /** The plan frame this instantiates (for a non-tail recursion: the collapsed stub). */
  readonly plan: PlanFrame;
  /** Whose children the bodies are keyed by. `plan`, except for a recursive stub: the call
   *  frame of the same function further up (so recursion nests the same template). */
  readonly template: PlanFrame;
  readonly span: string;
  readonly frame: FrameKind | "root";
  /** The frame's own invocation; `undefined` for the root, arms, and frames reached through
   *  the plan without an invocation of their own ("virtual"). */
  readonly invocation: Invocation | undefined;
  /** Non-tail recursion depth: 0 for an ordinary instance, d for the d-th nested call. */
  readonly depth: number;
  parent: Body | null;
  ordinal: number;
  /**
   * The interior runs, in start order:
   * - `par` / `callback`: one per TRACK (callback application), ordinal = enter order of the
   *   first body form = element order for map-family hosts;
   * - `loop`: one per ITERATION (named let / tail recursion flattened; `do`/`while`: one per
   *   test evaluation, so the last iteration holds only the exit test; host loops: one per
   *   callback application);
   * - everything else: exactly one (or none yet).
   */
  readonly bodies: Body[];
  /** par / callback: later body roots that never read the element param (or not yet). */
  unattributed: Body | undefined;
  /** branch: index into `template.children` of the arm that ran (the latest one for
   *  guard-like shapes where body and handler both run); `"undecided"` while running, when the
   *  branch rejected before an arm ran, or when several atom arms could have run. */
  takenArm: number | "undecided" | undefined;
}

export interface Body {
  readonly owner: FrameInstance;
  /** Track / iteration index; `-1` for a par's `unattributed` body. A fan's tracks are in
   *  ELEMENT order, which may reorder them as their elements become known. */
  ordinal: number;
  /** Call-path prefix of the keys in this body (`""` at top level, `"site▸"` inside an inlined
   *  call). */
  readonly callPath: string;
  /** Plan child key → instances in this body, in enter order (ordinal = index). */
  readonly byKey: Map<PlanKey, Instance[]>;
  /** Every instance in this body, enter order (planned and unplanned). */
  readonly items: Instance[];
  readonly unplanned: StepInstance[];
  /** The invocation whose entry started this body: loop iteration 0 → the loop invocation;
   *  later iterations → the recur call (named let / recursion), the test (`do`), the first
   *  callback form (host loop); par track → its first callback form. */
  readonly start: Invocation | undefined;
  /** Loop iteration: the recur call that started the next iteration. */
  next: Invocation | undefined;
  /** Loop iteration ≥ 1 started by a recur call: whether that call is the loop's tail (plan
   *  `tail`, else the call's own `tailPosition`). Tail ⇒ iteration k is done once k+1 started
   *  and its own steps settled; non-tail ⇒ k completes AFTER k+1. */
  readonly tail: boolean | undefined;
}

export interface ProgressCounters {
  /** Invocations attached (or classified as pass-through) so far. */
  invocations: number;
  /** Invocations at a planned span that could not be placed — conservation audit, 0 on the
   *  supported corpus. */
  unplacedInvocations: number;
  /** Designated invocations the plan does not know (attached as `unplanned` steps). */
  unplanned: number;
  /** Par roots that settled without ever reading the element param. */
  unattributed: number;
  /** Par roots still waiting for their element value. */
  pendingAttribution: number;
}

export interface StepValues {
  /** Operand values in source order (operand list after the head). */
  readonly inputs: readonly CapturedOperand[];
  readonly hasOutput: boolean;
  readonly output?: unknown;
  readonly error?: unknown;
}

/** What L4 reads. `ProgressProjector` implements it; `update()` returns the same object,
 *  mutated in place. */
export interface Progress {
  readonly plan: Plan;
  readonly trace: EvalTrace;
  readonly root: FrameInstance;
  readonly outcome: RunOutcome;
  readonly counters: Readonly<ProgressCounters>;
  /** Why something was not placed — deduplicated. */
  readonly notes: readonly string[];
  /** The instance an invocation was attached as, if any. */
  instanceOf(inv: Invocation): Instance | undefined;
  stateOf(x: Instance | Body): LiveState;
  /** A step's call phase: `pending` while its operands evaluate, `running` once called
   *  (program-defined callee: once a body form was entered). */
  phaseOf(step: StepInstance): "pending" | "running" | "settled";
  /** Whether nothing more will run in this body (owner settled, or a later loop iteration
   *  started). Never-entered plan items of a settled body did not run → `skipped`. */
  isSettled(x: Body | FrameInstance): boolean;
  /** Operand / output / error values. Exact with an `ExecutionCapture`; with a plain trace only
   *  what the trace kept (provenance points, symbol operands, live children). */
  valuesOf(step: StepInstance): StepValues;
}

export interface ProgressOptions {
  /** Ignore invocations with a smaller id (a long-lived trace holding earlier runs). */
  since?: number;
  /** Designated symbols for unplanned detection; default: the capture's symbols plus every
   *  symbol the plan names. */
  symbols?: Iterable<string>;
  outcome?: RunOutcome;
  /** The run's abort signal, when it has one: a rejection whose error is its `reason` reads as
   *  the abort it is (custom reasons are recognized only through this). */
  signal?: AbortSignal;
}

interface Slot {
  body: Body;
  /** Movable slots (deferred par roots) record what they attached directly to `body`. */
  readonly placed: Instance[] | undefined;
}

interface Place {
  readonly slot: Slot;
  frame?: FrameInstance;
  recurOf?: FrameInstance;
  /** The iteration this recur call started. */
  iter?: Body;
}

interface PendingRoot {
  readonly frame: FrameInstance;
  readonly inv: Invocation;
  readonly span: string;
  readonly slot: Slot;
}

const last = <T>(xs: readonly T[]): T | undefined => xs.at(-1);

export class ProgressProjector implements Progress {
  readonly plan: Plan;
  readonly trace: EvalTrace;
  outcome: RunOutcome;
  root!: FrameInstance;
  counters!: ProgressCounters;
  readonly #notes = new Set<string>();

  readonly #since: number;
  readonly #signal: AbortSignal | undefined;
  readonly #designated: ReadonlySet<string>;
  readonly #recurSpans = new Set<string>();

  #cursor = 0;
  #seq = 0;
  #rootPlace!: Place;
  #places = new WeakMap<Invocation, Place>();
  #instances = new WeakMap<Invocation, Instance>();
  readonly #order = new WeakMap<Instance, number>();
  #pending: PendingRoot[] = [];
  readonly #openBranches = new Set<FrameInstance>();
  /** Running invocations of a collapsed tail chain whose next iteration started. */
  #collapsed = new WeakSet<Invocation>();
  /** par: occurrences of each body-root span per track, and in the whole frame. */
  readonly #rootCounts = new WeakMap<Body, Map<string, number>>();
  readonly #seen = new WeakMap<FrameInstance, Map<string, number>>();
  readonly #byElement = new WeakMap<FrameInstance, Map<unknown, Body[]>>();
  readonly #unindexed = new WeakMap<FrameInstance, Body[]>();
  /** A fan's tracks in the order they entered (`bodies` is in element order). */
  readonly #entered = new WeakMap<FrameInstance, Body[]>();
  /** Fans whose tracks may still move to their element's place. */
  readonly #unordered = new Set<FrameInstance>();
  /** The fixed slot of each body (movable slots exist only for deferred par roots). */
  readonly #slots = new WeakMap<Body, Slot>();

  constructor(plan: Plan, trace: EvalTrace, options: ProgressOptions = {}) {
    this.plan = plan;
    this.trace = trace;
    this.outcome = options.outcome ?? "running";
    this.#since = options.since ?? 0;
    this.#signal = options.signal;
    const symbols = new Set(options.symbols ?? (trace instanceof ExecutionCapture ? trace.symbols : []));
    const index = (frame: PlanFrame) => {
      for (const r of frame.recurSpans ?? []) this.#recurSpans.add(r);
      for (const c of frame.children) {
        if (c.symbol !== undefined) symbols.add(c.symbol);
        if (c.kind === "frame") index(c);
      }
    };
    index(plan.root);
    this.#designated = symbols;
    this.#reset();
  }

  get notes(): readonly string[] {
    return [...this.#notes];
  }

  /** Mark how the run ended; then `update()` once more (zombie tracks keep mutating it). */
  settle(outcome: RunOutcome): this {
    this.outcome = outcome;
    return this;
  }

  /** Attach the invocations entered since the last call. O(Δ) plus waiting par roots and
   *  undecided branches. */
  update(outcome?: RunOutcome): this {
    if (outcome) this.outcome = outcome;
    const log = this.trace.invocationLog;
    // `clear()` truncated the log: the instance tree refers to a dropped graph.
    if (log.length < this.#cursor) this.#reset();
    for (; this.#cursor < log.length; this.#cursor++) {
      const inv = log[this.#cursor]!;
      if (inv.id >= this.#since) this.#attach(inv);
    }
    this.#retryPending();
    this.#decideBranches();
    this.#orderFans();
    return this;
  }

  instanceOf(inv: Invocation): Instance | undefined {
    return this.#instances.get(inv);
  }

  // ── states ────────────────────────────────────────────────────────────────────────────

  stateOf(x: Instance | Body): LiveState {
    if (!("kind" in x)) return this.#bodyState(x);
    if (x.kind === "step") {
      const s = this.#effective(x.invocation);
      return s === "running" && this.phaseOf(x) === "pending" ? "pending" : s;
    }
    if (x.invocation) return this.#effective(x.invocation);
    const branch = x.frame === "arm" ? x.parent?.owner : undefined;
    if (typeof branch?.takenArm === "number" && branch.template.children[branch.takenArm] !== x.plan) return "skipped";
    // Settled without a decidable arm (`(cond (s => ask))`: an atom test, a receiver with no
    // invocation of its own): no arm is known untaken — each reads the branch's own state.
    if (branch?.takenArm === "undecided" && this.isSettled(branch)) return this.stateOf(branch);
    if (x.bodies.length === 0) return this.isSettled(x) ? "resolved" : "pending";
    return foldStates(
      x.bodies.map((b) => this.#bodyState(b)),
      this.isSettled(x),
    );
  }

  phaseOf(step: StepInstance): "pending" | "running" | "settled" {
    const inv = step.invocation;
    if (inv.state !== "running") return "settled";
    const forms = operandForms(inv.node);
    const operands = new Set(forms);
    if (inv.children.some((c) => !operands.has(c.node))) return "running";
    for (const f of forms) {
      if (!isPair(f)) continue;
      const c = inv.children.find((ch) => ch.node === f);
      if (!c || c.state === "running") return "pending";
    }
    return "running";
  }

  isSettled(x: Body | FrameInstance): boolean {
    if (!("kind" in x)) {
      const owner = x.owner;
      // A later iteration started: a tail iteration is over. A non-tail one completes AFTER
      // the next (its recur call returns into it), so it settles with its owner.
      const next = owner.frame === "loop" && x.ordinal >= 0 ? owner.bodies[x.ordinal + 1] : undefined;
      if (next && next.tail !== false) return true;
      return this.isSettled(owner);
    }
    if (x.invocation) return this.#effective(x.invocation) !== "running";
    if (x.parent) return this.isSettled(x.parent);
    return this.outcome !== "running";
  }

  valuesOf(step: StepInstance): StepValues {
    const inv = step.invocation;
    if (this.trace instanceof ExecutionCapture) {
      const captured: Captured | undefined = this.trace.captured(inv);
      if (captured) return captured;
      if (inv.state === "running") return { inputs: this.trace.liveInputs(inv), hasOutput: false };
    }
    const settled = inv.state !== "running";
    const inputs = readArguments(this.trace, inv, settled);
    if (inv.state === "rejected") return { inputs, hasOutput: false, error: inv.error };
    if (inv.state === "resolved" && inv.value !== undefined) return { inputs, hasOutput: true, output: inv.value };
    return { inputs, hasOutput: false };
  }

  #effective(inv: Invocation): LiveState {
    // Aborting the run's signal makes arrival REJECT every parked call with the abort reason:
    // under a `cancelled` outcome those are cancellations, not failures.
    if (inv.state === "rejected")
      return this.outcome === "cancelled" && this.#isAbort(inv.error) ? "cancelled" : "rejected";
    if (inv.state !== "running") return inv.state;
    if (this.#collapsed.has(inv)) return "resolved";
    return this.outcome === "running" ? "running" : "cancelled";
  }

  /** The abort reason itself, or an `AbortError` — directly or as a `cause` (arrival wraps a
   *  host rejection as `ForeignThrowError` with the reason as its cause). */
  #isAbort(error: unknown): boolean {
    const reason = this.#signal?.reason;
    for (
      let e = error, depth = 0;
      e !== null && e !== undefined && depth < 4;
      e = (e as { cause?: unknown }).cause, depth++
    ) {
      if (reason !== undefined && e === reason) return true;
      if ((e as { name?: unknown }).name === "AbortError") return true;
      if (typeof e !== "object") break;
    }
    return false;
  }

  #bodyState(b: Body): LiveState {
    const isTrack = (b.owner.frame === "par" || b.owner.frame === "callback") && b.ordinal >= 0;
    return isTrack
      ? this.#trackState(b)
      : foldStates(
          b.items.map((i) => this.stateOf(i)),
          this.isSettled(b),
        );
  }

  /** A track is the template run once: a template item not entered yet is still to come until
   *  the track settled; a hosted step never enters on its own. */
  #trackState(b: Body): LiveState {
    const states = [...b.owner.template.children.flatMap((c) => b.byKey.get(c.key) ?? []), ...b.unplanned].map((i) =>
      this.stateOf(i),
    );
    // Template items not entered (a hosted step never enters on its own).
    const missing = b.owner.template.children.filter(
      (c) => !b.byKey.get(c.key)?.length && !(c.kind === "step" && c.via !== undefined),
    ).length;
    // Every designated call of the track is hosted and none ran yet: the track is the form that
    // opened it.
    if (states.length === 0 && missing === 0 && b.start) return this.#effective(b.start);
    if (states.includes("running")) return "running";
    if (states.includes("pending") || (missing > 0 && !this.isSettled(b))) {
      return states.some((s) => s !== "pending" && s !== "skipped") ? "running" : "pending";
    }
    if (states.includes("rejected")) return "rejected";
    if (states.includes("cancelled")) return "cancelled";
    return states.length > 0 || missing > 0 ? "resolved" : "pending";
  }

  // ── attachment ────────────────────────────────────────────────────────────────────────

  #reset(): void {
    this.counters = { invocations: 0, unplacedInvocations: 0, unplanned: 0, unattributed: 0, pendingAttribution: 0 };
    this.#notes.clear();
    this.#cursor = 0;
    this.#places = new WeakMap();
    this.#instances = new WeakMap();
    this.#pending = [];
    this.#unordered.clear();
    this.#openBranches.clear();
    this.#collapsed = new WeakSet();
    const root: FrameInstance = {
      kind: "frame",
      key: this.plan.root.key,
      plan: this.plan.root,
      template: this.plan.root,
      span: this.plan.root.span,
      frame: "root",
      invocation: undefined,
      depth: 0,
      parent: null,
      ordinal: 0,
      bodies: [],
      unattributed: undefined,
      takenArm: undefined,
    };
    this.root = root;
    this.#rootPlace = { slot: this.#slotOf(this.#newBody(root, undefined)) };
  }

  #attach(inv: Invocation): void {
    this.counters.invocations++;
    const parentPlace = (inv.parent ? this.#places.get(inv.parent) : undefined) ?? this.#rootPlace;
    const span = scopeId(inv.node);
    let slot = parentPlace.slot;
    if (parentPlace.frame) slot = this.#routeInterior(parentPlace.frame, inv, span) ?? slot;
    else if (parentPlace.recurOf) slot = this.#routeRecur(parentPlace, inv, span) ?? slot;
    const place: Place = { slot };
    this.#places.set(inv, place);
    const body = slot.body;

    if (this.#recurSpans.has(span)) {
      const loop = this.#enclosingLoop(body, span);
      if (loop) {
        place.recurOf = loop;
        return;
      }
    }

    const key = this.#resolveKey(body, span);
    if (key === null) return this.#unplaced(inv, span, "ambiguous span — no key matches the call path");
    if (key !== undefined) {
      const item = this.plan.byKey.get(key)!;
      const host = this.#descend(slot, item);
      if (!host) return this.#unplaced(inv, span, `${key} is not reachable from the instance it ran in`);
      if (item.kind === "step") {
        this.#add(host, slot, this.#step(item, inv, host));
      } else {
        const frame = this.#frame(item, inv, host);
        this.#add(host, slot, frame);
        place.frame = frame;
      }
      return;
    }

    const name = designatedName(this.trace, inv);
    const hosted = name === undefined ? undefined : this.#macroStep(body, inv, name);
    if (hosted) {
      const host = this.#descend(slot, hosted);
      if (host) return this.#add(host, slot, this.#step(hosted, inv, host));
    }
    if (name !== undefined && this.#designated.has(name)) {
      this.counters.unplanned++;
      const step: StepInstance = {
        kind: "step",
        key: undefined,
        plan: undefined,
        span,
        symbol: name,
        invocation: inv,
        unplanned: true,
        parent: body,
        ordinal: 0,
      };
      this.#add(body, slot, step);
    }
  }

  /**
   * A call a macro expansion built (`(-> s (ask) (fetch))` → `(fetch (ask s))`): its Pair carries
   * the macro use's location, not a planned span. The planned `via: "macro"` steps it can be are
   * the ones of its symbol whose spans the enclosing macro invocations' forms hold (up to the
   * nearest planned ancestor), through the plan's span index. Among several, the expansion nests
   * each earlier step into the next (threading), so a call holding k such calls is the k-th.
   */
  #macroStep(body: Body, inv: Invocation, name: string): PlanStep | undefined {
    const candidates: PlanStep[] = [];
    const visit = (form: unknown): void => {
      if (!isPair(form)) return;
      const key = this.#resolveKey(body, scopeId(form));
      const item = key ? this.plan.byKey.get(key) : undefined;
      if (item?.kind === "step" && item.via === "macro" && item.symbol === name && !candidates.includes(item))
        candidates.push(item);
      for (let c: unknown = form; isPair(c); c = c.cdr) visit(c.car);
    };
    for (let a = inv.parent; a; a = a.parent) {
      if (this.#resolveKey(body, scopeId(a.node))) break;
      visit(a.node);
      if (a === body.start) break;
    }
    // Only where the step's own instance is the body it ran in (through arms at most): a frame
    // the expansion rebuilt (`(->> xs (map f))`'s par) has no invocation to tell its tracks
    // apart, so a call there stays `unplanned`.
    const direct = candidates.filter((c) => this.#inBody(body, c));
    if (direct.length <= 1) return direct[0];
    const order = (s: PlanStep) => this.#planOrder(s);
    direct.sort((x, y) => order(x) - order(y));
    return direct[nestedCalls(inv.node, name) - 1];
  }

  /** `item` sits in `body`'s template, directly or through arms only. */
  #inBody(body: Body, item: PlanItem): boolean {
    for (let f = parentFrame(this.plan, item.key); f; f = parentFrame(this.plan, f.key)) {
      if (f === body.owner.template) return true;
      if (f.frame !== "arm") return false;
    }
    return false;
  }

  /** An item's place in plan (evaluation) order. */
  #planOrder(item: PlanItem): number {
    if (!this.#planIndex) {
      this.#planIndex = new Map();
      const walk = (f: PlanFrame): void => {
        for (const c of f.children) {
          this.#planIndex!.set(c.key, this.#planIndex!.size);
          if (c.kind === "frame") walk(c);
        }
      };
      walk(this.plan.root);
    }
    return this.#planIndex.get(item.key) ?? -1;
  }

  #planIndex: Map<PlanKey, number> | undefined;

  #unplaced(inv: Invocation, span: string, why: string): void {
    this.counters.unplacedInvocations++;
    this.#notes.add(`unplaced ${span} (#${inv.id}): ${why}`);
  }

  /** Where a child of a frame invocation goes: its interior slot, or `undefined` (operand). */
  #routeInterior(frame: FrameInstance, inv: Invocation, span: string): Slot | undefined {
    const t = frame.template;
    const isRoot = t.bodyRoots.includes(span);
    switch (t.frame) {
      case "branch":
        return this.#routeBranch(frame, span, isRoot);
      case "loop": {
        if (t.iterationMarker !== undefined) return this.#routeMarked(frame, inv, span);
        if (!isRoot) return undefined;
        if (t.host !== undefined && (span === t.bodyRoots[0] || frame.bodies.length === 0)) {
          return this.#slotOf(this.#newBody(frame, inv));
        }
        return this.#slotOf(last(frame.bodies) ?? this.#newBody(frame, frame.invocation));
      }
      case "par":
      case "callback":
        return isRoot ? this.#routeTrack(frame, inv, span) : undefined;
      default:
        // seq / call: operands run before the body, so once the body started every child is
        // interior (internal defines the plan did not list among the roots included).
        if (!isRoot && frame.bodies.length === 0) return undefined;
        return this.#slotOf(frame.bodies[0] ?? this.#newBody(frame, undefined));
    }
  }

  /** An arm's own forms ran → that arm was taken. A later clause's test (cond, and/or) runs
   *  inside its arm without deciding it. */
  #routeBranch(frame: FrameInstance, span: string, isRoot: boolean): Slot | undefined {
    const t = frame.template;
    const arm = t.children.findIndex((a) => a.kind === "frame" && a.bodyRoots.includes(span));
    if (arm !== -1) return this.#slotOf(this.#armBody(frame, arm, true));
    const tested = isRoot ? (t.armTests ?? []).indexOf(span) : -1;
    return tested === -1 ? undefined : this.#slotOf(this.#armBody(frame, tested, false));
  }

  /** `do` / `while`: `[test, body…, step…] × k, test, result…` flat under one invocation. The
   *  plan lists test, body and step forms as body roots; result forms are not — they run once
   *  after the loop and stay in the enclosing body. */
  #routeMarked(frame: FrameInstance, inv: Invocation, span: string): Slot | undefined {
    if (span === frame.template.iterationMarker) {
      const prev = last(frame.bodies);
      if (prev) prev.next = inv;
      return this.#slotOf(this.#newBody(frame, inv));
    }
    const cur = last(frame.bodies);
    return cur && frame.template.bodyRoots.includes(span) ? this.#slotOf(cur) : undefined;
  }

  #routeRecur(place: Place, inv: Invocation, span: string): Slot | undefined {
    const loop = place.recurOf!;
    if (!loop.template.bodyRoots.includes(span)) return undefined;
    if (!place.iter) {
      const recur = inv.parent!;
      const prev = last(loop.bodies);
      if (prev) prev.next = recur;
      // `tailPosition` is relative to the evaluator's context, not the loop: iteration 0 of a
      // named let at top level runs in non-tail context, so its recur call reads `false`
      // although it is the loop's tail. The plan's `tail` is the loop-relative fact.
      const tail = loop.template.tail === true || recur.tailPosition;
      place.iter = this.#newBody(loop, recur, tail);
      // The trampoline composes each collapsed tail frame onto its replacement: everything on
      // the path to this call stays `running` until the loop returns. It is done.
      if (tail) {
        for (let a: Invocation | null = recur; a && a !== loop.invocation && !this.#collapsed.has(a); a = a.parent) {
          this.#collapsed.add(a);
        }
      }
    }
    return this.#slotOf(place.iter);
  }

  #routeTrack(frame: FrameInstance, inv: Invocation, span: string): Slot {
    const t = frame.template;
    const seen = this.#seen.get(frame) ?? new Map<string, number>();
    this.#seen.set(frame, seen);
    if (span === t.bodyRoots[0]) {
      seen.set(span, (seen.get(span) ?? 0) + 1);
      const track = this.#newBody(frame, inv);
      (this.#entered.get(frame) ?? this.#entered.set(frame, []).get(frame)!).push(track);
      this.#unordered.add(frame);
      this.#countRoot(track, span);
      (this.#unindexed.get(frame) ?? this.#unindexed.set(frame, []).get(frame)!).push(track);
      return this.#trackSlot(track, span);
    }
    const r = this.#attribute(frame, inv, span);
    if (r !== "later" && r !== "never") return this.#trackSlot(r, span);
    frame.unattributed ??= this.#newBody(frame, undefined, undefined, -1);
    const slot: Slot = { body: frame.unattributed, placed: [] };
    if (r === "later") {
      this.#pending.push({ frame, inv, span, slot });
      this.counters.pendingAttribution++;
    } else this.counters.unattributed++;
    return slot;
  }

  /** A later callback form joins the track whose element it reads; duplicate elements and
   *  tracks whose element is unknown fall back to enter order. */
  #attribute(frame: FrameInstance, inv: Invocation, span: string): Body | "later" | "never" {
    const tracks = this.#entered.get(frame) ?? frame.bodies;
    const seen = this.#seen.get(frame)!;
    const byOrder = () => {
      const j = seen.get(span) ?? 0;
      seen.set(span, j + 1);
      const track = tracks.at(j);
      if (track) this.#countRoot(track, span);
      return track ?? "never";
    };
    if (tracks.length === 1 || frame.template.params.length === 0) return byOrder();
    const found = this.#readParam(inv, frame.template.params);
    if (!found) return inv.state === "running" ? "later" : "never";
    const matching = this.#tracksByElement(frame).get(found.value) ?? [];
    if (matching.length === 0) return byOrder();
    const count = (b: Body) => this.#rootCounts.get(b)?.get(span) ?? 0;
    const pick = matching.reduce((a, b) => (count(b) < count(a) ? b : a), matching[0]!);
    seen.set(span, (seen.get(span) ?? 0) + 1);
    this.#countRoot(pick, span);
    return pick;
  }

  /**
   * A fan's tracks run in the order the callbacks entered, which is timing: the evaluator parks
   * a callback that ran long, so a later element can enter first. The tracks belong in the
   * host's ELEMENT order (structure never depends on timing): each track takes the place of the
   * element its first form read (the k-th track reading a repeated value takes its k-th place).
   * A track whose element is unknown yet, or absent from the list, follows the known ones, in
   * entry order. Settled once every track is placed or the host is.
   */
  #orderFans(): void {
    const trace = this.trace;
    if (!(trace instanceof ExecutionCapture)) return;
    for (const frame of this.#unordered) {
      const host = frame.invocation;
      const params = frame.template.params;
      const entered = this.#entered.get(frame) ?? [];
      const elements = host && params.length === 1 ? trace.elementsOf(host) : undefined;
      if (!elements) {
        if (!host || params.length !== 1 || host.state !== "running") this.#unordered.delete(frame);
        continue;
      }
      const used = new Set<number>();
      let placed = 0;
      const rank = entered.map((track) => {
        const el = track.start && this.#readParam(track.start, params);
        if (!el) return Infinity;
        const k = elements.findIndex((e, i) => !used.has(i) && Object.is(e, el.value));
        if (k === -1) return Infinity;
        used.add(k);
        placed++;
        return k;
      });
      const order = entered.map((_, i) => i).sort((a, b) => rank[a]! - rank[b]! || a - b);
      const next = order.map((i) => entered[i]!);
      if (next.length === frame.bodies.length && next.some((b, i) => b !== frame.bodies[i]))
        frame.bodies.splice(0, frame.bodies.length, ...next);
      for (const [i, b] of frame.bodies.entries()) b.ordinal = i;
      if (placed === entered.length || host!.state !== "running") this.#unordered.delete(frame);
    }
  }

  #countRoot(track: Body, span: string): void {
    const m = this.#rootCounts.get(track) ?? new Map<string, number>();
    m.set(span, (m.get(span) ?? 0) + 1);
    this.#rootCounts.set(track, m);
  }

  /** Element value → tracks, indexing each track once its first form has read the param (a
   *  settled first form that never read it is dropped from the queue). */
  #tracksByElement(frame: FrameInstance): Map<unknown, Body[]> {
    const index = this.#byElement.get(frame) ?? this.#byElement.set(frame, new Map()).get(frame)!;
    const queue = this.#unindexed.get(frame) ?? [];
    const keep: Body[] = [];
    for (const track of queue) {
      const el = track.start && this.#readParam(track.start, frame.template.params);
      if (el) {
        const list = index.get(el.value);
        if (list) list.push(track);
        else index.set(el.value, [track]);
      } else if (track.start?.state === "running") keep.push(track);
    }
    this.#unindexed.set(frame, keep);
    return index;
  }

  /** A track's slot — or, when the callback is a recursive call of an enclosing function
   *  (`(map walk t)` inside `walk`), the body of a nested instance of that function. */
  #trackSlot(track: Body, span: string): Slot {
    const stub = track.owner.template.children.find(
      (c): c is PlanFrame => c.kind === "frame" && c.recursive === true && c.bodyRoots.includes(span),
    );
    if (!stub) return this.#slotOf(track);
    let inst = last(track.byKey.get(stub.key) ?? []) as FrameInstance | undefined;
    if (!inst) {
      inst = this.#frame(stub, undefined, track);
      this.#add(track, this.#slotOf(track), inst);
    }
    return this.#slotOf(inst.bodies[0] ?? this.#newBody(inst, track.start));
  }

  /** The first element-param value resolved anywhere in `inv`'s subtree. */
  #readParam(inv: Invocation, params: readonly string[]): { value: unknown } | undefined {
    const stack = [inv];
    while (stack.length > 0) {
      const n = stack.pop()!;
      const m = this.trace.symbolValues.get(n);
      if (m) for (const p of params) if (m.has(p)) return { value: m.get(p) };
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
    return undefined;
  }

  #retryPending(): void {
    if (this.#pending.length === 0) return;
    const still: PendingRoot[] = [];
    for (const p of this.#pending) {
      const r = this.#attribute(p.frame, p.inv, p.span);
      if (r === "later") {
        still.push(p);
        continue;
      }
      if (r === "never") this.counters.unattributed++;
      else this.#move(p.slot, r);
    }
    this.#pending = still;
    this.counters.pendingAttribution = still.length;
  }

  #move(slot: Slot, to: Body): void {
    const from = slot.body;
    slot.body = to;
    for (const inst of slot.placed ?? []) {
      this.#remove(from, inst);
      this.#insert(to, inst);
    }
  }

  #decideBranches(): void {
    for (const b of this.#openBranches) {
      if (b.takenArm !== "undecided") {
        this.#openBranches.delete(b);
        continue;
      }
      const inv = b.invocation!;
      if (this.#effective(inv) === "running") continue;
      this.#openBranches.delete(b);
      this.#settleArms(b, inv);
    }
  }

  /** A branch that settled: its taken arm, or — undecided at settle, an arm may have run — every
   *  arm instantiated (none taken) so none reads as never-run. A test / selector that rejected
   *  reached no arm: leave them out (never entered → `skipped`). */
  #settleArms(b: FrameInstance, inv: Invocation): void {
    const t = b.template;
    let decided: number | undefined;
    if (inv.state === "resolved") {
      decided = t.armTests?.some((x) => x !== undefined) ? this.#clauseTaken(b, inv) : this.#atomArm(t);
    }
    if (decided !== undefined) {
      this.#armBody(b, decided, true);
      return;
    }
    if (this.#testRejected(b, inv)) return;
    for (const i of t.children.keys()) this.#armBody(b, i, false);
  }

  /** A rejected child of the branch invocation that is no arm form: the selector or a clause
   *  test threw before any arm ran. */
  #testRejected(b: FrameInstance, inv: Invocation): boolean {
    if (inv.state !== "rejected") return false;
    const armForms = new Set(b.template.children.flatMap((a) => (a.kind === "frame" ? a.bodyRoots : [])));
    return inv.children.some((c) => c.state === "rejected" && !armForms.has(scopeId(c.node)));
  }

  /** cond / case-like chains: tests run in order until one holds, so the clause of the LAST
   *  evaluated test ran — unless that test was false, then the chain fell through to the next
   *  test-less arm (`else` / implicit). Covers `=>` clauses and atom bodies, which leave no
   *  arm child. */
  #clauseTaken(b: FrameInstance, inv: Invocation): number | undefined {
    const tests = b.template.armTests!;
    let k = -1;
    let test: Invocation | undefined;
    for (const c of inv.children) {
      const i = tests.indexOf(scopeId(c.node));
      if (i >= k && i >= 0) {
        k = i;
        test = c;
      }
    }
    if (k < 0) return undefined;
    const fallThrough = () => {
      for (let i = k + 1; i < tests.length; i++) if (tests[i] === undefined) return i;
      return undefined;
    };
    const v = this.#retained(test!);
    if (v) return v.value === false ? fallThrough() : k;
    // A later test exists but never ran: test k held.
    if (tests.slice(k + 1).some((x) => x !== undefined)) return k;
    // The last test ran; had it held, its arm's forms would have run.
    const arm = b.template.children.at(k);
    return arm?.kind === "frame" && arm.bodyRoots.length > 0 ? fallThrough() : undefined;
  }

  /** `if` / `when` / `unless`: no arm form ran, so the unique form-less arm did. */
  #atomArm(t: PlanFrame): number | undefined {
    const candidates: number[] = [];
    for (const [i, a] of t.children.entries()) {
      if (a.kind === "frame" && a.bodyRoots.length === 0) candidates.push(i);
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** A settled invocation's value if the trace or capture kept it, unboxed. */
  #retained(inv: Invocation): { value: unknown } | undefined {
    const c = this.trace instanceof ExecutionCapture ? this.trace.captured(inv) : undefined;
    let v: unknown;
    if (c?.hasOutput) v = c.output;
    else if (inv.state === "resolved") v = inv.value;
    if (v === undefined) return undefined;
    return { value: (v as { valueOf?: () => unknown } | null)?.valueOf?.() ?? v };
  }

  // ── plan structure ────────────────────────────────────────────────────────────────────

  /** `callPath + span`, trying the body's call path, then each enclosing one. `undefined`
   *  when the span is not planned, `null` when it is but no key fits. */
  #resolveKey(body: Body, span: string): PlanKey | undefined | null {
    const keys = this.plan.bySpan.get(span);
    if (!keys || keys.length === 0) return undefined;
    for (let b: Body | null = body; b; b = b.owner.parent) {
      const k = b.callPath + span;
      if (this.plan.byKey.has(k)) return k;
    }
    return keys.length === 1 ? keys[0]! : null;
  }

  /** The body `item` belongs in: `body` itself when its template is the item's plan parent;
   *  through frames without an invocation of their own (arms; guard handlers) when it is
   *  deeper; an enclosing body when it is shallower. */
  #descend(slot: Slot, item: PlanItem): Body | undefined {
    for (let b: Body | null = slot.body; b; b = b.owner.parent) {
      const t = b.owner.template;
      const chain: PlanFrame[] = [];
      let f = parentFrame(this.plan, item.key);
      while (f && f !== t) {
        chain.push(f);
        f = parentFrame(this.plan, f.key);
      }
      if (f !== t) continue;
      let cur = b;
      for (let i = chain.length - 1; i >= 0; i--) cur = this.#virtualBody(cur, chain[i]!, slot);
      return cur;
    }
    return undefined;
  }

  #virtualBody(body: Body, f: PlanFrame, slot: Slot): Body {
    const owner = body.owner;
    if (f.frame === "arm") {
      const i = owner.template.children.indexOf(f);
      // Reached through the plan (a guard's "on raise" handler ran): taken.
      if (i !== -1 && owner.template.frame === "branch") return this.#armBody(owner, i, true);
    }
    let inst = last(body.byKey.get(f.key) ?? []) as FrameInstance | undefined;
    if (!inst) {
      inst = this.#frame(f, undefined, body);
      this.#add(body, slot, inst);
    }
    return last(inst.bodies) ?? this.#newBody(inst, undefined);
  }

  #armBody(branch: FrameInstance, index: number, taken: boolean): Body {
    if (taken) branch.takenArm = index;
    const body = branch.bodies[0] ?? this.#newBody(branch, branch.invocation);
    const armPlan = branch.template.children[index] as PlanFrame;
    let arm = last(body.byKey.get(armPlan.key) ?? []) as FrameInstance | undefined;
    if (!arm) {
      arm = this.#frame(armPlan, undefined, body);
      this.#insert(body, arm);
    }
    return arm.bodies[0] ?? this.#newBody(arm, undefined);
  }

  #enclosingLoop(body: Body, span: string): FrameInstance | undefined {
    for (let b: Body | null = body; b; b = b.owner.parent) {
      const o = b.owner;
      if (o.template.frame === "loop" && o.template.recurSpans?.includes(span)) return o;
    }
    return undefined;
  }

  /** The call path of the keys inside `frame`: its children's, else an inlined call's own
   *  prefix, else the enclosing frame's. */
  #pathOf(frame: PlanFrame): string {
    const child = frame.children.at(0);
    if (child) return child.path;
    if (frame.frame === "call") return `${frame.key}▸`;
    const parent = parentFrame(this.plan, frame.key);
    return parent ? this.#pathOf(parent) : "";
  }

  // ── construction ──────────────────────────────────────────────────────────────────────

  #step(plan: PlanStep, inv: Invocation, parent: Body): StepInstance {
    return {
      kind: "step",
      key: plan.key,
      plan,
      span: plan.span,
      symbol: plan.symbol,
      invocation: inv,
      unplanned: false,
      parent,
      ordinal: 0,
    };
  }

  #frame(plan: PlanFrame, inv: Invocation | undefined, parent: Body): FrameInstance {
    let template = plan;
    let depth = 0;
    if (plan.recursive) {
      const found = this.#recursionOf(parent, inv, plan);
      if (found) ({ template, depth } = found);
      else this.#notes.add(`recursive call ${plan.key}: no enclosing instance of the same function`);
    }
    const frame: FrameInstance = {
      kind: "frame",
      key: plan.key,
      plan,
      template,
      span: plan.span,
      frame: plan.frame,
      invocation: inv,
      depth,
      parent,
      ordinal: 0,
      bodies: [],
      unattributed: undefined,
      takenArm: plan.frame === "branch" ? "undecided" : undefined,
    };
    if (plan.frame === "branch" && inv) this.#openBranches.add(frame);
    return frame;
  }

  /** The call frame of the same function further up: callee identity first, then the body
   *  roots the stub shares with it. */
  #recursionOf(
    body: Body,
    inv: Invocation | undefined,
    stub: PlanFrame,
  ): { template: PlanFrame; depth: number } | undefined {
    const headOf = (i: Invocation | undefined) => {
      const head = i && symbolName((i.node as { car?: unknown }).car);
      return head === undefined ? undefined : this.trace.symbolValues.get(i!)?.get(head);
    };
    const callee = headOf(inv);
    const sameRoots = (f: PlanFrame) =>
      stub.bodyRoots.length > 0 &&
      f.bodyRoots.length === stub.bodyRoots.length &&
      f.bodyRoots.every((r, i) => r === stub.bodyRoots[i]);
    for (let b: Body | null = body; b; b = b.owner.parent) {
      const o = b.owner;
      if (o.template.recursive || (o.template.frame !== "call" && o.template.frame !== "loop")) continue;
      // Nested instances opened by a fan callback have no call invocation: roots decide.
      const oCallee = headOf(o.invocation);
      if ((callee !== undefined && oCallee === callee) || sameRoots(o.template)) {
        return { template: o.template, depth: o.depth + 1 };
      }
    }
    return undefined;
  }

  #slotOf(body: Body): Slot {
    return this.#slots.get(body)!;
  }

  #newBody(owner: FrameInstance, start: Invocation | undefined, tail?: boolean, ordinal?: number): Body {
    const body: Body = {
      owner,
      ordinal: ordinal ?? owner.bodies.length,
      callPath: this.#pathOf(owner.template),
      byKey: new Map<PlanKey, Instance[]>(),
      items: [],
      unplanned: [],
      start,
      next: undefined,
      tail,
    };
    this.#slots.set(body, { body, placed: undefined });
    if (body.ordinal >= 0) owner.bodies.push(body);
    return body;
  }

  #add(body: Body, slot: Slot, inst: Instance): void {
    if (inst.kind === "step" || inst.invocation)
      this.#instances.set((inst as { invocation: Invocation }).invocation, inst);
    this.#insert(body, inst);
    if (slot.placed && body === slot.body) slot.placed.push(inst);
  }

  #insert(body: Body, inst: Instance): void {
    if (!this.#order.has(inst)) this.#order.set(inst, this.#seq++);
    const order = (x: Instance) => this.#order.get(x)!;
    const put = (list: Instance[]) => {
      let i = list.length;
      while (i > 0 && order(list[i - 1]!) > order(inst)) i--;
      list.splice(i, 0, inst);
      return list;
    };
    inst.parent = body;
    put(body.items);
    if (inst.kind === "step" && inst.unplanned) {
      for (const [i, x] of put(body.unplanned as Instance[]).entries()) x.ordinal = i;
    } else {
      const list = body.byKey.get(inst.key!) ?? [];
      body.byKey.set(inst.key!, list);
      for (const [i, x] of put(list).entries()) x.ordinal = i;
    }
  }

  #remove(body: Body, inst: Instance): void {
    const drop = (list: Instance[]) => {
      const i = list.indexOf(inst);
      if (i !== -1) list.splice(i, 1);
      return list;
    };
    drop(body.items);
    if (inst.kind === "step" && inst.unplanned)
      for (const [i, x] of drop(body.unplanned as Instance[]).entries()) x.ordinal = i;
    else for (const [i, x] of drop(body.byKey.get(inst.key!) ?? []).entries()) x.ordinal = i;
  }
}

/** Frames and iterations over their items: anything live → `running`; then, once settled,
 *  `cancelled` over `rejected` over `resolved` (a `skipped` arm counts as done). */
export function foldStates(states: readonly LiveState[], settled: boolean): LiveState {
  if (states.some((s) => s === "running" || s === "pending")) return "running";
  if (!settled) return states.length > 0 ? "running" : "pending";
  if (states.includes("cancelled")) return "cancelled";
  if (states.includes("rejected")) return "rejected";
  return "resolved";
}

/** `new ProgressProjector(plan, trace, options).update()`. */
export function projectProgress(plan: Plan, trace: EvalTrace, options?: ProgressOptions): ProgressProjector {
  return new ProgressProjector(plan, trace, options).update();
}

/** The calls of `name` in `form`, itself included (a threading expansion nests earlier steps). */
function nestedCalls(form: unknown, name: string): number {
  if (!isPair(form)) return 0;
  let n = symbolName(form.car) === name ? 1 : 0;
  for (let c: unknown = form.cdr; isPair(c); c = c.cdr) n += nestedCalls(c.car, name);
  return n;
}

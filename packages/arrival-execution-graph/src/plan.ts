/**
 * The static plan of an arrival-scheme program over a designated symbol set: which
 * named-symbol call sites exist (steps), inside which control structures (frames), in
 * evaluation order, plus the dataflow between them.
 *
 * Two sources fill one model. The control skeleton (`build-plan.ts`) is a lexical walk —
 * order, guards, iteration discipline and tail-ness live nowhere else. The dataflow
 * (`dataflow.ts`) is arrival's prospective wireframe joined to the skeleton by span.
 * Frame kinds come from syntax and from arrival's declarations (host role + callback role,
 * PROVENANCE.md §3); where the declarations are silent the plan says so (`callback`) rather
 * than consult a table of names.
 *
 * The contract the plan, dataflow, progress and render-graph layers share: types, plus the
 * one parent accessor. Keys are opaque — structure is read from `parentOf` and `path`, never
 * from a key's spelling.
 */

/** `${callPath}${span}`. `span` is `scopeId(form)` (`head@line:col`, or
 *  `head@source:line:col` for a sourced parse); `callPath` is `${callSiteSpan}▸` per enclosing
 *  inlined call frame, so a define inlined at two call sites yields two keys per element. */

export type PlanKey = string;

/** Declared-role lookup for builtins and capability verbs: `runCtx.vocabulary`, whose values
 *  carry `.provenanceRole` and `.callbackRoles`. A `LexicalScope` does not see these. */
export type Vocabulary = ReadonlyMap<string, unknown>;

/**
 * - `seq` — children in order. Top-level forms, `begin`, `let`-family and function bodies
 *   flatten into their enclosing frame; a `seq` FRAME exists for `guard`/`try` (the body,
 *   followed by a `branch` holding the handler arm that runs on raise) and for `and`/`or`
 *   (label `and`/`or`: each operand runs only if the previous did not short-circuit).
 * - `par` — declared `fan` host with an element-transformer / control / effect callback: the
 *   callback runs per element, concurrently.
 * - `loop` — named let, `do`, `while`, recursion whose recursive calls are ALL in tail position,
 *   and any host whose callback is declared `accumulator` (chained): sequential iterations with
 *   loop-carried params.
 * - `branch` — ordered `arm`s, first match runs: `if`/`when`/`unless` (then, else), and ONE
 *   frame per `cond`/`case` (the trace shows one invocation with flat children).
 * - `call` — a program-defined function (or a named let) whose body reaches a step, inlined at
 *   this call site. Recursion with any non-tail recursive call stays a `call`; each recursive
 *   site is a collapsed `recursive` stub that the actual mode expands into nested instances.
 * - `callback` — a host whose contract declares a lambda at that operand but no schedule we can
 *   read (or whose contract is unknown): runs an unknown number of times in unknown order.
 *   A host whose contract declares NO lambda at that operand does not call it — a designated
 *   symbol passed there is a value, not a step.
 */
export type FrameKind = "seq" | "par" | "loop" | "branch" | "arm" | "call" | "callback";

export interface PlanStep {
  readonly kind: "step";
  readonly key: PlanKey;
  readonly span: string;
  /** The call path `key` is prefixed with (`key === path + span`). */
  readonly path: string;
  readonly symbol: string;
  /** Operands in order; `slot` is `arg<k>`, `source` the printed operand form. */
  readonly args: readonly { readonly slot: string; readonly source: string }[];
  /** Set when the step has no invocation of its own and takes its host's state:
   *  `apply` — `(apply f …)`, the step IS the apply invocation; `callback` — a bare designated
   *  symbol passed as an argument, or a `cond`/`case` `=>` receiver, run inside the host;
   *  `macro` — inside a macro use whose expansion is untracked (`->`, `->>`, `~>`, `~>>`, `cut`,
   *  unknown macros), run inside the macro invocation. */
  readonly via?: "apply" | "callback" | "macro";
}

/** A host's declared callback role (arrival `CallbackRole`). */
export type CallbackRole = "element-transformer" | "control" | "effect" | "accumulator";

export interface PlanFrame {
  readonly kind: "frame";
  readonly key: PlanKey;
  readonly span: string;
  /** The call path `key` is prefixed with (`key === path + span`). */
  readonly path: string;
  readonly frame: FrameKind;
  readonly label: string;
  /** Set when the frame is itself a designated symbol (a designated function's call frame, a
   *  designated fan host with a reaching callback). */
  readonly symbol?: string;
  /** Evaluation order. */
  readonly children: readonly PlanItem[];
  /** Interior ingress: par element params, loop vars or accumulator, call formals. */
  readonly params: readonly string[];
  /** Spans of the located Pairs the evaluator enters with this frame's invocation as parent
   *  and that belong INSIDE the frame (body forms, callback body forms, arm forms — seen
   *  through collection literals and macros that splice user Pairs). Every other child
   *  invocation of the frame's invocation is an operand and belongs to the enclosing instance.
   *  For an `arm`: the forms whose presence among the branch invocation's children means the
   *  arm ran. */
  readonly bodyRoots: readonly string[];
  /** branch: test span per arm (`cond` clause tests), `undefined` for arms without a located
   *  test. */
  readonly armTests?: readonly (string | undefined)[];
  /** loop: spans of the recursive call sites (named-let self-call, recursive call). */
  readonly recurSpans?: readonly string[];
  /** loop from `do`/`while`: the test span; each of its occurrences starts an iteration. */
  readonly iterationMarker?: string;
  /** loop: every recursive call is in tail position. */
  readonly tail?: boolean;
  /** par, host-driven loop, callback: the host op (`map`, `reduce`, `for-each`). */
  readonly host?: string;
  /** par, host-driven loop, callback: the host call's span — callbacks of one call share it. */
  readonly hostSite?: string;
  /** par, host-driven loop: the declared role of the callback (`control`: `filter`'s predicate —
   *  the host's output counts kept elements, not applications). */
  readonly role?: CallbackRole;
  /** branch: the `guard`/`try` handler branch, which runs only on a raise. */
  readonly onRaise?: true;
  /** call: a non-tail recursive call, kept as a collapsed stub with no children; actual mode
   *  expands it into nested instances. */
  readonly recursive?: boolean;
}

export type PlanItem = PlanStep | PlanFrame;

/** `out`, `control` (branch selector), `in:arg<k>` (step operand), `in:<param>` (frame
 *  ingress). A frame port is fed from outside and read from inside; `out` the reverse. */
export type PlanPort = "out" | "control" | `in:${string}`;

/** A step into a value — the same shape as arrival's lineage `PathStep`. */
export type PathStep = { field: string } | { car: true } | { index: number };

/** How a value changes between producer and consumer, read from the closed wire body. */
export interface WireShape {
  /** One id per wire — plan edges sharing it are the inputs of ONE transformation. */
  readonly id: string;
  /** identity: passes as is · projection: a field/index path into it · compute: anything else. */
  readonly kind: "identity" | "projection" | "compute";
  /** projection: the path, in application order. */
  readonly path?: readonly PathStep[];
  /** compute: the body's head op (`string-append`, `+`, a helper). */
  readonly op?: string;
  /** The expression as the program wrote it: the consumer step's operand source when the consumer
   *  is a step slot, else the liveness-peeled wire body with cut params shown as their producers. */
  readonly text: string;
  /** The span of the program form the expression is — where its value is read at run time. */
  readonly span?: string;
  /** Set when the transformation runs inside a frame other than the consumer's own: an arm's
   *  value into its branch's `out` sits in that arm. */
  readonly container?: PlanKey;
}

export interface PlanEdge {
  readonly from: { readonly key: PlanKey; readonly port: PlanPort };
  readonly to: { readonly key: PlanKey; readonly port: PlanPort };
  /** `control`: a selector decides; `recur`: next-iteration value into a loop param. */
  readonly kind: "data" | "control" | "recur";
  /** The closed wire source the value flows through (wireframe `EmittedWire.source`). */
  readonly via?: string;
  /** The wire's shape (`data` and `recur` edges joined from a wire). */
  readonly wire?: WireShape;
}

/** How much of the program's dataflow `edges` represent. `unavailable`: no edges at all (the
 *  wireframe could not be built — `reason` says why); `partial`: some wires or steps could not
 *  be joined (counts + notes in `diagnostics`). Absent until `attachDataflow` ran. A reader must
 *  never mistake missing edges for independent steps, so the view surfaces anything but
 *  `complete`. */
export interface DataflowStatus {
  readonly status: "complete" | "partial" | "unavailable";
  readonly reason?: string;
  /** Wires or captures dropped, plus steps with no wireframe node. */
  readonly missing: number;
}

export interface Plan {
  readonly root: PlanFrame;
  readonly byKey: ReadonlyMap<PlanKey, PlanItem>;
  readonly bySpan: ReadonlyMap<string, readonly PlanKey[]>;
  /** Item key → the key of the frame holding it (every item but the root). */
  readonly parentOf: ReadonlyMap<PlanKey, PlanKey>;
  readonly edges: readonly PlanEdge[];
  readonly dataflow?: DataflowStatus;
  /** What the plan could not represent and why — never silent. */
  readonly diagnostics: readonly string[];
}

/** The frame holding `key`; `undefined` for the root. */
export function parentFrame(plan: Plan, key: PlanKey): PlanFrame | undefined {
  const parent = plan.parentOf.get(key);
  if (parent === undefined) return undefined;
  return parent === plan.root.key ? plan.root : (plan.byKey.get(parent) as PlanFrame | undefined);
}

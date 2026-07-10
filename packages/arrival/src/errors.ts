// -------------------------------------------------------------------------
// :: errors.ts — the single home for every arrival Error subclass.
//
// Kept a runtime LEAF: the only runtime import is the well-known-symbol brands.
// value-guards.js is NOT safe to depend on here — it imports the whole primitive
// class barrel as VALUES, so an `errors.ts → value-guards` edge would eagerly
// initialize AString/AExact/AInexact/ACharacter/APair/… at module-load, before
// those classes exist (they reach errors.ts on their own init path), leaving
// AValue `undefined` when a subclass `extends` it. A located Pair is detected via
// its LOCATION symbol-brand instead — same result, zero class imports.
// StackFrame / SchemeValue are TYPE-only (erased), so a value term can throw any of
// these without dragging the evaluator world in.
// -------------------------------------------------------------------------
import { CLASS, LOCATION } from "./well-known-symbols.js";
import type { StackFrame } from "./eval/evaluator.js";
import type { SchemeValue } from "./values/types.js";

// -------------------------------------------------------------------------
// :: Source Location Tracking
// -------------------------------------------------------------------------

/** Source location for AST nodes and errors. */
export interface SourceLocation {
  /** 1-indexed line number */
  line: number;
  /** 0-indexed column number */
  col: number;
  /** 0-indexed byte offset from start of source */
  offset: number;
  /** Optional source identifier (filename, module, etc.) */
  source?: string;
}

export function formatLocation(loc: SourceLocation): string {
  const source = loc.source ? `${loc.source}:` : "";
  return `${source}${loc.line}:${loc.col}`;
}

/** Thrown for unterminated expressions (unclosed strings, parentheses, etc). */
export class Unterminated extends Error {
  /** Type identity for CLASS-brand readers (`type()`), same convention as ArrivalError below. */
  static [CLASS] = "unterminated";

  location?: SourceLocation;
  /** Stable spec-taxonomy id — the grammar conformance corpus (spec/corpus/) matches
   *  error CLASSES on this, not on prose. */
  readonly code = "E-UNTERMINATED";

  constructor(message: string, location?: SourceLocation) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "Unterminated";
    this.location = location;
  }
}

export class ParseError extends Error {
  /** Type identity for CLASS-brand readers (`type()`), same convention as ArrivalError below. */
  static [CLASS] = "parse-error";

  location?: SourceLocation;
  /** Stable spec-taxonomy id (e.g. E-DICT-DUP-KEY) — the grammar conformance corpus
   *  (spec/corpus/) matches error CLASSES on this, not on prose, so messages stay
   *  free to teach while the contract stays machine-checkable. */
  code?: string;

  constructor(message: string, location?: SourceLocation, code?: string) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "ParseError";
    this.location = location;
    this.code = code;
  }
}

export class EvalError extends Error {
  /** Type identity for CLASS-brand readers (`type()`), same convention as ArrivalError below. */
  static [CLASS] = "eval-error";

  location?: SourceLocation;
  code?: unknown;

  constructor(message: string, options?: { location?: SourceLocation; code?: unknown }) {
    const loc = options?.location;
    super(loc ? `${message} at ${formatLocation(loc)}` : message);
    this.name = "EvalError";
    this.location = options?.location;
    this.code = options?.code;
  }
}

// -------------------------------------------------------------------------
// :: ArrivalError — the single concrete arrival / Scheme-level error (the base).
//
// StackFrame is a TYPE-only import, so value terms throw/extend it without pulling
// in the evaluator — stays cycle-free.
// -------------------------------------------------------------------------

/** A SchemeValue's source location off its LOCATION metadata, if any (leaf-local — the
 *  evaluator's richer `formatCode` renderer isn't reachable from a leaf, so a stack
 *  frame's code prints via its own `String()` repr). The parser stamps LOCATION on
 *  located Pairs (well-known-symbols.ts:58), so only an APair can carry it — read the
 *  brand directly so errors.ts imports no value class (see file header). */
function readLocation(code: SchemeValue): SourceLocation | undefined {
  // APair is the only SchemeValue member declaring `[LOCATION]?: SourceLocation`, so
  // this narrows `code` to APair and types `code[LOCATION]` with no cast.
  if (LOCATION in code) {
    return code[LOCATION];
  }
  return undefined;
}

export class ArrivalError extends Error {
  static [CLASS] = "arrival-error";
  public readonly name: string = "ArrivalError";

  constructor(
    message: string,
    public readonly schemeStack: StackFrame[] = [],
    public readonly cause?: Error,
  ) {
    super(message);
    // Capture on THIS wrapper only — capturing on the cause would overwrite its
    // original stack with the wrap site, destroying where it actually happened.
    Error.captureStackTrace?.(this);
  }

  get stack() {
    return this.cause?.stack ?? super.stack;
  }

  toString(): string {
    let result = `${this.name}: ${this.message}`;
    if (this.schemeStack.length > 0) {
      result += "\n\nScheme Stack Trace:";
      for (const [i, frame] of this.schemeStack.entries()) {
        const env = frame.env_name ? ` [${frame.env_name}]` : "";
        const proc = frame.procedure ? ` in ${frame.procedure}` : "";
        const loc = frame.location ?? readLocation(frame.code);
        const locStr = loc ? ` at ${formatLocation(loc)}` : "";
        result += `\n  ${i + 1}. ${String(frame.code)}${locStr}${proc}${env}`;
      }
    }
    return result;
  }
}

// A RAW HOST-runtime error — a V8/engine throw from a native impl body that skipped its
// contract (`Cannot read properties of undefined`, `x is not a function`, a non-iterable
// spread), NOT an arrival-authored type error. Both are `TypeError`s with no distinguishing
// class or `.cause` brand, so the message is the only honest discriminant — these phrasings
// are engine-authored, arrival never writes them. A host bug is an INTERNAL arrival defect
// (an impl that bypassed its zod/typecheck contract), so it must keep its scheme stack
// rather than surface bare. Matching is intentionally conservative — a miss just falls
// back to today's behavior.
const HOST_RUNTIME_BUG_RE =
  /Cannot read propert|reading '|is not a function|is not iterable|is not a constructor|Spread syntax requires|Maximum call stack|is not defined/;
// Returns `boolean`, not an `e is Error` predicate — a predicate would make a `? :`'s
// else-branch subtract `Error` from an already-`Error` operand → `never` (evaluator.ts
// failAndWrap).
export function isHostRuntimeBug(e: unknown): boolean {
  return (
    (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) &&
    HOST_RUNTIME_BUG_RE.test(e.message)
  );
}

// -------------------------------------------------------------------------
// :: PurityError — the typed error a deliberately-omitted feature carries.
//
// arrival is PURE DATAFLOW: mutation (set-car!/vector-set!/…) and dynamics
// (call/cc/dynamic-wind/parameterize/delay/force) are omitted by design — they'd
// falsify the lineage every value carries. Each omission is a `symbol.notImplemented`
// door in the pack owning that part of the spec, which throws this when reached.
// -------------------------------------------------------------------------
export class PurityError extends ArrivalError {
  static [CLASS] = "purity-error";
  public readonly owner: string;
  public readonly name = "PurityError";

  constructor(
    message: string,
    /** The omitted feature, e.g. "set-cdr!" — internal routing/telemetry key. */
    public readonly feature: string,
    /** The door's owning capability (`DoorCause.owner`, docs/working-proposals/
     *  symbol-define-static-program-validation.md §W0) when the throwing `DoorProcedure`
     *  carries a stamped cause. Absent ⇒ the pre-W0 fixed wall
     *  ("owned-by/purity-invariant") — BYTE-COMPATIBLE for a cause-less door. */
    owner?: string,
  ) {
    super(message);
    this.owner = owner ?? "owned-by/purity-invariant";
  }
}

// -------------------------------------------------------------------------
// :: PortabilityError + strictGate — the loose/strict (R7RS-portability) divergence.
//
// LOOSE mode (default) tolerates modern conveniences stock R7RS does not (e.g. `(map f #(…))`
// over a vector). STRICT mode (`RunContext.strict`) rejects them with an educational error so a
// user can test portability. `strictGate` is the single home for the per-method gate.
// -------------------------------------------------------------------------
export class PortabilityError extends ArrivalError {
  static [CLASS] = "portability-error";
  public readonly name = "PortabilityError";

  constructor(
    /** The diverging op, e.g. "map" — the routing/telemetry key. */
    public readonly op: string,
    /** The spec rule strict mode enforces, e.g. "R7RS `map` operates on lists; a vector is not a list". */
    public readonly rule: string,
    /** The portable alternative, e.g. "use `vector-map` for vectors". */
    public readonly alternative?: string,
  ) {
    super(`${op}: not portable in strict mode — ${rule}${alternative ? ` (${alternative})` : ""}`);
  }
}

/** Loose/strict divergence gate: throws PortabilityError in strict mode, no-op in loose
 *  (default). Reads `strict` structurally so it needs no RunContext import. */
export function strictGate(
  runCtx: { readonly strict: boolean } | undefined,
  divergence: { op: string; rule: string; alternative?: string },
): void {
  if (runCtx?.strict) {
    throw new PortabilityError(divergence.op, divergence.rule, divergence.alternative);
  }
}

// -------------------------------------------------------------------------
// :: ProvenanceRoleShapeError — declared `provenance` role vs contract SHAPE.
//
// docs/PROVENANCE.md §2's drift alarm (PROVENANCE-PLAN.md Q2): a symbol declares a
// `provenance` role (spec's declaration vocabulary — pipe/fan/source/sink/transparent/
// loop/opaque) that its OWN contract's normalized in/out vectors structurally disprove.
// Thrown at ASSEMBLY (bake time — `common/symbols/{native,rosetta,sequence}.ts`, via
// `assertProvenanceRoleShape` in `_bake.ts`), never at call time. LIMIT, stated at
// every throw site: shape catches CONTRADICTIONS, not LIES — a JS body that fans while
// declared `pipe` is consistent-but-wrong and invisible to shape (spec §2's own words).
// -------------------------------------------------------------------------
export class ProvenanceRoleShapeError extends ArrivalError {
  static [CLASS] = "provenance-role-shape-error";
  public readonly name = "ProvenanceRoleShapeError";

  constructor(
    /** The declaring symbol's name — routing/telemetry key. */
    public readonly op: string,
    /** The declared role that contradicts the contract. */
    public readonly role: string,
    /** The teaching explanation of WHY the contract's shape disproves the role. */
    public readonly rule: string,
  ) {
    super(`${op}: declared provenance role "${role}" contradicts its own contract — ${rule}`);
  }
}

// -------------------------------------------------------------------------
// :: InteropAccessError — a Scheme access that would cross an interop boundary.
// -------------------------------------------------------------------------
export class InteropAccessError extends Error {
  constructor(
    message: string,
    public readonly key: string | symbol,
    public readonly boundaryType: string,
  ) {
    super(message);
    this.name = "InteropAccessError";
  }
}

// -------------------------------------------------------------------------
// :: R7RS error types (Section 6.11) + the RaisedException carrier.
// -------------------------------------------------------------------------

/** R7RS error object — errors created by the `error` procedure. */
export class R7RSError extends Error {
  /** Type identity for CLASS-brand readers (`type()`), same convention as ArrivalError above. */
  static [CLASS] = "r7rs-error";

  readonly irritants: unknown[];
  readonly name: string = "R7RSError";

  constructor(message: string, ...irritants: unknown[]) {
    super(message);
    this.irritants = irritants;
  }
}

export class R7RSReadError extends R7RSError {
  readonly name = "R7RSReadError";
}

export class R7RSFileError extends R7RSError {
  readonly name = "R7RSFileError";
}

/** Raised exception wrapper — carries non-Error exceptions through JS try/catch. */
export class RaisedException extends Error {
  readonly name = "RaisedException";

  constructor(
    public readonly value: unknown,
    public readonly continuable: boolean = false,
  ) {
    super(value instanceof Error ? value.message : String(value));
  }
}

// -------------------------------------------------------------------------
// :: Env-assembly errors (teaching, errors-as-doors) — the C3 kernel.
// -------------------------------------------------------------------------
export class AssembleCycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(
      `env-pack dependency cycle: ${cycle.join(" → ")}. Packs form a DAG; break the edge ` +
        `(or model a genuine mutual as a declare-then-wire two-phase pack).`,
    );
    this.name = "AssembleCycleError";
  }
}
export class AssembleConfigConflictError extends Error {
  constructor(public readonly packName: string) {
    super(
      `env-pack "${packName}" appears twice in one assembly with different config. One name = one ` +
        `config per assembly — you armed the same capability two ways. Dedup the pack or unify the config.`,
    );
    this.name = "AssembleConfigConflictError";
  }
}
export class AssembleLinearizationError extends Error {
  constructor(public readonly packName: string) {
    super(
      `env-pack "${packName}" has an inconsistent dependency precedence (C3 merge failed): a dep ` +
        `ordering contradicts another. Reorder the conflicting deps so a single linearization exists.`,
    );
    this.name = "AssembleLinearizationError";
  }
}
export class AssemblePackError extends Error {
  constructor(
    public readonly packName: string,
    public readonly cause: unknown,
  ) {
    super(`env-pack "${packName}" failed to apply: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AssemblePackError";
  }
}
export class AssemblePackTimeoutError extends Error {
  constructor(
    public readonly packName: string,
    public readonly ms: number,
  ) {
    super(`env-pack "${packName}" did not finish applying within ${ms}ms (a wedged await import?).`);
    this.name = "AssemblePackTimeoutError";
  }
}

// -------------------------------------------------------------------------
// :: ResourceNotLiveError — a resource touched before the env accessor spawned it.
// -------------------------------------------------------------------------
export class ResourceNotLiveError extends Error {
  constructor(public readonly kind: string) {
    super(
      `resource "${kind}" was accessed via .live before it was spawned. The env accessor pre-spawns a ` +
        `capability's resources on first symbol touch — if you see this, the method ran outside that gate ` +
        `(use .get() for an explicit lazy acquire instead).`,
    );
    this.name = "ResourceNotLiveError";
  }
}

// -------------------------------------------------------------------------
// :: PreludeMembershipError — a port-reaching define asked for prelude membership.
//
// docs/PROVENANCE.md §1 (round 2 A3, narrowed round 3 M1): prelude membership is
// PURE-ONLY — a top-level define whose body transitively reaches a port (directly, or
// through a reference to another port-reaching define — PROVENANCE-PLAN.md Q7's
// fixpoint) is wireframe material, never prelude. Thrown by
// `provenance/prelude.ts`'s `assertPreludeEligible` — errors-as-doors: names WHY, never
// a bare rejection. §1 EXCLUDED: "port-reaching defines in the prelude (name
// indirection would smuggle sources into 'pure' wire bodies — γ would re-invoke them on
// replay, re-opening the R1 hole the frozen-payload ruling closed)".
// -------------------------------------------------------------------------
export class PreludeMembershipError extends ArrivalError {
  static [CLASS] = "prelude-membership-error";
  public readonly name = "PreludeMembershipError";

  constructor(
    /** The define's name — routing/telemetry key. */
    public readonly define: string,
    /** The teaching explanation of WHY it reaches a port (direct or transitive). */
    public readonly reason: string,
  ) {
    super(`"${define}" is not prelude-eligible — ${reason}`);
  }
}

// -------------------------------------------------------------------------
// :: WireLocalityError — a wire body's free variable is not accounted for (Q8a).
//
// docs/PROVENANCE.md §1 CHOSEN: "a wire is a closed arrival lambda … FV(body) ⊆
// params ∪ prelude-names (checked at emission — wire-locality law). Locality is
// thereby syntactic; declared-vs-actual consumption drift is unrepresentable."
// Thrown by `provenance/uneval.ts`'s `unevalWire` — the EMISSION-time check, not
// a post-hoc audit. errors-as-doors: names the variable, where, and the route
// (a port-reaching define must be a wireframe node, never a captured value).
// -------------------------------------------------------------------------
export class WireLocalityError extends ArrivalError {
  static [CLASS] = "wire-locality-error";
  public readonly name = "WireLocalityError";

  constructor(
    /** The offending free variable name. */
    public readonly variable: string,
    /** `scopeId` of the wire body's surface form — where the wire was cut. */
    public readonly span: string,
    /** The teaching explanation — why this name cannot ride the wire. */
    public readonly reason: string,
  ) {
    super(`wire-locality: free variable "${variable}" in the wire at ${span} — ${reason}`);
  }
}

// -------------------------------------------------------------------------
// :: DefineLocalityError — a `symbol.define` body's free variable escapes its
// capability's own bake-time allowlist (WireLocalityError's SIBLING, one level
// down — docs/working-proposals/symbol-define-static-program-validation.md §2.1's
// bake FV law: `FV(B) ⊆ SPECIAL_FORMS ∪ KEYWORD_SYNTAX ∪ ownNames(K) ∪
// exports(transitiveDeps(K)) ∪ resolver-synth family`). Thrown at BAKE (first
// `lower()`/`apply()` that evaluates the define), never at call time — an
// undeclared cross-capability reference is a declaration-authoring bug the
// design converts into a bake-time door instead of assembly-order luck
// (the srfi-235→polyglot `compose` census catch, §2.1).
// -------------------------------------------------------------------------
export class DefineLocalityError extends ArrivalError {
  static [CLASS] = "define-locality-error";
  public readonly name = "DefineLocalityError";

  constructor(
    /** The offending free variable name. */
    public readonly variable: string,
    /** The declaring define's OWN name (bare, as authored). */
    public readonly define: string,
    /** The owning capability's name. */
    public readonly owner: string,
  ) {
    super(
      `symbol.define "${define}" @ ${owner}: free variable "${variable}" is not in scope — ` +
        `declare a \`deps\` edge on the capability exporting "${variable}", or bind it in "${owner}" itself`,
    );
  }
}

// -------------------------------------------------------------------------
// :: DefineForwardReferenceError — an EAGER (non-lambda) `symbol.define` RHS
// referencing a LATER sibling define in the same capability (§2.3's decidable
// ordering check: today's prelude enforces this only by crashing at eval time;
// this makes it a named bake-time door instead).
// -------------------------------------------------------------------------
export class DefineForwardReferenceError extends ArrivalError {
  static [CLASS] = "define-forward-reference-error";
  public readonly name = "DefineForwardReferenceError";

  constructor(
    /** The declaring (eager) define's own name. */
    public readonly define: string,
    /** The later-declared sibling name it references before that sibling evaluates. */
    public readonly reference: string,
    /** The owning capability's name. */
    public readonly owner: string,
  ) {
    super(
      `symbol.define "${define}" @ ${owner}: its RHS is not a lambda (evaluates EAGERLY, in ` +
        `declaration order) but references "${reference}", declared LATER in the same capability — ` +
        `reorder "${reference}" before "${define}", or wrap "${define}"'s RHS in a lambda so the ` +
        `reference late-binds`,
    );
  }
}

// -------------------------------------------------------------------------
// :: ProvenanceShadowDivergence — static fullCone vs the eager stamp disagree (a named bug).
// -------------------------------------------------------------------------
export class ProvenanceShadowDivergence extends Error {
  constructor(
    readonly form: string,
    readonly staticCone: readonly number[],
    readonly eagerCone: readonly number[],
  ) {
    super(
      `PROVENANCE-SHADOW-DIVERGENCE on \`${form}\`: static fullCone ${JSON.stringify(
        staticCone,
      )} != untapped eager provenance ${JSON.stringify(eagerCone)}`,
    );
    this.name = "ProvenanceShadowDivergence";
  }
}

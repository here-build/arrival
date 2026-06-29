// -------------------------------------------------------------------------
// :: errors.ts — the single home for every arrival Error subclass.
//
// Kept a runtime LEAF: the only runtime import is the well-known-symbol brands.
// (value-guards.js is NOT a safe leaf for errors.ts to depend on — it imports the whole
// primitive class barrel as VALUES, so an `errors.ts → value-guards` edge eagerly
// initializes AString/AExact/AInexact/ACharacter/APair/… at module-load. Because the
// primitives reach errors.ts on their own init path (AString→op-helpers→errors,
// APair→errors), that pulls the barrel in mid-init and AValue is `undefined` when a
// subclass `extends` it. A located Pair is detected via its LOCATION symbol-brand
// instead — same result, zero class imports.)
// StackFrame / SchemeValue are TYPE-only (erased), so a value term can throw any of
// these without dragging the evaluator world in. Was scattered across ArrivalError.ts /
// purity.ts / portability.ts / interop-access.ts / bridge.ts / common/kernel.ts /
// common/resources.ts / values/lineage-shadow.ts — collected here.
// -------------------------------------------------------------------------
import { CLASS, LOCATION } from "./well-known-symbols.js";
import type { StackFrame } from "./eval/evaluator.js";
import type { SchemeValue } from "./values/types.js";

// -------------------------------------------------------------------------
// :: Source Location Tracking
// -------------------------------------------------------------------------

/**
 * Source location information for AST nodes and errors.
 * Tracks where in the source code a value originated.
 */
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

/**
 * Format a source location for display in error messages.
 */
export function formatLocation(loc: SourceLocation): string {
  const source = loc.source ? `${loc.source}:` : "";
  return `${source}${loc.line}:${loc.col}`;
}

/**
 * Error thrown when parsing encounters unterminated expressions
 * (unclosed strings, parentheses, etc.)
 */
export class Unterminated extends Error {
  location?: SourceLocation;

  constructor(message: string, location?: SourceLocation) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "Unterminated";
    this.location = location;
  }
}

/**
 * Error thrown during parsing with source location context.
 */
export class ParseError extends Error {
  location?: SourceLocation;

  constructor(message: string, location?: SourceLocation) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "ParseError";
    this.location = location;
  }
}

/**
 * Error thrown during evaluation with source location context.
 */
export class EvalError extends Error {
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
// The value terms (and the sibling error subclasses below) throw / extend it without
// importing the evaluator — StackFrame is a TYPE-only import, so this stays cycle-free.
// -------------------------------------------------------------------------

/** A SchemeValue's source location off its LOCATION metadata, if any (leaf-local — the
 *  evaluator's richer `formatCode` renderer is not reachable from a leaf, so a stack frame's
 *  code prints via its own `String()` repr). The parser stamps LOCATION on located Pairs
 *  (well-known-symbols.ts:58), so only an APair can carry it — read the brand directly so
 *  errors.ts imports no value class (an `is_pair` narrow would drag in the primitive
 *  barrel via value-guards.js and re-break module init; see the header note). */
function readLocation(code: SchemeValue): SourceLocation | undefined {
  // `LOCATION in code` is a discriminant: APair is the only SchemeValue member
  // declaring `[LOCATION]?: SourceLocation`, so TS narrows `code` to APair here
  // and `code[LOCATION]` types as `SourceLocation | undefined` with no cast
  // (mirrors evaluator.ts's `LOCATION in code` Pair-tap narrow).
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

// -------------------------------------------------------------------------
// :: PurityError — the typed error a deliberately-omitted feature carries.
//
// arrival is PURE DATAFLOW: value mutation (set-car!/vector-set!/…) and the dynamics
// (call/cc/dynamic-wind/parameterize/delay/force) are omitted by design — they'd falsify
// the lineage every value carries. Each omission is a `symbol.notImplemented` door in the
// pack that owns that part of the spec; the door surface throws this when reached.
// -------------------------------------------------------------------------
export class PurityError extends ArrivalError {
  static [CLASS] = "purity-error";
  public readonly owner = "owned-by/purity-invariant";
  public readonly name = "PurityError";

  constructor(
    message: string,
    /** The omitted feature, e.g. "set-cdr!" — internal routing/telemetry key. */
    public readonly feature: string,
  ) {
    super(message);
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
    super(`${op}: not portable in strict mode — ${rule}` + (alternative ? ` (${alternative})` : ""));
  }
}

/** Loose/strict divergence gate. In strict (R7RS-portability) mode a loose tolerance throws a
 *  PortabilityError explaining the divergence; in loose mode (the default) it is a no-op and
 *  the caller proceeds. Reads `strict` structurally so it needs no RunContext import. */
export function strictGate(
  runCtx: { readonly strict: boolean } | undefined,
  divergence: { op: string; rule: string; alternative?: string },
): void {
  if (runCtx?.strict) {
    throw new PortabilityError(divergence.op, divergence.rule, divergence.alternative);
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
  readonly irritants: unknown[];
  readonly name: string = "R7RSError";

  constructor(message: string, ...irritants: unknown[]) {
    super(message);
    this.irritants = irritants;
  }
}

/** R7RS read error — errors during reading/parsing. */
export class R7RSReadError extends R7RSError {
  readonly name = "R7RSReadError";
}

/** R7RS file error — file I/O errors. */
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

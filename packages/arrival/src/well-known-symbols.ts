// Well-known symbol registry for the Arrival interpreter.
//
// These brands are cross-cutting: they are set on one value/class and read
// polymorphically from elsewhere (often by code that does not — or cannot —
// import the defining class). A single registry of `Symbol.for(...)` keys
// gives every reader the same identity without a shared nominal type, and
// keeps the (formerly string-keyed) brands off the public enumerable surface
// of the objects they tag.
//
// Naming: `Symbol.for("arrival/<name>")` namespaces our brands in the global
// symbol registry so an unrelated `Symbol.for("data")` elsewhere can never
// collide. The one exception is LOCATION — see its note.

/**
 * STRING tag identifying a value class, read via `constructor[CLASS]`
 * (`stdlib.ts`, `utils/typecheck.ts`, `eval/guards.ts`). The KEY is this
 * symbol; the VALUE stays a plain string ("pair" / "vector" / …).
 */
export const CLASS = Symbol.for("arrival/class");

/**
 * Marks a JS function as a Scheme lambda (`true`). Set by the evaluator when it
 * wraps/creates lambdas; read INLINE (`typeof fn === "function" && LAMBDA in fn`) by the membrane's
 * isSchemeValue and the printer's procedure repr. Historically a string/symbol mix — now one symbol.
 */
export const LAMBDA = Symbol.for("arrival/lambda");

/**
 * Marks a builtin that understands a `HalfBaked` arg and must NOT have it
 * forced at the dispatch choke (Tier-2 speculation). Set on `length` and the
 * comparison ops; read by the speculative-eval path in the evaluator.
 */
export const SPECULATE = Symbol.for("arrival/speculate");

/**
 * Marks a value as quoted data (`(quote …)` output) so the evaluator treats a
 * Pair/symbol/array as a literal rather than a form to evaluate.
 */
export const DATA = Symbol.for("arrival/data");

/** Cycle-printing back-reference label (`#1=` … `#1#`) on a Pair. */
export const REF = Symbol.for("arrival/ref");

/** Detected cyclic edges on a Pair (`{ car?, cdr? }`), used by the printer. */
export const CYCLES = Symbol.for("arrival/cycles");

/**
 * Source location stamped on located Pairs by the parser.
 *
 * NOTE: deliberately keeps the legacy string `"__location__"`. Sibling packages
 * (`arrival-chain`, `arrival-provenance`) read this brand off Pairs WITHOUT
 * importing the interpreter — via an independent `Symbol.for("__location__")`
 * and via `symbol.description === "__location__"`. `Symbol.for` is global-by-
 * string, so renaming this key would silently sever those cross-package reads.
 * Normalizing it to `arrival/location` requires a coordinated change across all
 * three packages and is intentionally out of scope here.
 */
export const LOCATION = Symbol.for("__location__");

/** Reserved prototype-chain marker. Currently unreferenced; kept for parity. */
export const PROTOTYPE = Symbol.for("arrival/prototype");

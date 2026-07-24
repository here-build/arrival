// Well-known symbol registry for the Arrival interpreter.
//
// These brands are cross-cutting: set on one value/class, read polymorphically
// elsewhere (often by code that can't import the defining class). One registry
// of `Symbol.for(...)` keys gives every reader the same identity without a
// shared nominal type, and keeps brands off the object's enumerable surface.
//
// Naming: `Symbol.for("arrival/<name>")` namespaces brands in the global symbol
// registry so an unrelated `Symbol.for("data")` elsewhere can never collide.
// The one exception is LOCATION — see its note.

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
 * Wire key is `"__location__"` (not `arrival/location`): sibling packages
 * (`arrival-chain`, `arrival-provenance`) read this brand without importing the
 * interpreter — `Symbol.for("__location__")` and `symbol.description === "__location__"`.
 * Renaming silently severs those cross-package reads; a coordinated three-package
 * rename is the only safe change.
 */
export const LOCATION = Symbol.for("__location__");

// Well-known symbol registry for the Arrival interpreter.
//
// These brands are cross-cutting: set on one value/class, read polymorphically
// elsewhere (often by code that can't import the defining class). One registry
// of `Symbol.for(...)` keys gives every reader the same identity without a
// shared nominal type, and keeps brands off the object's enumerable surface.
//
// Naming: `Symbol.for("arrival/<name>")` namespaces our brands in the global
// symbol registry so an unrelated `Symbol.for("data")` elsewhere can never
// collide. The one exception is LOCATION — see its note.
//
// CLASS is the other exception, in the opposite direction (key taxonomy,
// docs/PRINCIPLES.md P7 corollary): it is an ALGEBRA INSTRUCTION KEY, not a
// metadata slot, so it is a plain STRING (`"arrival/class"`), not a
// `Symbol.for` registry entry — every static interpreter (type lens, oracle,
// lineage classifier, trace, MCP harvest) consumes instruction names as data,
// and a symbol would privilege the runtime pair. This is the sibling
// convention to `arrival/tagless-final/*` and `arrival/toJS`/`arrival/print`,
// which are also string-keyed directly on the value classes (see
// `values/tagless-final.ts`). It lives in this file (rather than beside
// those) only because it long predates the taxonomy split; a forged own data
// key named `"arrival/class"` on a borrowed JS object is DATA, never
// protocol — the membrane never reads a wrapped source's own keys as
// instructions (the forgery-guard law, `membrane/__tests__/crossing.law.test.ts`).

/**
 * STRING tag identifying a value class, read via `constructor[CLASS]`
 * (`utils/typecheck.ts`, `values/value-guards.ts`). Both the KEY and the
 * VALUE are plain strings: the key is always `"arrival/class"`, the value is
 * the per-class tag ("pair" / "vector" / …).
 */
export const CLASS = "arrival/class";

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

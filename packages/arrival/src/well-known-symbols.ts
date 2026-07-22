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
// RETIRED: `CLASS` (`export const CLASS = "arrival/class"`) used to live here as
// the ONE plain-STRING exception (key taxonomy, docs/PRINCIPLES.md P7 corollary)
// — an ALGEBRA INSTRUCTION KEY read via `constructor[CLASS]` off ~28 classes'
// `static [CLASS] = "<name>"`. It has been fully replaced by three nominal
// mechanisms, one per consumer: `is_macro_value` (values/value-guards.ts) now
// reads an own `["arrival/is-macro"]` field Macro/Syntax/Syntax.Parameter set
// directly; `isInteropBoundary` (membrane/interop-access.ts) now uses
// `instanceof AValue` / `instanceof ArrivalError` family checks (plus explicit
// `static [INTEROP_BOUNDARY] = true` stamps on the handful of classes outside
// both families); and `type()` (utils/typecheck.ts) now reads each AValue's own
// `kind` field (with explicit membrane arms for AJSArray/AJSObject, whose `kind`
// deliberately diverges from their membrane role). A forged own data key named
// `"arrival/class"` on a borrowed JS object was always DATA, never protocol — the
// membrane never reads a wrapped source's own keys as instructions (the
// forgery-guard law, `membrane/__tests__/crossing.law.test.ts`, still pins this
// for the retired string).

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

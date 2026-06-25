/**
 * Slice 1 of wiring the static lineage classifier (W3, the serial spine of the
 * static-lineage migration — docs/working-proposals/provenance-static-lineage-
 * finalization-v0.1-2026-06-19.md). Derives a `Classifier` (the op-taxonomy that
 * `classify()` in ./lineage.ts consults) from a live `Environment`, replacing the
 * hand-built test classifiers (lineage-spike.test.ts, rosetta-pure-marker.test.ts).
 *
 * Lives apart from lineage.ts so that module stays dependency-light (value-guards
 * only); this one imports Environment + the membrane's SchemeJSFunction.
 *
 * THE PREDICATES, and how much each is genuinely env-derived:
 *  - isRosettaIn (THE load-bearing cut — `classify` keys source-vs-pure on it):
 *    a Rosetta source MINTS provenance. The env has NO registry of source names
 *    today — the pure registry (`rosettaPureOf`) records the PURE ones, and `infer` registers via a
 *    wrapper (infer-kernel) that leaves no env-queryable mint marker. So sources
 *    are passed in EXPLICITLY (the documented seam). A pure rosetta is never a
 *    source even if mis-listed (the `&& !pure` guard). The follow-up that closes
 *    this seam is an env `__rosettaSources__` populated in `defineRosetta` when a
 *    rosetta carries the provenance-point/mint marker — then `sources` is derived,
 *    not passed. Until then, explicit-and-honest beats a hidden stale list.
 *  - isOpaque: STRUCTURAL — a name bound to a `SchemeJSFunction` (membrane/foreign
 *    call) is an irreducible black box. Fully env-derived, no list.
 *  - isFan: a NAME match (`map`/`filter`/`vector-map`). Fan-ness is not structural
 *    (they resolve to plain fl-interop callables), so this is an enumerated set —
 *    the same shape `classify`'s lengthPreserving cut already assumes.
 *  - isPure: provided for interface completeness, but NOTE `classify()` does not
 *    currently consult it — any op that is not source/opaque/fan falls through to
 *    the pure-application path (combine), so an unlisted pure op is still handled
 *    correctly. Kept honest + minimal rather than chasing builtin-list completeness
 *    (the SAFE_BUILTINS-staleness trap); the pure registry carries the pure ROSETTAS.
 */
import { Environment } from "../Environment.js";
import { rosettaPureOf } from "../env-registries.js";
import { AJSFunction } from "./primitives/js-wrappers.js";
import type { Classifier } from "./lineage.js";

/** Collection operators that classify to a per-element fan template (see classify). */
const FAN_OPS: ReadonlySet<string> = new Set(["map", "filter", "vector-map"]);

/** Pure builtins for the (currently unused) isPure predicate — the curated
 *  "author assertion" (env-registries.ts): builtins carry no structural purity
 *  flag. Deliberately minimal; the pure-application fallthrough in classify()
 *  handles anything omitted, so this list need not be exhaustive. */
const PURE_BUILTINS: ReadonlySet<string> = new Set([
  "+", "-", "*", "/", "<", ">", "=", "<=", ">=", "abs", "min", "max",
  "car", "cdr", "cons", "list", "length", "not", "string-append",
]);

/** True iff `op` is a pure rosetta registered anywhere up the env chain
 *  (the pure registry is per-env; this walk supplies the chaining — env-registries.ts). */
function isPureRosettaInChain(env: Environment, op: string): boolean {
  for (let e: Environment | null = env; e; e = e.__parent__) {
    if (rosettaPureOf(e).has(op)) return true;
  }
  return false;
}

/**
 * Build a `Classifier` for `classify()` from a live env. `sources` is the set of
 * Rosetta-in (mint) op names — the explicit seam described in the file header.
 */
export function classifierFromEnv(env: Environment, sources: ReadonlySet<string>): Classifier {
  return {
    isPure: (op) => PURE_BUILTINS.has(op) || isPureRosettaInChain(env, op),
    // A source mints iff it is a declared source AND not a pure transform.
    isRosettaIn: (op) => sources.has(op) && !isPureRosettaInChain(env, op),
    isFan: (op) => FAN_OPS.has(op),
    // Structural: a foreign-call membrane wrapper is an opaque black box.
    isOpaque: (op) => env.get(op, { throwError: false }) instanceof AJSFunction,
  };
}

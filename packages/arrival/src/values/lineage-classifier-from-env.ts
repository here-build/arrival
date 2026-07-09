/**
 * Slice 1 of wiring the static lineage classifier (W3, the serial spine of the
 * static-lineage migration — docs/working-proposals/provenance-static-lineage-
 * finalization-v0.1-2026-06-19.md). Derives a `Classifier` (the op-taxonomy that
 * `classify()` in ./lineage.ts consults) from a live `Environment`, replacing the
 * hand-built test classifiers (lineage-spike.test.ts, rosetta-pure-marker.test.ts).
 *
 * Lives apart from lineage.ts so that module stays dependency-light (value-guards
 * only); this one imports Environment.
 *
 * THE PREDICATES, and how much each is genuinely env-derived:
 *  - isRosettaIn (THE load-bearing cut — `classify` keys source-vs-pure on it):
 *    a Rosetta source MINTS provenance. The env has NO registry of source names
 *    today — the pure registry (`rosettaPureOf`) records the PURE ones, and `infer`
 *    registers via a wrapper (infer-kernel) leaving no env-queryable mint marker.
 *    So sources are passed in EXPLICITLY (the documented seam); a pure rosetta is
 *    never a source even if mis-listed (the `&& !pure` guard). Closing this seam
 *    needs an env `__rosettaSources__` populated in `defineRosetta` when a rosetta
 *    carries the mint marker — then `sources` derives instead of being passed.
 *    Until then, explicit-and-honest beats a hidden stale list.
 *  - isOpaque: always false — the `SchemeJSFunction` membrane/foreign-call wrapper
 *    it once classified is retired (a borrowed JS function crosses the membrane as
 *    #void, never a callable head), so no env binding is structurally opaque. The
 *    `opaque` lineage kind still arises from named-let recursion and test classifiers.
 *  - isFan: read off the bound value — `env.get(op).provenanceRole === "fan"`. Fan ops
 *    (map/filter/vector-map) declare `provenance: "fan"` on their symbol-def contract
 *    (docs/PROVENANCE.md §2, PROVENANCE-PLAN.md Q2 — migrated from the retired
 *    `fanout: true` boolean); capability.ts stamps the RESOLVED role onto the bound
 *    callable as `.provenanceRole`. Fan-ness FOLLOWS THE BINDING (alias-correct — an
 *    alias of `map` is still fan, a shadowing local `map` is not), not a name list.
 *    Q3 retires this duck-read entirely in favor of consuming declared roles directly
 *    (PROVENANCE-PLAN.md Q3 — "isRosettaIn heuristic + `.fanout` duck-reads deleted");
 *    this one-liner is Q2's minimal update to keep the classifier working meanwhile.
 *  - isPure: provided for interface completeness, but `classify()` does not
 *    currently consult it — an op that is not source/opaque/fan falls through to
 *    the pure-application path (combine) regardless. Rosetta-only: the pure
 *    registry (rosettaPureOf) is the whole story — no curated native-builtin list
 *    to go stale.
 */
import { Environment } from "../Environment.js";
import { rosettaPureOf } from "../env-registries.js";
import type { Classifier } from "./lineage.js";

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
    isPure: (op) => isPureRosettaInChain(env, op),
    // A source mints iff it is a declared source AND not a pure transform.
    isRosettaIn: (op) => sources.has(op) && !isPureRosettaInChain(env, op),
    // Fan-ness follows the BINDING: capability.ts stamps `.provenanceRole` on the bound value
    // from the def's declared `provenance: "fan"` (map/filter/vector-map). Non-throwing
    // lookup — the classifier sees arbitrary op names, an unbound one is simply not fan.
    isFan: (op) =>
      (env.get(op, { throwError: false }) as { provenanceRole?: string } | undefined)?.provenanceRole === "fan",
    // See the file header: no env binding is structurally opaque anymore.
    isOpaque: () => false,
  };
}

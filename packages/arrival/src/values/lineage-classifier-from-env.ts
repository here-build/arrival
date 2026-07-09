/**
 * Q3 (PROVENANCE-PLAN.md; docs/PROVENANCE.md §2 EXCLUDED "heuristic classification —
 * every static interpreter reads the declared field"): builds a `Classifier` for
 * `classify()` (./lineage.ts) from a live `Environment` by reading the ONE declared
 * `provenance` role stamped onto each bound callable (`.provenanceRole`,
 * `common/capability.ts` — resolved from `Contract.provenance` at bake time,
 * `common/symbols/_bake.ts`). No name list, no purity-chain probe, no duck-read.
 *
 * `env.get(op)` already walks the `__parent__` chain (Environment.ts's
 * `_lookupWithResolvers`), so a role declared on a parent env is visible to a child
 * for free — the classifier does not re-implement chain-walking.
 *
 * RETIRED HEURISTICS (Q2 landed the declared-role field; this file is the consumer
 * migration — do not resurrect any of these):
 *  - the explicit `sources: ReadonlySet<string>` parameter this function used to take
 *    — a CALLER-SUPPLIED name list standing in for "which ops mint," independent of
 *    anything actually registered. This was the load-bearing heuristic docs/
 *    PROVENANCE.md §2 excludes by name; `roleOf` reading `.provenanceRole` directly
 *    is the declared fact it stood in for.
 *  - `isPureRosettaInChain` / the `rosettaPureOf` per-env purity-registry walk — a
 *    SECOND signal that used to override the (heuristic) `sources` set for the one
 *    baked-declaration path (`&& !pure`). Q2 resolves `pure: true` to a single
 *    `provenance: "pipe"` role at bake time, so there is nothing left for a second
 *    runtime check to override — reading `.provenanceRole` once is the whole answer
 *    for every symbol declared through `symbol.native`/`symbol.rosetta`/
 *    `symbol.sequence`/`symbol.tagless`/`symbol.tagless-guard`. (The legacy dynamic
 *    `Environment.defineRosetta`/`RosettaFunction.pure` runtime API is a SEPARATE,
 *    not-yet-migrated registration path outside Q2/Q3's declared-role vocabulary —
 *    ops registered that way carry no `.provenanceRole` and fall through to this
 *    classifier's `undefined` default, same as any other undeclared name.)
 *  - the `.fanout`/`isFan` duck-read off a bound function's ad-hoc property —
 *    folded into the same uniform `.provenanceRole` read as every other role.
 *  - `isOpaque`'s constant `false` — not a heuristic (nothing WAS structurally
 *    opaque once the foreign-call wrapper class retired), but a parked boolean-
 *    predicate arm; opaque is now a genuine declared-role outcome like any other,
 *    so the constant is gone along with the whole 4-predicate `Classifier` shape.
 *  - `isPure` — already documented as inert (`classify()` never consulted it); gone
 *    with the rest of the retired shape.
 *
 * An unbound / undeclared op name (including a plain user-defined Scheme lambda, or
 * a name registered only via the legacy `defineRosetta` path) resolves to
 * `undefined` — classify()'s default arm treats it as a pure/pipe application,
 * exactly the fallback a shadowing local binding or an unmodeled special-form head
 * already got before this rewrite.
 */
import { Environment } from "../Environment.js";
import type { Classifier, DeclaredRole } from "./lineage.js";

export function classifierFromEnv(env: Environment): Classifier {
  return {
    roleOf: (op) =>
      (env.get(op, { throwError: false }) as { provenanceRole?: DeclaredRole } | undefined)?.provenanceRole,
  };
}

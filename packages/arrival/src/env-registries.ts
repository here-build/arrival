// env-registries — side-table ABOUT the rosettas registered on an env, kept
// OUT of the scope-node (`Environment`): this isn't lexical scope (bindings +
// `__parent__` + lookup), it's run-scoped metadata external tools harvest.
// Holding it here, keyed by the env it was registered on, keeps the
// scope-node minimal while preserving the per-env locality consumers depend on.
//
// WHY env-KEYED (WeakMap<Environment, …>), not one flat global:
//   • rosetta-types are read PER-ENV — the type-lens harvester spreads ONE
//     env's type entries (`[...rosettaTypesOf(env)]`); a sibling env's rosettas must
//     NOT leak in. A flat global would conflate every env built in the process.
//   • WeakMap ⇒ a side-table entry GCs with its env — no lifetime coupling, no leak.
//
// The accessor gets-or-creates the per-env container, so a writer
// (`defineRosetta` carrying a `type`) and a membership-only reader share one path; an
// empty container created by a read is inert (membership = false) and GC-eligible.
//
// This registry holds ONLY the TS-signature strings for the type-lens harvest — it
// does not track purity. `pure: true` on a `defineRosetta` config is still load-bearing
// at runtime even so: it gates `mintsPoint` inside `createRosettaWrapper` (rosetta.ts).
// The static lineage classifier gets purity a different way — the bound value's
// declared `.provenanceRole` (see `values/lineage-classifier-from-env.ts`), not a
// side-table lookup here.

import type { Environment } from "./Environment.js";

// (No global docstring registry: each hermetic symbol carries its own doc, e.g. Macro's `__doc__`.)

// -------------------------------------------------------------------------
// :: Rosetta type signatures — the type-lens HARVEST surface. Populated on each
// :: `defineRosetta` carrying a `type`, read per-env by arrival-type-lens's
// :: `assembleHostPrelude([...registry])`.
// -------------------------------------------------------------------------
const rosettaTypesByEnv = new WeakMap<Environment, Map<string, string>>();

/** This env's rosetta TS-signature registry — the single source the type-lens
 *  harvester derives its `ArrShape` leaf from (`[...rosettaTypesOf(env)]`). Per-env
 *  (NOT chained): the harvester spreads exactly one env's entries. */
export function rosettaTypesOf(env: Environment): Map<string, string> {
  let m = rosettaTypesByEnv.get(env);
  if (m === undefined) {
    m = new Map();
    rosettaTypesByEnv.set(env, m);
  }
  return m;
}

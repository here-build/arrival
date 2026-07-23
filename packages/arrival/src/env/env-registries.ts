// env-registries — side-table ABOUT the rosettas registered on an env, kept
// OUT of the scope-node (`AmbientRuntime`): this isn't lexical scope (bindings +
// `__parent__` + lookup), it's run-scoped metadata external tools harvest.
// Holding it here, keyed by the env it was registered on, keeps the
// scope-node minimal while preserving the per-env locality consumers depend on.
//
// WHY env-KEYED (WeakMap<AmbientRuntime, …>), not one flat global:
//   • rosetta-types are read PER-ENV — the type-lens harvester spreads ONE
//     env's type entries (`[...rosettaTypesOf(env)]`); a sibling env's rosettas must
//     NOT leak in. A flat global would conflate every env built in the process.
//   • WeakMap ⇒ a side-table entry GCs with its env — no lifetime coupling, no leak.
//
// The accessor gets-or-creates the per-env container, so a writer and a membership-only
// reader share one path; an empty container created by a read is inert (membership =
// false) and GC-eligible.
//
// This registry holds ONLY the TS-signature strings for the type-lens harvest. TRAILS
// CLEANUP (Tier 1, docs/plans/stage-c-corpse-deletion.md) shrank `bindRosetta`'s
// `RosettaFunction` config down to its sole live producer's shape (`replay.ts`'s
// playback-frame op, `{ fn }` only) — the `type`-carrying write path this registry was
// populated FROM no longer exists, so every env's registry now reads back empty. Kept
// alive (not deleted) because `rosettaTypesOf` itself is a separately-tracked survivor
// (WO-1 territory, `rosetta-registry-dissolution.md` owns its eventual death, not this
// wave) — this file's own contract is unaffected by who currently writes into it.

import type { AmbientRuntime } from "./AmbientRuntime.js";

// (No global docstring registry: each hermetic symbol carries its own doc, e.g. Macro's `__doc__`.)

// -------------------------------------------------------------------------
// :: Rosetta type signatures — the type-lens HARVEST surface, read per-env by
// :: arrival-lsp's `assembleHostPrelude([...registry])`. Currently never populated
// :: (see this file's header) — every env's map reads back empty.
// -------------------------------------------------------------------------
const rosettaTypesByEnv = new WeakMap<AmbientRuntime, Map<string, string>>();

/** This env's rosetta TS-signature registry — the single source the type-lens
 *  harvester derives its `ArrShape` leaf from (`[...rosettaTypesOf(env)]`). Per-env
 *  (NOT chained): the harvester spreads exactly one env's entries. */
export function rosettaTypesOf(env: AmbientRuntime): Map<string, string> {
  let m = rosettaTypesByEnv.get(env);
  if (m === undefined) {
    m = new Map();
    rosettaTypesByEnv.set(env, m);
  }
  return m;
}

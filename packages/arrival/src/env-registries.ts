// env-registries — side-tables ABOUT the rosettas/docs registered on an env, kept
// OUT of the scope-node (`Environment`): these aren't lexical scope (bindings +
// `__parent__` + lookup), they're run-scoped metadata external tools harvest.
// Holding them here, keyed by the env they were registered on, keeps the
// scope-node minimal while preserving the per-env locality consumers depend on.
//
// WHY env-KEYED (WeakMap<Environment, …>), not one flat global:
//   • docs + rosetta-types are read PER-ENV — the type-lens harvester spreads ONE
//     env's type entries (`[...rosettaTypesOf(env)]`); a sibling env's rosettas must
//     NOT leak in. A flat global would conflate every env built in the process.
//   • rosetta-PURITY is read CHAINED — the lineage classifier walks `__parent__`
//     asking each env's pure-set (a parent's pure rosetta is seen by a child). A
//     WeakMap keyed per-env, queried per step of the existing parent-walk, reproduces
//     that exactly; a flat global would also (accidentally) answer for unrelated envs.
//   • WeakMap ⇒ a side-table entry GCs with its env — no lifetime coupling, no leak.
//
// Accessors get-or-create the per-env container, so a writer
// (`defineRosetta`/`set`-with-doc) and a membership-only reader share one path; an
// empty container created by a read is inert (membership = false) and GC-eligible.

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

// -------------------------------------------------------------------------
// :: Rosetta purity roles — the lineage-classifier HARVEST surface. The set of
// :: rosetta names registered `pure: true` (provenance PIPES, not sources). Read
// :: CHAINED by the classifier's parent-walk.
// -------------------------------------------------------------------------
const rosettaPureByEnv = new WeakMap<Environment, Set<string>>();

/** This env's pure-rosetta set (names that PROPAGATE provenance rather than mint).
 *  The lineage classifier walks `__parent__` asking `rosettaPureOf(e).has(op)` at
 *  each step — so purity declared on a parent is seen by a child, as before. */
export function rosettaPureOf(env: Environment): Set<string> {
  let s = rosettaPureByEnv.get(env);
  if (s === undefined) {
    s = new Set();
    rosettaPureByEnv.set(env, s);
  }
  return s;
}

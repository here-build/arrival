/**
 * Builds a `Classifier` for `classify()` (./lineage.ts) from a live `AmbientRuntime` by
 * reading the ONE declared `provenance` role stamped onto each bound callable
 * (`.provenanceRole`, `common/capability.ts` — resolved from `Contract.provenance` at
 * bake time, `common/symbols/_bake.ts`). No name list, no purity-chain probe, no duck-read.
 *
 * `env.get(op)` already walks the `__parent__` chain (AmbientRuntime.ts's
 * `_lookupWithResolvers`), so a role declared on a parent env is visible to a child
 * for free — the classifier does not re-implement chain-walking.
 *
 * The legacy dynamic `AmbientRuntime.defineRosetta`/`RosettaFunction.pure` runtime API is
 * a separate registration path outside the declared-role vocabulary: ops registered
 * that way carry no `.provenanceRole` and fall through to this classifier's
 * `undefined` default, same as any other undeclared name.
 *
 * An unbound / undeclared op name (including a plain user-defined Scheme lambda, or
 * a name registered only via the legacy `defineRosetta` path) resolves to
 * `undefined` — classify()'s default arm treats it as a pure/pipe application, the
 * same fallback a shadowing local binding or an unmodeled special-form head gets.
 */
import { AmbientRuntime } from "../AmbientRuntime.js";
import type { Classifier, DeclaredRole } from "./lineage.js";

export function classifierFromEnv(env: AmbientRuntime): Classifier {
  return {
    roleOf: (op) =>
      (env.get(op, { throwError: false }) as { provenanceRole?: DeclaredRole } | undefined)?.provenanceRole,
  };
}

/**
 * Deep provenance of a scheme value: the union of `.provenance` over every AValue
 * reachable from it — itself, a Pair's car/cdr spine (recursively), the elements of a
 * SchemeVector, and the elements of a plain JS array. List construction
 * (`new Pair(value, rest)`) leaves the spine's provenance EMPTY, so the origins live
 * only on the elements; a shallow top-level read would return ∅ for any packed list /
 * vector (the container is provenance-transparent). Cycle/visited-guarded.
 *
 * Single source shared by rosetta.ts's argProvenance builder and
 * lineage-auto-bindings.ts's per-invocation leaf-stamp — the SAME reachability the
 * eager stamp's union walks. Lives in the `values/` leaf layer (imports only value
 * classes + the pair guard), so both rosetta.ts and the carrier modules import it
 * without an import cycle.
 */
import { AValue } from "../values/primitives/AValue.js";
import { is_pair } from "../values/value-guards.js";
import { AVector } from "../values/primitives/AVector.js";
import { APair } from "../values/primitives/APair.js";

export function deepProvenance(value: unknown): ReadonlySet<number> {
  const acc = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof AValue) {
      for (const p of v.provenance) acc.add(p);
      if (v instanceof APair) {
        walk(v.car);
        walk(v.cdr);
      } else if (v instanceof AVector) {
        for (const el of v.__vector__) walk(el);
      }
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    }
  };
  walk(value);
  return acc;
}

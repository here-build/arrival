/**
 * Union of `.provenance` over every AValue reachable from a scheme value —
 * the value itself, Pair car/cdr spines, SchemeVector / plain-array elements,
 * borrowed-array (AJSArray) elements. List construction leaves spine provenance
 * empty; origins live on elements — a shallow top-level read returns ∅ for
 * packed lists/vectors. Cycle-guarded.
 *
 * An alias of `collapseProvenance`, not a second walk: carrier enumeration is
 * owned by the classes' `arrival/provenanceChildren` term (P7), so the read-side
 * reachability cannot drift from the collapsing ops'. Used by lineage-auto-bindings
 * leaf-stamps and by arrival-provenance's verdict / trace-to-regions.
 */
import { collapseProvenance } from "./provenance-collapse.js";

export const deepProvenance = (value: unknown): ReadonlySet<number> => collapseProvenance(value);

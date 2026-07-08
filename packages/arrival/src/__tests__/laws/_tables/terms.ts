/**
 * The tagless-term table — F1's row axis (docs/test-suite-v2/DESIGN.md).
 *
 * Every term declares its BOX DISCIPLINE up front: that declaration IS the law the
 * term×carrier grid enforces (P0/P8 — one algebra, every carrier). A term whose
 * discipline "depends on the carrier" cannot be expressed in this table; that is
 * the point.
 *
 * boxDiscipline:
 *  - "element-preserving": every element's box (identity + provenance) survives
 *    into the result (map, filter, sort, concat elements).
 *  - "element-unioning": the result is a fresh scalar/container whose provenance
 *    is the union of consumed elements' (length counts, equals verdicts — pending
 *    R2 for the container-box question).
 *  - "projecting": the result IS one of the input's elements, box intact (car,
 *    cdr-of-dotted, vector-ref, assoc hit).
 */
export interface TermRow {
  /** protocol key, e.g. "arrival/tagless-final/map" */
  readonly term: string;
  /** scheme-surface verbs dispatching to it (for conformance cross-reference) */
  readonly verbs: readonly string[];
  readonly boxDiscipline: "element-preserving" | "element-unioning" | "projecting";
  /** R2 gate: container-box behavior is RULING-NEEDED; null until ruled */
  readonly containerBox: "preserved" | "fresh" | null;
}

export const TERMS: readonly TermRow[] = [
  { term: "arrival/tagless-final/map", verbs: ["map", "vector-map", "string-map"], boxDiscipline: "element-preserving", containerBox: null },
  { term: "arrival/tagless-final/filter", verbs: ["filter"], boxDiscipline: "element-preserving", containerBox: null },
  { term: "arrival/tagless-final/reduce", verbs: ["reduce"], boxDiscipline: "element-unioning", containerBox: null },
  { term: "arrival/tagless-final/sort", verbs: ["sort"], boxDiscipline: "element-preserving", containerBox: null },
  { term: "arrival/tagless-final/concat", verbs: ["append", "string-append", "vector-append"], boxDiscipline: "element-preserving", containerBox: null },
  { term: "arrival/tagless-final/length", verbs: ["length", "vector-length", "string-length"], boxDiscipline: "element-unioning", containerBox: null },
  { term: "arrival/tagless-final/equals", verbs: ["equal?"], boxDiscipline: "element-unioning", containerBox: null },
  { term: "arrival/tagless-final/car", verbs: ["car"], boxDiscipline: "projecting", containerBox: null },
  { term: "arrival/tagless-final/cdr", verbs: ["cdr"], boxDiscipline: "projecting", containerBox: null },
  { term: "arrival/toJS", verbs: [], boxDiscipline: "element-unioning", containerBox: null },
  { term: "arrival/print", verbs: ["display", "write"], boxDiscipline: "element-unioning", containerBox: null },
] as const;

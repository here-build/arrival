// The catalog's size budget, in ONE place.
//
// It lived in two: catalog.test.ts owned the per-mode table, and pilot-invariants.test.ts wrote
// `2400` inline under a comment promising it was "the same budget, not a fresh one." It was not the
// same budget — it was a COPY of it, and a copy silently becomes a second, stale budget the moment
// the first is re-measured (which is exactly what happened on 2026-07-14: the table moved, the copy
// did not, and the copy started failing while claiming to enforce the table).
//
// A number that must agree with another number should not be typed twice.
export const CATALOG_CAPS = {
  available: 2650, // measured 2447, 2026-07-14
  required: 3150, // measured 2895 — the wrap-rule teaching is the mode's cost
  off: 2350, // measured 2159
} as const;

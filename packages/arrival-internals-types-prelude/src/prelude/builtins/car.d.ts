// ─────────────────────────────────────────────────────────────────────────────
// `car` — the REFERENCE leaf the sibling builtins follow.
//
// Scheme semantics: (car list) → the head element of a non-empty list.
//
// Exemplar of the merge pattern (sibling leaves fold this to the one-line pointer
// below): a leaf declares ambient functions with its ONE member, written
// purely in PRE's base types (here `List<T>`); TS merges every leaf's member into
// global scope.
// // ─────────────────────────────────────────────────────────────────────────────

declare function car<T>(xs: List<T>): T;

// ─────────────────────────────────────────────────────────────────────────────
// L — SRFI-43 vectors (pure ops only — arrival vectors are immutable).
//
// Scheme semantics:
//   (vector x …)                  → a vector of the given elements
//   (vector? x)                   → #t iff x is a vector
//   (vector-fold kons knil vec)   → left fold, (kons acc elt) across 0..n-1
//   (vector-fold-right kons knil vec) → right fold, across n-1..0
//   (vector-count pred vec)       → count of indices where (pred elt) is truthy
//   (vector-index pred vec)       → first index where (pred elt), else #f
//   (vector-any pred vec)         → first truthy (pred elt), else #f
//   (vector-every pred vec)       → last (pred elt) if all truthy, else #f
//   (vector-empty? vec)           → #t iff length 0
//   (vector-binary-search vec value cmp) → index where (cmp elt value)=0, else #f
//
// Runtime truth (the `any` impls these SHARPEN — do NOT import them):
//   • `vector` / `vector?` mint/test a BOXED SchemeVector (wrappedOps in bridge.ts;
//     stdlib.ts:1792-1793). v1 MODELS A VECTOR AS `List<T>` per the assignment —
//     no distinct boxed brand is introduced here; this is the documented coarse
//     choice. (A `Vector<T>` brand wrapping SchemeVector would be the v2 sharpening.)
//   • The pure SRFI-43 ops are define'd over vector-length/vector-ref:
//       vector-fold        bootstrap.ts:778-782  — (kons acc elt), acc threads
//       vector-fold-right  bootstrap.ts:785-788
//       vector-count       bootstrap.ts:791-795  — pred → count (SNum)
//       vector-index       bootstrap.ts:798-803  — first index | #f
//       vector-binary-search bootstrap.ts:806-813 — (vec value cmp), cmp→SNum, idx | #f
//       vector-empty?      bootstrap.ts:816
//       vector-any         bootstrap.ts:819-824  — first truthy (pred elt) | #f
//       vector-every       bootstrap.ts:827-834  — last (pred elt) | #f
//
// Exposed to the sandbox via SAFE_BUILTINS (safe_builtins.ts:152-160 for the SRFI-43
// ops; `vector`/`vector?` at safe_builtins.ts:108/80).
//
// MODELING (v1):
//   • vector V = `List<T>`. So vector-fold/any/etc. take `List<T>` and thread T into
//     the kons/pred callbacks exactly like the list-family leaves.
//   • Search/index ops return `SNum | SBool` (a real index, or #f on miss) — honest:
//     the impl returns #f, so a downstream use must account for the false case.
//   • vector-any/-every return the truthy callback result OR #f — typed as the
//     callback's result type unioned with SBool (the #f sentinel).
//
// `?`-names → bracketed string keys.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // Construct a vector from its elements (v1: a List<T>). Variadic in elements.
  vector<T>(...elems: T[]): List<T>;
  // Tag/type predicate — accepts any value, returns SBool.
  "vector?"(x: unknown): SBool;

  // Folds — kons is (acc, elt) → acc'; the accumulator type A threads through.
  "vector-fold"<A, T>(kons: (acc: A, elt: T) => A, knil: A, vec: List<T>): A;
  "vector-fold-right"<A, T>(kons: (acc: A, elt: T) => A, knil: A, vec: List<T>): A;

  // Count of indices where the predicate holds → SNum.
  "vector-count"<T>(pred: (elt: T) => unknown, vec: List<T>): SNum;
  // First matching index, or #f → SNum | SBool.
  "vector-index"<T>(pred: (elt: T) => unknown, vec: List<T>): SNum | SBool;

  // Short-circuiting search — returns the truthy (pred elt) result, or #f.
  "vector-any"<T, R>(pred: (elt: T) => R, vec: List<T>): R | SBool;
  // Returns the last (pred elt) if all truthy, or #f.
  "vector-every"<T, R>(pred: (elt: T) => R, vec: List<T>): R | SBool;

  // Length-0 test → SBool.
  "vector-empty?"<T>(vec: List<T>): SBool;

  // Binary search — (vec, value, cmp) where cmp(elt, value) → SNum sign; index | #f.
  "vector-binary-search"<T>(vec: List<T>, value: T, cmp: (elt: T, value: T) => SNum): SNum | SBool;
}

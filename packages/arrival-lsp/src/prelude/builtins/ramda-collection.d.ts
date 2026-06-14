// ─────────────────────────────────────────────────────────────────────────────
// L — the RAMDA COLLECTION family — the list/grouping transforms that thread the
// element type from input to output. These SHARPEN the `(...args:any[])=>any`
// Ramda impls into element-precise signatures, so a callback↔element mismatch or
// a wrong-typed result bites instead of collapsing to `any`.
//
// Runtime truth (ramda-functions.ts — the `any` impls these SHARPEN, do NOT import):
//   group-by/classify   = R.groupBy        (ramda-functions.ts:234,235)
//   count-by/tally       = R.countBy        (ramda-functions.ts:236,237)
//   sort-by/order-by     = R.sortBy         (ramda-functions.ts:241,242)
//   order                = R.sort           (ramda-functions.ts:240)
//   sort-with            = R.sortWith       (ramda-functions.ts:243)
//   reject/remove/exclude= R.reject         (ramda-functions.ts:184,185,186)
//   slice                = R.slice          (ramda-functions.ts:131)
//   find-index           = R.findIndex      (ramda-functions.ts:194)
//   find-last            = R.findLast       (ramda-functions.ts:195)
//   find-last-index      = R.findLastIndex  (ramda-functions.ts:196)
//   locate               = R.find           (ramda-functions.ts:192)
//   select/keep          = R.filter         (ramda-functions.ts:180,182)
//   compact              = RA.compact       (ramda-functions.ts:408)
//   all/any/none         = R.all/R.any/R.none(ramda-functions.ts:144,146,148)
//   prepend              = R.prepend        (ramda-functions.ts:133)
//   reduce-by            = R.reduceBy        (ramda-functions.ts:233)
//   chain                = R.chain          (ramda-functions.ts:59)
//   aggregate/accumulate = RAMDA_FUNCTIONS.reduce (ramda-functions.ts:227,228 — fn,init,coll)
//
// FAITHFULNESS NOTES (env precedence inline > safeWrappedOps > SAFE_BUILTINS >
// RAMDA_FUNCTIONS, sandbox-env.ts:186-212):
//   • EVERY Ramda head here is fn/predicate/key/value FIRST, collection LAST.
//   • `remove`/`exclude` are ALIASES OF R.reject — the inverse of filter (DROP the
//     matching elements). NOT R.remove (index-splice). Typed as predicate-filter.
//   • `select`/`keep` are ALIASES OF R.filter — element type preserved (count
//     narrows, not the type). They duplicate filter's shape under SQL/retention
//     mental models, NOT object-selection.
//   • `aggregate`/`accumulate` are reduce ALIASES with arg order (fn, init, coll) —
//     NOTE the reducer is `(acc, x)` (initial FIRST), matching the polymorphic
//     reduce impl, NOT Ramda's curried `R.reduce` shape on this codepath.
//   • `group-by`/`count-by`/`reduce-by` collapse a list into a STRING-keyed object;
//     v1 keys are open `string` (the key fn returns a runtime string we can't
//     enumerate statically), so the result is `Record<string, …>`.
//   • `compact` drops nullish (and other falsy) elements → element type loses
//     `null | undefined` (`NonNullable<T>`); count narrows like filter.
//
// Base types (`List`, `SNum`, `SStr`, `SBool`) come from PRE (../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // ── Grouping into a string-keyed object ────────────────────────────────────
  // (group-by keyFn xs) → { [k]: List<T> }. keyFn sees a T, returns the bucket key.
  "group-by"<T>(keyFn: (x: T) => SStr, xs: List<T>): Record<string, List<T>>;
  classify<T>(keyFn: (x: T) => SStr, xs: List<T>): Record<string, List<T>>;

  // (count-by keyFn xs) → { [k]: SNum } — bucket sizes. keyFn sees a T.
  "count-by"<T>(keyFn: (x: T) => SStr, xs: List<T>): Record<string, SNum>;
  tally<T>(keyFn: (x: T) => SStr, xs: List<T>): Record<string, SNum>;

  // (reduce-by valueFn acc keyFn xs) → { [k]: Acc } — per-bucket fold.
  // valueFn folds (acc, x) within each bucket; keyFn assigns x to a bucket.
  "reduce-by"<T, Acc>(
    valueFn: (acc: Acc, x: T) => Acc,
    acc: Acc,
    keyFn: (x: T) => SStr,
    xs: List<T>,
  ): Record<string, Acc>;

  // ── Ordering — element type preserved, COUNT/ORDER only ────────────────────
  // (sort-by ordFn xs) — ordFn maps each T to an orderable; result reordered List<T>.
  "sort-by"<T>(ordFn: (x: T) => SNum | SStr, xs: List<T>): List<T>;
  "order-by"<T>(ordFn: (x: T) => SNum | SStr, xs: List<T>): List<T>;
  // (order cmp xs) — comparator (a,b)→SNum; reordered List<T>.
  order<T>(cmp: (a: T, b: T) => SNum, xs: List<T>): List<T>;
  // (sort-with cmps xs) — a list of comparators applied in order; reordered List<T>.
  "sort-with"<T>(cmps: List<(a: T, b: T) => SNum>, xs: List<T>): List<T>;

  // ── Predicate filtering — element type preserved ───────────────────────────
  // reject = inverse filter (DROP matches). Aliases remove/exclude.
  reject<T>(pred: (x: T) => SBool, xs: List<T>): List<T>;
  remove<T>(pred: (x: T) => SBool, xs: List<T>): List<T>;
  exclude<T>(pred: (x: T) => SBool, xs: List<T>): List<T>;
  // select/keep = filter (KEEP matches), SQL / retention mental models.
  select<T>(pred: (x: T) => SBool, xs: List<T>): List<T>;
  keep<T>(pred: (x: T) => SBool, xs: List<T>): List<T>;

  // ── Slicing — element type preserved ───────────────────────────────────────
  // (slice from to xs) — half-open [from, to); reordered/cut List<T>.
  slice<T>(from: SNum, to: SNum, xs: List<T>): List<T>;

  // ── Find family ────────────────────────────────────────────────────────────
  // index of first/last match (R.findIndex / R.findLastIndex) → SNum (-1 if none).
  "find-index"<T>(pred: (x: T) => SBool, xs: List<T>): SNum;
  "find-last-index"<T>(pred: (x: T) => SBool, xs: List<T>): SNum;
  // first match from the end (R.findLast). Element-precise; may miss → `| undefined`.
  "find-last"<T>(pred: (x: T) => SBool, xs: List<T>): T | undefined;
  // locate = R.find (first match). Element-precise; may miss → `| undefined`.
  locate<T>(pred: (x: T) => SBool, xs: List<T>): T | undefined;

  // ── Nullish/falsy compaction ───────────────────────────────────────────────
  // (compact xs) — drop nullish/falsy elements; surviving element type loses null/undefined.
  compact<T>(xs: List<T>): List<NonNullable<T>>;

  // ── Whole-list predicates → SBool, element arg still precise ────────────────
  all<T>(pred: (x: T) => SBool, xs: List<T>): SBool;
  any<T>(pred: (x: T) => SBool, xs: List<T>): SBool;
  none<T>(pred: (x: T) => SBool, xs: List<T>): SBool;

  // ── Build / flatten ────────────────────────────────────────────────────────
  // (prepend x xs) — cons-front; widens element type to the union of both.
  prepend<T, X>(x: X, xs: List<T>): List<T | X>;
  // (chain f xs) — flat-map: f maps each T to a List<B>; result is the flattened List<B>.
  chain<A, B>(f: (a: A) => List<B>, xs: List<A>): List<B>;

  // ── Reduce aliases (fn,init,coll; reducer is (acc, x)) ─────────────────────
  aggregate<T, Acc>(fn: (acc: Acc, x: T) => Acc, init: Acc, xs: List<T>): Acc;
  accumulate<T, Acc>(fn: (acc: Acc, x: T) => Acc, init: Acc, xs: List<T>): Acc;
}

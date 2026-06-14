// ─────────────────────────────────────────────────────────────────────────────
// L?? — the SRFI-1-ADJACENT LIST FAMILY that is ACTUALLY LIVE in the sandbox.
//
// This leaf types the prefix/suffix + fold/count list ops that resolve to a REAL
// impl under the sandbox env precedence
// (inline > safeWrappedOps > SAFE_BUILTINS > RAMDA_FUNCTIONS, sandbox-env.ts:186-212).
//
// ⚠️ EMPIRICAL CULL (probed against the constructed `sandboxedEnv`, 2026-06-14):
// the bootstrap SRFI-1 procedures (`take-while` `drop-while` `span` `break`
// `partition` `find-tail` `last-pair` `list-tabulate` `fold-right` `reduce-right`
// `concatenate` `append-reverse`) are `define`d into `user_env`
// (`global_env.inherit("user-env")`, stdlib.ts:2108) by `exec(BOOTSTRAP_SCHEME)`.
// But `sandboxedEnv` is built from `global_env.get(name)` over the SAFE_BUILTINS
// whitelist (sandbox-env.ts:189), and `Environment.get` walks PARENTS, never into
// the `user_env` CHILD — so those names resolve to ABSENT in the sandbox. They are
// NOT typed here. The post-bootstrap copy-list (bridge.ts:1827) only forwards
// `count` (+ first?/iota/remove/…), which is why `count` survives below.
// Conversions `list->array` / `array->list` / `tree->array` are not whitelisted
// AND not in wrappedOps → also ABSENT.
//
// Runtime truth for each LIVE member (the `any`/array impls this SHARPENS — the
// lens models a Scheme list as PRE's `List<T>` = `readonly T[]`, faithful to the
// Ramda array contract these heads carry):
//   • take / drop — RAMDA_FUNCTIONS, ramda-functions.ts:129-130 (R.take / R.drop):
//       (n, list) — COUNT-FIRST, list-LAST. Prefix / suffix of length n.
//   • head — ramda-functions.ts:81 (R.head): first element, `undefined` on empty.
//   • tail / rest — ramda-functions.ts:104-105 (R.tail): the list minus its head.
//   • init — ramda-functions.ts:108 (R.init): the list minus its LAST element.
//   • concat — ⚠️ SAFE_BUILTINS shadows RAMDA here: the LIVE `concat` is the LIPS
//       STRING concat (stdlib.ts:1629, `typecheck(arg,"string")`), variadic over
//       strings → a string. It is NOT list append (probed: `(concat (list 1 2) …)`
//       throws "Expecting string got pair"). Do NOT type it `(List,List)→List`.
//   • flatten — ramda-functions.ts:61 (R.flatten): DEEP, fully-recursive flatten.
//       Depth is unbounded, so the element type cannot thread precisely — the
//       honest return is `List<unknown>`. The ARGUMENT is still constrained to a
//       list, so `(flatten 5)` bites.
//   • fold — ramda-functions.ts:226 → RAMDA_FUNCTIONS.reduce (line 199): the
//       Ramda `(fn, init, list)` order with callback `(acc, x)` — NOT SRFI-1
//       fold's `(kons knil list)` with `(elt acc)`. (SRFI-1 `fold` is NOT live;
//       this Haskell-tradition alias of `reduce` is what resolves.) Threads the
//       accumulator type through, so a callback returning the wrong acc type bites.
//   • nth — SAFE_BUILTINS, stdlib.ts:1596 (LIPS native): (index, list) —
//       INDEX-FIRST, list-LAST → the element, or nil/undefined out of range.
//   • for-each — SAFE_BUILTINS, stdlib.ts:1885 (LIPS native): (fn, list…) for
//       side effects; yields the unspecified value → PRE's `Unit` (void).
//   • count — bootstrap define forwarded to the sandbox (bootstrap.ts:657 via
//       bridge.ts:1829): `(count pred . lists)` → how many elements satisfy pred,
//       an `SNum`. Pred-FIRST, list-LAST.
//
// Mis-arg bites (2345); wrong-typing a threaded result bites (2322). Base types
// (`List`, `SNum`, `SStr`, `Unit`) come from PRE (../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // Prefix / suffix by count (R.take / R.drop). Count-first, list-last; element
  // type preserved.
  take<T>(n: SNum, xs: List<T>): List<T>;
  drop<T>(n: SNum, xs: List<T>): List<T>;

  // Head / tail decomposition (R.head / R.tail / R.init). `head` may miss on an
  // empty list (R returns `undefined`); the tail-family preserve the element type.
  head<T>(xs: List<T>): T | undefined;
  tail<T>(xs: List<T>): List<T>;
  rest<T>(xs: List<T>): List<T>;
  init<T>(xs: List<T>): List<T>;

  // ⚠️ STRING concat (LIPS native shadows Ramda) — variadic over strings → string.
  // NOT list append.
  concat(...parts: SStr[]): SStr;

  // Deep recursive flatten (R.flatten). Depth unbounded → element type collapses
  // to `unknown`; the argument is still pinned to a list so a non-list bites.
  flatten(xs: List<unknown>): List<unknown>;

  // Left fold via Ramda reduce (fn, init, list) with callback (acc, x). Threads
  // the accumulator type B through both the seed and the callback's return.
  fold<A, B>(f: (acc: B, x: A) => B, init: B, xs: List<A>): B;

  // Indexed element read (LIPS native nth). Index-first, list-last; out-of-range
  // is the miss value (nil/undefined), so the result is `T | undefined`.
  nth<T>(index: SNum, xs: List<T>): T | undefined;

  // Side-effecting iteration (LIPS native). Callback param bound to the element
  // type; the form itself yields the unspecified value (Unit).
  "for-each"<A>(f: (a: A) => unknown, xs: List<A>): Unit;

  // Count elements satisfying a predicate (bootstrap `count`, forwarded to the
  // sandbox). Pred param bound to the element type; result is a number.
  count<A>(pred: (a: A) => unknown, xs: List<A>): SNum;
}

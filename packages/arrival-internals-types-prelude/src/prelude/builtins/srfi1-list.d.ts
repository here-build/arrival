// ─────────────────────────────────────────────────────────────────────────────
// the SRFI-1-adjacent list family bound in the inference env: `take`,
// `drop`, `concat`, `flatten`, `fold`, `nth`, `for-each`, `count`, `remove`.
//
// NOT typed here, despite SRFI-1-familiar names — unbound in the inference env,
// so typing them would advertise symbols the sampler can select but the
// compiled program can't call:
//   • `head` / `tail` / `rest` / `init`.
//   • the SRFI-1 bootstrap procedures (`take-while` `drop-while` `span`
//     `partition` `find-tail` `fold-right` `concatenate` …) — defined into
//     user_env, but the inference env's own surface does not re-home them.
//
// `remove` is the inverse-filter (drop the elements matching pred) — a
// predicate-filter, NOT an index splice.
//
// The lens models a Scheme list as PRE's `List<T>` = `readonly T[]`. Semantics that
// change the signatures:
//   • take / drop  — COUNT-first, list-LAST: prefix / suffix of length n.
//   • concat       — ⚠️ the LIVE `concat` is the LIPS STRING concat, variadic over
//                    strings → a string. It is NOT list append (`(concat (list 1 2) …)`
//                    throws "Expecting string got pair"). Do NOT type it (List,List)→List.
//   • flatten      — DEEP, fully-recursive flatten; depth unbounded → element type
//                    collapses to `unknown`, but the argument stays pinned to a list.
//   • fold         — the (fn, init, list) order with callback (acc, x) — the Haskell/
//                    Ramda-tradition alias of reduce, NOT SRFI-1 fold's (kons knil list).
//   • nth          — INDEX-first, list-LAST → the element, or the miss value out of range.
//   • for-each     — (fn, list…) for side effects; yields the unspecified value (void).
//   • count        — PRED-first, list-LAST → how many elements satisfy pred (number).
//
// Mis-arg bites (2345); wrong-typing a threaded result bites (2322). Base types
// (`List`/`Pair`/`Nil` + plain `number`/`string`/`boolean`/`void`) come from PRE (../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // Prefix / suffix by count. Count-first, list-last; element type preserved.
  take<T>(n: number, xs: List<T>): List<T>;
  drop<T>(n: number, xs: List<T>): List<T>;

  // ⚠️ STRING concat (LIPS native) — variadic over strings → string. NOT list append.
  concat(...parts: string[]): string;

  // Deep recursive flatten. Depth unbounded → element type collapses to `unknown`;
  // the argument is still pinned to a list so a non-list bites.
  flatten(xs: List<unknown>): List<unknown>;

  // Left fold (fn, init, list) with callback (acc, x). Threads the accumulator type B.
  fold<A, B>(f: (acc: B, x: A) => B, init: B, xs: List<A>): B;

  // Indexed element read. Index-first, list-last; out-of-range is the miss value.
  nth<T>(index: number, xs: List<T>): T | undefined;

  // Side-effecting iteration. Callback param bound to the element type; yields void.
  "for-each"<A>(f: (a: A) => unknown, xs: List<A>): void;

  // Count elements satisfying a predicate. Pred-first, list-last; result is a number.
  count<A>(pred: (a: A) => unknown, xs: List<A>): number;

  // Inverse filter — drop the elements matching pred.
  remove<T>(pred: (x: T) => boolean, xs: List<T>): List<T>;
}

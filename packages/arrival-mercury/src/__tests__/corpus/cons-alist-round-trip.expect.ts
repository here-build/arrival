import type { ExpectedOutcome } from "../../index.js";

/**
 * The alist idiom end to end: CONSTRUCT via `(list (cons 'field v) …)`, then
 * READ via the `:field` keyword accessor (the 2026-07-17 alist-lowering ruling,
 * `keyword-accessor-alist-*` rows) — the two halves landed separately and had
 * never been proven together through actual compilation, since the unconditional
 * spread crashed construction before the accessor ever saw a `cons`-built alist.
 * `e` is `[["guilty", true]]`; both sides walk to the entry whose key is
 * `"guilty"` and return its value, `#t` / `true`.
 */
export const expected: ExpectedOutcome = { value: true };

import type { ExpectedOutcome } from "../../index.js";

/**
 * `cons` with a PROVEN scalar tail — the alist-entry idiom (`list`/real alists'
 * `(cons 'field v)`) that unconditional-spread crashed on: a scalar cdr is not
 * iterable, so `[x, ...xs]` threw "42 is not iterable" at construction. The tail
 * fact gate proves `numeric` here (a literal), so the residual is the clean
 * 2-element pair `[x, xs]` — no spread, no runtime call. `guilty` is a symbol —
 * its JS/membrane face is its interned name, `"guilty"` (§2.1).
 */
export const expected: ExpectedOutcome = { value: ["guilty", 42] };

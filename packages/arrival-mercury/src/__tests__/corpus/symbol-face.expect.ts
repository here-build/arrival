import type { ExpectedOutcome } from "../../index.js";

/**
 * Symbol-face divergence, promoted from a discovery while authoring this corpus
 * (the tier-1 promotion convention): the interpreter egresses a symbol as the
 * apostrophe-prefixed string `"'hello"` (`ASymbol["arrival/toJS"]` — deliberate,
 * "this is a scheme symbol, not a string") while mercury lowers `'hello` to the
 * plain interned name `"hello"` (constitution §2.1's "symbol → interned name").
 * The two representation authorities disagree; until one side is ruled, every
 * symbol-VALUED program diverges — which is why all other rows in this corpus
 * use strings, keeping each cell isolated. Expected pins the interpreter's
 * landed, doc-commented face; the row is `it.fails`-tracked until the
 * reconciliation ruling.
 */
export const expected: ExpectedOutcome = { value: "'hello" };

import type { ExpectedOutcome } from "../../index.js";

/**
 * Symbol egress — ⚖️ RULED 2026-07-14: a quoted symbol's JS face is the PLAIN
 * interned name (constitution §2.1, "symbol → interned name"). The interpreter's
 * former apostrophe prefix ("'hello") died with the ruling (ASymbol arrival/toJS);
 * both worlds now agree by construction. Promoted from KNOWN_RED the same day.
 */
export const expected: ExpectedOutcome = { value: "hello" };

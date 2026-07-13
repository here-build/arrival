import type { ExpectedOutcome } from "../../index.js";

/** Inexact contagion: exact 1 + inexact 2.5 = inexact 3.5 — a plain unconditional JS fold agrees (constitution §7). */
export const expected: ExpectedOutcome = { value: 3.5 };

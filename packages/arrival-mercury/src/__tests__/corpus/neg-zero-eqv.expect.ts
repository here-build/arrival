import type { ExpectedOutcome } from "../../index.js";

/**
 * Runtime-sentinel twin of `nan-eqv`: `(eqv? -0.0 0.0)` is `#f` under the
 * interpreter's `Object.is` semantics (verified; `(eqv? -0.0 -0.0)` is `#t`).
 * A `===` lowering yields `true` (`-0 === 0`).
 */
export const expected: ExpectedOutcome = { value: false };

import type { ExpectedOutcome } from "../../index.js";

/**
 * Positive control for the short-circuit probe: when the branch IS taken, the
 * R7RS `(error …)` raise must surface on both sides as `user-error` — guarding
 * against a probe that silently no-ops. Interpreter face: an `ArrivalError`
 * whose `cause` is the `R7RSError` (message "does-run").
 */
export const expected: ExpectedOutcome = { errorClass: "user-error" };

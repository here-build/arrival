import type { ExpectedOutcome } from "../../index.js";

/**
 * The await-sniff regression row: a string literal containing "await" must
 * NOT trigger the async IIFE wrap (`containsAwaitToken` strips literals).
 * Pre-fix this emitted `await` inside a sync arrow — a SyntaxError at load.
 */
export const expected: ExpectedOutcome = { value: 0 };

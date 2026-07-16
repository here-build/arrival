import type { ExpectedOutcome } from "../../index.js";

/**
 * SURPRISE, verified against the interpreter rather than assumed: bare `some`
 * is NOT SRFI-1's value-returning `any` — srfi-1.ts aliases it to `any?`
 * (`some: symbol.alias\`any?\``), the HONEST boolean quantifier. This row is
 * the discriminating case: the predicate returns a truthy NON-`#t` witness
 * (`2`) for the first list. A value-returning `some` would answer `2`; the
 * real (boolean) `some` answers `#t`/`true`. The second list has no odd
 * element, so `#f`/`false`. See rules/phase1.ts's `some` table row and
 * runtime/stage0.ts's `some` shim for the mirrored implementation.
 */
export const expected: ExpectedOutcome = {
  value: [true, false],
};

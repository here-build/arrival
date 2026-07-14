/**
 * Gate 3 — short-circuit `or`-chain (Law T run-side, `guardedChain`). Three
 * operands, not all provably boolean (`#f` is boolean-typed, `"a"` is
 * stringy) — `lowerAndOr` cannot take the bare `||` shortcut, so it emits the
 * value-returning guarded cascade: one hygienic `fresh` temp per non-last
 * operand, the tail wrapped in an IIFE (a `Block` reaching expression
 * position). The chain nests: the outer guard's ELSE is itself a nested
 * guarded chain over the remaining two operands, so `fresh("or")` mints twice
 * in the SAME JS frame (`__or`, then `__or2` — the second collides and
 * disambiguates, exactly like the walker's own declare-pass ladder).
 * `(error …)` — the never-taken last operand — proves the cascade truly
 * short-circuits: reaching it would throw, and it doesn't.
 *
 * goldenEpoch: 1 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(or #f "a" (error "must-not-run"))`;

export const golden = `import { error } from "./stage0.mts";
function OracleMain() {
    const __or = false;
    return __or !== false ? __or : (() => {
        const __or2 = "a";
        return __or2 !== false ? __or2 : error("must-not-run");
    })();
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

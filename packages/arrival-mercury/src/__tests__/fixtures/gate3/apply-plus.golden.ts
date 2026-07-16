/**
 * Gate 3 — apply patterns, half 1: `(apply + xs)` → a `reduce` with the correct
 * additive identity (constitution §6's preserved-knowledge row; `applyRule`'s
 * `FOLD_OPS` table). Structural recognition over the ALREADY-LOWERED operand —
 * `+` in value position is `RuntimeRef("+")` before this rule ever runs (Law A:
 * the rule reads the lowered value in hand, never the source syntax).
 *
 * goldenEpoch: 3 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(apply + (list 1 2 3))`;

export const golden = `function OracleMain() {
    return [1, 2, 3].reduce((__acc, __item) => __acc + __item, 0);
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

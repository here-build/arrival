/**
 * Gate 3 — LEGIBILITY's implicit-destruction leg (constitution §3.5's third
 * invention, the constitution's OWN worked example). A callback parameter used
 * ONLY through car/cdr-composed positional access destructures to a
 * positionally-named tuple pattern:
 *
 *   (lambda (pair) (+ (car pair) (car (cdr pair))))
 *     → ([first, second]) => first + second
 *
 * The constitution spells the second access `(cadr pair)` — semantically
 * identical to `(car (cdr pair))`, the spelling this fixture's `source` still
 * uses (unchanged, no golden-churn reason to touch it): `cadr` itself is now a
 * bound registry symbol too (`rules/phase1.ts`'s `compoundCxrRules`, landed
 * after this fixture), but `destructure.ts`'s `cdrOffsetOf` already resolved
 * either spelling to the same tuple position, so re-spelling the source here
 * would exercise the identical destructuring path, not a new one.
 *
 * goldenEpoch: 3 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(map (lambda (pair) (+ (car pair) (car (cdr pair)))) (list (list 1 2) (list 3 4)))`;

export const golden = `function OracleMain() {
    return [[1, 2], [3, 4]].map(([first, second]) => first + second);
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

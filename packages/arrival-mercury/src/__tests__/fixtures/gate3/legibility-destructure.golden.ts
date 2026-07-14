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
 * identical to `(car (cdr pair))`, which is the form THIS slice's registered
 * rules actually produce (`cadr` itself is not yet a bound registry symbol —
 * registry/harvest.ts's own comment: the generative cxr composition rung is
 * future work); `destructure.ts`'s `cdrOffsetOf` resolves either spelling to
 * the same tuple position.
 *
 * goldenEpoch: 1 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(map (lambda (pair) (+ (car pair) (car (cdr pair)))) (list (list 1 2) (list 3 4)))`;

export const golden = `import { list } from "./stage0.mts";
function OracleMain() {
    return list(list(1, 2), list(3, 4)).map(([first, second]) => first + second);
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

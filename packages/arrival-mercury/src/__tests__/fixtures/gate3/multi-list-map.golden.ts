/**
 * Gate 3 — multi-list map (the arity bridge's zip case). Two lists drive
 * `mapRule`'s index-zip arrow (constitution §4.3/§6): `Method(lists[0], "map",
 * [Arrow([item, i], Call(f, [item, ...rest.map(l => Index(l, i))]))])`. `+` in
 * value position resolves through the stage-0 shim (`plus`, a variadic fold —
 * call position never reaches it, the `+` emit rule folds inline instead).
 *
 * goldenEpoch: 3 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(map + (list 1 2 3) (list 10 20 30))`;

export const golden = `import { plus } from "./stage0.mts";
function OracleMain() {
    return [1, 2, 3].map((__item, __i) => plus(__item, [10, 20, 30][__i]));
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

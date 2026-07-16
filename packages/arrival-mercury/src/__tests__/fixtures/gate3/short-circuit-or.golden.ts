/**
 * Gate 3 — short-circuit `or`-chain, now demonstrating STATIC PREVALUATION
 * (gate3-human-grade-rulings.md R-G6 — "its whole point becomes
 * demonstrating the fold"). Three operands: `#f` (provably false — inert,
 * dropped from the chain), `"a"` (provably true — Scheme truthiness, a
 * non-empty string is never `#f`, so it SHORT-CIRCUITS the whole `or`), and
 * `(error "must-not-run")` (strictly after the short-circuit point — dead,
 * unreachable, dropped whole). `prevalueDecisionAt` (`../../prevalue/
 * index.ts`) folds the entire three-operand chain down to the single
 * surviving value in one step; there is no runtime guard left to emit at
 * all — no `!== false` cascade, no hygienic `fresh` temp, no IIFE, no
 * `error` import. Before this landing, the guarded cascade below was the
 * ONLY way this shape could compile (three operands, not all provably
 * `boolean`-typed, so `lowerAndOr` had no bare-`||` shortcut either):
 *
 *   import { error } from "./stage0.mts";
 *   function OracleMain() {
 *       const __or = false;
 *       return __or !== false ? __or : (() => {
 *           const __or2 = "a";
 *           return __or2 !== false ? __or2 : error("must-not-run");
 *       })();
 *   }
 *
 * `(error …)` still proves the fold is honest, not just lucky: it is the
 * dead operand the fold must eliminate, not merely a value that happens
 * never to run at runtime.
 *
 * goldenEpoch: 5 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(or #f "a" (error "must-not-run"))`;

export const golden = `function OracleMain() {
    return "a";
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

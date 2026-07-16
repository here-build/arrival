/**
 * Gate 3 — first-class `car` in HOF position (constitution §4.1's `refPolicy`
 * open question). `car`'s Phase-1 row declares `refPolicy: "eta"`, and its rule
 * (`rules/phase1.ts`'s `carRule`) now carries a `.ref` method: the walker's
 * value-position ladder (`registryValueRef`) takes `rule.ref(...)` whenever it's
 * defined, ahead of the rung-3 `RuntimeRef` shim.
 *
 * ⚠ LANDED THIS EPOCH (R5c, goldenEpoch 2 — see ../gate3/REBASE_LOG.md): this is
 * the WATCHED flip goldenEpoch 1's own note predicted — `car`'s row grew a `.ref`
 * that reads `ctx.selfFacts?.callable` (the instantiated use-site signature;
 * typefacts/extract.ts's `probeCallable` was already wired for exactly this shape
 * — "Value-position probe — single-occurrence Refs in argument position" — the
 * once-unverified extraction assumption, now proven live). `xss.map(car)` eta-
 * expands to an inlined arrow; LEGIBILITY's destructuring + element-name
 * singularization passes (already wired, unmodified by this landing) then turn
 * the raw `(x) => x[0]` the `.ref` itself builds into the more idiomatic
 * `([head]) => head` below — an emergent interaction with existing passes, not
 * something `car`'s `.ref` constructs by hand. `car` no longer appears in the
 * import line at all: FRAME's import-as-query only imports symbols some
 * `RuntimeRef` in the finished tree still references, and eta replaced that
 * reference with an inlined arrow.
 *
 * `cdr` is the natural, structurally identical follow-up — deliberately NOT done
 * this wave (no golden names it yet; R5c lands exactly the case that's pinned).
 *
 * `car`'s stage-0 value-position shim (`src/runtime/stage0.ts`, added at
 * goldenEpoch 1 for the pre-eta shimmed form) is now DEAD for this specific
 * source (eta no longer routes through it) but stays — `(map car declared-any)`
 * or any other no-proof call site still needs the shim, and removing an
 * still-reachable stage-0 export is a separate, unrelated cleanup.
 *
 * goldenEpoch: 3 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(let ((xss (list (list 1 2) (list 3 4))))
  (map car xss))`;

export const golden = `function OracleMain() {
    const xss = [[1, 2], [3, 4]];
    return xss.map(([head]) => head);
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

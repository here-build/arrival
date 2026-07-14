/**
 * Gate 3 — first-class `car` in HOF position (constitution §4.1's `refPolicy`
 * open question). `car`'s Phase-1 row declares `refPolicy: "eta"`, but the
 * walker's value-position ladder (`registryValueRef`) only takes the eta path
 * when the row's `EmitRule` itself defines a `.ref` method — `carRule` defines
 * only `.call` (the call-position `Index(xs, 0)` fold), so TODAY eta degrades
 * to the rung-3 `RuntimeRef` shim (walker's own module header: "SKIPPED this
 * wave, degrades to shim — the instantiated-signature facts it needs haven't
 * landed"). This golden pins EXACTLY that: `xss.map(car)`, a plain shimmed
 * reference, not an inlined `xss.map((x) => x[0])`.
 *
 * ⚠ UPGRADE MARKER: when `car`'s row grows a `.ref` that reads
 * `ctx.selfFacts?.callable` (the instantiated use-site signature — the
 * "instantiated-signature evidence" this golden's own mission note defers to
 * typefacts' tests), `xss.map(car)` should become an eta-expanded arrow and
 * THIS FILE must be re-baselined via the ../gate3/REBASE_LOG.md discipline —
 * the flip is the whole point of landing that facility, never a silent drift.
 *
 * `car`'s stage-0 value-position shim (`src/runtime/stage0.ts`) was added
 * alongside this golden — it did not exist before (call position never needed
 * it; only a bare HOF reference does), and FRAME doors without it.
 *
 * goldenEpoch: 1 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(let ((xss (list (list 1 2) (list 3 4))))
  (map car xss))`;

export const golden = `import { car, list } from "./stage0.mts";
function OracleMain() {
    const xss = list(list(1, 2), list(3, 4));
    return xss.map(car);
}
export { __oracleResult };
const __oracleResult = OracleMain();
`;

/**
 * Gate 3 — async-map → `Promise.all` (Law W's ASYNC-IFY rewrite table, the
 * `.map` collapse). `infer` is an ASYNC-IFY seed (`inferAsyncSeeds`), so the
 * lambda callback's body — `(infer "fast" x)` — fixpoints to async, which makes
 * `callType` of the callback `"promise"`; the rewrite table then collapses the
 * WHOLE `.map` call to `Promise.all(xs.map(...))` at the node (constitution
 * §5.2 Law W) rather than at each element.
 *
 * R-G3 (gate3-human-grade-rulings.md) tail-await elision, goldenEpoch 4: BOTH
 * the callback (`async (x) => await infer(...)` → `x => infer(...)`) and the
 * outer `Promise.all(...)` call (`return await Promise.all(...)` →
 * `return Promise.all(...)`) sit at bare tail-return positions with nothing
 * downstream observing the resolved value — neither needs `async`/`await` at
 * all; the promise is returned either way. `OracleMain` itself drops to a
 * plain (non-async) function for the same reason — its own body is now
 * nothing but that one tail return. This is R-G3's own worked target
 * example, verbatim.
 *
 * `infer`'s stage-0 shim (`src/runtime/stage0.ts`) is an honest placeholder —
 * throws rather than answering, since the framework axis (vercel/langchain) is
 * deferred past Phase 1 (phase1.ts's own `TODO(config.framework)`); it exists
 * only so this async-seeded shape can compile and render end to end. This
 * golden pins the REWRITE SHAPE, not a real inference result.
 *
 * goldenEpoch: 4 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(map (lambda (x) (infer "fast" x)) (list "a" "b"))`;

export const golden = `import { infer } from "./stage0.mts";
function OracleMain() {
    return Promise.all(["a", "b"].map(x => infer("fast", x)));
}
export { __oracleResult };
const __oracleResult = await OracleMain();
`;

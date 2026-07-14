/**
 * Gate 3 — async-map → `Promise.all` (Law W's ASYNC-IFY rewrite table, the
 * `.map` collapse). `infer` is an ASYNC-IFY seed (`inferAsyncSeeds`), so the
 * lambda callback's body — `(infer "fast" x)` — fixpoints to async, which makes
 * `callType` of the callback `"promise"`; the rewrite table then collapses the
 * WHOLE `.map` call to `await Promise.all(xs.map(async (x) => await infer(...)))`
 * at the node (constitution §5.2 Law W) rather than at each element.
 *
 * `infer`'s stage-0 shim (`src/runtime/stage0.ts`) is an honest placeholder —
 * throws rather than answering, since the framework axis (vercel/langchain) is
 * deferred past Phase 1 (phase1.ts's own `TODO(config.framework)`); it exists
 * only so this async-seeded shape can compile and render end to end. This
 * golden pins the REWRITE SHAPE, not a real inference result.
 *
 * goldenEpoch: 1 — see ../gate3/REBASE_LOG.md before touching `golden` below.
 */
export const source = `(map (lambda (x) (infer "fast" x)) (list "a" "b"))`;

export const golden = `import { infer, list } from "./stage0.mts";
async function OracleMain() {
    return await Promise.all(list("a", "b").map(async (x) => await infer("fast", x)));
}
export { __oracleResult };
const __oracleResult = await OracleMain();
`;

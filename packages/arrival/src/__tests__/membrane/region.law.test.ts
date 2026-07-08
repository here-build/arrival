/**
 * LAW F5 — region discipline for re-entrant crossings (P6).
 *
 * Written BEFORE its code: these are the acceptance tests for the
 * reverse-membrane migration (docs/working-proposals/
 * reverse-membrane-for-callables.md §7c). Every row is it.todo gated on that
 * landing; the migration is done when this file's todos become green tests.
 *
 * B3 landed §7c's reverse wrapper (`schemeToJs`'s ACallable branch in
 * rosetta.ts, `z.procedure().decode` in scheme-zod.ts) — see
 * `src/values/primitives/region-scope.ts` for the scope token + doors this
 * file exercises. Row 8 stays `it.todo`: its own title tags it
 * `[STAGED: post-migration]` — a NAMED persistent-handler capability granting
 * a detached scope is explicitly future work, not part of the reverse-wrapper
 * landing these other seven rows gate.
 */
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod.js";
import { schemeToJs } from "../../rosetta.js";
import { ANativeProcedure } from "../../values/primitives/ACallable.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../../values/primitives/region-scope.js";
import { CONSTANT_CTX, makeRunContext } from "../../values/primitives/RunContext.js";
import type { SchemeValue } from "../../values/types.js";
import { execState } from "../../eval/generator-exec.js";
import { EvalTrace, type Invocation } from "../../provenance/trace.js";
import { inferenceEnv } from "../../inference-env.js";

/** A trivial one-arg echo callable — enough surface for the door/identity/
 *  abort rows, which don't care what the callable actually computes. */
function makeEcho(): ANativeProcedure {
  return new ANativeProcedure({
    name: "echo",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: (args) => args[0],
  });
}

/** A callable whose impl never settles — lets the abort row prove the
 *  SIGNAL wins the race, not the underlying call completing on its own. */
function makeHangingProc(): ANativeProcedure {
  return new ANativeProcedure({
    name: "hang",
    arity: { min: 0, max: 0 },
    contract: undefined,
    impl: () => new Promise<never>(() => {}),
  });
}

describe("a reverse lambda is region-bound to its invocation", () => {
  it("calling the wrapper AFTER the symbol returned throws the escape door (educational, names the capability path)", async () => {
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => schemeToJs(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    closeRegionScope(scope); // simulates the exporting symbol invocation returning
    await expect(wrapper(1)).rejects.toThrow(/region-bound to the calling symbol/);
    // The door also names what to do instead — a real capability, not a relaxation.
    await expect(wrapper(1)).rejects.toThrow(/explicit capability/);
  });

  it("the symbol returning while wrapper calls are IN FLIGHT throws (pending > 0 at settle)", async () => {
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => schemeToJs(makeEcho()) as (...a: unknown[]) => Promise<unknown>);
    // `wrapper(1)` runs synchronously up to its first await (`withRegionCall`'s own
    // `pending++` fires before any `await`), so `scope.pending` is already 1 the
    // instant this call returns — no need to await it first.
    const call = wrapper(1);
    expect(scope.pending).toBe(1);
    expect(() => closeRegionScope(scope)).toThrow(/1 reverse-lambda call incomplete/);
    expect(scope.open).toBe(false); // rule 1 still applies even though the throw is rule 2's
    await call; // let the in-flight call settle so nothing lingers as an unhandled rejection
  });

  it("run abort cancels in-flight re-entries via the scope's derived signal", async () => {
    const controller = new AbortController();
    const runCtx = makeRunContext({ signal: controller.signal });
    const scope = openRegionScope({ runCtx, dynSite: undefined });
    const wrapper = withRegionScope(
      scope,
      () => schemeToJs(makeHangingProc()) as (...a: unknown[]) => Promise<unknown>,
    );
    const call = wrapper();
    controller.abort(new Error("region-law abort probe"));
    await expect(call).rejects.toThrow("region-law abort probe");
  });

  it("wrapper identity is per-(callable, scope): same lambda, same invocation → ===; new invocation → new wrapper", () => {
    const echo = makeEcho();
    const scopeA = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const w1 = withRegionScope(scopeA, () => schemeToJs(echo));
    const w2 = withRegionScope(scopeA, () => schemeToJs(echo));
    expect(w1).toBe(w2); // same callable, same scope → same wrapper

    const scopeB = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const w3 = withRegionScope(scopeB, () => schemeToJs(echo));
    expect(w3).not.toBe(w1); // same callable, DIFFERENT scope → a fresh wrapper
  });

  it("each re-entry opens a child trace scope of the enclosing invocation — lineage nests, never attributes flat to the run root", async () => {
    const trace = new EvalTrace();
    let capturedInv: Invocation | undefined;
    let capturedWrapper: ((...a: unknown[]) => Promise<unknown>) | undefined;

    let before = 0;
    let result: unknown;
    const env = inferenceEnv.inherit("region-law-trace-nesting");
    env.defineRosetta("region-law-capture", {
      // `this.ctx.currentInvocation` is createRosettaWrapper's own receiver shape
      // (rosetta.ts:`fn.apply({ ctx: { runCtx, currentInvocation, argProvenance } }, …)`)
      // — the SAME invocation the region scope opened against (`scope.dynSite`).
      // Calling the wrapper HERE, inside `fn`, awaited before `fn` itself returns,
      // keeps the re-entry INSIDE the exporting invocation's open scope window —
      // the region-bound contract this row is testing, not a post-return escape
      // (that's row 1's job).
      async fn(this: { ctx: { currentInvocation?: unknown } }, lambdaWrapper: unknown) {
        capturedInv = this.ctx.currentInvocation as Invocation | undefined;
        capturedWrapper = lambdaWrapper as (...a: unknown[]) => Promise<unknown>;
        before = trace.invocationLog.length;
        result = await capturedWrapper(41);
        return null;
      },
    });

    await execState("(region-law-capture (lambda (x) (+ x 1)))", { env, tap: trace });
    expect(capturedInv).toBeDefined();
    expect(capturedWrapper).toBeDefined();
    expect(result).toBe(42); // sanity: the re-entry actually ran the lambda body

    const newInvocations = trace.invocationLog.slice(before);
    expect(newInvocations.length).toBeGreaterThan(0);
    // At least one invocation minted DURING the re-entry walks back (via `.parent`)
    // to the invocation that exported the wrapper — nesting, not a flat run-root
    // attribution.
    const nestsUnderCapture = newInvocations.some((inv) => {
      for (let p: Invocation | null = inv; p; p = p.parent) if (p === capturedInv) return true;
      return false;
    });
    expect(nestsUnderCapture).toBe(true);
  });

  it("re-entry args mint under the enclosing invocation's runCtx, never CONSTANT_CTX", async () => {
    let capturedArgs: SchemeValue[] = [];
    const capture = new ANativeProcedure({
      name: "capture-args",
      arity: { min: 1, max: 1 },
      contract: undefined,
      impl: (args) => {
        capturedArgs = args;
        return args[0];
      },
    });
    const runCtx = makeRunContext({ strict: true }); // distinguishable from CONSTANT_CTX (strict: false)
    const scope = openRegionScope({ runCtx, dynSite: undefined });
    const wrapper = withRegionScope(scope, () => schemeToJs(capture) as (...a: unknown[]) => Promise<unknown>);

    await wrapper(42);
    expect(capturedArgs).toHaveLength(1);
    expect((capturedArgs[0] as { ctx: unknown }).ctx).toBe(runCtx);
    expect((capturedArgs[0] as { ctx: unknown }).ctx).not.toBe(CONSTANT_CTX);
  });

  it("z.procedure decode adopts the same scope token — one discipline, typed and untyped paths", async () => {
    const echo = makeEcho();
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const untyped = withRegionScope(scope, () => schemeToJs(echo));
    const typed = withRegionScope(scope, () => z.procedure().parse(echo));
    // Same (callable, scope) → the SAME cache entry, regardless of which door minted it.
    expect(typed).toBe(untyped);

    closeRegionScope(scope);
    await expect((typed as (...a: unknown[]) => Promise<unknown>)(1)).rejects.toThrow(
      /region-bound to the calling symbol/,
    );
  });

  it.todo(
    "a persistent handler is a NAMED capability with a detached scope, not a relaxation [STAGED: post-migration]",
  );
});

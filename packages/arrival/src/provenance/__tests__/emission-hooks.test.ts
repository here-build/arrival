/**
 * emission-hooks.test.ts — Q11a's INTEGRATION exercise of the evaluator-side hook
 * (docs/PROVENANCE.md §7 W3 port completeness; `eval/provenance-hooks.ts`, `eval/evaluator.ts`'s
 * generic apply site). Where `provenance/store/__tests__/emit.test.ts` drives the
 * emission core directly, this file drives it through a REAL interpreted program —
 * a rosetta-registered source, run under a tap (`EvalTrace`, exactly the
 * mechanism `membrane/region.law.test.ts` and `w1-harness.ts` already use), with a
 * `RunEmission` (store ports + region + coordinate) carried by the run's `RunContext`.
 *
 * The two things this file exists to prove that the direct unit suite cannot:
 *   1. the hook actually reads `ctx.currentInvocation.isProvenancePoint` correctly
 *      off a REAL rosetta call crossing evaluator.ts's generic apply — not a
 *      hand-built `RecordId`/payload;
 *   2. "sunset byte-identical when off" is true of the REAL program result, not just
 *      "the emit* functions no-op in isolation" — the SAME program, same env, same
 *      inputs, produces an identical `toJS` result whether the run carries `emission` or
 *      not (the sidecar is provably inert on the primary execution path).
 */
import type { CallCtx } from "../../run/CallCtx.js";
import { describe, expect, it } from "vitest";
import { type ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { EvalTrace } from "../../provenance/trace.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { toJS } from "../../membrane/rosetta.js";
import type { RecordCoordinate } from "../../eval/provenance-hooks.js";
import type { RunEmission } from "../../run/RunContext.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";

const COORD: RecordCoordinate = { templateHash: "th-source", ordinalPath: [0], regionEpoch: "e0" };
const REGION = "region-emission-hooks";

/** One rosetta source, mirroring `w1-harness.ts`'s `SourceRegistry.register("num")`
 *  shape (a fresh env, a plain synchronous numeric return — baked `symbol.rosetta`
 *  wraps it into the async `mintsPoint` path regardless of the impl's own sync body).
 *  Test-local `EnvCapability`; a plain `z.number` output, same as
 *  `silent-region.test.ts`'s sibling. */
async function registerSource(env: ResolvingAmbient): Promise<void> {
  await applyCapability(env, [
    EnvCapability.define("test/fetch-item", {
      symbols: (symbol, z) => ({
        "fetch-item": symbol.rosetta`fetch-item: a zero-arg numeric source`(
          { input: [], output: [z.number] },
          function (this: CallCtx) {
            return 42;
          },
        ),
      }),
    }),
  ]);
}

describe("the real port site: a rosetta crossing through evaluator.ts's generic apply", () => {
  it("run with `emission`: exactly one MintRecord lands, payload = the rosetta's return value", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const emission: RunEmission = { store, payloads, regionId: REGION, coordinate: COORD };
    const trace = new EvalTrace();
    const env = inferenceEnv.child("emission-hooks-on");
    await registerSource(env);

    const result = await execState("(fetch-item)", { env, tap: trace, emission });
    expect(toJS(result.values[0])).toBe(42);

    // Emission is DETACHED (fire-and-forget off the settled Promise) — give its
    // microtask a turn before asserting the store's contents.
    await Promise.resolve();
    await Promise.resolve();

    const stream = await store.readStream(REGION);
    const mints = stream.filter((r) => r.kind === "mint");
    expect(mints).toHaveLength(1);
    const payload = await payloads.get(mints[0].payloadHash);
    expect(payload.value).toBe(42);
  });

  it("`silent` run: the same program produces the SAME result, and NOTHING lands in the store — byte-identical", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const emission: RunEmission = { store, payloads, regionId: REGION, coordinate: COORD };
    const trace = new EvalTrace();
    const env = inferenceEnv.child("emission-hooks-off");
    await registerSource(env);

    const result = await execState("(fetch-item)", { env, tap: trace, emission, silent: true });
    expect(toJS(result.values[0])).toBe(42);

    await Promise.resolve();
    await Promise.resolve();

    expect(await store.readStream(REGION)).toHaveLength(0);
  });

  it("NO emission on the run (today's default production shape): no-ops, same result", async () => {
    const trace = new EvalTrace();
    const env = inferenceEnv.child("emission-hooks-no-coordinate");
    await registerSource(env);

    // No `emission` option — facility off, exactly what an ordinary call looks like.
    const result = await execState("(fetch-item)", { env, tap: trace });
    expect(toJS(result.values[0])).toBe(42);
    // No assertion is possible against "the store" here — there IS no sink; the point
    // of this row is that the run completes identically without one, i.e. the hook's
    // `emission === undefined` early return is exercised on a
    // REAL call, not just reasoned about.
  });

  it("a non-rosetta call (a plain native procedure) never mints, even with an emission target", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const emission: RunEmission = { store, payloads, regionId: REGION, coordinate: COORD };
    const trace = new EvalTrace();
    const env = inferenceEnv.child("emission-hooks-non-rosetta");

    const result = await execState("(+ 1 2)", { env, tap: trace, emission });
    expect(toJS(result.values[0])).toBe(3);

    await Promise.resolve();
    await Promise.resolve();

    expect(await store.readStream(REGION)).toHaveLength(0);
  });

  it("three port mints of one run store THREE distinct records (RecordId carries the per-crossing ordinal)", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const emission: RunEmission = { store, payloads, regionId: REGION, coordinate: COORD };
    const trace = new EvalTrace();
    const env = inferenceEnv.child("emission-hooks-three");
    await registerSource(env);

    await execState("(list (fetch-item) (fetch-item) (fetch-item))", { env, tap: trace, emission });
    await Promise.resolve();
    await Promise.resolve();

    const mints = (await store.readStream(REGION)).filter((r) => r.kind === "mint");
    expect(mints).toHaveLength(3);
    expect(new Set(mints.map((m) => m.id.ordinalPath.join("."))).size).toBe(3);
    for (const m of mints) expect(m.id.ordinalPath.slice(0, COORD.ordinalPath.length)).toEqual(COORD.ordinalPath);
  });
});

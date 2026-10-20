/**
 * Emission overhead on hot paths, measured in-step against the §7 "port
 * completeness" law's real call sites — budget ~µs/record.
 *
 * Three honest layers, same shape as `exec-seam.bench.test.ts`'s own three-layer split:
 *
 *   1. no emission — `notePotentialRosettaExit` called N times on a run with no
 *                   `RunContext.emission`: the byte-identical cost, i.e. what every
 *                   real call site pays TODAY (one field read per generic apply).
 *   2. emitting   — `emitMint` called N times against `ProvenanceStoreFake`/
 *                   `PayloadStoreFake`: hash + payload put + seq allocation + append,
 *                   the full per-record cost once a run's emission target IS set.
 *   3. the other three kinds — `emitMuxDecision`/`emitFanInstantiation`/
 *                   `emitIngressBinding` (no payload hashing/put — cheaper than a mint
 *                   by construction: per §4's record-kinds table, these three kinds
 *                   carry no payload of their own).
 *
 * No cloud/DO/R2 involved — the fakes are in-memory `Map`s (per store/fakes.ts's own
 * header: "DETERMINISTIC BY CONSTRUCTION... default CI, no cloud"), so these numbers
 * are a LOWER BOUND on real DO-storage latency, not an upper one; they measure the
 * emission CORE's own overhead.
 */
import { describe, it, expect } from "vitest";
import { emitFanInstantiation, emitIngressBinding, emitMint, emitMuxDecision } from "../provenance/store/emit.js";
import { notePotentialRosettaExit } from "../eval/provenance-hooks.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../provenance/store/fakes.js";
import type { RecordId } from "../provenance/store/ids.js";
import { execStateOverFrame } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import type { EnvWithInternals, ResolvingAmbient } from "../env/AmbientRuntime.js";
import { CONSTANT_CTX, RunContext } from "../run/RunContext.js";
import { withInputProvenance } from "../values/op-helpers.js";
import { jsToScheme } from "../membrane/rosetta.js";
// In-package bench: the module-internal storage write (hermetic-Environment ruling — no public set).

const REGION = "bench-region";
const ITERATIONS = 5000;

function report(label: string, iterations: number, elapsedMs: number): void {
  const usPerRecord = (elapsedMs / iterations) * 1000;
  console.log(
    `${label}: ${iterations} calls in ${elapsedMs.toFixed(2)}ms ` +
      `(${((iterations / elapsedMs) * 1000).toFixed(0)} ops/sec, ${usPerRecord.toFixed(2)}µs/record)`,
  );
}

function idAt(i: number): RecordId {
  return { templateHash: `t-${i}`, ordinalPath: [i], regionEpoch: "e0" };
}

describe("emission overhead — no emission on the run (the byte-identical/sunset cost)", () => {
  it(`layer 1 — notePotentialRosettaExit × ${ITERATIONS}, no emission: the cost every real call site pays today`, () => {
    const runCtx = new RunContext();
    const value = jsToScheme(CONSTANT_CTX, 1);
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) notePotentialRosettaExit(runCtx, { id: i, isProvenancePoint: true }, value);
    report("notePotentialRosettaExit (no emission)", ITERATIONS, performance.now() - start);
    expect(runCtx.emission).toBeUndefined();
  });
});

describe("emission overhead — emitting (real store/payload work per record)", () => {
  it(`layer 2 — emitMint × ${ITERATIONS}: hash + payload put + seq alloc + append`, async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const record = await emitMint({
        store,
        payloads,
        regionId: REGION,
        id: idAt(i),
        value: { i, note: "a small mint payload" },
        stampIds: [i, i + 1],
      });
      expect(record).toBeDefined();
    }
    report("emitMint", ITERATIONS, performance.now() - start);
    expect(await store.readStream(REGION)).toHaveLength(ITERATIONS);
  });

  // eslint-disable-next-line sonarjs/assertions-in-tests -- benchmark: records timings, asserts nothing by design
  it(`layer 3 — the payload-free kinds × ${ITERATIONS} each: mux-decision / fan-instantiation / ingress-binding`, async () => {
    const store = new ProvenanceStoreFake();

    const muxStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) await emitMuxDecision({ store, regionId: REGION, id: idAt(i), arm: i % 2 });
    report("emitMuxDecision", ITERATIONS, performance.now() - muxStart);

    const fanStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++)
      await emitFanInstantiation({
        store,
        regionId: REGION,
        id: { templateHash: `fan-${i}`, ordinalPath: [i], regionEpoch: "e0" },
      });
    report("emitFanInstantiation", ITERATIONS, performance.now() - fanStart);

    const ingressStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++)
      await emitIngressBinding({
        store,
        regionId: REGION,
        id: { templateHash: `ingress-${i}`, ordinalPath: [i], regionEpoch: "e0" },
      });
    report("emitIngressBinding", ITERATIONS, performance.now() - ingressStart);
  });
});

/**
 * The eager-stamp oracle's own overhead (docs/PROVENANCE.md §4: "the eager stamp
 * path is a TEST-ONLY oracle"), distinct from the record-EMISSION layers above:
 * this measures op-helpers.ts's per-op ACCUMULATION cost (the filter + union-set
 * allocation `withInputProvenance`/`nativeNumericOp`'s `applyNumeric` skip when the
 * oracle is inactive) on a real interpreter run — the hot path the production
 * default-OFF setting targets, exercised through arithmetic (the highest-traffic op
 * family) and string-append (a genuine multi-arg union).
 */
describe("Q20b — eager-oracle accumulation overhead: default-OFF vs forced-ON exec throughput", () => {
  const EXEC_ITERATIONS = 2000;
  const WARMUP_ITERATIONS = 500;

  async function runExecLoop(iterations: number, eagerStamps: boolean): Promise<number> {
    const env = inferenceEnv.child(
      // eslint-disable-next-line sonarjs/pseudo-random -- unique-name nonce for test isolation, not security-sensitive
      `q20b-bench-${Math.random().toString(36).slice(2)}`,
    ) as EnvWithInternals<ResolvingAmbient>;
    env.bind("a", jsToScheme(CONSTANT_CTX, 10, {}, new Set([100])));
    env.bind("b", jsToScheme(CONSTANT_CTX, 20, {}, new Set([200])));
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await execStateOverFrame(`(string-append "sum=" (number->string (+ a (* b 2) ${i})))`, { env, eagerStamps });
    }
    return performance.now() - start;
  }

  // exec() itself (parse + generator-driven eval) dwarfs op-helpers.ts's own
  // filter+union cost on a 1-2-operand array — an UN-warmed-up single pass mostly
  // measures V8 JIT warmup order, not the flag: whichever variant runs SECOND
  // in-process comes out ~40% faster regardless of which flag value it used. Warm
  // BOTH variants (discarded) before measuring EITHER, so the recorded numbers
  // isolate the accumulation delta instead of this cold-start artifact.
  // eslint-disable-next-line sonarjs/assertions-in-tests -- benchmark: records timings, asserts nothing by design
  it(`exec × ${EXEC_ITERATIONS}, oracle OFF (Q20b production default) vs FORCED ON (CI agreement oracle), both JIT-warmed first`, async () => {
    await runExecLoop(WARMUP_ITERATIONS, false);
    await runExecLoop(WARMUP_ITERATIONS, true);

    const offElapsed = await runExecLoop(EXEC_ITERATIONS, false);
    report("exec, arithmetic+string-append (oracle OFF, Q20b default)", EXEC_ITERATIONS, offElapsed);

    const onElapsed = await runExecLoop(EXEC_ITERATIONS, true);
    report("exec, arithmetic+string-append (oracle ON, CI agreement mode)", EXEC_ITERATIONS, onElapsed);

    const deltaPct = ((onElapsed - offElapsed) / onElapsed) * 100;
    console.log(
      `Q20b demotion delta: OFF is ${deltaPct.toFixed(1)}% faster than ON (${((offElapsed / EXEC_ITERATIONS) * 1000).toFixed(2)}µs vs ${((onElapsed / EXEC_ITERATIONS) * 1000).toFixed(2)}µs per exec() call)`,
    );
  });

  // The above, isolated: parse+eval overhead per exec() call (~265µs) dwarfs
  // op-helpers.ts's own filter+union cost on a 1-2-operand array, so the
  // whole-exec() delta is noise (±2%). This row measures the ISOLATED
  // accumulation cost directly against `withInputProvenance`/`mintVerdict` — the
  // shape of arrival-sampler's actual hot loop (~513 interpreter calls per
  // decode-step, no re-parse per call), where the saving is NOT amortized
  // against parse overhead.
  // eslint-disable-next-line sonarjs/assertions-in-tests -- benchmark: records timings, asserts nothing by design
  it(`withInputProvenance × ${EXEC_ITERATIONS * 10} direct calls, oracle OFF vs FORCED ON (the sampler's actual hot-loop shape)`, () => {
    const DIRECT_ITERATIONS = EXEC_ITERATIONS * 10;
    const a = jsToScheme(CONSTANT_CTX, 10, {}, new Set([100]));
    const b = jsToScheme(CONSTANT_CTX, 20, {}, new Set([200]));

    const OFF = new RunContext({});
    const ON = new RunContext({ eagerStamps: true });
    const runDirectLoop = (runCtx: RunContext, iterations: number): number => {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) withInputProvenance(runCtx, [a, b], i);
      return performance.now() - start;
    };

    runDirectLoop(OFF, DIRECT_ITERATIONS); // warmup
    runDirectLoop(ON, DIRECT_ITERATIONS); // warmup

    const offElapsed = runDirectLoop(OFF, DIRECT_ITERATIONS);
    report("withInputProvenance direct (oracle OFF, Q20b default)", DIRECT_ITERATIONS, offElapsed);

    const onElapsed = runDirectLoop(ON, DIRECT_ITERATIONS);
    report("withInputProvenance direct (oracle ON, CI agreement mode)", DIRECT_ITERATIONS, onElapsed);

    const deltaPct = ((onElapsed - offElapsed) / onElapsed) * 100;
    console.log(`Q20b demotion delta (isolated, sampler-shaped): OFF is ${deltaPct.toFixed(1)}% faster than ON`);
  });
});

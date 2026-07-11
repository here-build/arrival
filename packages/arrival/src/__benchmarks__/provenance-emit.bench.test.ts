/**
 * provenance-emit.bench.test.ts — Q11a's own overhead measurement (docs/PROVENANCE-PLAN.md
 * Q11a: "Risk: emission overhead on hot paths — measure in-step, budget ~µs/record").
 *
 * Three honest layers, same shape as `exec-seam.bench.test.ts`'s own three-layer split:
 *
 *   1. flag OFF   — `emitMint` called N times while disabled: the "sunset byte-identical"
 *                   cost, i.e. what every real call site pays TODAY (nothing wires a
 *                   coordinate/sink in production yet, so this is also the current
 *                   steady-state cost of the `notePotentialRosettaExit` hook itself).
 *   2. flag ON    — `emitMint` called N times against `ProvenanceStoreFake`/
 *                   `PayloadStoreFake`: hash + payload put + seq allocation + append,
 *                   the full per-record cost once a coordinate/sink IS installed.
 *   3. the other three kinds ON — `emitMuxDecision`/`emitFanInstantiation`/
 *                   `emitIngressBinding` (no payload hashing/put — cheaper than a mint
 *                   by construction, §5 A6: "no payload of its own").
 *
 * No cloud/DO/R2 involved — the fakes are in-memory `Map`s (per store/fakes.ts's own
 * header: "DETERMINISTIC BY CONSTRUCTION... default CI, no cloud"), so these numbers
 * are a LOWER BOUND on real DO-storage latency, not an upper one; they measure the
 * emission CORE's own overhead, which is what this node's risk note is about.
 */
import { describe, it, expect } from "vitest";

import { emitFanInstantiation, emitIngressBinding, emitMint, emitMuxDecision, setEmissionEnabled } from "../provenance/store/emit.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../provenance/store/fakes.js";
import type { RecordId } from "../provenance/store/ids.js";
import { execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { setEagerProvenanceOracleEnabled, withInputProvenance } from "../values/op-helpers.js";
import { jsToScheme } from "../rosetta.js";
// In-package bench: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue } from "../Environment.js";

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

describe("emission overhead — flag OFF (the byte-identical/sunset cost)", () => {
  it(`layer 1 — emitMint × ${ITERATIONS}, flag OFF: the cost every real call site pays today`, async () => {
    setEmissionEnabled(false);
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const record = await emitMint({ store, payloads, regionId: REGION, id: idAt(i), value: i, stampIds: [i] });
      expect(record).toBeUndefined(); // no-op, proven per-iteration, not just once
    }
    report("emitMint (flag OFF)", ITERATIONS, performance.now() - start);
  });
});

describe("emission overhead — flag ON (real store/payload work per record)", () => {
  it(`layer 2 — emitMint × ${ITERATIONS}, flag ON: hash + payload put + seq alloc + append`, async () => {
    setEmissionEnabled(true);
    try {
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
      report("emitMint (flag ON)", ITERATIONS, performance.now() - start);
      expect(await store.readStream(REGION)).toHaveLength(ITERATIONS);
    } finally {
      setEmissionEnabled(false);
    }
  });

  it(`layer 3 — the payload-free kinds × ${ITERATIONS} each, flag ON: mux-decision / fan-instantiation / ingress-binding`, async () => {
    setEmissionEnabled(true);
    try {
      const store = new ProvenanceStoreFake();

      const muxStart = performance.now();
      for (let i = 0; i < ITERATIONS; i++) await emitMuxDecision({ store, regionId: REGION, id: idAt(i), arm: i % 2 });
      report("emitMuxDecision (flag ON)", ITERATIONS, performance.now() - muxStart);

      const fanStart = performance.now();
      for (let i = 0; i < ITERATIONS; i++)
        await emitFanInstantiation({ store, regionId: REGION, id: { templateHash: `fan-${i}`, ordinalPath: [i], regionEpoch: "e0" } });
      report("emitFanInstantiation (flag ON)", ITERATIONS, performance.now() - fanStart);

      const ingressStart = performance.now();
      for (let i = 0; i < ITERATIONS; i++)
        await emitIngressBinding({
          store,
          regionId: REGION,
          id: { templateHash: `ingress-${i}`, ordinalPath: [i], regionEpoch: "e0" },
        });
      report("emitIngressBinding (flag ON)", ITERATIONS, performance.now() - ingressStart);
    } finally {
      setEmissionEnabled(false);
    }
  });
});

/**
 * Q20b — the DEMOTION's own overhead measurement (docs/PROVENANCE-PLAN.md Q20:
 * "Gate: standing + perf delta recorded"), distinct from Q11a's record-EMISSION
 * layers above: this measures op-helpers.ts's per-op ACCUMULATION cost (the filter
 * + union-set allocation `withInputProvenance`/`nativeNumericOp`'s `applyNumeric`
 * skip when the oracle is inactive) on a real interpreter run — the actual hot
 * path Q20b's default flip targets, exercised through arithmetic (the highest-
 * traffic op family per the sweep) and string-append (a genuine multi-arg union).
 */
describe("Q20b — eager-oracle accumulation overhead: default-OFF vs forced-ON exec throughput", () => {
  const EXEC_ITERATIONS = 2000;
  const WARMUP_ITERATIONS = 500;

  async function runExecLoop(iterations: number): Promise<number> {
    const env = inferenceEnv.inherit(`q20b-bench-${Math.random().toString(36).slice(2)}`);
    bindValue(env, "a", jsToScheme(CONSTANT_CTX, 10, {}, new Set([100])));
    bindValue(env, "b", jsToScheme(CONSTANT_CTX, 20, {}, new Set([200])));
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await execState(`(string-append "sum=" (number->string (+ a (* b 2) ${i})))`, { env });
    }
    return performance.now() - start;
  }

  // exec() itself (parse + generator-driven eval) dwarfs op-helpers.ts's own
  // filter+union cost on a 1-2-operand array — an UN-warmed-up single pass mostly
  // measures V8 JIT warmup order, not the flag. Warm BOTH variants (discarded)
  // before measuring EITHER, so the recorded numbers isolate the accumulation
  // delta instead of a cold-start artifact (confirmed empirically: without this,
  // whichever variant ran SECOND in-process came out ~40% faster regardless of
  // which flag value it used).
  it(`exec × ${EXEC_ITERATIONS}, oracle OFF (Q20b production default) vs FORCED ON (CI agreement oracle), both JIT-warmed first`, async () => {
    setEagerProvenanceOracleEnabled(false);
    await runExecLoop(WARMUP_ITERATIONS);
    setEagerProvenanceOracleEnabled(true);
    await runExecLoop(WARMUP_ITERATIONS);

    setEagerProvenanceOracleEnabled(false);
    const offElapsed = await runExecLoop(EXEC_ITERATIONS);
    report("exec, arithmetic+string-append (oracle OFF, Q20b default)", EXEC_ITERATIONS, offElapsed);

    setEagerProvenanceOracleEnabled(true);
    let onElapsed: number;
    try {
      onElapsed = await runExecLoop(EXEC_ITERATIONS);
    } finally {
      setEagerProvenanceOracleEnabled(false);
    }
    report("exec, arithmetic+string-append (oracle ON, CI agreement mode)", EXEC_ITERATIONS, onElapsed);

    const deltaPct = ((onElapsed - offElapsed) / onElapsed) * 100;
    console.log(`Q20b demotion delta: OFF is ${deltaPct.toFixed(1)}% faster than ON (${((offElapsed / EXEC_ITERATIONS) * 1000).toFixed(2)}µs vs ${((onElapsed / EXEC_ITERATIONS) * 1000).toFixed(2)}µs per exec() call)`);
  });

  // The above, isolated: parse+eval overhead per exec() call (~265µs) dwarfs
  // op-helpers.ts's own filter+union cost on a 1-2-operand array, so the
  // whole-exec() delta is noise (±2%, confirmed over repeated runs). This row
  // measures the ISOLATED accumulation cost directly against `withInputProvenance`/
  // `mintVerdict` — the shape of arrival-sampler's actual hot loop (Q20a's
  // original motivation: ~513 interpreter calls/decode-step, no re-parse per
  // call), where the demotion's saving is NOT amortized against parse overhead.
  it(`withInputProvenance × ${EXEC_ITERATIONS * 10} direct calls, oracle OFF vs FORCED ON (the sampler's actual hot-loop shape)`, () => {
    const DIRECT_ITERATIONS = EXEC_ITERATIONS * 10;
    const a = jsToScheme(CONSTANT_CTX, 10, {}, new Set([100]));
    const b = jsToScheme(CONSTANT_CTX, 20, {}, new Set([200]));

    const runDirectLoop = (iterations: number): number => {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) withInputProvenance([a, b], i);
      return performance.now() - start;
    };

    setEagerProvenanceOracleEnabled(false);
    runDirectLoop(DIRECT_ITERATIONS); // warmup
    setEagerProvenanceOracleEnabled(true);
    runDirectLoop(DIRECT_ITERATIONS); // warmup

    setEagerProvenanceOracleEnabled(false);
    const offElapsed = runDirectLoop(DIRECT_ITERATIONS);
    report("withInputProvenance direct (oracle OFF, Q20b default)", DIRECT_ITERATIONS, offElapsed);

    setEagerProvenanceOracleEnabled(true);
    let onElapsed: number;
    try {
      onElapsed = runDirectLoop(DIRECT_ITERATIONS);
    } finally {
      setEagerProvenanceOracleEnabled(false);
    }
    report("withInputProvenance direct (oracle ON, CI agreement mode)", DIRECT_ITERATIONS, onElapsed);

    const deltaPct = ((onElapsed - offElapsed) / onElapsed) * 100;
    console.log(`Q20b demotion delta (isolated, sampler-shaped): OFF is ${deltaPct.toFixed(1)}% faster than ON`);
  });
});

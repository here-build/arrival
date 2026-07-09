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

/**
 * concurrent-runs-holders.law.test.ts — P19 (docs/PRINCIPLES.md): concurrent runs in ONE isolate
 * are the EXPECTED case, so nothing a run owns may live in a module-level holder. Each law is an
 * architect's repro (the legacy `_silentRegion` / `_coordinate`+`_sink` / dynamic-call-site /
 * region-scope holders mis-attributed state between overlapping `exec()` calls) turned into a
 * standing law over the migrated homes:
 *
 *   1. `RunContext.silent` is per run — a parked silent replay is invisible to a loud run;
 *   2. `RunContext.emission` is per run — overlapping recording runs on one store each get
 *      exactly their OWN mints, with distinct RecordIds (the per-crossing instance ordinal);
 *   3. a recording run keeps its mint when its port fires during another run's silent replay;
 *   4. the dynamic call site (`ambient.dynSite`) and the current region scope
 *      (`ambient.regionScope`) of run A are never observed by run B under interleaved awaits —
 *      directly (the windows) and end-to-end (reverse crossings, each landing in its own region).
 */
import { describe, expect, it } from "vitest";
import type { CallCtx } from "../../run/CallCtx.js";
import { execState } from "../../eval/generator-exec.js";
import { EvalTrace, type Invocation } from "../../provenance/trace.js";
import { EnvCapability } from "../../common/capability.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import type { ProvenanceRecord } from "../../provenance/store/records.js";
import type { RecordCoordinate } from "../../eval/provenance-hooks.js";
import { currentDynamicCallSite, enterDynamicCallSite, withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import { closeRegionScope, currentRegionScope, openRegionScope, withRegionScope } from "../../membrane/region-scope.js";
import { currentRun } from "../current-run.js";
import { RunContext, type RunEmission } from "../RunContext.js";
import { toJS } from "../../membrane/rosetta.js";

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The exporting invocation of each `call-later` crossing, keyed by its `ms` (40 → run A, 5 → run B). */
const exported = new Map<number, unknown>();

const ports = EnvCapability.define("law/concurrent-ports", {
  symbols: (symbol, z) => ({
    "fetch-item": symbol.rosetta`fetch-item: zero-arg numeric source`(
      { input: [], output: [z.number] },
      function (this: CallCtx) {
        return 42;
      },
    ),
    slow: symbol.rosetta`slow: async port that yields for ms, then returns ms`(
      { input: [z.number], output: [z.number] },
      async function (this: CallCtx, ms: number) {
        await sleep(ms);
        return ms;
      },
    ),
    "silent?": symbol.rosetta`silent?: samples THIS run's silent flag, after yielding`(
      { input: [z.number], output: [z.boolean] },
      async function (this: CallCtx, ms: number) {
        await sleep(ms);
        return this.runCtx.silent;
      },
    ),
    "call-later": symbol.rosetta`call-later: yields, then re-enters the scheme callback`(
      { input: [z.number, z.procedure()], output: [z.number] },
      async function (this: CallCtx, ms: number, fn: (...a: unknown[]) => unknown) {
        exported.set(ms, this.invocation.currentInvocation);
        await sleep(ms);
        await fn();
        return ms;
      },
    ),
  }),
});

function emissionOf(
  regionId: string,
  store: ProvenanceStoreFake,
  payloads: PayloadStoreFake,
  tag: string,
): RunEmission {
  const coordinate: RecordCoordinate = { templateHash: `th-${tag}`, ordinalPath: [0], regionEpoch: "e0" };
  return { store, payloads, regionId, coordinate };
}

async function mintValues(
  store: ProvenanceStoreFake,
  payloads: PayloadStoreFake,
  regionId: string,
): Promise<{ readonly templateHashes: string[]; readonly values: unknown[]; readonly stream: ProvenanceRecord[] }> {
  const stream = [...(await store.readStream(regionId))];
  const templateHashes: string[] = [];
  const values: unknown[] = [];
  for (const record of stream) {
    if (record.kind !== "mint") continue;
    templateHashes.push(record.id.templateHash);
    values.push((await payloads.get(record.payloadHash)).value);
  }
  return { templateHashes, values, stream };
}

describe("law 1 — RunContext.silent is per run, never a module flag", () => {
  it("a loud run reading its silent flag while another run's silent replay is parked sees false", async () => {
    const silentReplay = execState("(silent? 80)", { capabilities: [ports], silent: true });
    await sleep(15); // the silent run is now parked on its async port
    const loud = await execState("(silent? 10)", { capabilities: [ports] });
    const silent = await silentReplay;
    expect(toJS(loud.values[0])).toBe(false);
    expect(toJS(silent.values[0])).toBe(true); // control: the flag is real, just not shared
  });
});

describe("law 2 — overlapping recording runs each get exactly their own mints", () => {
  it("run A and run B on one ProvenanceStoreFake, distinct regions: no mint crosses, A's two ports store two DISTINCT records", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const a = execState("(begin (slow 40) (+ (fetch-item) 0))", {
      capabilities: [ports],
      tap: new EvalTrace(),
      emission: emissionOf("region-A", store, payloads, "A"),
    });
    await sleep(10);
    const b = execState("(begin (slow 100) 7)", {
      capabilities: [ports],
      tap: new EvalTrace(),
      emission: emissionOf("region-B", store, payloads, "B"),
    });
    await Promise.all([a, b]);
    await sleep(5);

    const ra = await mintValues(store, payloads, "region-A");
    const rb = await mintValues(store, payloads, "region-B");
    expect(ra.values.toSorted()).toEqual([40, 42]); // A's two ports, both retained (no id collapse)
    expect(new Set(ra.templateHashes)).toEqual(new Set(["th-A"]));
    expect(rb.values).toEqual([100]); // B's one port — and none of A's
    expect(new Set(rb.templateHashes)).toEqual(new Set(["th-B"]));
  });

  it("three port mints of one run store three distinct RecordIds (per-crossing instance ordinal)", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    await execState("(list (fetch-item) (fetch-item) (fetch-item))", {
      capabilities: [ports],
      tap: new EvalTrace(),
      emission: emissionOf("region-3", store, payloads, "T"),
    });
    await sleep(5);
    const { stream } = await mintValues(store, payloads, "region-3");
    const mints = stream.filter((r) => r.kind === "mint");
    expect(mints).toHaveLength(3);
    expect(new Set(mints.map((m) => m.id.ordinalPath.join("/"))).size).toBe(3);
  });
});

describe("law 3 — a recording run keeps its mint when its port fires during another run's silent replay", () => {
  it("silent replay parked in the middle of the recording run's window", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const recording = execState("(begin (slow 40) (+ (fetch-item) 0))", {
      capabilities: [ports],
      tap: new EvalTrace(),
      emission: emissionOf("region-A", store, payloads, "A"),
    });
    await sleep(10);
    const replay = execState("(slow 100)", {
      capabilities: [ports],
      tap: new EvalTrace(),
      emission: emissionOf("region-silent", store, payloads, "S"),
      silent: true,
    });
    await Promise.all([recording, replay]);
    await sleep(5);

    expect((await mintValues(store, payloads, "region-A")).values.toSorted()).toEqual([40, 42]);
    expect((await mintValues(store, payloads, "region-silent")).values).toEqual([]); // silence still bites ITS run
  });
});

describe("law 4 — dynamic call site and region scope of run A are never observed by run B", () => {
  it("windows are per-run holders: B sees nothing of A's site/scope, and nothing survives an await", async () => {
    const runA = new RunContext();
    const runB = new RunContext();
    const siteA = { id: "site-A", parent: null };
    const siteB = { id: "site-B", parent: null };
    const scopeA = openRegionScope({ runCtx: runA, dynSite: siteA });
    const scopeB = openRegionScope({ runCtx: runB, dynSite: siteB });
    const seen: string[] = [];

    const task = async (
      name: string,
      runCtx: RunContext,
      other: RunContext,
      site: unknown,
      scope: ReturnType<typeof openRegionScope>,
      ms: number,
    ): Promise<void> => {
      // Sync windows: inside, own site/scope visible, the other run's never.
      enterDynamicCallSite(runCtx, site, () => {
        seen.push(`${name}:site-own=${currentDynamicCallSite(runCtx) === site}`);
        seen.push(`${name}:site-other=${currentDynamicCallSite(other)}`);
      });
      withRegionScope(scope, () => {
        seen.push(`${name}:scope-own=${currentRegionScope() === scope}`);
        seen.push(`${name}:scope-other=${other.ambient.regionScope === undefined ? "none" : "LEAK"}`);
        seen.push(`${name}:run-own=${currentRun() === runCtx}`);
      });
      await sleep(ms); // interleave with the sibling task
      // After an await NO window is open: nothing leaked out of the sync windows.
      seen.push(
        `${name}:after-await=${String(currentDynamicCallSite(runCtx))}/${String(currentRegionScope())}/${String(currentRun())}`,
      );
    };

    await Promise.all([task("A", runA, runB, siteA, scopeA, 30), task("B", runB, runA, siteB, scopeB, 5)]);
    closeRegionScope(scopeA);
    closeRegionScope(scopeB);

    for (const name of ["A", "B"]) {
      expect(seen).toContain(`${name}:site-own=true`);
      expect(seen).toContain(`${name}:site-other=undefined`);
      expect(seen).toContain(`${name}:scope-own=true`);
      expect(seen).toContain(`${name}:scope-other=none`);
      expect(seen).toContain(`${name}:run-own=true`);
      expect(seen).toContain(`${name}:after-await=undefined/undefined/undefined`);
    }
  });

  it("withDynamicCallSite prefers the deeper site per run and restores on exit, independently", () => {
    const runA = new RunContext();
    const runB = new RunContext();
    const outer = { parent: null };
    const inner = { parent: outer };
    withDynamicCallSite(runA, inner, () => {
      // deeper holder (inner) is kept over a shallower request (outer) on run A only
      withDynamicCallSite(runA, outer, () => expect(currentDynamicCallSite(runA)).toBe(inner));
      withDynamicCallSite(runB, outer, () => expect(currentDynamicCallSite(runB)).toBe(outer));
      expect(currentDynamicCallSite(runB)).toBeUndefined();
    });
    expect(currentDynamicCallSite(runA)).toBeUndefined();
  });

  it("end-to-end: two overlapping runs re-enter from async ports; each reverse crossing lands in its OWN region and nests under its OWN invocation", async () => {
    const store = new ProvenanceStoreFake();
    const payloads = new PayloadStoreFake();
    const traceA = new EvalTrace();
    const traceB = new EvalTrace();
    const run = (code: string, trace: EvalTrace, tag: string): Promise<unknown> =>
      execState(code, {
        capabilities: [ports],
        tap: trace,
        emission: emissionOf(`region-${tag}`, store, payloads, tag),
      });

    const a = run("(call-later 40 (lambda () 1))", traceA, "A");
    await sleep(10);
    const b = run("(call-later 5 (lambda () 2))", traceB, "B"); // fires (and finishes) while A is parked
    await Promise.all([a, b]);
    await sleep(5);

    for (const tag of ["A", "B"]) {
      const { stream } = await mintValues(store, payloads, `region-${tag}`);
      expect(stream.filter((r) => r.kind === "track-open")).toHaveLength(1);
      expect(stream.filter((r) => r.kind === "track-close")).toHaveLength(1);
      expect(new Set(stream.map((r) => r.id.templateHash))).toEqual(new Set([`th-${tag}`]));
    }

    // Each lambda body's invocation chains up (via `.parent`) to the `call-later` invocation of
    // ITS OWN run — and to no invocation of the sibling run.
    const reaches = (inv: Invocation, target: unknown): boolean => {
      for (let p = inv.parent; p; p = p.parent) if (p === target) return true;
      return false;
    };
    const exportedA = exported.get(40);
    const exportedB = exported.get(5);
    expect(exportedA).toBeDefined();
    expect(exportedB).toBeDefined();
    expect(traceA.invocationLog.some((inv) => reaches(inv, exportedA))).toBe(true);
    expect(traceB.invocationLog.some((inv) => reaches(inv, exportedB))).toBe(true);
    expect(traceA.invocationLog.some((inv) => reaches(inv, exportedB))).toBe(false);
    expect(traceB.invocationLog.some((inv) => reaches(inv, exportedA))).toBe(false);
  });
});

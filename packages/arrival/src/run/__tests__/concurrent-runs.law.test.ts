/**
 * concurrent-runs.law.test.ts — P17–P19 (docs/PRINCIPLES.md; docs/execution.md §1): N runs launched
 * concurrently in ONE isolate are observationally identical to the same N runs executed one after
 * another. The oracle is the sequential execution; the law is that interleaving (any launch order,
 * any port jitter) changes nothing a run can observe about ITSELF:
 *
 *   per run  { toJS(values), provenance stamps (normalized to per-run ordinals),
 *              trace invocation shape (op-name tree), notes, region stream (kinds + payloads),
 *              effect/read logs, replay cone }
 *
 * The eight programs mix tapped/untapped, strict on/off, eagerStamps on/off, one SILENT hermetic
 * replay (playback + a silent live run), TWO recording runs with distinct emission regions on one
 * shared ProvenanceStoreFake, one run tripping membrane warnings, one with effects + reads armed.
 * Also here: the drift alarm — no module-scope `let` in non-test source outside the (shared,
 * classified) ESLint allowlist.
 *
 * Timing: the `slow` port sleeps a SEEDED 0–20ms jitter, so the interleaving differs between the
 * sequential, forward and reverse launches while the values stay a pure function of the program.
 * Order among the tracks of one run's fan (children of a trace node) is NOT observable (P18), so the
 * trace shape sorts siblings.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { execState } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/rosetta.js";
import { warnMembrane } from "../../membrane/membrane-warn.js";
import { collapseProvenance } from "../../provenance/provenance-collapse.js";
import { SENTINEL_BASE, replayProgramWithPlayback } from "../../provenance/replay.js";
import { PayloadStoreFake, ProvenanceStoreFake } from "../../provenance/store/fakes.js";
import type { Payload } from "../../provenance/store/interfaces.js";
import { EvalTrace, type Invocation } from "../../provenance/trace.js";
import type { RecordCoordinate } from "../../eval/provenance-hooks.js";
import type { CallCtx } from "../CallCtx.js";
import { MemoryEffectLog } from "../effect-log.js";
import { createNoteSink } from "../note-sink.js";
import { MemoryReadTracker } from "../read-guard.js";
import { currentRegionScope, openRegionScope, withRegionScope } from "../../membrane/region-scope.js";
import { AmbientWindowError, CONSTANT_CTX, type RunEmission } from "../RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";

// ── Fixture capability ───────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seeded 0–20ms sequence (LCG). Test-local timing only: values never depend on it. */
function jitterFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % 21;
  };
}
const portJitter = { next: jitterFrom(12_648_430) };

function fixture(tracker: MemoryReadTracker) {
  return EnvCapability.define("law/concurrent-fixture", {
    symbols: (symbol, z) => ({
      slow: symbol.rosetta`slow: async port; yields a seeded jitter, then returns its argument`(
        { input: [z.number], output: [z.number] },
        async function (this: CallCtx, n: number) {
          await sleep(portJitter.next());
          return n;
        },
      ),
      "fetch-item": symbol.rosetta`fetch-item: sync source`(
        { input: [], output: [z.number] },
        function (this: CallCtx) {
          return 42;
        },
      ),
      trip: symbol.rosetta`trip: yields, then trips the membrane warning on THIS run`(
        { input: [z.number], output: [z.number] },
        async function (this: CallCtx, n: number) {
          await sleep(portJitter.next());
          for (let i = 0; i < 5; i++) warnMembrane(this.runCtx, "a JS function");
          return n;
        },
      ),
      "read-key": symbol.rosetta`read-key: records a read of its key`(
        { input: [z.string], output: [z.number] },
        function (this: CallCtx, key: string) {
          tracker.record(key);
          return 1;
        },
      ),
      "write!": symbol.rosetta`write!: deferred sink`(
        { input: [z.string], output: [z.undefinedResult], provenance: "sink" },
        async function (this: CallCtx, _key: string) {
          return undefined;
        },
      ),
    }),
  });
}

// ── Capture ──────────────────────────────────────────────────────────────────

interface Capture {
  readonly values?: unknown;
  readonly stamps?: readonly (readonly number[])[];
  readonly trace?: unknown;
  readonly notes: readonly string[];
  readonly extra?: unknown;
}

/** Normalize stamp ids to per-run ordinals (rank among this run's own distinct ids). */
function normalizeStamps(values: readonly unknown[]): number[][] {
  const sets = values.map((v) => (v instanceof AValue ? [...collapseProvenance(v)].toSorted((a, b) => a - b) : []));
  const rank = new Map<number, number>();
  for (const id of sets.flat().toSorted((a, b) => a - b)) if (!rank.has(id)) rank.set(id, rank.size);
  return sets.map((s) => s.map((id) => rank.get(id)!));
}

function shapeOf(inv: Invocation): unknown {
  const head = inv.node.car;
  const op = head instanceof AValue ? String(head) : "<expr>";
  const children = inv.children.map((child) => JSON.stringify(shapeOf(child))).toSorted();
  return [op, ...children];
}

function traceShape(trace: EvalTrace): unknown {
  return trace.invocationLog
    .filter((inv) => inv.parent === null)
    .map((root) => JSON.stringify(shapeOf(root)))
    .toSorted();
}

const coordinateOf = (tag: string): RecordCoordinate => ({
  templateHash: `th-${tag}`,
  ordinalPath: [0],
  regionEpoch: "e0",
});

interface Scenario {
  readonly name: string;
  run(): Promise<Capture>;
  /** Post-phase observation (after EVERY run has settled): the region stream, for recorders. */
  after?(): Promise<unknown>;
}

async function regionStream(store: ProvenanceStoreFake, payloads: PayloadStoreFake, regionId: string) {
  const stream = await store.readStream(regionId);
  const out: unknown[] = [];
  for (const record of stream) {
    const payload = record.kind === "mint" ? (await payloads.get(record.payloadHash)).value : undefined;
    out.push({ kind: record.kind, payload, template: record.id.templateHash });
  }
  return out;
}

/** Fresh scenarios (fresh stores/sinks) — the sequential oracle and each concurrent launch get their own. */
function makeScenarios(): readonly Scenario[] {
  const sharedStore = new ProvenanceStoreFake();
  const payloadsA = new PayloadStoreFake();
  const payloadsB = new PayloadStoreFake();
  const emissionOf = (regionId: string, payloads: PayloadStoreFake, tag: string): RunEmission => ({
    store: sharedStore,
    payloads,
    regionId,
    coordinate: coordinateOf(tag),
  });

  async function plain(
    src: string,
    opts: { tapped: boolean; strict: boolean; eagerStamps: boolean },
  ): Promise<Capture> {
    const notes = createNoteSink();
    const tap = opts.tapped ? new EvalTrace() : undefined;
    const state = await execState(src, {
      capabilities: [fixture(new MemoryReadTracker())],
      tap,
      strict: opts.strict,
      eagerStamps: opts.eagerStamps,
      notes,
    });
    return {
      values: state.values.map((v) => toJS(v)),
      stamps: normalizeStamps(state.values),
      trace: tap === undefined ? undefined : traceShape(tap),
      notes: notes.drain(),
    };
  }

  async function recorder(src: string, regionId: string, payloads: PayloadStoreFake, tag: string): Promise<Capture> {
    const notes = createNoteSink();
    const tap = new EvalTrace();
    const state = await execState(src, {
      capabilities: [fixture(new MemoryReadTracker())],
      tap,
      notes,
      emission: emissionOf(regionId, payloads, tag),
    });
    return {
      values: state.values.map((v) => toJS(v)),
      stamps: normalizeStamps(state.values),
      trace: traceShape(tap),
      notes: notes.drain(),
    };
  }

  return [
    {
      name: "plain/tapped/tolerant",
      run: () =>
        plain("(list (slow 3) (fetch-item) (+ (slow 5) 1))", { tapped: true, strict: false, eagerStamps: false }),
    },
    {
      name: "plain/untapped/strict/for-each-fan",
      run: () =>
        plain("(begin (for-each (lambda (x) (slow x)) (list 1 2 3)) (map (lambda (x) (+ x (slow 2))) (list 1 2 3)))", {
          tapped: false,
          strict: true,
          eagerStamps: false,
        }),
    },
    {
      name: "plain/tapped/strict/eager",
      run: () =>
        plain("(let ((a (slow 4))) (list a (fetch-item) (vector-map (lambda (x) (* x 2)) (vector 1 (slow 1)))))", {
          tapped: true,
          strict: true,
          eagerStamps: true,
        }),
    },
    {
      name: "silent-hermetic-replay",
      async run() {
        const payload = (value: unknown, id: number): Payload => ({ value, stampIds: [id] });
        const replayed = await replayProgramWithPlayback({
          source: "(+ (slow 3) (fetch-item))",
          playback: new Map([
            ["slow", [payload(3, 1)]],
            ["fetch-item", [payload(42, 2)]],
          ]),
          basePacks: [fixture(new MemoryReadTracker())],
        });
        const cone = [...collapseProvenance(replayed.boxed)].toSorted((a, b) => a - b);
        // A second silent run, LIVE ports: silence rides the run, so it mints/emits nothing.
        const notes = createNoteSink();
        const silentEmission: RunEmission = {
          store: new ProvenanceStoreFake(),
          payloads: new PayloadStoreFake(),
          regionId: "region-silent",
          coordinate: coordinateOf("S"),
        };
        const state = await execState("(list (slow 6) (fetch-item))", {
          capabilities: [fixture(new MemoryReadTracker())],
          tap: new EvalTrace(),
          silent: true,
          notes,
          emission: silentEmission,
        });
        const silentStream = await (silentEmission.store as ProvenanceStoreFake).readStream("region-silent");
        return {
          values: [replayed.value, ...state.values.map((v) => toJS(v))],
          notes: notes.drain(),
          extra: {
            // Sentinel discipline: nothing replay minted is a sentinel, and the cone is the same every time.
            cone,
            sentinelFree: cone.every((id) => id < SENTINEL_BASE),
            silentRecords: silentStream.length,
          },
        };
      },
    },
    {
      name: "recorder-A",
      run: () => recorder("(begin (slow 7) (+ (fetch-item) 0))", "region-A", payloadsA, "A"),
      after: () => regionStream(sharedStore, payloadsA, "region-A"),
    },
    {
      name: "recorder-B",
      run: () => recorder("(list (slow 9) (slow 3) (fetch-item))", "region-B", payloadsB, "B"),
      after: () => regionStream(sharedStore, payloadsB, "region-B"),
    },
    {
      name: "membrane-warnings",
      async run() {
        const notes = createNoteSink();
        const tap = new EvalTrace();
        const state = await execState("(begin (trip 1) (slow 2) (trip 3))", {
          capabilities: [fixture(new MemoryReadTracker())],
          tap,
          notes,
        });
        return {
          values: state.values.map((v) => toJS(v)),
          stamps: normalizeStamps(state.values),
          trace: traceShape(tap),
          notes: notes.drain(),
        };
      },
    },
    {
      name: "effects-and-reads-armed",
      async run() {
        const tracker = new MemoryReadTracker();
        const effects = new MemoryEffectLog();
        const notes = createNoteSink();
        const state = await execState('(begin (read-key "k") (write! "k") (slow 1))', {
          capabilities: [fixture(tracker)],
          tap: new EvalTrace(),
          effects,
          reads: { tracker },
          notes,
        });
        return {
          values: state.values.map((v) => toJS(v)),
          notes: notes.drain(),
          extra: {
            effects: effects.entries.map((e) => ({
              verb: e.verbName,
              args: e.decodedArgs,
              clock: e.enqueuedAtReadClock,
            })),
            reads: tracker.log.map((r) => ({ key: r.key, clock: r.clock })),
          },
        };
      },
    },
  ];
}

interface Observed {
  readonly capture: Capture;
  readonly region: unknown;
}

type Order = "sequential" | "forward" | "reverse";

async function runAll(order: Order, launchSeed: number): Promise<Observed[]> {
  const scenarios = makeScenarios();
  const launchJitter = jitterFrom(launchSeed);
  const captures: Capture[] = Array.from({ length: scenarios.length });
  if (order === "sequential") {
    for (const [i, s] of scenarios.entries()) captures[i] = await s.run();
  } else {
    const indices = scenarios.map((_, i) => i);
    if (order === "reverse") indices.reverse();
    const pending: Promise<void>[] = [];
    for (const i of indices) {
      pending.push(
        scenarios[i].run().then((c) => {
          captures[i] = c;
        }),
      );
      await sleep(launchJitter() % 8); // jitter between launches — the runs overlap mid-flight
    }
    await Promise.all(pending);
  }
  await sleep(10); // let write-behind flushes settle before reading region streams
  const observed: Observed[] = [];
  for (const [i, s] of scenarios.entries()) {
    observed.push({ capture: captures[i], region: s.after === undefined ? undefined : await s.after() });
  }
  return observed;
}

// ── The law ──────────────────────────────────────────────────────────────────

describe("LAW — N concurrent runs ≡ the same N runs sequentially (P17–P19)", () => {
  it("forward and reverse launches with port jitter deep-equal the sequential oracle, run for run", async () => {
    const oracle = await runAll("sequential", 1);
    const names = makeScenarios().map((s) => s.name);
    // Sanity: the oracle itself is non-vacuous.
    expect(oracle).toHaveLength(8);
    expect(oracle[0].capture.values).toEqual([[3, 42, 6]]);
    expect(oracle[6].capture.notes.length).toBeGreaterThan(0); // the tripping run reported
    expect(oracle[0].capture.notes).toEqual([]); // ... and its neighbours did not

    for (const [order, seed] of [
      ["forward", 7],
      ["reverse", 13],
    ] as const) {
      const observed = await runAll(order, seed);
      for (const [i, name] of names.entries()) {
        expect(observed[i], `${order}: ${name}`).toEqual(oracle[i]);
      }
    }
    // Wall-clock port jitter × 3 passes × 8 runs: the default 20s budget is a CPU-load hostage, not a law bound.
  }, 60_000);

  it("each recording run's region stream holds only its own mints (distinct regions, one shared store)", async () => {
    const observed = await runAll("forward", 21);
    const a = observed[4].region as { kind: string; payload: unknown; template: string }[];
    const b = observed[5].region as { kind: string; payload: unknown; template: string }[];
    const mints = (stream: typeof a) => stream.filter((r) => r.kind === "mint");
    expect(new Set(a.map((r) => r.template))).toEqual(new Set(["th-A"]));
    expect(new Set(b.map((r) => r.template))).toEqual(new Set(["th-B"]));
    expect(
      mints(a)
        .map((r) => r.payload)
        .toSorted(),
    ).toEqual([42, 7]);
    expect(
      mints(b)
        .map((r) => r.payload)
        .toSorted(),
    ).toEqual([3, 42, 9]);
  });

  it("the silent replay mints no sentinel, emits nothing, and its cone is identical under interleaving", async () => {
    const alone = (await makeScenarios()[3].run()).extra as {
      sentinelFree: boolean;
      silentRecords: number;
      cone: number[];
    };
    expect(alone.sentinelFree).toBe(true);
    expect(alone.silentRecords).toBe(0);
    const observed = await runAll("reverse", 5);
    expect((observed[3].capture.extra as { cone: number[] }).cone).toEqual(alone.cone);
  });

  it("the membrane-warning budget is per run: the tripping run gets its teaching line + suppression notice, others none", async () => {
    const observed = await runAll("forward", 3);
    expect(observed[6].capture.notes).toHaveLength(2);
    for (const i of [0, 1, 2, 3, 4, 5, 7]) expect(observed[i].capture.notes).toEqual([]);
  });
});

// ── Drift alarm ──────────────────────────────────────────────────────────────

describe("DRIFT ALARM — no module-scope `let` in non-test source outside the classified allowlist", () => {
  const pkgRoot = path.join(import.meta.dirname, "..", "..", "..");
  const allowlist: readonly { path: string; class: string; why: string }[] = JSON.parse(
    readFileSync(path.join(pkgRoot, "module-let-allowlist.json"), "utf8"),
  );
  const TEST_DIRS = new Set(["__tests__", "__benchmarks__", "__experiments__", "__visual__"]);

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!TEST_DIRS.has(entry)) sources(full, out);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const MODULE_LET = /^(?:export\s+)?let\s/m;
  const withModuleLet = sources(path.join(pkgRoot, "src"))
    .filter((file) => MODULE_LET.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(pkgRoot, file));

  it("every module-scope `let` lives in an allowlisted, classified file", () => {
    const allowed = new Set(allowlist.map((e) => e.path));
    expect(withModuleLet.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("the allowlist holds no stale entries (a holder that is gone must be removed) and every entry is classified", () => {
    const present = new Set(withModuleLet);
    expect(allowlist.filter((e) => !present.has(e.path)).map((e) => e.path)).toEqual([]);
    for (const e of allowlist) {
      expect(e.class.length, e.path).toBeGreaterThan(0);
      expect(e.why.length, e.path).toBeGreaterThan(0);
    }
  });
});

describe("SYNC WINDOWS — the CONSTANT_CTX region-scope leg is guarded like currentRun", () => {
  it("a thenable body in a CONSTANT_CTX region window throws AmbientWindowError, and the slot is restored", () => {
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    expect(currentRegionScope()).toBeUndefined();
    expect(() => withRegionScope(scope, () => Promise.resolve(1))).toThrow(AmbientWindowError);
    expect(currentRegionScope()).toBeUndefined();
    // a sync body sees the scope inside the window and nothing outside it
    expect(withRegionScope(scope, () => currentRegionScope())).toBe(scope);
    expect(currentRegionScope()).toBeUndefined();
  });
});

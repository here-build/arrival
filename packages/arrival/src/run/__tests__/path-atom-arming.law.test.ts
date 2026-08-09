/**
 * LAW — Phase 5 reactivity X1: path-atom arming at query/effect penetrations (gate 5a).
 *
 * Single-run white-box over MemoryPathAtomBus. No host re-invoke envelope (R2 / X2).
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md §X1
 *
 * Each negative carries A-CTRL-X1: a call in the same fixture that *does* populate the
 * same set, proving the bus is capable of recording, not merely abstaining.
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { MemoryRunCache } from "../run-cache.js";
import { MemoryEffectLog } from "../effect-log.js";
import {
  MemoryResourcePathLog,
  ResourcePathConflictError,
  ResourcePathProducerError,
  type ResourcePath,
  type ResourcePathLog,
} from "../resource-paths.js";
import { atomKey, MemoryPathAtomBus } from "../path-atom-bus.js";

// ── Fake capability family (mirrors S1 fixtures; X1 does not import S1 harness) ─

type SpyMap = Record<string, number>;

function makePathCap(spies: SpyMap, opts?: { pathFnThrow?: "queries" | "effects" }) {
  const base = new MemoryResourcePathLog();
  const pathLog: ResourcePathLog = {
    get effectPaths() {
      return base.effectPaths;
    },
    recordEffects(paths) {
      base.recordEffects(paths);
    },
  };

  const track = (name: string) => {
    spies[name] = (spies[name] ?? 0) + 1;
  };

  const q =
    (name: string, fn: (...a: string[]) => ResourcePath[]) =>
    (...a: string[]) => {
      if (opts?.pathFnThrow === "queries") throw new Error("path-fn-queries-boom");
      return fn(...a);
    };
  const e =
    (name: string, fn: (...a: string[]) => ResourcePath[]) =>
    (...a: string[]) => {
      if (opts?.pathFnThrow === "effects") throw new Error("path-fn-effects-boom");
      return fn(...a);
    };

  const store = new Map<string, string>();

  const cap = EnvCapability.define("test/path-atom-arming", {
    symbols: (symbol, z) => ({
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: q("read", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("read");
          return store.get(`${d}:${id}`) ?? `${d}:${id}`;
        },
      ),
      "read-all": symbol.rosetta`read-all: `(
        {
          input: [z.string],
          output: [z.string],
          queries: q("read-all", (d) => [["test", d]]),
        },
        (d: string) => {
          track("read-all");
          return `all:${d}`;
        },
      ),
      "read-many": symbol.rosetta`read-many: `(
        {
          input: [z.string, z.string, z.string],
          output: [z.string],
          queries: q("read-many", (d, id1, id2) => [
            ["test", d, id1],
            ["test", d, id2],
          ]),
        },
        (d: string, id1: string, id2: string) => {
          track("read-many");
          return `${d}:${id1}+${id2}`;
        },
      ),
      "read-decoded": symbol.rosetta`read-decoded: `(
        {
          input: [
            z.string,
            z.string.transform((s) => (s.startsWith("raw:") ? s.slice(4) : s)),
          ],
          output: [z.string],
          queries: q("read-decoded", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("read-decoded");
          return `${d}:${id}`;
        },
      ),
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: e("write", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("write");
          store.set(`${d}:${id}`, "written");
          return undefined;
        },
      ),
      upsert: symbol.rosetta`upsert: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: q("upsert", (d, id) => [["test", d, id]]),
          effects: e("upsert", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("upsert");
          return `row:${d}:${id}`;
        },
      ),
      noop: symbol.rosetta`noop: `({ input: [z.string], output: [z.string] }, (x: string) => {
        track("noop");
        return x;
      }),
      "fail-impl": symbol.rosetta`fail-impl: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: e("fail-impl", (d) => [["test", d]]),
        },
        () => {
          track("fail-impl");
          throw new Error("plain-impl-boom");
        },
      ),
      // void-sink gather (ARM 1) — RX-FAKE-SINK fixture for P-RX-GATHER-QUEUED
      "sink-gather": symbol.rosetta`sink-gather: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          provenance: "sink",
          effects: e("sink-gather", (d, id) => [["test", d, id]]),
        },
        () => {
          track("sink-gather");
          return undefined;
        },
      ),
      // non-string segment producer (for N-RX-NONSTRING-SEGMENT under RX-STRICT)
      "read-num": symbol.rosetta`read-num: `(
        {
          input: [z.string],
          output: [z.string],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate non-string segment
          queries: ((_d: string) => [["db", 1]]) as any,
        },
        () => {
          track("read-num");
          return "x";
        },
      ),
      // no path producers
      bare: symbol.rosetta`bare: `({ input: [z.string], output: [z.string] }, (x: string) => {
        track("bare");
        return x;
      }),
    }),
  });

  return { cap, pathLog, store };
}

const key = (...segs: string[]) => atomKey(segs);

async function runRx(
  code: string,
  opts?: {
    pathFnThrow?: "queries" | "effects";
    cache?: MemoryRunCache;
    effects?: MemoryEffectLog;
    pathLog?: ResourcePathLog;
    strictCQSstrings?: boolean;
  },
) {
  const spies: SpyMap = {};
  const bus = new MemoryPathAtomBus();
  const { cap, pathLog } = makePathCap(spies, { pathFnThrow: opts?.pathFnThrow });
  const result = await exec(code, {
    capabilities: [cap],
    pathAtoms: bus,
    cache: opts?.cache,
    effects: opts?.effects,
    resourcePaths: opts?.pathLog ?? pathLog,
    strictCQSstrings: opts?.strictCQSstrings,
  });
  return { result, spies, bus, pathLog: opts?.pathLog ?? pathLog };
}

// ── Positives ────────────────────────────────────────────────────────────────

describe("X1 arming positives (5a)", () => {
  it("P-RX-OBSERVE — read observes key; Q=[] adds nothing", async () => {
    const { bus, spies } = await runRx('(read "D" "id") (noop "x")');
    expect(bus.observed).toEqual(new Set([key("test", "D", "id")]));
    expect(spies.read).toBe(1);
    expect(spies.noop).toBe(1);
  });

  it("P-RX-MULTI-Q — readMany observes both keys", async () => {
    const { bus } = await runRx('(read-many "D" "a" "b")');
    expect(bus.observed).toEqual(new Set([key("test", "D", "a"), key("test", "D", "b")]));
  });

  it("P-RX-DECODE — observed key uses decoded segment", async () => {
    const { bus } = await runRx('(read-decoded "D" "raw:42")');
    expect(bus.observed).toEqual(new Set([key("test", "D", "42")]));
    expect(bus.observed.has(key("test", "D", "raw:42"))).toBe(false);
  });

  it("P-RX-CACHE-HIT — second read still observed (path fns precede cache)", async () => {
    const cache = new MemoryRunCache("record");
    const { bus, spies } = await runRx('(read "D" "id") (read "D" "id")', { cache });
    expect(bus.observed).toEqual(new Set([key("test", "D", "id")]));
    // Both penetrations run path fns / observe; cache may serve value on 2nd fire
    expect(spies.read).toBeGreaterThanOrEqual(1);
  });

  it("P-RX-INVALIDATE — write commits → invalidated at run commit (RX-CLOCK)", async () => {
    const { bus, spies } = await runRx('(write "D" "id")');
    expect(spies.write).toBe(1);
    expect(bus.observed.size).toBe(0);
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });

  it("P-RX-GATHER-QUEUED — sink-gather: E enqueued, impl skipped, no invalidate at run commit", async () => {
    const effects = new MemoryEffectLog();
    const { bus, spies } = await runRx('(sink-gather "D" "id")', { effects });
    expect(spies["sink-gather"]).toBeUndefined(); // impl skipped
    expect(effects.entries).toHaveLength(1);
    expect(effects.entries[0].resourcePaths).toEqual([["test", "D", "id"]]);
    expect(effects.entries[0].fired).not.toBe(true);
    expect(bus.invalidated.size).toBe(0);
    expect(bus.observed.size).toBe(0);
  });

  it("P-RX-HYBRID-ARM — upsert observes and invalidates", async () => {
    const { bus, spies } = await runRx('(upsert "D" "id")');
    expect(spies.upsert).toBe(1);
    expect(bus.observed).toEqual(new Set([key("test", "D", "id")]));
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });

  it("P-RX-UNTRACKED-NOOP — noop between tracked calls contributes to neither set", async () => {
    const { bus, spies } = await runRx('(read "D" "a") (noop "z") (write "D" "b")');
    expect(spies.noop).toBe(1);
    expect(bus.observed).toEqual(new Set([key("test", "D", "a")]));
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "b")]));
  });
});

// ── Negatives (A-CTRL-X1) ────────────────────────────────────────────────────

describe("X1 arming negatives (5a)", () => {
  it("N-RX-PURE — arithmetic/list only: empty sets; control read populates observed", async () => {
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    await exec("(+ 1 2)", { capabilities: [cap], pathAtoms: bus });
    expect(bus.observed.size).toBe(0);
    expect(bus.invalidated.size).toBe(0);
    // A-CTRL-X1
    await exec('(read "D" "id")', { capabilities: [cap], pathAtoms: bus });
    expect(bus.observed.has(key("test", "D", "id"))).toBe(true);
  });

  it("N-RX-EFFECT-ONLY — write only: observed empty; own invalidated non-empty", async () => {
    const { bus } = await runRx('(write "D" "id")');
    expect(bus.observed.size).toBe(0);
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });

  it("N-RX-DOORED-Q — doored query observes nothing; prior write abandoned (RX-CLOCK)", async () => {
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    await expect(
      exec('(write "D" "id") (read "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: pathLog,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    // Doored read did not observe; run failed → staged write abandoned
    expect(bus.observed.size).toBe(0);
    expect(bus.invalidated.size).toBe(0);
    expect(spies.write).toBe(1);
    expect(spies.read).toBeUndefined();
    // A-CTRL-X1: successful write alone populates invalidated
    const bus2 = new MemoryPathAtomBus();
    await exec('(write "D" "id")', {
      capabilities: [cap],
      pathAtoms: bus2,
      resourcePaths: new MemoryResourcePathLog(),
    });
    expect(bus2.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });

  it("N-RX-PATHFN-THROW — queries() throws: no observation; not a door", async () => {
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies, { pathFnThrow: "queries" });
    await expect(
      exec('(read "D" "id")', { capabilities: [cap], pathAtoms: bus }),
    ).rejects.toThrow(ResourcePathProducerError);
    expect(bus.observed.size).toBe(0);
    expect(spies.read).toBeUndefined();
    // A-CTRL-X1: sibling successful penetration observes
    const { cap: cap2 } = makePathCap({});
    await exec('(read "D" "id")', { capabilities: [cap2], pathAtoms: bus });
    expect(bus.observed.has(key("test", "D", "id"))).toBe(true);
  });

  it("N-RX-IMPL-THROW-NO-INVAL — E in prior-E but nothing invalidated (record ≠ invalidate)", async () => {
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    await expect(
      exec('(fail-impl "D")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: pathLog,
      }),
    ).rejects.toThrow(/plain-impl-boom/);
    // prior-E recorded pre-impl (R-RECORD-ON-IMPL-THROW)
    expect(pathLog.effectPaths).toEqual([["test", "D"]]);
    expect(bus.invalidated.size).toBe(0);
    expect(spies["fail-impl"]).toBe(1);
  });

  it("N-RX-REPLAY-SILENT — replay mode: no observe / no invalidate; record control arms", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const busReplay = new MemoryPathAtomBus();
    const replay = new MemoryRunCache("replay");
    // Prime a value entry so replay can serve (optional — silence holds either way)
    await exec('(read "D" "id") (write "D" "id")', {
      capabilities: [cap],
      pathAtoms: new MemoryPathAtomBus(),
      cache: new MemoryRunCache("record"),
    });
    await exec('(read "D" "id") (write "D" "id")', {
      capabilities: [cap],
      pathAtoms: busReplay,
      cache: replay,
    });
    expect(busReplay.observed.size).toBe(0);
    expect(busReplay.invalidated.size).toBe(0);
    // A-CTRL-X1: same program in record mode arms
    const busRecord = new MemoryPathAtomBus();
    await exec('(read "D" "id") (write "D" "id")', {
      capabilities: [cap],
      pathAtoms: busRecord,
      cache: new MemoryRunCache("record"),
    });
    expect(busRecord.observed.has(key("test", "D", "id"))).toBe(true);
    expect(busRecord.invalidated.has(key("test", "D", "id"))).toBe(true);
  });

  it("N-RX-NONSTRING-SEGMENT — under RX-STRICT rejected at path-fn time; string twin observes", async () => {
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    await expect(
      exec('(read-num "x")', {
        capabilities: [cap],
        pathAtoms: bus,
        strictCQSstrings: true,
      }),
    ).rejects.toThrow(ResourcePathProducerError);
    expect(bus.observed.size).toBe(0);
    // A-CTRL-X1: string-segment twin keys and observes
    await exec('(read "D" "id")', { capabilities: [cap], pathAtoms: bus });
    expect(bus.observed.has(key("test", "D", "id"))).toBe(true);
  });

  it("N-RX-NO-PATHS — rosetta without queries/effects never touches the bus", async () => {
    const { bus, spies } = await runRx('(bare "x")');
    expect(spies.bare).toBe(1);
    expect(bus.observed.size).toBe(0);
    expect(bus.invalidated.size).toBe(0);
    // A-CTRL-X1
    const { bus: bus2 } = await runRx('(read "D" "id")');
    expect(bus2.observed.has(key("test", "D", "id"))).toBe(true);
  });
});

describe("X1 — ProxyPathAtomBus smoke (MobX optional; memory proxy)", () => {
  it("ProxyPathAtomBus observes via AtomProxy (no MobX import in this file)", async () => {
    const { createMemoryAtomProxy, ProxyPathAtomBus } = await import("../path-atom-bus.js");
    const proxy = createMemoryAtomProxy();
    const bus = new ProxyPathAtomBus(proxy);
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    await exec('(read "D" "id") (write "D" "id")', {
      capabilities: [cap],
      pathAtoms: bus,
    });
    const k = key("test", "D", "id");
    expect(proxy.stats.get(k)?.observed).toBeGreaterThanOrEqual(1);
    expect(proxy.stats.get(k)?.changed).toBeGreaterThanOrEqual(1);
  });

  it("createMobxAtomProxy builds a live ProxyPathAtomBus (optional peer)", async () => {
    const { createMobxAtomProxy } = await import("../mobx-atom-proxy.js");
    const { ProxyPathAtomBus } = await import("../path-atom-bus.js");
    const bus = new ProxyPathAtomBus(createMobxAtomProxy());
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    await exec('(read "D" "id")', { capabilities: [cap], pathAtoms: bus });
    // Behavioral only — no MobX API asserted
    expect(spies.read).toBe(1);
  });
});

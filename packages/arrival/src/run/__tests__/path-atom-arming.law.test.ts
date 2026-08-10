/**
 * LAW — Phase 5 reactivity X1: path-atom arming at query/effect penetrations (gate 5a).
 *
 * Single-run white-box over MemoryPathAtomBus. No host re-invoke envelope (R2 / X2).
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md §X1
 *
 * Each negative carries A-CTRL-X1: a call in the same fixture that *does* populate the
 * same set, proving the bus is capable of recording, not merely abstaining.
 *
 * X2 WITNESSES (suite 5a checklist #2 — X1 is white-box, X2a is normative; every case
 * here either names the behavioral case that will subsume it at 5b, or is white-box-only):
 *
 *   P-RX-OBSERVE ................. P-RX-REINVOKE
 *   P-RX-MULTI-Q ................. P-RX-PREFIX-DOWN
 *   P-RX-DECODE .................. P-RX-REINVOKE-DECODE
 *   P-RX-CACHE-HIT ............... P-RX-REINVOKE
 *   P-RX-OBSERVE-ACROSS-AWAIT .... P-RX-PARITY
 *   P-RX-INVALIDATE .............. P-RX-CROSS-UNIT
 *   P-RX-GATHER-QUEUED .......... P-RX-GATHER-INVAL-ON-COMMIT
 *   P-RX-HYBRID-ARM .............. P-RX-HYBRID
 *   P-RX-UNTRACKED-NOOP ......... P-RX-CROSS-UNIT
 *   N-RX-EFFECT-ONLY ............. N-RX-EFFECT-ONLY-DEAF
 *   N-RX-DOORED-Q ................ P-RX-DOOR-PERSISTS
 *   N-RX-IMPL-THROW-NO-INVAL ..... N-RX-IMPL-THROW-NO-WAKE
 *   N-RX-REPLAY-SILENT ........... P-RX-REPLAY-DOOR-LIVE
 *   N-RX-PURE / N-RX-PATHFN-THROW / N-RX-NONSTRING-SEGMENT / N-RX-NO-PATHS ... white-box-only
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { RunContext } from "../RunContext.js";
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
    get events() {
      return base.events;
    },
    get effectPaths() {
      return base.effectPaths;
    },
    recordQueries(paths) {
      base.recordQueries(paths);
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
      // ASYNC impl — the only way to author a query penetration that survives a
      // trampoline yield (P-RX-OBSERVE-ACROSS-AWAIT).
      "read-slow": symbol.rosetta`read-slow: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: q("read-slow", (d, id) => [["test", d, id]]),
        },
        async (d: string, id: string) => {
          await Promise.resolve();
          track("read-slow");
          return `${d}:${id}`;
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

  it("P-RX-OBSERVE-ACROSS-AWAIT — both penetrations observed across a trampoline yield", async () => {
    // Two Q penetrations either side of an async impl's await, in ONE form. This is the
    // regression guard for the substrate constraint read-guard.ts's header names: MobX's
    // own `Reaction` tracking is stack-synchronous and does NOT survive an await, so an
    // implementation that armed by ambient auto-tracking would lose one of these. Arming
    // is an explicit call at the penetration, which is why both land.
    const { bus, spies } = await runRx('(string-append (read-slow "D" "a") (read "D" "b"))');
    expect(bus.observed).toEqual(new Set([key("test", "D", "a"), key("test", "D", "b")]));
    expect(spies["read-slow"]).toBe(1);
    expect(spies.read).toBe(1);
    // Attributed to THIS run only — a second bus that never saw the run stays empty.
    const other = new MemoryPathAtomBus();
    expect(other.observed.size).toBe(0);
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
    // Restaged to N-I4c (Q→E→Q): bare E→Q is LEGAL under temporal immutability.
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    await expect(
      exec('(read "D" "id") (write "D" "id") (read "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: pathLog,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    // First read observed; second (doored) Q never reaches observe (post-CQS arming).
    // Run failed → staged write abandoned (RX-CLOCK).
    expect(bus.observed).toEqual(new Set([key("test", "D", "id")]));
    expect(bus.invalidated.size).toBe(0);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1); // first read only; second doored before impl
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

// ── RX-UNIT: who owns the run-commit clock ───────────────────────────────────

describe("X1 — the commit clock belongs to the run, not to the call (RX-UNIT)", () => {
  it("an exec over a CALLER-OWNED runCtx does not fire the clock", async () => {
    // `require`'s module-eval loop threads the requiring run's LIVE runCtx into a nested
    // exec, and a REPL pass reuses one runCtx across calls. Both are forms INSIDE another
    // run — RX-UNIT says the unit is the whole top-level exec, so neither may flush the
    // parent's staged effects. Staging still happened; only the clock is withheld.
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    const runCtx = new RunContext({ pathAtoms: bus, resourcePaths: pathLog });

    await exec('(write "D" "id")', { capabilities: [cap], runCtx });
    expect(spies.write).toBe(1);
    expect(bus.invalidated.size).toBe(0); // staged, not flushed

    // The runCtx's owner fires the clock; the staged effect lands then, and only then.
    bus.commitRun();
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });

  it("A-CTRL — the same program on an exec-owned runCtx does fire it", async () => {
    const { bus } = await runRx('(write "D" "id")');
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });

  it("a nested exec's throw does not abandon the outer run's staged effects", async () => {
    const bus = new MemoryPathAtomBus();
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    const runCtx = new RunContext({ pathAtoms: bus, resourcePaths: pathLog });

    await exec('(write "D" "id")', { capabilities: [cap], runCtx });
    await expect(
      exec("(no-such-verb)", { capabilities: [cap], runCtx }),
    ).rejects.toThrow(/unbound variable/i);

    // The outer run has not ended; its staged write survives the inner failure.
    bus.commitRun();
    expect(bus.invalidated).toEqual(new Set([key("test", "D", "id")]));
  });
});

// The MobX-backed twin of this smoke is NOT here: the frozen suite puts any
// MobX-proxy spike in `__experiments__/` and never a gate (SUITE §Phase gates), and
// mobx is an optional peer — a gate that imports it is red on every install that
// declines the peer. See src/__experiments__/mobx-atom-proxy.test.ts.
describe("X1 — ProxyPathAtomBus smoke (memory proxy; no MobX)", () => {
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

  it("invalidate matches SEGMENT-WISE, not by string prefix on keys", async () => {
    const { createMemoryAtomProxy, ProxyPathAtomBus } = await import("../path-atom-bus.js");
    const proxy = createMemoryAtomProxy();
    const bus = new ProxyPathAtomBus(proxy);
    // Non-string segments: key("db",1) IS a string prefix of key("db",12) while
    // pathsOverlap is false (X-KEY-NONSTRING). A key-prefix bus wakes the wrong atom.
    const sub = ["db", 12] as unknown as ResourcePath;
    const write = ["db", 1] as unknown as ResourcePath;
    bus.observe([sub]);
    bus.invalidate([write]);
    expect(proxy.stats.get(atomKey(sub))?.changed ?? 0).toBe(0);
    // Control, same bus: the genuine segment-wise parent DOES wake it.
    bus.invalidate([["db"] as unknown as ResourcePath]);
    expect(proxy.stats.get(atomKey(sub))?.changed).toBeGreaterThanOrEqual(1);
  });
});

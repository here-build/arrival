/**
 * LAW — Phase 5 reactivity X2a re-invoke + X5 door interop (gate 5b).
 *
 * Host reaction envelope over real top-level `exec`s sharing a ReactionHub.
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md
 *
 * Gather/burst pair (**OQ-BURST-CONFIRM**) loud-skips — no burst-commit hook named yet.
 * X2b scheduling cases live elsewhere (foreign-write driver timing).
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { MemoryEffectLog } from "../effect-log.js";
import {
  MemoryResourcePathLog,
  ResourcePathConflictError,
  type ResourcePathLog,
} from "../resource-paths.js";
import { createReactionHub } from "../reaction-envelope.js";
import { MemoryRunCache } from "../run-cache.js";

// ── Shared fake capability family ────────────────────────────────────────────

type SpyMap = Record<string, number>;

function makePathCap(spies: SpyMap) {
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

  const store = new Map<string, string>();

  const cap = EnvCapability.define("test/reaction-envelope", {
    symbols: (symbol, z) => ({
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string) => {
          track("read");
          return store.get(`${d}:${id}`) ?? `v1:${d}:${id}`;
        },
      ),
      "read-all": symbol.rosetta`read-all: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (d: string) => [["test", d]] as const,
        },
        (d: string) => {
          track("read-all");
          return `all:${d}`;
        },
      ),
      "read-decoded": symbol.rosetta`read-decoded: `(
        {
          input: [
            z.string,
            z.string.transform((s) => (s.startsWith("raw:") ? s.slice(4) : s)),
          ],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string) => {
          track("read-decoded");
          return `${d}:${id}`;
        },
      ),
      "read-parent": symbol.rosetta`read-parent: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (d: string) => [["test", d]] as const,
        },
        (d: string) => {
          track("read-parent");
          return `parent:${d}`;
        },
      ),
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string) => {
          track("write");
          store.set(`${d}:${id}`, `v2:${d}:${id}`);
          return undefined;
        },
      ),
      "write-val": symbol.rosetta`write-val: `(
        {
          input: [z.string, z.string, z.string],
          output: [z.undefinedResult],
          effects: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string, v: string) => {
          track("write-val");
          store.set(`${d}:${id}`, v);
          return undefined;
        },
      ),
      upsert: symbol.rosetta`upsert: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]] as const,
          effects: (d: string, id: string) => [["test", d, id]] as const,
        },
        (d: string, id: string) => {
          track("upsert");
          store.set(`${d}:${id}`, `up:${d}:${id}`);
          return `row:${d}:${id}`;
        },
      ),
      // three distinct domains for P-RX-WHOLE-UNIT / P-RX-LANE-REINVOKE
      "read-a": symbol.rosetta`read-a: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (id: string) => [["test", "A", id]] as const,
        },
        (id: string) => {
          track("read-a");
          return `A:${id}`;
        },
      ),
      "read-b": symbol.rosetta`read-b: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (id: string) => [["test", "B", id]] as const,
        },
        (id: string) => {
          track("read-b");
          return `B:${id}`;
        },
      ),
      "read-c": symbol.rosetta`read-c: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (id: string) => [["test", "C", id]] as const,
        },
        (id: string) => {
          track("read-c");
          return `C:${id}`;
        },
      ),
      "write-a": symbol.rosetta`write-a: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: (id: string) => [["test", "A", id]] as const,
        },
        (id: string) => {
          track("write-a");
          store.set(`A:${id}`, "w");
          return undefined;
        },
      ),
      "write-x": symbol.rosetta`write-x: `(
        {
          input: [],
          output: [z.undefinedResult],
          effects: () => [["test", "X"]] as const,
        },
        () => {
          track("write-x");
          return undefined;
        },
      ),
      "write-y": symbol.rosetta`write-y: `(
        {
          input: [],
          output: [z.undefinedResult],
          effects: () => [["test", "Y"]] as const,
        },
        () => {
          track("write-y");
          return undefined;
        },
      ),
      "read-x": symbol.rosetta`read-x: `(
        {
          input: [],
          output: [z.string],
          queries: () => [["test", "X"]] as const,
        },
        () => {
          track("read-x");
          return "x";
        },
      ),
      "read-y": symbol.rosetta`read-y: `(
        {
          input: [],
          output: [z.string],
          queries: () => [["test", "Y"]] as const,
        },
        () => {
          track("read-y");
          return "y";
        },
      ),
      "fail-impl": symbol.rosetta`fail-impl: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: (d: string) => [["test", d]] as const,
        },
        () => {
          track("fail-impl");
          throw new Error("plain-impl-boom");
        },
      ),
      "sink-gather": symbol.rosetta`sink-gather: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          provenance: "sink",
          effects: (d: string, id: string) => [["test", d, id]] as const,
        },
        () => {
          track("sink-gather");
          return undefined;
        },
      ),
      noop: symbol.rosetta`noop: `({ input: [z.string], output: [z.string] }, (x: string) => {
        track("noop");
        return x;
      }),
    }),
  });

  return { cap, pathLog, store };
}

// ── X2a positives ────────────────────────────────────────────────────────────

describe("X2a re-invoke positives (5b)", () => {
  it("P-RX-REINVOKE — foreign write wakes subscriber exactly once", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });

    await u.run();
    expect(u.runCount).toBe(1);
    expect(spies.read).toBe(1);

    await w.run();
    await hub.settle({ maxRounds: 8 });

    expect(u.runCount).toBe(2);
    expect(spies.read).toBe(2);
    expect(spies.write).toBe(1);
    hub.disposeAll();
  });

  it("P-RX-REINVOKE-DECODE — re-invoke on decoded key only", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read-decoded "D" "raw:42")', capabilities: [cap] });
    await u.run();
    expect(u.subscriptionPaths).toEqual([["test", "D", "42"]]);

    // write decoded id — wakes
    const w = hub.unit({ code: '(write "D" "42")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);

    // write raw form (different segment) — no wake
    const before = u.runCount;
    const wRaw = hub.unit({ code: '(write "D" "raw:42")', capabilities: [cap] });
    await wRaw.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(before);
    hub.disposeAll();
  });

  it("P-RX-PREFIX-UP — subscribe child, write parent → re-invoke", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "child")', capabilities: [cap] });
    await u.run();

    // parent write via read-parent's domain: effects on ["test","D"]
    // use write on a synthetic parent — write path is ["test","D","x"] which is child of parent
    // PREFIX-UP: subscribe child, write **parent**. Parent path = ["test","D"].
    // Our write fixture is 3-seg; use a unit that effects the parent via a custom path.
    // read-all observes parent ["test","D"]; for PREFIX-UP we need child sub + parent write.
    // Stage parent write through hub.invalidate as harness? X2a says no harness for production of run2 —
    // "second real top-level exec whose effects reach the shared host bus".
    // So need an effect fixture on parent. read-parent only queries. Add write via bare bus path:
    // Actually: write "D" "anything" is child of ["test","D"] — that's PREFIX-DOWN for a parent sub.
    // PREFIX-UP: sub=["test","D","child"], write=["test","D"].
    // Use hub.bus with a one-shot envelope that effects parent — we need a rosetta with effects: (d)=[["test",d]].
    // Fail-impl has that but throws. write-x uses ["test","X"]. Let's use bare hub.invalidate only as
    // RX-EXT for this path algebra case — suite X2a prefers real exec; I'll use a unit with effects
    // on the parent by writing through a custom cap method. Simpler: use `hub.bus` stage+commit
    // is not a real exec. Real path: extend with write-domain.

    // Practical approach matching product: foreign unit writes overlapping parent by
    // invalidating via a real effect on ["test","D"] — use fail-impl's domain shape via
    // a successful write-domain. Inject via second cap in same fixture:
    const parentCap = EnvCapability.define("test/rx-parent-write", {
      symbols: (symbol, z) => ({
        "write-domain": symbol.rosetta`write-domain: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: (d: string) => [["test", d]] as const,
          },
          () => undefined,
        ),
      }),
    });
    const w = hub.unit({
      code: '(write-domain "D")',
      capabilities: [cap, parentCap],
    });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });

  it("P-RX-PREFIX-DOWN — subscribe parent (read-all), write child → re-invoke", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read-all "D")', capabilities: [cap] });
    await u.run();
    expect(u.subscriptionPaths).toEqual([["test", "D"]]);

    const w = hub.unit({ code: '(write "D" "child")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    expect(spies["read-all"]).toBe(2);
    hub.disposeAll();
  });

  it("P-RX-CROSS-UNIT — unit A write wakes unit B subscribed to D", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const b = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    const a = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await b.run();
    await a.run();
    await hub.settle({ maxRounds: 8 });
    expect(b.runCount).toBe(2);
    expect(a.runCount).toBe(1); // effect-only, no self-wake
    hub.disposeAll();
  });

  it("P-RX-FRESH-EPOCH — re-invoke gets fresh path log, prior-E, record cache (A-EPOCH)", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    // legal lane: read then write same path
    const u = hub.unit({
      code: '(read "D" "id") (write "D" "id")',
      capabilities: [cap],
    });
    await u.run();
    const cache1 = u.lastCache;
    const log1 = u.lastPathLog;
    expect(cache1?.mode).toBe("record");
    expect(log1?.effectPaths.length).toBeGreaterThan(0);

    // foreign write to D wakes u (it observed D)
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    const cache2 = u.lastCache;
    const log2 = u.lastPathLog;
    // all three RX-FRESH axes
    expect(cache2).not.toBe(cache1);
    expect(cache2?.mode).toBe("record");
    expect(log2).not.toBe(log1);
    // run2 legal again — prior-E is fresh (write after read in same run still ok)
    expect(log2?.effectPaths).toEqual([["test", "D", "id"]]);
    hub.disposeAll();
  });

  it("P-RX-REINVOKE-SEES-NEW — run2 re-reads mutated backing store", async () => {
    const spies: SpyMap = {};
    const { cap, store } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    const v1 = await u.run();
    expect(v1).toEqual(["v1:D:id"]);

    store.set("D:id", "v2:from-foreign");
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    // write sets v2:D:id — check that
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    expect(u.lastResult).toEqual(["v2:D:id"]);
    hub.disposeAll();
  });

  it("N-RX-NO-CACHE-CARRYOVER — run2 has fresh RunCache; impl fires again", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u.run();
    const cache1 = u.lastCache!;
    // seed a value in run1's cache that would wrongly serve run2 if carried
    await cache1.set('poison', { kind: "value", value: "POISON" });

    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    expect(u.lastCache).not.toBe(cache1);
    expect(u.lastCache?.mode).toBe("record");
    expect(spies.read).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-REINVOKE-NOT-REPLAY — run2 cache mode is record", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u.run();
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.lastCache?.mode).toBe("record");
    hub.disposeAll();
  });

  it("P-RX-WHOLE-UNIT — write hits penetration 2's domain; all 3 impls re-fire", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(read-a "1") (read-b "1") (read-c "1")',
      capabilities: [cap],
    });
    await u.run();
    expect(spies["read-a"]).toBe(1);
    expect(spies["read-b"]).toBe(1);
    expect(spies["read-c"]).toBe(1);

    const w = hub.unit({ code: '(write-a "1")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    // whole unit — all three fire again
    expect(spies["read-a"]).toBe(2);
    expect(spies["read-b"]).toBe(2);
    expect(spies["read-c"]).toBe(2);
    hub.disposeAll();
  });

  it("P-RX-HYBRID — upsert unit re-invokes on foreign write; later overlapping read still doors", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(upsert "D" "id")', capabilities: [cap] });
    await u.run();
    expect(spies.upsert).toBe(1);

    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    expect(spies.upsert).toBe(2);

    // door still live inside a run: upsert (E on D) then read D → door
    await expect(
      exec('(upsert "D" "id") (read "D" "id")', {
        capabilities: [cap],
        resourcePaths: new MemoryResourcePathLog(),
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    hub.disposeAll();
  });

  it("P-RX-SUB-REPLACE — subs replaced, not accumulated, after successful run", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    let domain = "A";
    const u = hub.unit({
      code: () => `(read "${domain}" "id")`,
      capabilities: [cap],
    });
    await u.run();
    expect(u.subscriptionPaths).toEqual([["test", "A", "id"]]);

    // host param change → unit now reads B; force re-run by foreign write to A first,
    // then change domain for run2... Actually: change domain, then trigger via write A
    // would still use old code if we change after arm. Change domain, invalidate A won't
    // wake if we already replaced. Sequence from suite:
    // run1 reads A; run2 (host param changed) reads B; then write A → nothing; write B → one re-run.
    domain = "B";
    // Force run2 by direct run() — host re-instantiation with new param (not foreign path wake).
    // Suite: "run2 (host param changed) reads B" — then foreign writes test replacement.
    await u.run();
    expect(u.runCount).toBe(2);
    expect(u.subscriptionPaths).toEqual([["test", "B", "id"]]);
    expect(u.subscriptionPaths.some((p) => p[1] === "A")).toBe(false);

    const before = u.runCount;
    const wA = hub.unit({ code: '(write "A" "id")', capabilities: [cap] });
    await wA.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(before); // write A → nothing

    const wB = hub.unit({ code: '(write "B" "id")', capabilities: [cap] });
    await wB.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(before + 1); // write B → exactly one
    hub.disposeAll();
  });

  it("P-RX-DOOR-PERSISTS — failed re-run keeps last successful subs; later write re-invokes", async () => {
    // RX-SUBS: a run that doors keeps the last *successful* subscription set.
    // Arm on A, then a re-invoke that doors mid-body, then a further write to A still wakes.
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    let phase: "arm" | "door" | "ok" = "arm";
    const u = hub.unit({
      code: () => {
        if (phase === "arm") return '(read "A" "id")';
        if (phase === "door") return '(read "A" "id") (write "D" "id") (read "D" "id")';
        return '(read "A" "id")';
      },
      capabilities: [cap],
    });
    await u.run();
    expect(u.subscriptionPaths).toEqual([["test", "A", "id"]]);

    phase = "door";
    await expect(u.run()).rejects.toThrow(ResourcePathConflictError);
    // last successful subs retained — reactivity launders nothing
    expect(u.subscriptionPaths).toEqual([["test", "A", "id"]]);

    phase = "ok";
    const w = hub.unit({ code: '(write "A" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(3); // arm + door-fail + success re-invoke
    hub.disposeAll();
  });
});

// ── X2a negatives (A-CTRL-X2) ─────────────────────────────────────────────────

describe("X2a re-invoke negatives (5b)", () => {
  it("N-RX-SELF-LOOP — read+write same path does not re-trigger; foreign write does", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(read "D" "id") (write "D" "id")',
      capabilities: [cap],
    });
    await u.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1); // self-suppressed

    // A-CTRL-X2: foreign write → run2
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-SELF-LOOP-HYBRID — upsert does not self-wake; foreign write does", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(upsert "D" "id")', capabilities: [cap] });
    await u.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1);

    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-MUTUAL-LOOP — A↔B quiesces under settle (OQ-CYCLE-POLICY at-most-once)", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    // A: read X → write Y
    const a = hub.unit({ code: "(read-x) (write-y)", capabilities: [cap] });
    // B: read Y → write X
    const b = hub.unit({ code: "(read-y) (write-x)", capabilities: [cap] });

    await a.run(); // writes Y → B dirty once B has subs; B not armed yet
    await b.run(); // writes X → A dirty
    // After both initial runs: A dirty (from B's write X), B dirty (from A's write Y)?
    // Order: a.run commits write-y → b not registered with subs yet → no wake
    // Wait — b is already registered as envelope, but b.subs is empty until b.run.
    // a.run → publish Y, b.subs=[] → no wake
    // b.run → publish X, a.subs=[X] → a dirty
    // settle: a re-invokes → publish Y, b.subs=[Y] → b dirty
    // settle: b re-invokes → publish X, a already ran this settle → quiesce

    await hub.settle({ maxRounds: 8 });
    expect(a.runCount).toBe(2);
    expect(b.runCount).toBe(2);
    // quiesced — no throw
    await hub.settle({ maxRounds: 8 });
    expect(a.runCount).toBe(2);
    expect(b.runCount).toBe(2);
    hub.disposeAll();
  });

  it("RX-SETTLE — settle rejects loudly when maxRounds is 0 and work remains", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u.run();
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    // dirty set non-empty, maxRounds 0 → immediate loud reject
    await expect(hub.settle({ maxRounds: 0 })).rejects.toThrow(/did not quiesce in 0 rounds/);
    hub.disposeAll();
  });

  it("N-RX-SIBLING — subscribe …/D/a; write …/D/b → no re-invoke", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "a")', capabilities: [cap] });
    await u.run();
    const w = hub.unit({ code: '(write "D" "b")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1);
    // A-CTRL: write a does wake
    const w2 = hub.unit({ code: '(write "D" "a")', capabilities: [cap] });
    await w2.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-DISJOINT — subscribe domain A; write domain B → no re-invoke", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "A" "id")', capabilities: [cap] });
    await u.run();
    const w = hub.unit({ code: '(write "B" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1);
    const wA = hub.unit({ code: '(write "A" "id")', capabilities: [cap] });
    await wA.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-STRING-INT — subscribe …/projects; write …/project → no re-invoke", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "projects" "id")', capabilities: [cap] });
    await u.run();
    const w = hub.unit({ code: '(write "project" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1);
    hub.disposeAll();
  });

  it("N-RX-EFFECT-ONLY-DEAF — effect-only unit does not re-invoke on its domain", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await u.run();
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1);
    // cross-envelope control — weaker: query-arm unit on same domain does wake
    const q = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await q.run();
    const w2 = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w2.run();
    await hub.settle({ maxRounds: 8 });
    expect(q.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-DISPOSED — dispose freezes unit; foreign write does not re-invoke", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u.run();
    u.dispose();
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(1);
    expect(u.disposed).toBe(true);
    // cross-envelope control — weaker: pre-dispose same fixture would wake (separate unit)
    const u2 = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u2.run();
    const w2 = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w2.run();
    await hub.settle({ maxRounds: 8 });
    expect(u2.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-IMPL-THROW-NO-WAKE — failing effect run wakes nobody", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const sub = hub.unit({ code: '(read "D" "x")', capabilities: [cap] });
    await sub.run();
    const fail = hub.unit({ code: '(fail-impl "D")', capabilities: [cap] });
    await expect(fail.run()).rejects.toThrow(/plain-impl-boom/);
    await hub.settle({ maxRounds: 8 });
    expect(sub.runCount).toBe(1);
    // control: same domain succeeding wakes
    const ok = hub.unit({ code: '(write "D" "x")', capabilities: [cap] });
    await ok.run();
    await hub.settle({ maxRounds: 8 });
    expect(sub.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-IMPL-THROW-STAYS-ARMED — failed re-run keeps last successful subs", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    let boom = false;
    const u = hub.unit({
      code: () => (boom ? '(fail-impl "Z")' : '(read "D" "id")'),
      capabilities: [cap],
    });
    await u.run();
    expect(u.subscriptionPaths).toEqual([["test", "D", "id"]]);

    boom = true;
    // foreign write wakes; re-invoke throws
    const w = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w.run();
    // settle will reject when reinvoke throws — catch and continue
    await expect(hub.settle({ maxRounds: 8 })).rejects.toThrow(/plain-impl-boom/);
    // subs still {D}
    expect(u.subscriptionPaths).toEqual([["test", "D", "id"]]);
    boom = false;
    // subsequent write to D re-invokes again
    const w2 = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await w2.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(3); // initial + fail + success
    hub.disposeAll();
  });

  it("N-RX-PARTIAL-RUN-INVAL — write then door in same run does not wake subscribers", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const sub = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await sub.run();

    const partial = hub.unit({
      code: '(write "D" "id") (read "D" "id")',
      capabilities: [cap],
    });
    await expect(partial.run()).rejects.toThrow(ResourcePathConflictError);
    await hub.settle({ maxRounds: 8 });
    expect(sub.runCount).toBe(1); // per-run-commit grain: abandoned

    // control: successful write wakes
    const ok = hub.unit({ code: '(write "D" "id")', capabilities: [cap] });
    await ok.run();
    await hub.settle({ maxRounds: 8 });
    expect(sub.runCount).toBe(2);
    hub.disposeAll();
  });
});

// ── Gather pair — loud-skip until OQ-BURST-CONFIRM ───────────────────────────

const BURST_HOOK_NAMED = false; // flip when burst-commit invalidation hook is named

describe.skipIf(!BURST_HOOK_NAMED)("X2a gather clock (blocked on OQ-BURST-CONFIRM)", () => {
  it("P-RX-GATHER-INVAL-ON-COMMIT — sink gather invalidates at burst commit", async () => {
    console.warn(
      "[loud-skip] P-RX-GATHER-INVAL-ON-COMMIT: OQ-BURST-CONFIRM — burst-commit hook not named",
    );
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const effects = new MemoryEffectLog();
    const hub = createReactionHub();
    const sub = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await sub.run();
    const g = hub.unit({
      code: '(sink-gather "D" "id")',
      capabilities: [cap],
      effects,
    });
    await g.run();
    expect(effects.entries).toHaveLength(1);
    // would drive burst commit here once hook exists
    await hub.settle({ maxRounds: 8 });
    expect(sub.runCount).toBe(2);
    hub.disposeAll();
  });

  it("N-RX-GATHER-NO-INVAL-PRE-COMMIT — no wake before burst commit", async () => {
    console.warn(
      "[loud-skip] N-RX-GATHER-NO-INVAL-PRE-COMMIT: OQ-BURST-CONFIRM — burst-commit hook not named",
    );
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const effects = new MemoryEffectLog();
    const hub = createReactionHub();
    const sub = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await sub.run();
    const g = hub.unit({
      code: '(sink-gather "D" "id")',
      capabilities: [cap],
      effects,
    });
    await g.run();
    await hub.settle({ maxRounds: 8 });
    expect(sub.runCount).toBe(1);
    hub.disposeAll();
  });
});

// Always-visible loud-skip markers so CI logs show the blocked rows.
describe("X2a gather clock — loud-skip markers (OQ-BURST-CONFIRM)", () => {
  it("loud-skips P-RX-GATHER-INVAL-ON-COMMIT and N-RX-GATHER-NO-INVAL-PRE-COMMIT", () => {
    if (!BURST_HOOK_NAMED) {
      console.warn(
        "[loud-skip] gather pair blocked on OQ-BURST-CONFIRM (burst-commit invalidation hook unnamed)",
      );
    }
    expect(BURST_HOOK_NAMED).toBe(false);
  });
});

// ── X5 door interop ──────────────────────────────────────────────────────────

describe("X5 door interop (5b)", () => {
  it("N-RX-CROSS-EPOCH-DOOR — re-invoke has fresh prior-E; read after write does not door", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();

    // Control: same read inside run1 doors
    await expect(
      exec('(write "D" "id") (read "D" "id")', {
        capabilities: [cap],
        resourcePaths: new MemoryResourcePathLog(),
      }),
    ).rejects.toThrow(ResourcePathConflictError);

    // Real re-invoke path: unit reads trigger T, then (run1) writes D / (run2) reads D
    let phase: "write" | "read" = "write";
    const u = hub.unit({
      code: () =>
        phase === "write"
          ? '(read "T" "go") (write "D" "id")'
          : '(read "T" "go") (read "D" "id")',
      capabilities: [cap],
    });
    await u.run();
    expect(u.runCount).toBe(1);
    phase = "read";
    // foreign write on T → re-invoke with fresh prior-E; read D is legal
    const w = hub.unit({ code: '(write "T" "go")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    expect(u.lastPathLog?.effectPaths ?? []).toEqual([]); // read-only run2
    hub.disposeAll();
  });

  it("P-RX-LANE-REINVOKE — write on lane A re-invokes whole multi-lane unit once", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(read-a "1") (read-b "1") (read-c "1")',
      capabilities: [cap],
    });
    await u.run();
    const w = hub.unit({ code: '(write-a "1")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    expect(spies["read-a"]).toBe(2);
    expect(spies["read-b"]).toBe(2);
    expect(spies["read-c"]).toBe(2);
    hub.disposeAll();
  });

  it("P-RX-REPLAY-DOOR-LIVE — replay-mode still doors on illegal N-I1 shape", async () => {
    // Reactivity silence must NOT short-circuit CQS. Constructed with bare exec + replay
    // cache (not envelope — envelope always uses record). Door is pre-cache.
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const replay = new MemoryRunCache("replay");
    await expect(
      exec('(write "D" "id") (read "D" "id")', {
        capabilities: [cap],
        cache: replay,
        resourcePaths: new MemoryResourcePathLog(),
      }),
    ).rejects.toThrow(ResourcePathConflictError);
  });

  it("X-KEY-GUARD-SPACE — guard equality vs atom prefix are separate relations", async () => {
    // Behavioral: prefix-related child write wakes parent sub (atoms);
    // read-guard key equality is not under test here beyond co-existence.
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read-all "D")', capabilities: [cap] });
    await u.run();
    // child write overlaps by prefix (atoms) even though serialized keys differ
    const w = hub.unit({ code: '(write "D" "child")', capabilities: [cap] });
    await w.run();
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    // sibling does not
    const u2 = hub.unit({ code: '(read "D" "a")', capabilities: [cap] });
    await u2.run();
    const wSib = hub.unit({ code: '(write "D" "b")', capabilities: [cap] });
    await wSib.run();
    await hub.settle({ maxRounds: 8 });
    expect(u2.runCount).toBe(1);
    hub.disposeAll();
  });
});

// ── Bare hub.bus writer (cross-unit without second envelope) ──────────────────

describe("ReactionHub.bus bare exec writer", () => {
  it("bare exec on hub.bus wakes envelope subscribers", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u.run();
    await exec('(write "D" "id")', {
      capabilities: [cap],
      pathAtoms: hub.bus,
      strictCQSstrings: true,
    });
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });

  it("hub.invalidate harness shortcut wakes subscribers (RX-EXT)", async () => {
    const spies: SpyMap = {};
    const { cap } = makePathCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({ code: '(read "D" "id")', capabilities: [cap] });
    await u.run();
    hub.invalidate([["test", "D", "id"]]);
    await hub.settle({ maxRounds: 8 });
    expect(u.runCount).toBe(2);
    hub.disposeAll();
  });
});

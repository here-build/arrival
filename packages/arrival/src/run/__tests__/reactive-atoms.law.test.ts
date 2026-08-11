/**
 * LAW — Phase 5 X6 in-symbol reactiveAtoms (R6–R8).
 *
 * Product: CallCtx.reactiveAtoms — Q-membership-gated get → reportObserved /
 * reportChanged on the path-atom bus (01-unified-design §6.3).
 *
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/reactivity/SUITE.md §X6
 * Review: test-suite-design/reactivity/rounds/r6-ideas-review-opus.md
 *
 * Gate policy: red is not information — loud-skip until R6 wires mint
 * (mirror OQ-BURST-CONFIRM / reaction-envelope gather pair).
 */
import { beforeEach, describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import type { CallCtx } from "../CallCtx.js";
import { MemoryEffectLog } from "../effect-log.js";
import { createReactionHub } from "../reaction-envelope.js";
import {
  MemoryResourcePathLog,
  ResourcePathConflictError,
  type ResourcePath,
} from "../resource-paths.js";
import { ReactiveAtomMembershipError } from "../reactive-atoms.js";
import { atomKey, MemoryPathAtomBus } from "../path-atom-bus.js";

// Flip when CallCtx.reactiveAtoms is minted after CQS (R6).
const R6_WIRED = true;

if (!R6_WIRED) {
  console.warn(
    "[loud-skip] X6 reactive-atoms.law: R6 unwired (CallCtx.reactiveAtoms not minted after CQS)",
  );
}

// ── Harness ──────────────────────────────────────────────────────────────────

type SpyMap = Record<string, number>;

/** Explicit-bridge counters — auto-observe does not touch these (RX-ATOM-AUTO / idea D). */
const bridge = {
  observed: 0,
  changed: 0,
  reset() {
    this.observed = 0;
    this.changed = 0;
  },
};

const changeStash: {
  cell: { reportChanged(): void } | null;
  path: ResourcePath | null;
} = { cell: null, path: null };

function makeBridgeCap(spies: SpyMap) {
  const track = (name: string) => {
    spies[name] = (spies[name] ?? 0) + 1;
  };
  const store = new Map<string, string>();

  const requireAtoms = (ctx: CallCtx, verb: string) => {
    const atoms = ctx.reactiveAtoms;
    if (atoms === undefined) {
      // Product may throw facility-off MembershipError, or leave undefined.
      // Fixture surfaces a loud product-shaped failure for N-RX-ATOM-OFF until R6.
      throw new ReactiveAtomMembershipError(verb, [], "facility-off");
    }
    return atoms;
  };

  /** Wrap product cell so harness can count explicit reportObserved/Changed. */
  const instrument = (cell: { reportObserved(): void; reportChanged(): void }) => ({
    reportObserved() {
      bridge.observed++;
      cell.reportObserved();
    },
    reportChanged() {
      bridge.changed++;
      cell.reportChanged();
    },
  });

  const cap = EnvCapability.define("test/reactive-atoms-x6", {
    symbols: (symbol, z) => ({
      "view-bridge": symbol.rosetta`view-bridge: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("view-bridge");
          const path: ResourcePath = ["test", d, id];
          const atoms = requireAtoms(this, "view-bridge");
          instrument(atoms.get(path)).reportObserved();
          return store.get(`${d}:${id}`) ?? `${d}:${id}`;
        },
      ),
      "view-change": symbol.rosetta`view-change: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("view-change");
          const path: ResourcePath = ["test", d, id];
          const atoms = requireAtoms(this, "view-change");
          const cell = instrument(atoms.get(path));
          cell.reportObserved();
          changeStash.cell = cell;
          changeStash.path = path;
          return store.get(`${d}:${id}`) ?? `${d}:${id}`;
        },
      ),
      "view-bad-get": symbol.rosetta`view-bad-get: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("view-bad-get");
          const atoms = requireAtoms(this, "view-bad-get");
          atoms.get(["test", d, "other"]);
          return "should-not-reach";
        },
      ),
      "write-only-get": symbol.rosetta`write-only-get: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: (d: string, id: string) => [["test", d, id]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("write-only-get");
          const atoms = requireAtoms(this, "write-only-get");
          // Q is empty for this symbol — get must reject (effects-only or not-in-q)
          atoms.get(["test", d, id]);
          return undefined;
        },
      ),
      "view-prefix-q": symbol.rosetta`view-prefix-q: `(
        {
          input: [z.string],
          output: [z.string],
          queries: (d: string) => [["test", d]],
        },
        function (this: CallCtx, d: string) {
          track("view-prefix-q");
          const atoms = requireAtoms(this, "view-prefix-q");
          atoms.get(["test", d, "child"]);
          return "should-not-reach";
        },
      ),
      /**
       * Split hybrid: Q and E on **disjoint** paths so "Q half only" is falsifiable.
       * Q = [[test,d,id]]  E = [[test,d,"log"]]
       */
      "hybrid-split": symbol.rosetta`hybrid-split: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
          effects: (d: string, id: string) => [["test", d, "log"]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("hybrid-split");
          const atoms = requireAtoms(this, "hybrid-split");
          instrument(atoms.get(["test", d, id])).reportObserved();
          return `row:${d}:${id}`;
        },
      ),
      "hybrid-split-e-get": symbol.rosetta`hybrid-split-e-get: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
          effects: (d: string, _id: string) => [["test", d, "log"]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("hybrid-split-e-get");
          const atoms = requireAtoms(this, "hybrid-split-e-get");
          // E half only — must reject with effects-only (or not-in-q if E not closed over)
          atoms.get(["test", d, "log"]);
          return "should-not-reach";
        },
      ),
      /**
       * Mid-impl reportChanged then returns — used with write+read for RX-ATOM-CLOCK
       * (change must not weaken intervening-E door on a later Q).
       */
      "view-then-change": symbol.rosetta`view-then-change: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
        },
        function (this: CallCtx, d: string, id: string) {
          track("view-then-change");
          const path: ResourcePath = ["test", d, id];
          const atoms = requireAtoms(this, "view-then-change");
          const cell = instrument(atoms.get(path));
          cell.reportObserved();
          cell.reportChanged(); // mid-impl — must not license later overlapping Q same run
          return `${d}:${id}`;
        },
      ),
      /** A-CTRL: real path-E for EffectLog comparison. */
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: (d: string, id: string) => [["test", d, id]],
        },
        () => {
          track("write");
          return undefined;
        },
      ),
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: (d: string, id: string) => [["test", d, id]],
        },
        (d: string, id: string) => {
          track("read");
          return `${d}:${id}`;
        },
      ),
    }),
  });

  return { cap, store };
}

const k = (...segs: string[]) => atomKey(segs);

function unwrapMembership(err: unknown): ReactiveAtomMembershipError {
  if (err instanceof ReactiveAtomMembershipError) return err;
  // Defence if anything still wraps
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (cause instanceof ReactiveAtomMembershipError) return cause;
  throw err;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!R6_WIRED)("X6 in-symbol reactiveAtoms — 5c membership", () => {
  beforeEach(() => {
    bridge.reset();
    changeStash.cell = null;
    changeStash.path = null;
  });

  it("P-RX-ATOM-DEFINED — pathAtoms armed ⇒ reactiveAtoms defined in impl", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    await exec('(view-bridge "D" "id")', {
      capabilities: [cap],
      pathAtoms: bus,
      resourcePaths: new MemoryResourcePathLog(),
    });
    expect(spies["view-bridge"]).toBe(1);
    expect(bridge.observed).toBe(1); // explicit bridge, not only membrane auto-observe
  });

  it("P-RX-ATOM-Q-MEMBER — get(Q-path)+reportObserved increments explicit bridge counter", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    await exec('(view-bridge "D" "id")', {
      capabilities: [cap],
      pathAtoms: bus,
      resourcePaths: new MemoryResourcePathLog(),
    });
    expect(spies["view-bridge"]).toBe(1);
    expect(bridge.observed).toBeGreaterThanOrEqual(1);
    // Membrane may also observe — bus set is necessary but not sufficient alone
    expect(bus.observed.has(k("test", "D", "id"))).toBe(true);
  });

  it("N-RX-ATOM-NOT-IN-Q — get(undeclared) ⇒ membership not-in-q; impl ran", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    try {
      await exec('(view-bad-get "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: new MemoryResourcePathLog(),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(ResourcePathConflictError);
      const m = unwrapMembership(err);
      expect(m.reason).toBe("not-in-q");
      expect(m.name).toBe("ReactiveAtomMembershipError");
    }
    expect(spies["view-bad-get"]).toBe(1);
  });

  it("N-RX-ATOM-E-ONLY — effects-only symbol get ⇒ membership; impl ran", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    try {
      await exec('(write-only-get "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: new MemoryResourcePathLog(),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(ResourcePathConflictError);
      const m = unwrapMembership(err);
      // effects-only or not-in-q both acceptable teaching labels for Q=[]
      expect(["effects-only", "not-in-q"]).toContain(m.reason);
    }
    expect(spies["write-only-get"]).toBe(1);
  });

  it("N-RX-ATOM-PREFIX-STRICT — get(child) when Q is parent ⇒ not-in-q; impl ran", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    try {
      await exec('(view-prefix-q "D")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: new MemoryResourcePathLog(),
      });
      expect.unreachable();
    } catch (err) {
      const m = unwrapMembership(err);
      expect(m.reason).toBe("not-in-q");
    }
    expect(spies["view-prefix-q"]).toBe(1);
  });

  it("P-RX-ATOM-HYBRID-Q-ONLY — split hybrid may get Q path", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    await exec('(hybrid-split "D" "id")', {
      capabilities: [cap],
      pathAtoms: bus,
      resourcePaths: new MemoryResourcePathLog(),
    });
    expect(spies["hybrid-split"]).toBe(1);
    expect(bridge.observed).toBe(1);
  });

  it("N-RX-ATOM-HYBRID-E-PATH — split hybrid get(E-path) rejects", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    try {
      await exec('(hybrid-split-e-get "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: new MemoryResourcePathLog(),
      });
      expect.unreachable();
    } catch (err) {
      const m = unwrapMembership(err);
      expect(["effects-only", "not-in-q"]).toContain(m.reason);
    }
    expect(spies["hybrid-split-e-get"]).toBe(1);
  });

  it("N-RX-ATOM-OFF — without pathAtoms, no silent success", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    try {
      await exec('(view-bridge "D" "id")', {
        capabilities: [cap],
        resourcePaths: new MemoryResourcePathLog(),
      });
      expect.unreachable();
    } catch (err) {
      // Product: undefined handle → fixture MembershipError facility-off, or product equivalent
      const m = unwrapMembership(err);
      expect(m.reason).toBe("facility-off");
    }
    // Must not have completed as a successful store read with bridge
    expect(bridge.observed).toBe(0);
  });
});

describe.skipIf(!R6_WIRED)("X6 in-symbol reactiveAtoms — 5d wake/dispose", () => {
  beforeEach(() => {
    bridge.reset();
    changeStash.cell = null;
    changeStash.path = null;
  });

  /**
   * RX-ATOM-SELF-WAKE (frozen for suite): bridge reportChanged is store liveness,
   * not a unit's declared effect — the observing unit **does** re-invoke (unlike RX-SELF
   * for own E). Bounded by settle at-most-once-per-unit per settle call.
   */
  it("P-RX-ATOM-CHANGED-WAKE — reportChanged re-invokes observing unit once (self-wake ok)", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(view-change "D" "id")',
      capabilities: [cap],
    });
    await u.run();
    expect(spies["view-change"]).toBe(1);
    expect(changeStash.cell).not.toBeNull();
    expect(bridge.observed).toBe(1);
    changeStash.cell!.reportChanged();
    expect(bridge.changed).toBe(1);
    await hub.settle({ maxRounds: 4 });
    expect(u.runCount).toBe(2);
    expect(spies["view-change"]).toBe(2);
    hub.disposeAll();
  });

  it("P-RX-ATOM-CHANGED-FRESH — re-invoke is RX-FRESH (A-EPOCH)", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(view-change "D" "id")',
      capabilities: [cap],
    });
    await u.run();
    const cache1 = u.lastCache;
    const log1 = u.lastPathLog;
    expect(cache1?.mode).toBe("record");
    changeStash.cell!.reportChanged();
    await hub.settle({ maxRounds: 4 });
    expect(u.runCount).toBe(2);
    expect(u.lastCache).not.toBe(cache1);
    expect(u.lastCache?.mode).toBe("record");
    expect(u.lastPathLog).not.toBe(log1);
    // Fresh prior-E: re-run is a clean query, not carrying prior-run E
    expect(u.lastPathLog?.effectPaths ?? []).toEqual([]);
    hub.disposeAll();
  });

  it("P-RX-ATOM-CROSS-UNIT — bridge change wakes *other* unit (other.runCount === 2)", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    const hub = createReactionHub();
    const changer = hub.unit({
      code: '(view-change "D" "id")',
      capabilities: [cap],
    });
    const other = hub.unit({
      code: '(view-bridge "D" "id")',
      capabilities: [cap],
    });
    await changer.run();
    await other.run();
    expect(changer.runCount).toBe(1);
    expect(other.runCount).toBe(1);
    changeStash.cell!.reportChanged();
    await hub.settle({ maxRounds: 4 });
    // Cross-unit: other must wake. Changer may also self-wake (RX-ATOM-SELF-WAKE).
    expect(other.runCount).toBe(2);
    expect(changer.runCount).toBeGreaterThanOrEqual(1);
    expect(changer.runCount).toBeLessThanOrEqual(2);
    hub.disposeAll();
  });

  it("P-RX-ATOM-≠-EFFECT-LOG — reportChanged does not enqueue EffectLog (A-CTRL write does)", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    const effects = new MemoryEffectLog();
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(view-change "D" "id")',
      capabilities: [cap],
      effects,
    });
    await u.run();
    expect(effects.entries).toHaveLength(0);
    changeStash.cell!.reportChanged();
    await hub.settle({ maxRounds: 4 });
    expect(effects.entries).toHaveLength(0);
    // A-CTRL: same channel can still log a real path-E write
    const w = hub.unit({
      code: '(write "D" "id")',
      capabilities: [cap],
      effects,
    });
    await w.run();
    expect(effects.entries.length).toBeGreaterThanOrEqual(1);
    hub.disposeAll();
  });

  it("N-RX-ATOM-NO-SAME-RUN-Q — mid-impl reportChanged then write; later read still doors", async () => {
    const spies: SpyMap = {};
    const bus = new MemoryPathAtomBus();
    const { cap } = makeBridgeCap(spies);
    // view-then-change (Q + mid reportChanged) → write (E) → read (Q) = intervening door
    await expect(
      exec('(view-then-change "D" "id") (write "D" "id") (read "D" "id")', {
        capabilities: [cap],
        pathAtoms: bus,
        resourcePaths: new MemoryResourcePathLog(),
      }),
    ).rejects.toBeInstanceOf(ResourcePathConflictError);
    expect(spies["view-then-change"]).toBe(1);
    expect(spies.write).toBe(1);
    expect(spies.read ?? 0).toBe(0);
    expect(bridge.changed).toBe(1);
  });

  it("P-RX-ATOM-DISPOSE — disposed unit silent; neighbour wakes (A-CTRL)", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    const hub = createReactionHub();
    const dead = hub.unit({
      code: '(view-change "D" "id")',
      capabilities: [cap],
    });
    const alive = hub.unit({
      code: '(view-bridge "D" "id")',
      capabilities: [cap],
    });
    await dead.run();
    await alive.run();
    const cell = changeStash.cell!;
    const deadCount = dead.runCount;
    dead.dispose();
    cell.reportChanged();
    await hub.settle({ maxRounds: 4 });
    expect(dead.runCount).toBe(deadCount);
    expect(alive.runCount).toBe(2);
    hub.disposeAll();
  });

  it("P-RX-ATOM-SUPERSEDE — after re-invoke, only live unit wakes (stale cell no double-fire)", async () => {
    const spies: SpyMap = {};
    const { cap } = makeBridgeCap(spies);
    const hub = createReactionHub();
    const u = hub.unit({
      code: '(view-change "D" "id")',
      capabilities: [cap],
    });
    await u.run();
    const cellRun1 = changeStash.cell!;
    // First change → re-invoke installs run-2 cell
    cellRun1.reportChanged();
    await hub.settle({ maxRounds: 4 });
    expect(u.runCount).toBe(2);
    const cellRun2 = changeStash.cell!;
    expect(cellRun2).not.toBeNull();
    const countAfter = u.runCount;
    // Stale run-1 cell must not schedule another wake (R7 dispose of prior bridge)
    cellRun1.reportChanged();
    await hub.settle({ maxRounds: 4 });
    expect(u.runCount).toBe(countAfter);
    // Live cell still works
    cellRun2.reportChanged();
    await hub.settle({ maxRounds: 4 });
    expect(u.runCount).toBe(countAfter + 1);
    hub.disposeAll();
  });
});

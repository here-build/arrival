/**
 * LAW — resource-path CQS door (Phase 3a / suite S1 core + 3a-complete door-only).
 *
 * After a domain has been effected this run, a new query genesis that overlaps
 * that effect is structurally illegal. Everything else is free (lanes, hold
 * results, Q→Q, effects-only). Paths come from contract producers after decode,
 * never from impl return.
 *
 * Suite: docs/working-proposals/cqs-reactivity/test-suite-design/SUITE.md
 */
import { describe, it, expect } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { exec } from "../../eval/generator-exec.js";
import { CONSTANT_CTX, RunContext } from "../RunContext.js";
import { MemoryRunCache } from "../run-cache.js";
import { MemoryEffectLog } from "../effect-log.js";
import { testCallCtx } from "../../symbol/index.js";
import {
  MemoryResourcePathLog,
  ResourcePathConflictError,
  ResourcePathProducerError,
  applyResourcePathCqs,
  type ResourcePath,
  type ResourcePathLog,
} from "../resource-paths.js";

// ── Fake capability family (SUITE §Fake capability family) ───────────────────

type SpyMap = Record<string, number>;

function makePathCap(spies: SpyMap, opts?: { pathFnThrow?: "queries" | "effects" }) {
  const pathFnCalls: { axis: "q" | "e"; name: string }[] = [];
  const appendEvents: ResourcePath[][] = [];
  const base = new MemoryResourcePathLog();

  /** Test-only append-on-pass spy (R-HARNESS-SPY) — records only when product records. */
  const pathLog: ResourcePathLog = {
    get effectPaths() {
      return base.effectPaths;
    },
    recordEffects(paths) {
      appendEvents.push(paths.map((p) => [...p]));
      base.recordEffects(paths);
    },
  };

  const track = (name: string) => {
    spies[name] = (spies[name] ?? 0) + 1;
  };

  const q =
    (name: string, fn: (...a: string[]) => ResourcePath[]) =>
    (...a: string[]) => {
      pathFnCalls.push({ axis: "q", name });
      if (opts?.pathFnThrow === "queries") throw new Error("path-fn-queries-boom");
      return fn(...a);
    };
  const e =
    (name: string, fn: (...a: string[]) => ResourcePath[]) =>
    (...a: string[]) => {
      pathFnCalls.push({ axis: "e", name });
      if (opts?.pathFnThrow === "effects") throw new Error("path-fn-effects-boom");
      return fn(...a);
    };

  const cap = EnvCapability.define("test/resource-path-cqs", {
    symbols: (symbol, z) => ({
      read: symbol.rosetta`read: `(
        {
          input: [z.string, z.string],
          output: [z.string],
          queries: q("read", (d, id) => [["test", d, id]]),
        },
        (d: string, id: string) => {
          track("read");
          return `${d}:${id}`;
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
      write: symbol.rosetta`write: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          effects: e("write", (d, id) => [["test", d, id]]),
        },
        (_d: string, _id: string) => {
          track("write");
          return undefined;
        },
      ),
      "write-all": symbol.rosetta`write-all: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          effects: e("write-all", (d) => [["test", d]]),
        },
        (_d: string) => {
          track("write-all");
          return undefined;
        },
      ),
      "write-many": symbol.rosetta`write-many: `(
        {
          input: [z.string, z.string, z.string],
          output: [z.undefinedResult],
          effects: e("write-many", (d, id1, id2) => [
            ["test", d, id1],
            ["test", d, id2],
          ]),
        },
        () => {
          track("write-many");
          return undefined;
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
      move: symbol.rosetta`move: `(
        {
          input: [z.string, z.string],
          output: [z.undefinedResult],
          // Q = src tree, E = dst tree (disjoint hybrid)
          queries: q("move", (src) => [["test", src]]),
          effects: e("move", (_src, dst) => [["test", dst]]),
        },
        () => {
          track("move");
          return undefined;
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
      // Path fns name nothing under test/D; impl "would" touch D — must not feed prior E.
      "impl-only-touch": symbol.rosetta`impl-only-touch: `(
        {
          input: [z.string],
          output: [z.undefinedResult],
          // empty contribution: declared axis present but no path (R-O6: fn called)
          effects: e("impl-only-touch", () => []),
        },
        () => {
          track("impl-only-touch");
          // would touch ["test","D"] in a real host — paths not from impl
          return undefined;
        },
      ),
      // Decode non-trivial: raw id "raw:42" → decoded segment "42"
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
      "write-decoded": symbol.rosetta`write-decoded: `(
        {
          input: [
            z.string,
            z.string.transform((s) => (s.startsWith("raw:") ? s.slice(4) : s)),
          ],
          output: [z.undefinedResult],
          effects: e("write-decoded", (d, id) => [["test", d, id]]),
        },
        () => {
          track("write-decoded");
          return undefined;
        },
      ),
    }),
  });

  return { cap, pathLog, pathFnCalls, appendEvents };
}

async function run(
  code: string,
  spies: SpyMap = {},
  extra?: { pathFnThrow?: "queries" | "effects"; pathLog?: ResourcePathLog },
) {
  const { cap, pathLog, pathFnCalls, appendEvents } = makePathCap(spies, {
    pathFnThrow: extra?.pathFnThrow,
  });
  const log = extra?.pathLog ?? pathLog;
  const runCtx = new RunContext({ resourcePaths: log });
  const result = await exec(code, { capabilities: [cap], runCtx });
  return { result, spies, pathFnCalls, appendEvents, pathLog: log };
}

function expectDoor(err: unknown): asserts err is ResourcePathConflictError {
  expect(err).toBeInstanceOf(ResourcePathConflictError);
}

/** A-QUAD: discriminator; doored impl=0; doored symbol's path fns ran; prior impls unchanged. */
function aQuad(
  err: unknown,
  spies: SpyMap,
  pathFnCalls: { axis: "q" | "e"; name: string }[],
  dooredSymbol: string,
  priorSpies: SpyMap,
) {
  expectDoor(err);
  expect((err as ResourcePathConflictError)["arrival/error-category"]).toBe("domain-immutability");
  expect(spies[dooredSymbol] ?? 0).toBe(0);
  expect(pathFnCalls.some((c) => c.name === dooredSymbol)).toBe(true);
  for (const [k, v] of Object.entries(priorSpies)) {
    expect(spies[k] ?? 0).toBe(v);
  }
}

// ── S1 Core positives ────────────────────────────────────────────────────────

describe("resource-path CQS door — core positives", () => {
  it("P-I3 — effects only, repeats / overlapping E never door", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (write "a" "1") (write-all "a")', spies);
    expect(spies.write).toBe(2);
    expect(spies["write-all"]).toBe(1);
  });

  it("P-I4 — read then write same tree", async () => {
    const spies: SpyMap = {};
    await run('(read "a" "1") (write "a" "1")', spies);
    expect(spies.read).toBe(1);
    expect(spies.write).toBe(1);
  });

  it("P-I4b — use query result after effects (no second read)", async () => {
    const spies: SpyMap = {};
    const { result } = await run(
      '(define r (read "a" "1")) (write "a" "1") r',
      spies,
    );
    expect(spies.read).toBe(1);
    expect(spies.write).toBe(1);
    // last form is held binding from first read — value is domain:id
    expect(result.at(-1)).toBe("a:1");
  });

  it("P-I2 — sibling write then read", async () => {
    const spies: SpyMap = {};
    await run('(write "a" "1") (read "a" "2")', spies);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-LANE — multi-domain interleave; A post-effect while B queries", async () => {
    const spies: SpyMap = {};
    await run(
      '(write "A" "1") (read "B" "1") (write "B" "1") (read "C" "9") (read "B" "2")',
      spies,
    );
    expect(spies.write).toBe(2);
    expect(spies.read).toBe(3);
  });

  it("P-QQ — query never doors query", async () => {
    const spies: SpyMap = {};
    await run('(read "a" "1") (read "a" "1")', spies);
    expect(spies.read).toBe(2);
  });

  it("P-I5 — dynamic ids from computed args; different ids no door", async () => {
    const spies: SpyMap = {};
    // id from string-append so path producers see runtime-computed decoded segments
    await run('(write "a" (string-append "i" "d1")) (read "a" (string-append "i" "d2"))', spies);
    expect(spies.write).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-DECODE — path fns use decoded form only", async () => {
    // Asymmetric raw vs decoded: write "raw:42" → E=["test","d","42"];
    // read "42" (already decoded shape) → Q=["test","d","42"] collides only if
    // path fns see decoded args. If they saw raw, write E would be …/"raw:42"
    // and would NOT prefix-overlap …/"42".
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents } = makePathCap(spies);
    await expect(
      exec('(write-decoded "d" "raw:42") (read-decoded "d" "42")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    expect(spies["write-decoded"]).toBe(1);
    expect(spies["read-decoded"] ?? 0).toBe(0);
    expect(appendEvents.flat()).toContainEqual(["test", "d", "42"]);
    expect(appendEvents.flat()).not.toContainEqual(["test", "d", "raw:42"]);
  });

  it("P-FRESH — fresh run has empty prior; prior run's effects do not carry", async () => {
    const spies1: SpyMap = {};
    await run('(write "a" "1")', spies1);
    const spies2: SpyMap = {};
    await run('(read "a" "1")', spies2);
    expect(spies2.read).toBe(1);
  });

  it("P-DISJOINT — effect A then query B", async () => {
    const spies: SpyMap = {};
    await run('(write "A" "1") (read "B" "1")', spies);
    expect(spies.read).toBe(1);
  });

  it("P-PATHS-NOT-IMPL — impl does not feed prior E; subsequent read of D no door", async () => {
    const spies: SpyMap = {};
    await run('(impl-only-touch "D") (read "D" "1")', spies);
    expect(spies["impl-only-touch"]).toBe(1);
    expect(spies.read).toBe(1);
  });

  it("P-HYBRID-FIRST — empty prior; single upsert no self-door", async () => {
    const spies: SpyMap = {};
    await run('(upsert "a" "1")', spies);
    expect(spies.upsert).toBe(1);
  });

  it("P-MOVE-OK — after move(s,d); read(s) legal", async () => {
    const spies: SpyMap = {};
    await run('(move "src" "dst") (read-all "src")', spies);
    expect(spies.move).toBe(1);
    expect(spies["read-all"]).toBe(1);
  });

  it("P-UNTRACKED — noop never doors and adds no prior E", async () => {
    const spies: SpyMap = {};
    await run('(noop "x") (write "a" "1") (noop "y") (read "b" "1")', spies);
    expect(spies.noop).toBe(2);
    expect(spies.read).toBe(1);
  });

  it("P-STRING-INT — effect …/project; query …/projects — no door (segment-wise)", async () => {
    const spies: SpyMap = {};
    await run('(write "project" "1") (read "projects" "1")', spies);
    expect(spies.read).toBe(1);
  });

  it("P-EMPTY-PATH — empty path list never doors and never appends", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents } = makePathCap(spies);
    // impl-only-touch declares effects: () => [] — empty contribution
    await exec('(impl-only-touch "D") (read "D" "1")', {
      capabilities: [cap],
      resourcePaths: pathLog,
    });
    expect(spies["impl-only-touch"]).toBe(1);
    expect(spies.read).toBe(1);
    expect(appendEvents.flat()).toEqual([]);
  });
});

// ── S1 Core negatives ────────────────────────────────────────────────────────

describe("resource-path CQS door — core negatives (A-QUAD)", () => {
  it("N-I1 — write D; read overlapping D", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(write "a" "1") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read", { write: 1 });
      const e = err as ResourcePathConflictError;
      expect(e.priorEffect).toEqual(["test", "a", "1"]);
      expect(e.thisQuery).toEqual(["test", "a", "1"]);
    }
  });

  it("N-PREFIX-↑ — write child; read parent", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(write "a" "1") (read-all "a")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read-all", { write: 1 });
    }
  });

  it("N-PREFIX-↓ — write parent; read child", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(write-all "a") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read", { "write-all": 1 });
    }
  });

  it("N-I4c — read; write; read again — door on second read", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(read "a" "1") (write "a" "1") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      // impl counts 1/1/0 — first read and write ran; second read doored
      expectDoor(err);
      expect(spies.read).toBe(1);
      expect(spies.write).toBe(1);
      expect(pathFnCalls.filter((c) => c.name === "read" && c.axis === "q").length).toBe(2);
    }
  });

  it("N-CROSS-SYMBOL — write via write-many; read via read (different symbols, shared path)", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(write-many "a" "1" "9") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read", { "write-many": 1 });
    }
  });

  it("N-PATHFN-THROW — queries() throws is not CQS door; impl=0", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies, { pathFnThrow: "queries" });
    try {
      await exec('(read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(ResourcePathConflictError);
      expect(err).toMatchObject({ name: "ResourcePathProducerError" });
      expect(String(err)).toMatch(/path-fn-queries-boom/);
      expect(spies.read ?? 0).toBe(0);
    }
  });

  it("N-PATHFN-THROW-E — effects() throws is not CQS door; impl=0", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies, { pathFnThrow: "effects" });
    try {
      await exec('(write "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).not.toBeInstanceOf(ResourcePathConflictError);
      expect(err).toMatchObject({ name: "ResourcePathProducerError" });
      expect(String(err)).toMatch(/path-fn-effects-boom/);
      expect(spies.write ?? 0).toBe(0);
    }
  });

  it("N-DISCRIM-CONTROL — failImpl plain error is not door; impl ran", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    await expect(
      exec('(fail-impl "a")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      }),
    ).rejects.toThrow(/plain-impl-boom/);
    expect(spies["fail-impl"]).toBe(1);
    expect(pathFnCalls.some((c) => c.axis === "e" && c.name === "fail-impl")).toBe(true);
  });
});

// ── S1 3a-complete (door-only) ───────────────────────────────────────────────

describe("resource-path CQS door — 3a-complete", () => {
  it("N-MULTI-E-PATHS — both ends of multi-path E door independently", async () => {
    for (const probe of ['(read "a" "1")', '(read "a" "2")'] as const) {
      const spies: SpyMap = {};
      const { cap, pathLog, pathFnCalls } = makePathCap(spies);
      try {
        await exec(`(write-many "a" "1" "2") ${probe}`, {
          capabilities: [cap],
          runCtx: new RunContext({ resourcePaths: pathLog }),
        });
        expect.unreachable();
      } catch (err) {
        aQuad(err, spies, pathFnCalls, "read", { "write-many": 1 });
      }
    }
  });

  it("N-MULTI-Q-PATHS — multi Q with one overlapping path doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(write "a" "1") (read-many "a" "x" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read-many", { write: 1 });
    }
  });

  it("N-HYBRID-AS-E — upsert then read overlapping doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(upsert "a" "1") (read "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read", { upsert: 1 });
    }
  });

  it("N-MOVE-E — after move(s,d); read(d) doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(move "src" "dst") (read-all "dst")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "read-all", { move: 1 });
    }
  });

  it("N-DOORED-E-NOT-RECORDED — doored move's E not on append spy", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents, pathFnCalls } = makePathCap(spies);
    try {
      // write src first so move's Q(src) doors; move's E(dst) must NOT record
      await exec('(write-all "src") (move "src" "dst")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      aQuad(err, spies, pathFnCalls, "move", { "write-all": 1 });
      // only write-all's E recorded — not move's dst
      const flat = appendEvents.flat();
      expect(flat).toContainEqual(["test", "src"]);
      expect(flat).not.toContainEqual(["test", "dst"]);
    }
  });

  it("N-E-IMPL-THROW — effect recorded before impl; later read doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    const runCtx = new RunContext({ resourcePaths: pathLog });
    // fail-impl records E then throws — subsequent read same run needs host continue.
    // We call two separate penetrations on the same runCtx via sequential exec with reuse.
    await expect(
      exec('(fail-impl "a")', { capabilities: [cap], runCtx }),
    ).rejects.toThrow(/plain-impl-boom/);
    expect(spies["fail-impl"]).toBe(1);
    // same runCtx — prior E still there
    await expect(
      exec('(read "a" "1")', { capabilities: [cap], runCtx }),
    ).rejects.toThrow(ResourcePathConflictError);
  });

  it("N-UPSERT-TWICE — second upsert same paths doors", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, pathFnCalls } = makePathCap(spies);
    try {
      await exec('(upsert "a" "1") (upsert "a" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResourcePathConflictError);
      expect(spies.upsert).toBe(1);
      expect(pathFnCalls.filter((c) => c.name === "upsert").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("N-DOOR-LOCUS — illegal Q only on A in multi-lane", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog } = makePathCap(spies);
    try {
      await exec('(write "A" "1") (read "B" "1") (read "A" "1")', {
        capabilities: [cap],
        runCtx: new RunContext({ resourcePaths: pathLog }),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ResourcePathConflictError);
      expect(spies.write).toBe(1);
      expect(spies.read).toBe(1); // B succeeded; A did not
    }
  });
});

describe("resource-path CQS — producer shape + strictCQSstrings", () => {
  it("default off — non-string segments do not throw (type-level is the law)", async () => {
    let fires = 0;
    const cap = EnvCapability.define("test/cqs-strict-off", {
      symbols: (symbol, z) => ({
        "write-num": symbol.rosetta`write-num: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: ((d: string) => [["test", d, 1 as unknown as string]]) as (
              d: string,
            ) => readonly (readonly string[])[],
          },
          () => {
            fires++;
            return undefined;
          },
        ),
      }),
    });
    await exec('(write-num "a")', { capabilities: [cap] });
    expect(fires).toBe(1);
  });

  it("strictCQSstrings true — non-string segment is type-mismatch, not CQS door", async () => {
    let fires = 0;
    const cap = EnvCapability.define("test/cqs-strict-on", {
      symbols: (symbol, z) => ({
        "write-num": symbol.rosetta`write-num: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: ((d: string) => [["test", d, 1 as unknown as string]]) as (
              d: string,
            ) => readonly (readonly string[])[],
          },
          () => {
            fires++;
            return undefined;
          },
        ),
      }),
    });
    await expect(
      exec('(write-num "a")', { capabilities: [cap], strictCQSstrings: true }),
    ).rejects.toBeInstanceOf(ResourcePathProducerError);
    expect(fires).toBe(0);
  });

  it("producer returns non-array top-level → ResourcePathProducerError (always)", () => {
    expect(() =>
      applyResourcePathCqs({
        verbName: "bad",
        decodedArgs: [],
        queries: (() => undefined) as any,
        log: new MemoryResourcePathLog(),
      }),
    ).toThrow(ResourcePathProducerError);
  });

  it("producer returns flat path instead of list-of-paths → ResourcePathProducerError", () => {
    expect(() =>
      applyResourcePathCqs({
        verbName: "flat",
        decodedArgs: [],
        effects: (() => ["test", "a", "1"]) as any,
        log: new MemoryResourcePathLog(),
      }),
    ).toThrow(/segment array|flat path/i);
  });
});

describe("resource-path CQS — seams (cache / burst / CONSTANT_CTX / ExecOptions)", () => {
  it("CQS runs before cache — write then identical view-read doors; first read cached once", async () => {
    let readFires = 0;
    let writeFires = 0;
    const cap = EnvCapability.define("test/cqs-cache", {
      symbols: (symbol, z) => ({
        "v-read": symbol.rosetta`v-read: `(
          {
            input: [z.string],
            output: [z.string],
            cacheClass: "view",
            queries: (id: string) => [["test", "v", id]],
          },
          (id: string) => {
            readFires++;
            return `val:${id}`;
          },
        ),
        "v-write": symbol.rosetta`v-write: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            effects: (id: string) => [["test", "v", id]],
          },
          () => {
            writeFires++;
            return undefined;
          },
        ),
      }),
    });
    const cache = new MemoryRunCache("record");
    await expect(
      exec('(v-read "1") (v-write "1") (v-read "1")', {
        capabilities: [cap],
        cache,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    expect(writeFires).toBe(1);
    expect(readFires).toBe(1); // second read doored before cache serve / re-fire
  });

  it("burst sink + CQS — path E recorded even when impl is gathered (not fired)", async () => {
    let writeFires = 0;
    const cap = EnvCapability.define("test/cqs-burst", {
      symbols: (symbol, z) => ({
        "b-write": symbol.rosetta`b-write: `(
          {
            input: [z.string],
            output: [z.undefinedResult],
            provenance: "sink",
            effects: (id: string) => [["test", "b", id]],
          },
          () => {
            writeFires++;
            return undefined;
          },
        ),
        "b-read": symbol.rosetta`b-read: `(
          {
            input: [z.string],
            output: [z.string],
            queries: (id: string) => [["test", "b", id]],
          },
          (id: string) => `r:${id}`,
        ),
      }),
    });
    const effects = new MemoryEffectLog();
    const pathLog = new MemoryResourcePathLog();
    await expect(
      exec('(b-write "1") (b-read "1")', {
        capabilities: [cap],
        effects,
        resourcePaths: pathLog,
      }),
    ).rejects.toThrow(ResourcePathConflictError);
    expect(writeFires).toBe(0); // burst gather skipped impl
    expect(effects.entries).toHaveLength(1);
    expect(pathLog.effectPaths).toContainEqual(["test", "b", "1"]);
  });

  it("CONSTANT_CTX — facility off: path fns run but check/record no-op", async () => {
    expect(CONSTANT_CTX.resourcePaths).toBeUndefined();
    let pathFnRan = false;
    // log undefined ⇒ no door even after "effect" path production
    applyResourcePathCqs({
      verbName: "x",
      decodedArgs: ["1"],
      effects: (id: string) => {
        pathFnRan = true;
        return [["test", "c", id]];
      },
      log: undefined,
    });
    expect(pathFnRan).toBe(true);
    // subsequent query under same undefined log also free
    applyResourcePathCqs({
      verbName: "y",
      decodedArgs: ["1"],
      queries: (id: string) => [["test", "c", id]],
      log: undefined,
    });
    // live membrane under CONSTANT_CTX (testCallCtx default)
    const { symbol } = await import("../../symbol/index.js");
    const z = await import("../../common/scheme-zod/index.js");
    const { AString } = await import("../../values/primitives/AString.js");
    let fires = 0;
    const proc = symbol.rosetta`const-write: `(
      {
        input: [z.string],
        output: [z.undefinedResult],
        effects: (id: string) => [["test", "c", id]],
      },
      () => {
        fires++;
        return undefined;
      },
    );
    await proc["arrival/tagless-final/apply"]([new AString("1")], testCallCtx());
    // write then read both succeed — facility off
    const readProc = symbol.rosetta`const-read: `(
      {
        input: [z.string],
        output: [z.string],
        queries: (id: string) => [["test", "c", id]],
      },
      (id: string) => id,
    );
    await readProc["arrival/tagless-final/apply"]([new AString("1")], testCallCtx());
    expect(fires).toBe(1);
  });

  it("ExecOptions.resourcePaths injects spy without manual RunContext", async () => {
    const spies: SpyMap = {};
    const { cap, pathLog, appendEvents } = makePathCap(spies);
    await exec('(write "a" "1")', { capabilities: [cap], resourcePaths: pathLog });
    expect(spies.write).toBe(1);
    expect(appendEvents.flat()).toContainEqual(["test", "a", "1"]);
  });
});

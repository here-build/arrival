// R3 session laws (docs/working-proposals/arrival-mcp-rework-over-phases.md, Part IV — R3 gate):
//
//   • fold-idempotence      — fold ∘ persist ∘ fold = fold
//   • penetration-count     — a `view` penetration fires exactly ONCE across N rehydrations
//                             (arrival-mcp's own verbs are unclassified today — D4's lazy scope —
//                             so the law runs over a test capability declaring `view`/`sink`)
//   • config-change         — same session, changed data-config ⇒ cache dropped (hit must miss),
//                             log kept
//   • dispose-spy (INTERIM) — sessionless per-call assembly disposes in `finally`; a config-digest
//                             change disposes the stale warm pair (§2.8's bar column, tranche 1)
//   • store injection       — `AsyncSessionStore` round-trip: persisted (awaited) blob rehydrates
//                             on a fresh instance; zero-config default keeps the session bag
//   • statement cap         — the teaching error at the cap, never silent truncation
//
// A cold fold is forced with a FRESH DiscoveryTool instance (fresh warm map = process eviction in
// miniature); the store variant rehydrates through the injected blob instead of the session bag.

import { symbol } from "@inhuman.tools/arrival";
import { port, type Resource } from "@inhuman.tools/arrival/resources";
import * as sz from "@inhuman.tools/arrival/scheme-zod";
import { createInMemorySessionStore } from "@inhuman.tools/mcp-substrate";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { type SessionRunState, decodeSessionRunState, isSessionRunState } from "../session-run-state.js";

function runState(session: { state: Record<string, unknown> }): SessionRunState {
  const state = session.state.__run__;
  if (!isSessionRunState(state)) throw new Error("no v2 SessionRunState in the session bag");
  return state;
}

/** One capability with a spied `view` verb + a spied `sink` verb + a spied unclassified verb. */
function classedCapability() {
  const counts = { view: 0, sink: 0, plain: 0 };
  const cap = new McpEnvCapability("classed-caps", {
    symbols: {
      peek: symbol.rosetta`peek: a boundary snapshot`(
        { input: [sz.number], output: [sz.number], cacheClass: "view" },
        (n: number) => {
          counts.view++;
          return n * 2;
        },
      ),
      "fire!": symbol.rosetta`fire!: an effect`(
        { input: [sz.number], output: [sz.undefinedResult], provenance: "sink" },
        (_n: number) => {
          counts.sink++;
          return undefined;
        },
      ),
      plain: { fn: () => ++counts.plain },
    },
    annotations: {
      peek: { description: "view-classed snapshot" },
      "fire!": { description: "sink effect" },
      plain: { description: "unclassified counter" },
    },
  });
  return { cap, counts };
}

const tool = (cap: McpEnvCapability) => new DiscoveryTool("classed", cap, { description: "classed tool" });

describe("R3 law — penetration-count: a `view` penetration fires exactly once across N rehydrations", () => {
  it("N cold folds over the same session answer the view from the cache — one fire, ever", async () => {
    const { cap, counts } = classedCapability();
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool(cap).call({ expr: "(define snapshot (peek 21))" }, { session }); // records {value}
    expect(counts.view).toBe(1);

    for (let n = 0; n < 3; n++) {
      // each iteration: a fresh instance = a rehydration; fold replays the log over the cache
      const out = await tool(cap).call({ expr: "snapshot" }, { session });
      expect(out).toEqual(["42"]);
    }
    expect(counts.view).toBe(1); // the classified penetration NEVER re-fired
    expect(runState(session).counters.rehydrations).toBe(3);
    expect(runState(session).counters.cacheHits).toBe(3); // the cache economy is observable (§2.7)
  });

  it("a `sink` effect statement is tombstone-skipped on every fold — one live effect, ever", async () => {
    const { cap, counts } = classedCapability();
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool(cap).call({ expr: "(fire! 7)" }, { session }); // the live effect + its tombstone
    expect(counts.sink).toBe(1);

    await tool(cap).call({ expr: "(+ 1 1)" }, { session }); // fresh instance → fold replays (fire! 7)
    await tool(cap).call({ expr: "(+ 2 2)" }, { session });
    expect(counts.sink).toBe(1); // tombstone hit → skip, both times
    expect(runState(session).counters.effectsSkipped).toBe(2);
  });

  it("an unclassified verb re-runs on every fold — regenerateable, the ruled-safe default", async () => {
    const { cap, counts } = classedCapability();
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool(cap).call({ expr: "(define p (plain))" }, { session });
    await tool(cap).call({ expr: "(+ 1 1)" }, { session }); // cold fold re-runs the define
    expect(counts.plain).toBe(2);
  });
});

describe("R3 law — fold-idempotence: fold ∘ persist ∘ fold = fold", () => {
  it("repeated persist/fold cycles are a fixpoint: same bindings, same log, no extra penetrations", async () => {
    const { cap, counts } = classedCapability();
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool(cap).call({ expr: "(define snapshot (peek 21))\n(define twice (* snapshot 2))" }, { session });
    const readback1 = await tool(cap).call({ expr: "(list snapshot twice)" }, { session }); // fold #1
    const logAfter1 = runState(session).log.map((s) => s.src);

    const readback2 = await tool(cap).call({ expr: "(list snapshot twice)" }, { session }); // fold #2 over the persisted twin
    const logAfter2 = runState(session).log.map((s) => s.src);

    expect(readback2).toEqual(readback1);
    // the log grew only by the read statements themselves — fold added/duplicated nothing
    expect(logAfter2).toEqual([...logAfter1, "(list snapshot twice)"]);
    expect(counts.view).toBe(1); // idempotence includes the membrane: no fold re-fired the view
  });
});

function configuredCapability() {
  const counts = { view: 0 };
  const cap = new McpEnvCapability("cfg-caps", {
    configuration: { who: z.string() },
    symbols: {
      peek: symbol.rosetta`peek: a boundary snapshot`(
        { input: [sz.number], output: [sz.number], cacheClass: "view" },
        (n: number) => {
          counts.view++;
          return n * 2;
        },
      ),
    },
    annotations: { peek: { description: "view-classed snapshot" } },
  });
  return { cap, counts };
}

describe("R3 law — config-change: a hit after a data-config change must miss (cache dropped, log kept)", () => {
  it("same session + changed config ⇒ the view re-fires (no stale hit); the bindings still fold from the kept log", async () => {
    const { cap, counts } = configuredCapability();
    const t = new DiscoveryTool("cfg", cap, { description: "cfg tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await t.call({ expr: "(define snapshot (peek 21))", who: "ada" }, { session });
    expect(counts.view).toBe(1);
    expect(await t.call({ expr: "snapshot", who: "ada" }, { session })).toEqual(["42"]); // warm — no re-fire
    expect(counts.view).toBe(1);

    // SAME instance, different data-config: digest changes ⇒ warm pair dropped, cache dropped,
    // the log re-records with LIVE penetrations (record mode) — never a stale hit.
    expect(await t.call({ expr: "snapshot", who: "bob" }, { session })).toEqual(["42"]);
    expect(counts.view).toBe(2); // the penetration re-fired under the new config
    const state = runState(session);
    expect(state.log.map((s) => s.src)).toContain("(define snapshot (peek 21))"); // log KEPT
    expect(Object.keys(state.cache).length).toBeGreaterThan(0); // and re-recorded under the new digest
  });
});

function spiedCapability(disposeSpy: () => void) {
  const greeter: Resource<{ hello: () => string }> = {
    kind: "greeter",
    async acquire() {
      return port({ hello: () => "hi" }, disposeSpy);
    },
  };
  return new McpEnvCapability("spied-caps", {
    resources: { greeter: () => greeter },
    symbols: {
      greet: {
        fn(this: { resources: { greeter: { live: { hello: () => string } } } }) {
          return this.resources.greeter.live.hello();
        },
      },
    },
    annotations: { greet: { description: "greets" } },
  });
}

describe("R3 law — INTERIM dispose-spy (§2.8, first tranche)", () => {
  it("a sessionless call's per-call assembly disposes in `finally` — the resource is wound down", async () => {
    const disposeSpy = vi.fn();
    const t = new DiscoveryTool("spied", spiedCapability(disposeSpy), { description: "spied tool" });
    expect(await t.call({ expr: "(greet)" })).toEqual(["hi"]); // NO session in ctx (single-token strings serialize bare)
    expect(disposeSpy).toHaveBeenCalledOnce(); // drop site #2 is closed on the per-call path
  });

  it("a config-digest change disposes the stale warm pair; closeSession disposes the live one", async () => {
    const disposeSpy = vi.fn();
    const cap = new McpEnvCapability("spied-cfg-caps", {
      configuration: { who: z.string() },
      resources: {
        greeter: (cfg) =>
          ({
            kind: "greeter",
            async acquire() {
              return port({ hello: () => `hi ${(cfg as { who: string }).who}` }, disposeSpy);
            },
          }) satisfies Resource<{ hello: () => string }>,
      },
      symbols: {
        greet: {
          fn(this: { resources: { greeter: { live: { hello: () => string } } } }) {
            return this.resources.greeter.live.hello();
          },
        },
      },
      annotations: { greet: { description: "greets the configured person" } },
    });
    const t = new DiscoveryTool("spied-cfg", cap, { description: "spied tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await t.call({ expr: "(greet)", who: "ada" }, { session });
    expect(disposeSpy).not.toHaveBeenCalled(); // the warm pair stays live across calls
    await t.call({ expr: "(greet)", who: "ada" }, { session });
    expect(disposeSpy).not.toHaveBeenCalled();

    await t.call({ expr: "(greet)", who: "bob" }, { session }); // digest change ⇒ old warm disposed
    expect(disposeSpy).toHaveBeenCalledOnce();

    await t.closeSession(session.id); // the session-close hook (R4 wires the transport event)
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("R3 — injected AsyncSessionStore (in-memory default = today's zero-config behavior)", () => {
  it("with a store: the twin round-trips through the blob (awaited pre-response) and rehydrates a fresh instance; the session bag stays clean", async () => {
    const { cap, counts } = classedCapability();
    const store = createInMemorySessionStore();
    const session = { id: "s-store", state: {} as Record<string, unknown> };

    await tool(cap).call({ expr: "(define snapshot (peek 21))" }, { session, store });
    expect(session.state.__run__).toBeUndefined(); // store injected ⇒ the bag carries nothing

    const blob = await store.get("s-store");
    expect(blob).toBeDefined(); // persisted before the response
    const decoded = decodeSessionRunState(blob!);
    expect(decoded?.log).toEqual([{ src: "(define snapshot (peek 21))", definedName: "snapshot" }]);
    expect(Object.values(decoded!.cache)).toEqual([{ kind: "value", value: 42 }]); // the settled view entry

    // A fresh instance + a fresh session BAG — only the store carries the twin. Fold answers the
    // view from the rehydrated cache: the penetration never re-fires.
    const out = await tool(cap).call({ expr: "snapshot" }, { session: { id: "s-store", state: {} }, store });
    expect(out).toEqual(["42"]);
    expect(counts.view).toBe(1);
  });

  it("without a store: the twin lives in the session bag as ONE object (stdio: the blob is one object)", async () => {
    const { cap } = classedCapability();
    const session = { id: "s-bag", state: {} as Record<string, unknown> };
    await tool(cap).call({ expr: "(define x 1)" }, { session });
    expect(isSessionRunState(session.state.__run__)).toBe(true);
  });
});

describe("R3 — the statement-count cap teaches, never truncates silently (Part III LIMIT)", () => {
  it("statements past the cap surface a teaching door naming the cap and the way out", async () => {
    const { cap } = classedCapability();
    const t = new DiscoveryTool("capped", cap, { description: "capped tool", statementCap: 2 });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    expect(await t.call({ expr: "(define a 1)\n(define b 2)" }, { session })).toEqual(["undefined", "undefined"]);
    const out = await t.call({ expr: "(define c 3)" }, { session });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\(error /);
    expect(out[0]).toContain("session statement cap reached (2)");
    expect(out[0]).toContain("fresh MCP session"); // the door routes, not just bans
    expect(runState(session).log).toHaveLength(2); // never silently truncated or evicted
  });
});

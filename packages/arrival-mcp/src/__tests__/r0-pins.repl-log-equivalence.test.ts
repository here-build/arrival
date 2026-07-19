// Regression pins for the v2 SessionRunState log/fold mechanism:
//
//   • The log holds ALL top-level statements — defines AND bare expressions — each define entry
//     carrying its bound name. Bare expressions must appear in the log too: if only defines
//     replayed, the sink tombstone-skip path would be unreachable. A legacy `__repl__` history
//     seeds the log's define entries on first touch (the log is a superset of that history, not
//     a rename).
//
//   • fold(log, cache) reproduces the same bindings for every wire-safe define — forced by a
//     FRESH DiscoveryTool instance over the same session bag (a fresh warm map models process
//     eviction).
//
//   • An UNCLASSIFIED impure verb diverges on cold fold — undeclared classification defaults to
//     regenerateable — while its `view`-classed twin does not: fold answers a `view` penetration
//     from the run cache instead of re-firing it, which is what makes the fold-equivalence pin
//     above hold even for verbs that penetrate the membrane.

import { symbol } from "@inhuman.tools/arrival";
import * as sz from "@inhuman.tools/arrival/scheme-zod";
import { describe, expect, it } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { type SessionRunState, isSessionRunState } from "../session-run-state.js";

function demoTool(): DiscoveryTool {
  return new DiscoveryTool("demo", new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} }), {
    description: "demo tool",
  });
}

function runState(session: { state: Record<string, unknown> }): SessionRunState {
  const state = session.state.__run__;
  if (!isSessionRunState(state)) throw new Error("no v2 SessionRunState in the session bag");
  return state;
}

describe("R3 pin — the v2 log holds ALL top-level statements, in program order (§2.2)", () => {
  it("a bare expression enters the log (no definedName); a define enters with its definedName", async () => {
    const tool = demoTool();
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(+ 1 1)" }, { session });
    await tool.call({ expr: "(define n 5)" }, { session });
    await tool.call({ expr: "(+ n n)" }, { session });
    expect(runState(session).log).toEqual([
      { src: "(+ 1 1)" },
      { src: "(define n 5)", definedName: "n" },
      { src: "(+ n n)" },
    ]);
  });

  it("every define entry carries its bound name — the log is fold-addressable by construction", async () => {
    const tool = demoTool();
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define a 1)" }, { session });
    await tool.call({ expr: "(define b (+ a 1))" }, { session });
    const defines = runState(session).log.filter((s) => s.definedName !== undefined);
    expect(defines).toEqual([
      { src: "(define a 1)", definedName: "a" },
      { src: "(define b (+ a 1))", definedName: "b" },
    ]);
  });

  it("migration: a legacy __repl__ history SEEDS the define entries of the v2 log — and the bindings fold back", async () => {
    const tool = demoTool();
    // A legacy session bag: only the __repl__ define history, no v2 state.
    const session = {
      id: "legacy",
      state: { __repl__: ["(define x 1)", "(define y (+ x 1))"] } as Record<string, unknown>,
    };
    const out = await tool.call({ expr: "(list x y)" }, { session });
    expect(out).toEqual(["(list 1 2)"]); // the seeded log folded into real bindings
    expect(runState(session).log.slice(0, 2)).toEqual([
      { src: "(define x 1)", definedName: "x" },
      { src: "(define y (+ x 1))", definedName: "y" },
    ]);
  });
});

describe("R3 semantic pin — fold(log, cache) reproduces the overlay-restore bindings", () => {
  it("golden pin: the exact readback the overlay mechanism produced for a chain of pure wire-safe defines", async () => {
    // Pure/deterministic defines have no membrane penetration, so the readback is stable under
    // either fold path — restore or honest re-execution reach the same value by construction.
    const tool = demoTool();
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define x 1)" }, { session });
    await tool.call({ expr: '(define y "hello")' }, { session });
    await tool.call({ expr: "(define z (list 1 2 3))" }, { session });
    await tool.call({ expr: "(define w (dict :a 1 :b 2))" }, { session });

    const out = await tool.call({ expr: "(list x y z w)" }, { session });
    // NOTE (pinned, not asserted as ideal): a string binding serializes as a BARE token
    // (`hello`, no quotes) — same as a freshly-evaluated string literal at HEAD.
    expect(out).toEqual(["(list\n  1\n  hello\n  (list 1 2 3)\n  (dict :a 1 :b 2))"]);
  });

  it("equivalence: a COLD FOLD (fresh tool instance, same session bag) reproduces the same readback as the warm path", async () => {
    const warmTool = demoTool();
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await warmTool.call({ expr: "(define x 1)" }, { session });
    await warmTool.call({ expr: '(define y "hello")' }, { session });
    await warmTool.call({ expr: "(define z (list 1 2 3))" }, { session });
    const warmReadback = await warmTool.call({ expr: "(list x y z)" }, { session });

    // A FRESH instance has an empty warm map — its first call on this session must fold:
    // re-run the log over the cache. Pure defines re-run honestly and land on the same values.
    const coldTool = demoTool();
    const coldReadback = await coldTool.call({ expr: "(list x y z)" }, { session });
    expect(coldReadback).toEqual(warmReadback);
    expect(runState(session).counters.rehydrations).toBe(1); // the fold is observable
  });

  it("boundary, sharpened: an UNCLASSIFIED impure verb diverges on cold fold (regenerateable — the ruled-safe default); its `view` twin does not", async () => {
    // `tick` is wire-safe (an integer) but IMPURE (a shared counter). Unclassified ⇒ fold re-runs
    // it (undeclared = regenerateable) and the binding advances. `tick-view` declares `view` ⇒
    // the penetration is answered from the run cache on fold, so the binding stays stable across
    // rehydrations.
    let plainCalls = 0;
    let viewCalls = 0;
    const cap = new McpEnvCapability("tick-caps", {
      symbols: {
        tick: { fn: () => ++plainCalls },
        "tick-view": symbol.rosetta`tick-view: a boundary snapshot`(
          { input: [], output: [sz.number], cacheClass: "view" },
          () => ++viewCalls,
        ),
      },
      annotations: {
        tick: { description: "unclassified impure counter" },
        "tick-view": { description: "view-classed counter" },
      },
    });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    const warmTool = new DiscoveryTool("tick", cap, { description: "tick tool" });
    await warmTool.call({ expr: "(define a (tick))" }, { session }); // plainCalls=1, a=1
    await warmTool.call({ expr: "(define v (tick-view))" }, { session }); // viewCalls=1, v=1
    expect(await warmTool.call({ expr: "(list a v)" }, { session })).toEqual(["(list 1 1)"]);

    const coldTool = new DiscoveryTool("tick", cap, { description: "tick tool" });
    const coldReadback = await coldTool.call({ expr: "(list a v)" }, { session });
    expect(plainCalls).toBe(2); // unclassified: the fold re-fired it — a=2 now (divergence, by design)
    expect(viewCalls).toBe(1); // view: answered from the cache — NEVER re-fired
    expect(coldReadback).toEqual(["(list 2 1)"]);
  });
});

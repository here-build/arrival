// R0 pins, FLIPPED to the R3 mechanism (docs/working-proposals/arrival-mcp-rework-over-phases.md,
// Part IV — R0 → R3). The original file characterized the `__repl__`/`__cache__` overlay; R3
// dissolved that overlay (D3), so these pins now gate what their own headers said they would
// become:
//
//   (a) "`__repl__` → the SEEDED define entries of `log`": the v2 `SessionRunState.log` holds ALL
//        top-level statements (defines AND bare expressions, §2.2 — the sink tombstone-skip is
//        unreachable if only defines replay), and a legacy `__repl__` history seeds the log's
//        define entries on first touch (the v2 log is a SUPERSET, not a rename).
//
//   (b) The SEMANTIC pin that replaced rev 1's retired `__cache__` byte-compat pin: "fold(log,
//        cache) reproduces the same bindings the overlay restore produced for every wire-safe
//        define in the existing suite." Fold is forced by a FRESH DiscoveryTool instance over the
//        same session bag (a fresh warm map = process eviction in miniature).
//
// The boundary condition at the bottom is the original file's third pin, kept and sharpened: an
// UNCLASSIFIED impure verb legitimately diverges on cold fold (regenerateable is the RULED-safe
// default, §2.3); its `view`-classed twin does not (the penetration answers from the run cache) —
// the membrane-level cache is exactly what makes pin (b) hold for penetrating defines.

import { symbol } from "@here.build/arrival";
import * as sz from "@here.build/arrival/scheme-zod";
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
    // A pre-R3 session bag: only the legacy define history, no v2 state.
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
    // Pure/deterministic defines — no membrane penetration, so the pin is stable under either
    // the retired restore-from-overlay OR honest re-execution (both reach the same value by
    // construction). Pinned output text is byte-identical to the pre-R3 golden pin.
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
    // it (§2.3: undeclared = regenerateable) and the binding advances — the RULED behavior, where
    // the retired overlay silently pinned the original value. `tick-view` declares `view` ⇒ the
    // penetration is answered from the run cache on fold and the binding is stable across
    // rehydrations — the membrane-level mechanism pin (b) rests on.
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

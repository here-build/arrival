// Session-replay pins: what a cold fold (a fresh DiscoveryTool instance over the same
// session bag — process eviction in miniature, e.g. a stdio restart) must reproduce for
// each statement class:
//
//   • wire-safe define, same config → WARM-PAIR reuse (no fold at all): the penetration
//     fires exactly once across N calls.
//   • closure define                → warm: never re-run; cold fold: re-run, penetration-free
//     for the define itself (fold correctness inherits the poison rule below).
//   • replay-time crash             → the poison rule: a fold-time crash DROPS the statement
//     from the log (with a counter increment) rather than tolerating or retrying it.
//   • crash-stops-batch + crashed-statement-never-logged → asserted against the v2 log.

import { describe, expect, it, vi } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { defineMcpCapability } from "../defineMcpCapability.js";
import { type SessionRunState, isSessionRunState } from "../session-run-state.js";
import { tool } from "../tool.js";

function runState(session: { state: Record<string, unknown> }): SessionRunState {
  const state = session.state.__run__;
  if (!isSessionRunState(state)) throw new Error("no v2 SessionRunState in the session bag");
  return state;
}

describe("R3 pin — warm-pair reuse: a define's penetration fires exactly once across N same-config calls", () => {
  it("the verb fires once; the warm env carries the binding — no fold, no re-fire, stable readback", async () => {
    let calls = 0;
    const cap = defineMcpCapability("tick-caps", {
      tools: () => ({
        tick: tool`tick: increments + returns a counter`({ input: [], output: [], shape: {} }, () => ++calls),
      }),
    });
    const discoveryTool = new DiscoveryTool("tick", cap, { description: "tick tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await discoveryTool.call({ expr: "(define a (tick))" }, { session }); // tick fires → 1
    expect(calls).toBe(1);

    // Three more calls with the SAME config digest — each reuses the warm pair (zero fold cost).
    await discoveryTool.call({ expr: "(+ 1 1)" }, { session });
    await discoveryTool.call({ expr: "(+ 2 2)" }, { session });
    await discoveryTool.call({ expr: "(+ 3 3)" }, { session });
    expect(calls).toBe(1); // warm reuse never re-fires the penetration

    expect(await discoveryTool.call({ expr: "a" }, { session })).toEqual(["1"]);
    expect(calls).toBe(1);
  });
});

// a lambda value — unclassified, so its define statement re-runs on fold (the ruled-safe
// regenerateable default); while the pair is warm nothing re-runs at all.
const identityClosure = (x: unknown): unknown => x;

describe("R3 pin — a closure define: warm calls never re-run it; a cold fold re-runs it (regenerateable)", () => {
  it("the DEFINING verb builds once while warm, and once more per cold fold", async () => {
    let builds = 0;
    const cap = defineMcpCapability("mk-caps", {
      tools: () => ({
        mk: tool`mk: returns a closure`({ input: [], output: [], shape: {} }, () => {
          builds++;
          return identityClosure;
        }),
      }),
    });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const warmTool = new DiscoveryTool("mk", cap, { description: "mk tool" });
    await warmTool.call({ expr: "(define f (mk))" }, { session });
    expect(builds).toBe(1);
    await warmTool.call({ expr: "(+ 1 1)" }, { session });
    expect(builds).toBe(1); // warm reuse — no fold runs at all while the pair stays warm

    const coldTool = new DiscoveryTool("mk", cap, { description: "mk tool" });
    await coldTool.call({ expr: "(+ 2 2)" }, { session }); // the fold re-ran the define…
    expect(builds).toBe(2); // …exactly once — the closure binding is re-derived, never restored
  });
});

describe("R3 pin — the poison rule: a fold-time crash DROPS the statement (with a counter), never poisons the session", () => {
  it("a fold-time crash does not stop the fold — later log entries and the new input still run", async () => {
    let calls = 0;
    const cap = defineMcpCapability("flaky-caps", {
      tools: () => ({
        flaky: tool`flaky: returns a closure once, then throws`({ input: [], output: [], shape: {} }, () => {
          calls++;
          if (calls === 1) return () => 1; // a closure → the define re-runs on fold
          throw new Error("boom on replay");
        }),
      }),
    });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const warmTool = new DiscoveryTool("flaky", cap, { description: "flaky tool" });
    await warmTool.call({ expr: "(define a (flaky))" }, { session }); // calls=1, ok

    // A fresh instance folds: `a`'s define re-runs → flaky throws (calls=2) → DROPPED, counted.
    // The new input still executes normally.
    const coldTool = new DiscoveryTool("flaky", cap, { description: "flaky tool" });
    const out = await coldTool.call({ expr: "(define b 42)" }, { session });
    expect(calls).toBe(2);
    expect(out).toEqual(["undefined"]); // `(define …)`'s own statement value — the fold did NOT stop the call

    expect(await coldTool.call({ expr: "b" }, { session })).toEqual(["42"]);
  });

  it("the crashing statement IS dropped from the log — retried never, counted once", async () => {
    let calls = 0;
    const cap = defineMcpCapability("flaky2-caps", {
      tools: () => ({
        flaky2: tool`flaky2: returns a closure once, then throws`({ input: [], output: [], shape: {} }, () => {
          calls++;
          if (calls === 1) return () => 1;
          throw new Error("boom on replay");
        }),
      }),
    });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const toolA = new DiscoveryTool("flaky2", cap, { description: "flaky2 tool" });
    await toolA.call({ expr: "(define a (flaky2))" }, { session }); // calls=1

    const toolB = new DiscoveryTool("flaky2", cap, { description: "flaky2 tool" });
    await toolB.call({ expr: "(define b 1)" }, { session }); // fold re-attempts a → calls=2, throws → DROPPED
    const toolC = new DiscoveryTool("flaky2", cap, { description: "flaky2 tool" });
    await toolC.call({ expr: "(define c 2)" }, { session }); // fold replays only b — a is GONE

    expect(calls).toBe(2); // dropped after ONE failed re-run, never retried again
    const state = runState(session);
    expect(state.log.map((s) => s.src)).not.toContain("(define a (flaky2))");
    expect(state.counters.droppedOnReplay).toBe(1);

    // The dropped statement's name is genuinely unbound in a later call's env.
    const out = await toolC.call({ expr: "a" }, { session });
    expect(out).toEqual(['(error "Unbound variable `a\'")']);
    expect(calls).toBe(2); // and STILL never re-attempted
  });
});

describe("R3 pin — crash-stops-batch: earlier statements in the SAME call stand, later ones never run", () => {
  it("a mid-batch crash halts further NEW-input forms; earlier ones already produced their output", async () => {
    const cap = defineMcpCapability("demo-caps", { tools: () => ({}) });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const spyExpr = "(+ 1 1)\n(+ 2 2)\n(this-verb-does-not-exist)\n(+ 999 999)";
    const out = await tool.call({ expr: spyExpr }, { session: { id: "s1", state: {} } });

    // exactly 3 elements: two successes + one trailing error door — the 4th form never ran.
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("2");
    expect(out[1]).toBe("4");
    expect(out[2]).toMatch(/^\(error /);
  });

  it("a crashed SOLE statement in the NEW input never enters the log — it never becomes replay-eligible", async () => {
    const cap = defineMcpCapability("demo-caps", { tools: () => ({}) });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define bad (this-verb-does-not-exist))" }, { session });
    // The statement is appended AFTER successful execution — a crash means it never lands.
    expect(runState(session).log).toEqual([]);
    expect(runState(session).counters.crashes).toBe(1);
  });
});

// ── Multi-statement batches log EVERY form with its exact source slice, and all of them
// survive a cold fold. ─────────────────────────────────────────────────────────────────
describe("R3 pin — a multi-statement batch's statements ALL enter the log with exact source slices", () => {
  it("two defines in ONE call: both logged with their own exact source, both fold on a cold instance", async () => {
    const cap = defineMcpCapability("demo-caps", { tools: () => ({}) });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const out = await tool.call({ expr: "(define x 1)\n(define y 2)" }, { session });
    expect(out).toEqual(["undefined", "undefined"]); // BOTH defines ran fine within this call…

    // …and BOTH made it into the log, each with its own exact (untruncated) source.
    expect(runState(session).log).toEqual([
      { src: "(define x 1)", definedName: "x" },
      { src: "(define y 2)", definedName: "y" },
    ]);

    // A COLD instance folds the log — no data loss.
    const coldTool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    expect(await coldTool.call({ expr: "(list x y)" }, { session })).toEqual(["(list 1 2)"]);
  });

  it("a single define alone in a call — its full source survives verbatim", async () => {
    const cap = defineMcpCapability("demo-caps", { tools: () => ({}) });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define ok 1)" }, { session });
    expect(runState(session).log).toEqual([{ src: "(define ok 1)", definedName: "ok" }]);
  });
});

describe("R3 pin — dispatch-time record still fires on a crashed call (success:false, errorMessage set)", () => {
  it("records failure with the crash message even though partial output was produced", async () => {
    const cap = defineMcpCapability("demo-caps", { tools: () => ({}) });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const record = vi.fn();
    await tool.call({ expr: "(+ 1 1)\n(this-verb-does-not-exist)" }, { session: { id: "s1", state: {} }, record });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({ success: false });
    expect((record.mock.calls[0]![0] as { errorMessage?: string }).errorMessage).toBeDefined();
  });
});

// R0 pin (docs/working-proposals/arrival-mcp-rework-over-phases.md, Part IV — R0):
// "Replay semantics at statement level (re-run / poison-drop / crash-stops-batch with earlier
// values standing)". This file characterizes DiscoveryTool.call's ACTUAL statement-level replay
// mechanism as it behaves on HEAD (the working tree, including the uncommitted reader-split diff
// the design doc treats as HEAD throughout — `parse` + `sourceTextFor` LOCATION slicing).
//
// These are the ground truth R3's `fold = re-run log over cache` must reproduce for every class
// below (§2.2/§R3 of the doc: "fold correctness inherits the poison rule").
//
// A companion behavioral suite already exists at `DiscoveryTool.test.ts` (wire-safe restore,
// closure re-run, REPL-partial-success). This file does not duplicate those — it adds the rows
// R0 asks for that the existing suite does not cover: poison persistence across MULTIPLE calls,
// and referencing a poisoned binding.

import { describe, expect, it, vi } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";

describe("R0 pin — wire-safe define restores from cache without re-firing its penetration", () => {
  it("a wire-safe define's verb fires exactly once across N subsequent calls; the value read back is stable", async () => {
    let calls = 0;
    const cap = new McpEnvCapability("tick-caps", {
      symbols: { tick: { fn: () => ++calls } },
      annotations: { tick: { description: "increments + returns a counter" } },
    });
    const tool = new DiscoveryTool("tick", cap, { description: "tick tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool.call({ expr: "(define a (tick))" }, { session }); // tick fires → 1
    expect(calls).toBe(1);

    // Three more calls, none referencing `a` in their own input — each one folds history first.
    await tool.call({ expr: "(+ 1 1)" }, { session });
    await tool.call({ expr: "(+ 2 2)" }, { session });
    await tool.call({ expr: "(+ 3 3)" }, { session });
    expect(calls).toBe(1); // still 1 — the restore path never re-fires the penetration

    expect(await tool.call({ expr: "a" }, { session })).toEqual(["1"]);
    expect(calls).toBe(1);
  });
});

describe("R0 pin — a closure define re-runs on replay (penetration-free) every call", () => {
  it("the DEFINING verb (which builds the closure) fires again on every subsequent call's fold", async () => {
    let builds = 0;
    const cap = new McpEnvCapability("mk-caps", {
      symbols: {
        mk: {
          fn() {
            builds++;
            // a lambda value — schemeToJs peels it to a JS function, not JSON round-trippable,
            // so DiscoveryTool never caches it and always re-runs the define on fold.
            return (x: unknown) => x;
          },
        },
      },
      annotations: { mk: { description: "returns a closure" } },
    });
    const tool = new DiscoveryTool("mk", cap, { description: "mk tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool.call({ expr: "(define f (mk))" }, { session });
    expect(builds).toBe(1);

    await tool.call({ expr: "(+ 1 1)" }, { session });
    expect(builds).toBe(2); // re-built on this call's fold

    await tool.call({ expr: "(+ 2 2)" }, { session });
    expect(builds).toBe(3); // and again
  });
});

describe("R0 pin — poison behavior on a replay-time crash (TODAY's actual mechanism)", () => {
  // IMPORTANT FINDING: the source comment above `DiscoveryTool.call` (and the R0 doc's own prose)
  // describes this as "dropped from history / not allowed to poison the session." The ACTUAL code
  // (the fold loop at DiscoveryTool.ts, the `for (const src of history)` loop) does NOT remove a
  // crashing entry from `history`/`state.__repl__`. It is caught, silently skipped for THIS call,
  // and left in place — so it is re-attempted (and re-fails, re-silently) on every future call.
  // This pin characterizes the REAL behavior (poison-TOLERATE, not poison-DROP) so R3's fold is
  // measured against what HEAD actually does, not against the aspirational comment.
  it("a replay-time crash does not stop the batch — later history entries and the new input still run", async () => {
    let calls = 0;
    const cap = new McpEnvCapability("flaky-caps", {
      symbols: {
        flaky: {
          fn() {
            calls++;
            if (calls === 1) return () => 1; // not JSON round-trippable → forces re-run on replay
            throw new Error("boom on replay");
          },
        },
      },
      annotations: { flaky: { description: "returns a closure once, then throws" } },
    });
    const tool = new DiscoveryTool("flaky", cap, { description: "flaky tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool.call({ expr: "(define a (flaky))" }, { session }); // calls=1, ok
    // This call's fold re-runs `a`'s define → flaky throws (calls=2) → caught, swallowed.
    // The rest of the call (a fresh define `b`) still executes normally. NOTE: a `(define …)`
    // form's OWN printed value is `"undefined"` (define returns void) — this is pinned
    // separately below; the meaningful assertion here is that `b` is genuinely bound.
    const out = await tool.call({ expr: "(define b 42)" }, { session });
    expect(calls).toBe(2);
    expect(out).toEqual(["undefined"]); // `(define …)`'s own statement value — the batch was NOT stopped

    expect(await tool.call({ expr: "b" }, { session })).toEqual(["42"]);
  });

  it("the crashing statement is NOT dropped from history — it persists and is retried (and re-fails) on every later call", async () => {
    let calls = 0;
    const cap = new McpEnvCapability("flaky2-caps", {
      symbols: {
        flaky2: {
          fn() {
            calls++;
            if (calls === 1) return () => 1;
            throw new Error("boom on replay");
          },
        },
      },
      annotations: { flaky2: { description: "returns a closure once, then throws" } },
    });
    const tool = new DiscoveryTool("flaky2", cap, { description: "flaky2 tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await tool.call({ expr: "(define a (flaky2))" }, { session }); // calls=1
    await tool.call({ expr: "(define b 1)" }, { session }); // fold re-attempts a → calls=2, throws, swallowed
    await tool.call({ expr: "(define c 2)" }, { session }); // fold re-attempts a AGAIN → calls=3, throws, swallowed

    // `a`'s define source is still present in the history array — never removed.
    const history = session.state.__repl__ as string[];
    expect(history).toContain("(define a (flaky2))");
    expect(calls).toBe(3); // re-attempted on every call, not just once

    // The failed statement's name is genuinely unbound in the env of a later call.
    const out = await tool.call({ expr: "a" }, { session });
    expect(out).toEqual(['(error "Unbound variable `a\'")']);
    expect(calls).toBe(4); // yet ANOTHER attempt on this call's own fold
  });
});

describe("R0 pin — crash-stops-batch: earlier statements in the SAME call stand, later ones never run", () => {
  it("a mid-batch crash halts further NEW-input forms; earlier ones already produced their output", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const spyExpr = "(+ 1 1)\n(+ 2 2)\n(this-verb-does-not-exist)\n(+ 999 999)";
    const out = await tool.call({ expr: spyExpr }, { session: { id: "s1", state: {} } });

    // exactly 3 elements: two successes + one trailing error door — the 4th form never ran.
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("2");
    expect(out[1]).toBe("4");
    expect(out[2]).toMatch(/^\(error /);
  });

  it("a crashed SOLE statement in the NEW input is not added to history — it never becomes replay-eligible", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define bad (this-verb-does-not-exist))" }, { session });
    // `bad`'s define crashed mid-statement — `defineName` never got a chance to push it to history
    // (the crash happens inside `execSerialized`, before the push-to-history line runs).
    expect(session.state.__repl__).toEqual([]);
  });
});

// ── R0 FINDING (not asserted as "correct", pinned as what HEAD actually does) ──────────────────
//
// `sourceTextFor`/`nextLocatedOffset` (the uncommitted reader-split diff this doc's Part I §1.2
// treats as HEAD) slice a form's history/cache-key text using `APair.getLocation()` from
// `@here.build/arrival`'s `parse`. Probing the RAW locations `parse` returns for a multi-top-level-
// form source shows form[0]'s location is correct (offset 0), but every LATER top-level form's
// OWN reported `getLocation().offset` points to a position INSIDE the PRECEDING form's text (not
// its own start) — e.g. for `"(define ok 1)\n(define bad 2)"`, form[1]'s reported offset is 11
// (the position of the digit `1` inside form[0]'s own source), not 14 (form[1]'s true start).
//
// Two visible consequences on DiscoveryTool's REPL-history mechanism, pinned below:
//   1. A multi-statement batch's FIRST define gets a TRUNCATED history/cache-key text (sliced up
//      to the second form's wrong offset, landing mid-token).
//   2. Every define AFTER the first in the SAME batch computes a garbled `sourceTextFor` result
//      (sliced from ITS OWN wrong start) that no longer matches `DEFINE_NAME`'s `^\(define …`
//      anchor — so `defineName` returns `undefined` for it, and it is silently treated as a bare
//      expression: NEVER pushed to history, NEVER cached. Its binding is correctly live for the
//      REST of the CURRENT call (execution runs the parsed FORM object, not the sliced string),
//      but is LOST on every subsequent call (the fold loop only re-establishes what's in history).
//
// This is a genuine data-loss bug relative to the design doc's own premise (§1.2: "already parses
// with the REAL reader … slices each form's exact source via LOCATION spans") and relative to the
// OLD `splitTopLevel` mechanism it replaced (token-offset-based, not `getLocation()`-based) — worth
// a follow-up fix before R3 (which depends on "the log holds ALL top-level statements", R3's own
// wording) locks this mechanism in as the log's source. Pinned here so it is visible and so a fix
// shows up as an intentional, expected diff rather than a silent behavior change.
describe("R0 FINDING (pinned, not endorsed) — a multi-statement batch loses non-first defines from history", () => {
  it("two defines in ONE call: only the first survives to the next call; the second is silently lost", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const out = await tool.call({ expr: "(define x 1)\n(define y 2)" }, { session });
    expect(out).toEqual(["undefined", "undefined"]); // BOTH defines ran fine within this call…

    // …but only `x` made it into history (truncated), and its cache key is truncated too.
    expect(session.state.__repl__).toEqual(["(define x"]);
    expect(session.state.__cache__).toEqual({ "(define x": "1" });

    // On the NEXT call, `x` replays (from its truncated-but-self-consistent cache key) but `y` is
    // genuinely gone — an honest characterization, not a design goal.
    const readback = await tool.call({ expr: "(list x y)" }, { session });
    expect(readback).toEqual(['(error "Unbound variable `y\'")']);
  });

  it("a single define alone in a call is NOT affected — its full source survives verbatim", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define ok 1)" }, { session });
    expect(session.state.__repl__).toEqual(["(define ok 1)"]); // last (only) form ⇒ end = source.length
  });
});

describe("R0 pin — dispatch-time record still fires on a crashed call (success:false, errorMessage set)", () => {
  it("records failure with the crash message even though partial output was produced", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const record = vi.fn();
    await tool.call(
      { expr: "(+ 1 1)\n(this-verb-does-not-exist)" },
      { session: { id: "s1", state: {} }, record },
    );
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toMatchObject({ success: false });
    expect((record.mock.calls[0]![0] as { errorMessage?: string }).errorMessage).toBeDefined();
  });
});

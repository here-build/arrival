// R0 pins (docs/working-proposals/arrival-mcp-rework-over-phases.md, Part IV — R0):
//
//   (a) "`__repl__` → the SEEDED define entries of `log` (equivalence over the defines it held —
//        the v2 log is a superset, §2.2)" — `__repl__` holds ONLY define-statement source text,
//        never bare expressions; the v2 `SessionRunState.log` seeds its define entries from
//        exactly that set (§2.2: "`__repl__` … SEEDS the define entries of `log` on migration —
//        the v2 log is a SUPERSET of it, not a rename").
//
//   (b) The SEMANTIC pin that replaces rev 1's retired `__cache__` byte-compat pin: "fold(log,
//        cache) reproduces the same bindings the overlay restore produced for every wire-safe
//        define in the existing suite." Per the task's own framing this is written as a
//        CHARACTERIZATION test against TODAY's mechanism (there is no `RunCache`/fold yet — that
//        is R2/R3) — it becomes the equivalence gate R3 must clear once it swaps `__cache__`
//        overlay-restore for real fold-over-cache execution.
//
// All defines used here are SINGLE top-level forms per call, deliberately avoiding the
// multi-statement source-slicing quirk pinned+flagged in `r0-pins.discovery-replay.test.ts`
// ("R0 FINDING" block) — that quirk is a separate, orthogonal characterization; conflating it
// here would make this file's pins fragile to an unrelated fix.

import { describe, expect, it } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";

describe("R0 pin — __repl__ holds only define-statement source (the v2 log's seed set)", () => {
  it("a bare expression never enters __repl__/history", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(+ 1 1)" }, { session });
    expect(session.state.__repl__).toEqual([]);
  });

  it("a define enters __repl__ verbatim (single-statement call); a following bare expr does not", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define n 5)" }, { session });
    await tool.call({ expr: "(+ n n)" }, { session });
    expect(session.state.__repl__).toEqual(["(define n 5)"]);
  });

  it("every entry of __repl__ matches the define-statement shape (a v2 log seed is well-formed by construction)", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define a 1)" }, { session });
    await tool.call({ expr: "(define b (+ a 1))" }, { session });
    await tool.call({ expr: "(* a b)" }, { session }); // bare — must not appear below
    const history = session.state.__repl__ as string[];
    expect(history).toEqual(["(define a 1)", "(define b (+ a 1))"]);
    for (const entry of history) expect(entry).toMatch(/^\(define\s/);
  });
});

describe("R0 semantic pin — fold(log, cache-to-be) must reproduce today's overlay-restore bindings", () => {
  it("golden pin: today's overlay-restore mechanism produces these exact bindings for a chain of pure wire-safe defines", async () => {
    // Pure/deterministic defines — no membrane penetration, so the pin is stable under either
    // restore-from-cache OR honest re-execution (both reach the same value by construction). This
    // is the reference R3's fold must hit.
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });
    const session = { id: "s1", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define x 1)" }, { session });
    await tool.call({ expr: "(define y \"hello\")" }, { session });
    await tool.call({ expr: "(define z (list 1 2 3))" }, { session });
    await tool.call({ expr: "(define w (dict :a 1 :b 2))" }, { session });

    const out = await tool.call({ expr: "(list x y z w)" }, { session });
    // NOTE (pinned, not asserted as ideal): a restored string binding serializes as a BARE token
    // (`hello`, no quotes) — same as a freshly-evaluated string literal at HEAD (verified: a bare
    // `"world"` expression serializes the same bare way). Pinning the ACTUAL output, not the
    // naively-expected quoted form.
    expect(out).toEqual(["(list\n  1\n  hello\n  (list 1 2 3)\n  (dict :a 1 :b 2))"]);
  });

  it("equivalence: honest re-execution of the SAME define history (cache cleared) reproduces the SAME readback as overlay-restore — for pure wire-safe defines", async () => {
    const cap = new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} });
    const tool = new DiscoveryTool("demo", cap, { description: "demo tool" });

    // Path 1 — TODAY's overlay-restore mechanism: build up history+cache the normal way, then
    // fold on a later call restores `x`/`y`/`z` from `state.__cache__` (jsToScheme(JSON.parse(…))),
    // never re-running their statements.
    const restoreSession = { id: "restore", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define x 1)" }, { session: restoreSession });
    await tool.call({ expr: "(define y \"hello\")" }, { session: restoreSession });
    await tool.call({ expr: "(define z (list 1 2 3))" }, { session: restoreSession });
    const restoreReadback = await tool.call({ expr: "(list x y z)" }, { session: restoreSession });

    // Path 2 — honest re-execution: the SAME history, but with `__cache__` cleared, so
    // DiscoveryTool's fold loop takes the `execSerialized` (re-run) branch for every entry instead
    // of the `env.set(name, jsToScheme(…))` (restore) branch — this is fold-over-the-statement-log
    // in miniature, the mechanism R2/R3 generalizes into fold-over-cache. Because these three
    // defines are PURE (no membrane penetration), naive re-execution reproduces identical bindings.
    const rerunSession = {
      id: "rerun",
      state: {
        __repl__: [...(restoreSession.state.__repl__ as string[])],
        __cache__: {}, // force the re-run branch for every history entry
      } as Record<string, unknown>,
    };
    const rerunReadback = await tool.call({ expr: "(list x y z)" }, { session: rerunSession });

    expect(rerunReadback).toEqual(restoreReadback);
  });

  it("boundary condition (documented, not a contradiction): a PENETRATING wire-safe define does NOT survive naive re-execution unchanged — this is exactly why R2/R3 needs a membrane-level (view) cache rather than statement re-run", async () => {
    // `tick` is wire-safe (its result, an integer, is JSON-round-trippable) but IMPURE (a shared
    // counter). Overlay-restore (today) reproduces the ORIGINAL value forever, because it never
    // re-fires the verb. A naive "always re-execute the statement" fold — the thing this file's
    // PREVIOUS test showed agrees for pure defines — genuinely diverges here, because
    // re-executing `(tick)` advances the counter. The doc's semantic pin ("fold reproduces the
    // same bindings … for every wire-safe define") holds once fold answers from a real
    // `view`/`pure`-classed MEMBRANE cache (R2) — never from naive statement re-execution. This
    // test pins that naive re-execution is NOT the mechanism that gate can be built on.
    let calls = 0;
    const cap = new McpEnvCapability("tick-caps", {
      symbols: { tick: { fn: () => ++calls } },
      annotations: { tick: { description: "increments + returns a counter" } },
    });
    const tool = new DiscoveryTool("tick", cap, { description: "tick tool" });

    const restoreSession = { id: "restore", state: {} as Record<string, unknown> };
    await tool.call({ expr: "(define a (tick))" }, { session: restoreSession }); // calls=1, a=1
    const restoreReadback = await tool.call({ expr: "a" }, { session: restoreSession });
    expect(restoreReadback).toEqual(["1"]); // overlay-restore: unchanged forever
    expect(calls).toBe(1); // never re-fired

    const rerunSession = {
      id: "rerun",
      state: {
        __repl__: [...(restoreSession.state.__repl__ as string[])],
        __cache__: {}, // force naive re-execution of `(define a (tick))` on fold
      } as Record<string, unknown>,
    };
    const rerunReadback = await tool.call({ expr: "a" }, { session: rerunSession });
    expect(calls).toBe(2); // naive re-run DID re-fire the penetration
    expect(rerunReadback).toEqual(["2"]); // and DIVERGED from the overlay-restored "1"

    expect(rerunReadback).not.toEqual(restoreReadback);
  });
});

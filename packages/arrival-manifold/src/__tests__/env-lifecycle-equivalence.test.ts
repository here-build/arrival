// ENV-LIFECYCLE-AGNOSTIC EQUIVALENCE — the CRUX property a shared doors-steering runner would
// depend on. ONE runner must be able to serve BOTH arrival-manifold (one persistent env, mutated
// call-to-call) AND arrival-mcp (a FRESH env assembled per call, authorization-scoped). That only
// works if running the SAME sequence of top-level define+use statements produces BYTE-IDENTICAL
// output whether the env identity persists across calls, or a fresh env is rebuilt every call and
// `replaySessionHistory` (session-history.ts) replays the prior successful defines into it first.
//
// Today NOTHING exercises the ITERATED form of this (call N → fresh env → replay → call N+1 →
// ANOTHER fresh env → replay again, …) — session-declaration-persistence.test.ts's replay
// coverage is a ONE-SHOT reconstruction (build history via a persistent-env tool, replay once into
// a single brand-new env at the very end). This file drives the repeated loop the arrival-mcp
// adoption model actually needs, and asserts it against the persistent-env baseline.
//
// SIMULATING THE FUTURE RUNNER BY HAND: `createManifoldTool` itself has no "replay-then-call"
// entry point (that seam doesn't exist until the runner is extracted — this suite characterizes
// today's PRIMITIVES, session-history.ts's real API, composed by hand). The session-scoped state
// the future runner would own (the define-history) is modeled here by ONE external
// `SessionHistory` instance living OUTSIDE any single call's env/tool — exactly the split the
// design calls for ("teaching state is SESSION-scoped … env is the consumer's to own"). Each
// iteration: build a FRESH env, replay the running history into it, construct a FRESH
// `createManifoldTool` over it (so nothing about the tool's own closure survives either), run the
// call, then fold this call's OWN newly-recorded defines (`tool.sessionHistory()` — which, since
// the tool is fresh, only ever contains defines THIS call itself produced) into the running
// history via the SAME last-wins `push` semantics session-history.ts already implements.

import { createSessionHistory, replaySessionHistory } from "@inhuman.tools/mcp-substrate";
import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

type Block = { type: string; text: string };
const textsOf = (r: { content: unknown }): string[] => (r.content as Block[]).map((b) => b.text);

/** The introduced-names persistence note (mcp-substrate runner.ts's void-result-trap fix): a
 *  bare `define` call produces this note rather than an empty block. It rides BOTH mechanisms
 *  identically — deterministic per-call in either the persistent env or fresh-env+replay — so it
 *  does not touch the equivalence invariant this file protects ("persistent env vs
 *  fresh-env+replay produce IDENTICAL output"); only its CONCRETE TEXT is pinned here.
 *
 *  Every note-shaped producer (introduced-bindings, elision, futility, attachment) accumulates
 *  into ONE combined `#| ── environment notes ── … |#` block; this fixture only ever has ONE
 *  producer active per call, so the wrapper is visible around a single line.
 *
 *  The trailing clause "(nothing was executed — these are bindings only)" fires whenever the
 *  call produced no other observation (every call in this file is a single bare `define`, so it
 *  fires every time): a define-only banner read on its own as evidence something had executed,
 *  and cost a trajectory a round over it. */
const intro = (...names: string[]): string =>
  [
    "#| ── environment notes ──",
    `${names.join(", ")} — also available in subsequent calls. (nothing was executed — these are bindings only)`,
    "|#",
  ].join("\n");

/** Runs the SAME ordered sequence of per-call programs against a mechanism-A (persistent env,
 *  today's manifold model — replay never engages) or mechanism-B (fresh env + history-replay
 *  every call — the arrival-mcp shape the future runner must also serve) and returns each call's
 *  result text blocks, per call, in order. */
async function runPersistent(programsPerCall: readonly string[]): Promise<string[][]> {
  const manifoldEnv = await buildManifoldEnv([]);
  const tool = createManifoldTool(manifoldEnv, "CATALOG");
  const results: string[][] = [];
  for (const program of programsPerCall) {
    results.push(textsOf(await tool.call({ expr: program })));
  }
  return results;
}

async function runFreshEnvWithReplay(programsPerCall: readonly string[]): Promise<string[][]> {
  // The session-lived history — owned OUTSIDE any one call's env/tool, surviving across the
  // whole loop exactly as the future runner's session-scoped instance would.
  const runningHistory = createSessionHistory();
  const results: string[][] = [];
  for (const program of programsPerCall) {
    const manifoldEnv = await buildManifoldEnv([]); // a BRAND-NEW world every call — no identity carried over
    await replaySessionHistory(runningHistory.entries(), manifoldEnv.ambient, manifoldEnv.scope);
    const tool = createManifoldTool(manifoldEnv, "CATALOG"); // a BRAND-NEW tool instance too
    results.push(textsOf(await tool.call({ expr: program })));
    // Fold this call's OWN new defines into the running (session-scoped) history — same
    // last-wins/move-to-newest rule session-history.ts's own store already implements.
    for (const entry of tool.sessionHistory()) runningHistory.push(entry.name, entry.source);
  }
  return results;
}

describe("env-lifecycle-agnostic equivalence — persistent env vs fresh-env+replay produce IDENTICAL output", () => {
  it("a 3-call sequence of defines + a dependent use produces byte-identical results either way", async () => {
    const programs = ["(define a 1)", "(define b (+ a 1))", "(+ a b)"];

    const persistent = await runPersistent(programs);
    const freshReplay = await runFreshEnvWithReplay(programs);

    // A void-returning define now LEADS with the introduced-names persistence note (never an
    // empty block — the void-result-trap fix); only the final expression-statement adds a value.
    expect(persistent).toEqual([[intro("a")], [intro("b")], ["3"]]);
    expect(freshReplay).toEqual(persistent);
  });

  it("a longer, 5-call sequence with a rebind that does NOT reorder a dependency — still byte-identical", async () => {
    const programs = [
      "(define x 10)",
      "(define y (* x 2))",
      "(+ x y)",
      "(define z 5)", // a fresh name — no rebind, so no history-reordering is in play
      "(+ x y z)",
    ];

    const persistent = await runPersistent(programs);
    const freshReplay = await runFreshEnvWithReplay(programs);

    expect(freshReplay).toEqual(persistent);
    // Concrete pin: 10+20=30, then 10+20+5=35 (defines lead with the persistence note).
    expect(persistent).toEqual([[intro("x")], [intro("y")], ["30"], [intro("z")], ["35"]]);
  });

  it(
    "KNOWN, DOCUMENTED DIVERGENCE (session-history.ts's own ORDERING CAVEAT, not a new finding here): " +
      "a REBIND that reorders a name past a statement that depended on its EARLIER value breaks the " +
      "equivalence — fresh-env+replay genuinely differs from the persistent-env baseline in this one " +
      "acknowledged case",
    async () => {
      const programs = [
        "(define x 10)",
        "(define y (* x 2))", // y closes over x's CURRENT value (10) in the persistent env
        "(+ x y)",
        "(define x 100)", // rebind — session-history.ts moves x to NEWEST position in the compacted history
        "(+ x y)", // persistent env: y is still the LIVE 20 it was bound to; replay: y's entry now
        //            replays AFTER x's rebind, so it re-evaluates `(* x 2)` against x=100 ⇒ 200 —
        //            except the caveat is actually the OPPOSITE direction (y moves BEFORE x in
        //            history order, so replay tries y first and finds x unbound, per the caveat's
        //            own text) — asserted empirically below rather than guessed.
      ];

      const persistent = await runPersistent(programs);
      const freshReplay = await runFreshEnvWithReplay(programs);

      // The persistent env's live-object semantics: y is bound ONCE (=20) and never re-evaluated by
      // the later rebind of x — ordinary scheme `define` semantics.
      expect(persistent).toEqual([[intro("x")], [intro("y")], ["30"], [intro("x")], ["120"]]);
      // The fresh-env+replay mechanism does NOT reproduce this: session-history.ts's compacted,
      // last-wins store moves a rebound name to the NEWEST position (its own file header, the
      // ORDERING CAVEAT), so replay processes `y`'s entry BEFORE `x`'s rebind entry — `y`'s replay
      // statement `(define y (* x 2))` throws "Unbound variable `x'" (x isn't bound yet at that
      // point in replay order) and is reported in `failed`, never silently wrong. The final
      // statement then reads `y` as unbound too.
      expect(freshReplay).not.toEqual(persistent);
      expect(freshReplay[4]).toEqual(["Error: Unbound variable `y'"]);
    },
  );

  it("a statement that ERRORS never persists into either mechanism's replayed state", async () => {
    const programs = ["(define a 1)", "(car 42)", "(define b (+ a 1))", "(+ a b)"];

    const persistent = await runPersistent(programs);
    const freshReplay = await runFreshEnvWithReplay(programs);

    expect(freshReplay).toEqual(persistent);
    // The `(car 42)` call fails identically in both mechanisms (it's never a define, so it never
    // reaches session-history either way) — only its ERROR TEXT needs to agree, not be re-derived
    // here; the byte-identical assertion above already covers it structurally. Spot-check the
    // final arithmetic still lands correctly around the failure.
    expect(persistent[3]).toEqual(["3"]);
  });
});

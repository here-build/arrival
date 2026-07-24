// prelude-overlay.test.ts — end-to-end proof of the phase-gated `preludeOnly` mechanism
// (design doc §1.3) against the self-hosted vocabulary path (`buildVocabulary` +
// `env/assemble-run.ts`'s per-run prelude pass) — via `exec`/`execState({capabilities})`.
//
// STAGE C CUT 4 (docs/plans/stage-c-corpse-deletion.md) retired `lower()`/`assembleEnv`; this
// file's OWN mechanism (a bespoke `assembleEnv(base, [cap.lower({evalScheme})])` fixture) went
// with it. Re-authored against the sanctioned path: `exec`/`execState({capabilities})` builds
// the `Vocabulary` and runs the tuple's per-run prelude pass (`env/assemble-run.ts`'s
// `assembleRun`, step 3) as part of minting the RunContext, before any program form evaluates.
//
// A REAL BEHAVIORAL FINDING surfaced while re-authoring (not caused by Cut 4 — Stage B2's
// `assemble-run.ts` already shipped this, this migration is what first exercised it end-to-end):
// the per-run prelude pass runs preludes against a FRESH, DISCARDED-per-run scope
// (`assemble-run.ts`'s own doc: "any `(define …)` a prelude form ran is gone with it — the
// spec's confirmed discard ruling"). Under the retired BOOTSTRAP path, `ctx.preludeEvalScope`
// was `undefined`, so `capability.ts`'s `lower().apply()` fell back to evaluating a prelude
// directly against the REAL env — an ordinary `(define …)` in prelude TEXT genuinely persisted.
// That is NO LONGER TRUE: every run (there is no other path now) discards the per-run prelude
// scope. Facts proven here, against the CURRENT model:
//   1. a preludeOnly verb is callable from a LATER capability's prelude during the per-run
//      prelude pass, and a plain unbound-variable error from user program code.
//   2. an ordinary prelude `(define …)` does NOT land in the runtime env anymore — discarded
//      with the per-run prelude scope (the reversed finding above).
//   3. the prelude scope ACCUMULATES across capabilities within ONE prelude pass (C3 dep order)
//      — proven via side-effecting rosetta calls (recording, not defining), which still observe
//      each other correctly within that one pass.
//   4. NEITHER a lambda DEFINED BY a prelude NOR a value CAPTURED BY a prelude `(define …)`
//      survives to runtime anymore — both are ordinary prelude-scope defines, discarded alike.
//      The only way to expose a prelude-computed value as a stable runtime name now is a real
//      `symbol.define`/`symbol.native` declaration (Pass 1/2 of `buildVocabulary`), never prelude
//      TEXT.

import { describe, expect, it } from "vitest";
import { exec, execState } from "../../eval/generator-exec.js";
import { EnvCapability } from "../capability.js";

describe("preludeOnly — the phase-gated per-run prelude pass (design §1.3, over the vocabulary path)", () => {
  // INVARIANT: a preludeOnly verb is unbound at runtime, but a later capability's prelude can
  // call it during the per-run prelude pass.
  it("a preludeOnly verb is UNBOUND at runtime, but a LATER capability's prelude that calls it during the prelude pass works", async () => {
    // Capability A contributes a preludeOnly rosetta. Capability B (deps on A) calls it from
    // its OWN prelude, recording the call as an observable side effect via a runtime-bound sink.
    const calls: string[] = [];
    const capA = EnvCapability.define("test/overlay-a", {
      symbols: (symbol, z) => ({
        "overlay/greet": symbol.rosetta`overlay/greet: prelude-only greeting verb`(
          { input: [z.string], output: [z.string], preludeOnly: true },
          (name) => `hello ${name}`,
        ) }) });
    const capB = EnvCapability.define("test/overlay-b", {
      deps: [capA],
      symbols: (symbol, z) => ({
        "sink/record": symbol.rosetta`sink/record: record a call for the test to observe`(
          { input: [z.string], output: [z.string] },
          (s) => {
            calls.push(s);
            return s;
          },
        ) }),
      // B's prelude calls A's preludeOnly verb (visible because A applied first — C3 dep
      // order — and the per-run prelude scope answers from BOTH the main map and the
      // preludeOnly overlay) and forwards the result to a RUNTIME-bound sink.
      prelude: `(sink/record (overlay/greet "world"))` });

    // Minting a run for this tuple runs the prelude pass — before ANY program form evaluates.
    const state = await execState(`1`, { capabilities: [capB] });
    expect(calls).toEqual(["hello world"]);

    // The preludeOnly verb itself is a plain unbound-variable error from user code — nothing to
    // seal. Reuse the SAME runCtx (REPL continuity) so the prelude pass does not re-fire.
    await expect(exec(`(overlay/greet "again")`, { capabilities: [capB], runCtx: state.runCtx })).rejects.toThrow(
      /Unbound variable/,
    );
  });

  // INVARIANT (Stage B2, reversed from the retired bootstrap path — see this file's header): an
  // ordinary prelude `(define …)` is DISCARDED with the per-run prelude scope, never reaching
  // user program code.
  it("an ordinary prelude `define` does NOT land in the runtime env — discarded with the per-run prelude scope", async () => {
    const cap = EnvCapability.define("test/overlay-define", {
      prelude: `(define overlay-defined-value 42)`,
      symbols: () => ({}) });
    const state = await execState(`1`, { capabilities: [cap] });
    await expect(
      exec(`overlay-defined-value`, { capabilities: [cap], runCtx: state.runCtx }),
    ).rejects.toThrow(/Unbound variable/);
  });

  // INVARIANT: the prelude scope accumulates across a chain of dependents in C3 order, WITHIN
  // one prelude pass — a shared Map for that pass, not rebuilt per capability.
  it("the prelude scope ACCUMULATES: A's preludeOnly verb is visible to a chain of TWO dependents via C3 order", async () => {
    const capA = EnvCapability.define("test/overlay-chain-a", {
      symbols: (symbol, z) => ({
        "chain/base-secret": symbol.rosetta`chain/base-secret: preludeOnly value contributed by A`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 7,
        ) }) });
    // B deps on A, records what it saw at prelude-eval time.
    const bSeen: number[] = [];
    const capB = EnvCapability.define("test/overlay-chain-b", {
      deps: [capA],
      symbols: (symbol, z) => ({
        "chain/note": symbol.rosetta`chain/note: record a number seen during B's prelude`(
          { input: [z.number], output: [z.number] },
          (n) => {
            bSeen.push(n);
            return n;
          },
        ) }),
      prelude: `(chain/note (chain/base-secret))` });
    // C deps on B (transitively on A) — proves the prelude scope is the SAME shared Map across
    // the whole prelude pass, not re-built per-capability.
    const cSeen: number[] = [];
    const capC = EnvCapability.define("test/overlay-chain-c", {
      deps: [capB],
      symbols: (symbol, z) => ({
        "chain/note-c": symbol.rosetta`chain/note-c: record a number seen during C's prelude`(
          { input: [z.number], output: [z.number] },
          (n) => {
            cSeen.push(n);
            return n;
          },
        ) }),
      prelude: `(chain/note-c (chain/base-secret))` });

    await execState(`1`, { capabilities: [capC] });

    expect(bSeen).toEqual([7]);
    expect(cSeen).toEqual([7]);
  });

  // INVARIANT (Stage B2, reversed from the retired bootstrap path — see this file's header):
  // NEITHER a lambda DEFINED BY a prelude NOR a value CAPTURED BY a prelude `(define …)` reaches
  // runtime anymore — both are ordinary prelude-scope defines, discarded alike. The retired
  // bootstrap path's "capture the RESULT, not the verb" bridge no longer bridges anything at
  // all; only a real `symbol.define`/`symbol.native` declaration (not prelude TEXT) exposes a
  // stable runtime name now.
  it("THE CONTRACT (reversed): neither a closure NOR a captured value defined by a prelude survives to runtime", async () => {
    const cap = EnvCapability.define("test/overlay-closure", {
      symbols: (symbol, z) => ({
        "closure/secret": symbol.rosetta`closure/secret: preludeOnly source`(
          { input: [], output: [z.number], preludeOnly: true },
          () => 99,
        ) }),
      // Two prelude defines: what the retired bootstrap path called the WRONG bridge (a lambda
      // naming the verb) and the RIGHT bridge (capture the call's result) — both discarded now.
      prelude: `
        (define (broken-bridge) (closure/secret))
        (define captured-secret (closure/secret))
      ` });
    const state = await execState(`1`, { capabilities: [cap] });

    // Neither prelude define reaches user program code — the per-run prelude scope that held
    // both is gone.
    await expect(exec(`captured-secret`, { capabilities: [cap], runCtx: state.runCtx })).rejects.toThrow(
      /Unbound variable/,
    );
    await expect(exec(`(broken-bridge)`, { capabilities: [cap], runCtx: state.runCtx })).rejects.toThrow(
      /Unbound variable/,
    );
  });
});

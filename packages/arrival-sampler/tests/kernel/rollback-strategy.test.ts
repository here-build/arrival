// rollback-strategy.test.ts — THE MODEL-FREE PROOF that rollback's search is correct (and that K=0 ≡ greedy).
//
// The payoff of building rollback against the ABSTRACT `DecodeBackend` (decode-backend.ts) is THIS file: a
// `ScriptedDecodeBackend` driven by a canned `prefix → ranked distribution` map drives the WHOLE rollback
// search — backtrack, rewind, re-descend — with NO model, NO Metal, NO inference. The constraint is a tiny
// STUB `OracleScanner` whose per-prefix feasibility + closeability we control directly, so each scenario
// pins exactly the contested-step / regret structure under test. Four properties:
//
//   1. PARITY (K=0):              RollbackStrategy K=0 ≡ GreedyStrategy byte-for-byte on one scripted backend.
//   2. NO-REGRET ⇒ NO-BACKTRACK:  every step's regret ≤ θ ⇒ zero backtracks, one completion, == greedy.
//   3. RECOVERY (the search):     a fork where greedy's best-feasible completes VALID but LOW total-logprob
//                                 while the untried alternative completes VALID + HIGHER — rollback (K≥1)
//                                 returns the higher one; greedy the lower; improvedOverGreedy is set.
//   4. BUDGET:                    on a many-contested-point script, backtracksUsed never exceeds K.
//
// All four run in the default `__tests__` gate (no native addon — the scripted backend's node-llama-cpp
// imports are type-only).

import { describe, expect, it } from "vitest";

import { ScriptedDecodeBackend, type ScriptEntry, type ScriptedBackendSpec } from "../../src/runners/local/backends/index.js";
import {
  GreedyStrategy,
  makeRollbackStrategy,
  type DecodeContext,
  type DecodeTelemetry,
  type IdPolyDecodeStrategy,
} from "../../src/runners/local/strategies/index.js";
import type { OracleScanner, OracleState } from "../../src/oracle-types.js";

// ── the controllable stub oracle ─────────────────────────────────────────────────────────────────────
//
// Feasibility is STRING-BASED: a candidate `str` at accepted `prefix` is structurally live iff the full
// string `prefix + str` is in `liveStrings` (classifyCandidate's first gate is `scanner.feasible(next)`).
// Σ is disabled (`validSymbols() => null` ⇒ passesSigma is a no-op pass), and the test strings never trip
// `violatesToolCallGrammar` (no `,` / backtick / bad-quote), so feasibility reduces to exactly our set.
// `closeable` (EOS legality) is read off the ACCEPTED prefix via `closeableStrings`.

function makeStubScanner(liveStrings: ReadonlySet<string>, closeableStrings: ReadonlySet<string>): OracleScanner {
  const state = (prefix: string): OracleState => ({
    midToken: false,
    position: "argument",
    formKind: "application",
    closeable: closeableStrings.has(prefix),
    overClosed: !liveStrings.has(prefix),
    validSymbols: () => null,
  });
  return {
    feasible: (prefix) => liveStrings.has(prefix),
    analyze: (prefix) => state(prefix),
  };
}

/** A fresh telemetry object (the strategy mutates it in place). */
function telemetry(): DecodeTelemetry {
  return { generatedTokens: 0, overruledSteps: 0, forcedSlots: 0, tailPicks: 0, tailMass: 0 };
}

/** Build a `DecodeContext` over a fresh scripted backend for `spec`, constrained by `scanner`. Each call
 *  gets its OWN backend (the backend is stateful — commits mutate it), so two strategies decode independently. */
function context(spec: ScriptedBackendSpec, scanner: OracleScanner): DecodeContext<number> {
  return {
    backend: new ScriptedDecodeBackend(spec),
    prefix: spec.prefill,
    constrained: true,
    scanner,
    maxNewTokens: 32,
    topK: 64,
    wideK: 256,
    temperature: 0,
    rng: () => 0,
    profile: undefined,
    explainTopK: 8,
    telemetry: telemetry(),
  };
}

/** Convenience: a script step from `[id, prob, str]` tuples (prob-descending order = model rank). */
function step(...entries: [number, number, string][]): ScriptEntry[] {
  return entries.map(([id, prob, str]) => ({ id, prob, str }));
}

const EOS = 0; // the EOS token id across all scripts.

// ── SCENARIO 3's script (shared by 1 + 3): a single contested fork at `(` ────────────────────────────
//
// At `(` the model most wants `f ` (id 1, p=0.6) — but it is INFEASIBLE (no `(f ` live string). The
// feasible arms are `g ` (id 2, p=0.3) and `h ` (id 3, p=0.1). regret = 0.6 − 0.3 = 0.3 > θ(0.25), ≥2
// feasible ⇒ a CHOICE POINT. Greedy commits `g ` (the best feasible), whose path `(g x)` has total-logprob
// log(0.3)+log(0.2)+log(0.95). The untried arm `h ` leads to `(h y)` with log(0.1)+log(0.9)+log(0.95) —
// HIGHER (log 0.09 > log 0.06). So greedy lands the low one; rollback recovers the high one.
const RECOVERY_SPEC: ScriptedBackendSpec = {
  prefill: "(",
  eosId: EOS,
  steps: new Map<string, ScriptEntry[]>([
    // The fork: `f ` (infeasible) ranked above the two feasible arms.
    ["(", step([1, 0.6, "f "], [2, 0.3, "g "], [3, 0.1, "h "])],
    // Greedy arm `g `: a LOW-prob content step then a closeable end.
    ["(g ", step([4, 0.2, "x)"], [1, 0.1, "f)"])],
    ["(g x)", step([EOS, 0.95, ""], [5, 0.05, " "])],
    // Alternative arm `h `: a HIGH-prob content step then a closeable end (better total-logprob).
    ["(h ", step([6, 0.9, "y)"], [1, 0.05, "f)"])],
    ["(h y)", step([EOS, 0.95, ""], [5, 0.05, " "])],
  ]),
};
// Live strings: every prefix the descent can legally reach (the gate is `feasible(prefix + str)`). `(f ` is
// ABSENT ⇒ `f ` is vetoed at the fork. The closeable set is the two complete programs (EOS legal there).
const RECOVERY_LIVE = new Set<string>(["(", "(g ", "(g x)", "(h ", "(h y)", "(g f)", "(h f)"]);
const RECOVERY_CLOSEABLE = new Set<string>(["(g x)", "(h y)", "(g f)", "(h f)"]);

function recoveryScanner(): OracleScanner {
  return makeStubScanner(RECOVERY_LIVE, RECOVERY_CLOSEABLE);
}

// ── 1. PARITY: RollbackStrategy K=0 ≡ GreedyStrategy, byte-for-byte ───────────────────────────────────
describe("rollback K=0 ≡ greedy (parity)", () => {
  it("produces the byte-identical program GreedyStrategy produces on the same scripted backend", async () => {
    const scanner = recoveryScanner();
    const greedy = await GreedyStrategy.decode(context(RECOVERY_SPEC, scanner));

    const rollback0: IdPolyDecodeStrategy & { lastTelemetry: { backtracksUsed: number; completionsExplored: number } } =
      makeRollbackStrategy(0, 0.25);
    const rolled = await rollback0.decode(context(RECOVERY_SPEC, scanner));

    expect(rolled.program, "K=0 rollback must equal greedy byte-for-byte").toBe(greedy.program);
    expect(greedy.program, "greedy lands the low-logprob arm `(g x)`").toBe("(g x)");
    // K=0 ⇒ ONLY the baseline pass ran: no backtrack, exactly one completion.
    expect(rollback0.lastTelemetry.backtracksUsed).toBe(0);
    expect(rollback0.lastTelemetry.completionsExplored).toBe(1);
  });
});

// ── 2. NO-REGRET ⇒ NO-BACKTRACK ──────────────────────────────────────────────────────────────────────
describe("rollback with no regret ⇒ no backtrack", () => {
  // Every step's model-preferred token is FEASIBLE (regret 0), so no choice point is ever recorded.
  const SPEC: ScriptedBackendSpec = {
    prefill: "(",
    eosId: EOS,
    steps: new Map<string, ScriptEntry[]>([
      ["(", step([1, 0.8, "a "], [2, 0.2, "b "])], // `a ` feasible AND top ⇒ regret 0.
      ["(a ", step([3, 0.7, "c)"], [4, 0.3, "d)"])], // `c)` feasible AND top ⇒ regret 0.
      ["(a c)", step([EOS, 0.9, ""], [5, 0.1, " "])],
    ]),
  };
  const LIVE = new Set<string>(["(", "(a ", "(a c)", "(a d)", "(b "]);
  const CLOSEABLE = new Set<string>(["(a c)", "(a d)"]);

  it("rollback == greedy with zero backtracks / one completion (no regret anywhere)", async () => {
    const scanner = makeStubScanner(LIVE, CLOSEABLE);
    const greedy = await GreedyStrategy.decode(context(SPEC, scanner));

    const rollback = makeRollbackStrategy(3, 0.25);
    const rolled = await rollback.decode(context(SPEC, scanner));

    expect(rolled.program).toBe(greedy.program);
    expect(rolled.program).toBe("(a c)");
    expect(rollback.lastTelemetry.backtracksUsed, "no regret ⇒ no backtrack").toBe(0);
    expect(rollback.lastTelemetry.completionsExplored, "only the baseline completion").toBe(1);
    expect(rollback.lastTelemetry.improvedOverGreedy, "nothing to improve").toBe(false);
  });
});

// ── 3. ★RECOVERY — rollback beats greedy on crafted myopia ───────────────────────────────────────────
describe("rollback recovers a higher-log-prob valid program greedy's myopia misses", () => {
  it("greedy lands the low arm; rollback (K≥1) recovers the high arm; improvedOverGreedy set", async () => {
    const scanner = recoveryScanner();

    // GREEDY: commits the best-feasible `g ` at the fork → the LOW-total-logprob valid program `(g x)`.
    const greedy = await GreedyStrategy.decode(context(RECOVERY_SPEC, scanner));
    expect(greedy.program, "greedy myopically takes the higher-prob feasible arm at the fork").toBe("(g x)");

    // ROLLBACK (K=1): backtracks the single regret choice point, takes the untried arm `h ` → the
    // HIGHER-total-logprob valid program `(h y)`.
    const rollback = makeRollbackStrategy(1, 0.25);
    const rolled = await rollback.decode(context(RECOVERY_SPEC, scanner));

    expect(rolled.program, "rollback recovers the higher-log-prob valid completion").toBe("(h y)");
    expect(rolled.program).not.toBe(greedy.program);
    expect(rollback.lastTelemetry.backtracksUsed, "exactly one backtrack spent").toBe(1);
    expect(rollback.lastTelemetry.completionsExplored, "baseline + one backtrack completion").toBe(2);
    expect(rollback.lastTelemetry.improvedOverGreedy, "the backtrack BEAT greedy").toBe(true);
  });

  it("the recovered arm is genuinely higher total log-prob (log 0.09 > log 0.06)", () => {
    // The numerical claim the test rests on, asserted directly so the script's intent is self-documenting.
    const greedyArm = Math.log(0.3) + Math.log(0.2); // `(g ` → `x)`
    const altArm = Math.log(0.1) + Math.log(0.9); //   `(h ` → `y)`
    expect(altArm).toBeGreaterThan(greedyArm); // the EOS step (0.95) is identical on both, so it cancels.
  });
});

// ── 4. BUDGET — backtracksUsed never exceeds K on a many-contested-point script ──────────────────────
describe("rollback respects the K backtrack budget", () => {
  // A CHAIN of contested forks: at every `(`, `(a `, `(a b ` … the model wants an infeasible top token and
  // ≥2 feasible arms with regret > θ exist, so each greedy step records a choice point AND each backtrack's
  // onward descent records more — the pool always has untried arms. K must still cap the backtracks.
  const SPEC: ScriptedBackendSpec = {
    prefill: "(",
    eosId: EOS,
    steps: new Map<string, ScriptEntry[]>([
      // Each fork: infeasible `z ` (id 9, p=0.7) over two feasible arms (regret 0.7−0.3 = 0.4 > θ).
      ["(", step([9, 0.7, "z "], [1, 0.3, "a "], [2, 0.1, "b "])],
      ["(a ", step([9, 0.7, "z "], [3, 0.3, "c "], [4, 0.1, "d "])],
      ["(b ", step([9, 0.7, "z "], [3, 0.3, "c "], [4, 0.1, "d "])],
      ["(a c ", step([9, 0.7, "z "], [5, 0.3, "e)"], [6, 0.1, "f)"])],
      ["(a d ", step([9, 0.7, "z "], [5, 0.3, "e)"], [6, 0.1, "f)"])],
      ["(b c ", step([9, 0.7, "z "], [5, 0.3, "e)"], [6, 0.1, "f)"])],
      // Closeable ends for every arm combination reachable within the budget.
      ["(a c e)", step([EOS, 0.9, ""], [7, 0.1, " "])],
      ["(a c f)", step([EOS, 0.9, ""], [7, 0.1, " "])],
      ["(a d e)", step([EOS, 0.9, ""], [7, 0.1, " "])],
      ["(b c e)", step([EOS, 0.9, ""], [7, 0.1, " "])],
    ]),
  };
  // Every reachable prefix EXCEPT the `z `-led ones is live (so `z ` is always vetoed, always contested).
  const LIVE = new Set<string>([
    "(",
    "(a ",
    "(b ",
    "(a c ",
    "(a d ",
    "(b c ",
    "(b d ",
    "(a c e)",
    "(a c f)",
    "(a d e)",
    "(a d f)",
    "(b c e)",
    "(b c f)",
  ]);
  const CLOSEABLE = new Set<string>(["(a c e)", "(a c f)", "(a d e)", "(a d f)", "(b c e)", "(b c f)"]);

  it("backtracksUsed ≤ K (K=2) on a script with many contested choice points", async () => {
    const scanner = makeStubScanner(LIVE, CLOSEABLE);
    const K = 2;
    const rollback = makeRollbackStrategy(K, 0.25);
    const rolled = await rollback.decode(context(SPEC, scanner));

    expect(rollback.lastTelemetry.backtracksUsed, "never exceeds the budget K").toBeLessThanOrEqual(K);
    // The baseline completion plus AT MOST K backtrack completions.
    expect(rollback.lastTelemetry.completionsExplored).toBeLessThanOrEqual(K + 1);
    // Sanity: the budget was actually exercised (the script is genuinely contested), and a valid program
    // came out (a closeable `(… …)` end was reached).
    expect(rollback.lastTelemetry.backtracksUsed, "the contested script DID drive backtracks").toBe(K);
    expect(rolled.program.startsWith("(") && rolled.program.endsWith(")")).toBe(true);
  });
});

// honor-the-stop.test.ts — the HONOR-THE-STOP decode guard (greedyDescend). At a CLOSEABLE prefix, if the
// model's UNMASKED argmax is itself INFEASIBLE — it wants to LEAVE Scheme-space (close a markdown fence,
// write prose, emit a grammar-banned delimiter) — the program is already complete and the decode TERMINATES
// rather than force-feeding the best *feasible* token.
//
// The bug it fixes (rnj-1, BFCL parallel grammar, −39pp vs unconstrained): the model frames calls in a
// ```scheme fence and terminates by CLOSING the fence — its argmax after a complete program is ``` at p≈1.
// The oracle masks the backtick (quasiquote) and force-feeds a p≈0 NEW call, looping to the token cap and
// breaking the parallel set-match. The grammar's "valid" (no backtick) is NARROWER than the scorer's
// "correct" (it strips the fence), so masking the close DELETES a correct program — a soundness violation
// (a grammar gate must never score below unconstrained). Two model-free scenarios over a scripted backend:
//   STOPS    — closeable + infeasible argmax ⇒ terminate at the complete program (the fix).
//   CONTINUES — closeable + FEASIBLE argmax (a genuine next call) ⇒ do NOT truncate (no over-stop).
//
// The stub oracle mirrors rollback-strategy.test.ts: feasibility is STRING-BASED (`prefix+str` ∈ liveStrings),
// Σ disabled (validSymbols ⇒ null), closeability read off a set — so the test isolates exactly the guard.

import { describe, expect, it } from "vitest";

import { ScriptedDecodeBackend, type ScriptEntry, type ScriptedBackendSpec } from "../../src/runners/local/backends/index.js";
import { GreedyStrategy, type DecodeContext, type DecodeTelemetry } from "../../src/runners/local/strategies/index.js";
import type { OracleScanner, OracleState } from "../../src/oracle-types.js";

const EOS = 0;

function makeStubScanner(liveStrings: ReadonlySet<string>, closeableStrings: ReadonlySet<string>): OracleScanner {
  const state = (prefix: string): OracleState => ({
    midToken: false,
    position: "argument",
    formKind: "application",
    closeable: closeableStrings.has(prefix),
    overClosed: !liveStrings.has(prefix),
    validSymbols: () => null,
  });
  return { feasible: (prefix) => liveStrings.has(prefix), analyze: (prefix) => state(prefix) };
}

function telemetry(): DecodeTelemetry {
  return { generatedTokens: 0, overruledSteps: 0, forcedSlots: 0, tailPicks: 0, tailMass: 0 };
}

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

/** A script step from `[id, prob, str]` tuples (prob-descending = model rank). */
function step(...entries: [number, number, string][]): ScriptEntry[] {
  return entries.map(([id, prob, str]) => ({ id, prob, str }));
}

describe("honor-the-stop: closeable + infeasible argmax ⇒ terminate (runaway-past-completion fix)", () => {
  // After the complete `(c)`, the model's argmax is `X` (id 2, p=0.99) — INFEASIBLE (`(c)X` is not live), the
  // analog of the masked close-fence ```. A feasible-but-low runaway continuation `(d)` (p=0.01) and EOS
  // (p=0.005) also exist, so without the guard greedy force-feeds `(d)` (the best feasible) and loops; with it,
  // the infeasible argmax at a complete program is read as "the model is done" and the decode stops at `(c)`.
  const SPEC: ScriptedBackendSpec = {
    prefill: "(",
    eosId: EOS,
    steps: new Map<string, ScriptEntry[]>([
      ["(", step([1, 0.9, "c)"])], // → "(c)" (complete, closeable)
      ["(c)", step([2, 0.99, "X"], [3, 0.01, "(d)"], [EOS, 0.005, ""])], // argmax X infeasible; (d) the runaway trap
      ["(c)(d)", step([2, 0.99, "X"], [4, 0.01, "(d)"], [EOS, 0.005, ""])], // where it WOULD loop if it continued
      ["(c)(d)(d)", step([EOS, 0.9, ""])],
    ]),
  };
  // X-suffixed prefixes are ABSENT ⇒ infeasible; the `(d)` continuations are live (the trap greedy would take).
  const LIVE = new Set<string>(["(", "(c)", "(c)(d)", "(c)(d)(d)"]);
  const CLOSEABLE = new Set<string>(["(c)", "(c)(d)", "(c)(d)(d)"]);

  it("stops at the complete program instead of running away to the token cap", async () => {
    const greedy = await GreedyStrategy.decode(context(SPEC, makeStubScanner(LIVE, CLOSEABLE)));
    // Assert the FULL decoded text (rawDecode), NOT `.program` — `.program` extracts the first balanced form
    // (`(c)`) and would pass even on a runaway. Without the guard the pick would force `(d)` (best feasible
    // after X is masked) and loop: rawDecode would be `(c)(d)(d)`. The guard ⇒ the decode ends at `(c)`.
    expect(greedy.rawDecode).toBe("(c)");
  });
});

describe("honor-the-stop: closeable + FEASIBLE argmax ⇒ do NOT truncate (no over-stop)", () => {
  // After `(c)` the model's argmax is a GENUINE next call `(d)` (feasible) — a parallel set still in progress.
  // The guard must NOT fire (a feasible argmax is not "leaving Scheme-space"); the decode continues until the
  // model's OWN argmax becomes EOS at `(c)(d)`. This proves the guard keys on infeasibility, not on closeability.
  const SPEC: ScriptedBackendSpec = {
    prefill: "(",
    eosId: EOS,
    steps: new Map<string, ScriptEntry[]>([
      ["(", step([1, 0.9, "c)"])], // → "(c)"
      ["(c)", step([3, 0.9, "(d)"], [EOS, 0.1, ""])], // argmax (d) FEASIBLE ⇒ model wants another call
      ["(c)(d)", step([EOS, 0.9, ""], [4, 0.1, "(e)"])], // now argmax EOS ⇒ done
    ]),
  };
  const LIVE = new Set<string>(["(", "(c)", "(c)(d)"]);
  const CLOSEABLE = new Set<string>(["(c)", "(c)(d)"]);

  it("continues to the model's own EOS, emitting both calls", async () => {
    const greedy = await GreedyStrategy.decode(context(SPEC, makeStubScanner(LIVE, CLOSEABLE)));
    // Full text again: the guard must NOT truncate a feasible continuation, so both calls land before the
    // model's own EOS at `(c)(d)`. (`.program` would be just `(c)` here — the first form — masking the bug.)
    expect(greedy.rawDecode).toBe("(c)(d)");
  });
});

describe("honor-the-stop: EMPTY program ⇒ do NOT fire (guard against the zero-output regression)", () => {
  // The Arch-1.5B regression: a model whose VERY FIRST token is infeasible (it opens with ` `( ` — quasiquote,
  // masked) at an EMPTY prefix the scanner reports CLOSEABLE (empty = "nothing to close" ≠ a complete program).
  // Without the non-empty guard the decode honors the "stop" at step 0 and emits ZERO tokens (grammar 50%→0%).
  // The guard defers to the pick, which force-feeds the feasible opener `(a)` and lets the program begin.
  const SPEC: ScriptedBackendSpec = {
    prefill: "",
    eosId: EOS,
    steps: new Map<string, ScriptEntry[]>([
      ["", step([2, 0.9, "X"], [3, 0.1, "(a)"])], // argmax X infeasible at the EMPTY, closeable prefix
      ["(a)", step([EOS, 0.9, ""], [4, 0.1, "(b)"])], // a complete program, then the model's own EOS
    ]),
  };
  // "" is live (structurally OK, not over-closed); "X"-suffixed prefixes are absent ⇒ infeasible.
  const LIVE = new Set<string>(["", "(a)", "(a)(b)"]);
  // The TRAP: the empty prefix is reported closeable (as the real scanner did for the parallel grant env).
  const CLOSEABLE = new Set<string>(["", "(a)"]);

  it("does not terminate at an empty closeable prefix; forces a feasible opener instead", async () => {
    const greedy = await GreedyStrategy.decode(context(SPEC, makeStubScanner(LIVE, CLOSEABLE)));
    expect(greedy.rawDecode).toBe("(a)");
  });
});

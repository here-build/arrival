// backtick-tolerance.test.ts — the BACKTICK TOLERANCE decode step (greedyDescend). Models frame tool calls
// with markdown backticks the grammar bans (R-UNQUOTE-QUASI): a per-call quasiquote ` `( ` (Arch-1.5B), a
// closing ```` ``` ```` fence (rnj-1), inline code. These are NON-SEMANTIC envelope the scorer/extraction
// strips. Rather than MASK the backtick (which force-feeds the model off its distribution and, after
// honor-the-stop, makes a per-call ` `( ` look like "leaving" → under-generation), we TOLERATE a leading
// backtick at a form boundary: commit the token to the KV (the model stays on its trained rails) but STRIP
// the backtick from the oracle prefix — the `(call)` inside is the program. The per-token analog of the fence
// preamble; the scored/emitted program stays pure Scheme.
//
// The ScriptedDecodeBackend reconstructs its prefix from the COMMITTED tokens (the KV), so the script is
// keyed WITH the backtick (` `( `), while the oracle prefix the stub scanner sees — and `rawDecode` — is the
// STRIPPED form. The script's no-tolerance fallback emits a DIFFERENT call (`(z)`), so `rawDecode === "(c)"`
// proves the backtick path (not the fallback) was taken.

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

function step(...entries: [number, number, string][]): ScriptEntry[] {
  return entries.map(([id, prob, str]) => ({ id, prob, str }));
}

describe("backtick tolerance: a leading ` `( ` is admitted to the KV and stripped from the program", () => {
  // At the empty prefix the model's argmax is ` `( ` (a quasiquoted call opener) — masked by the grammar. WITH
  // tolerance it is committed to the KV and stripped (oracle prefix becomes `(`), the body `c)` lands, and the
  // program is `(c)`. WITHOUT tolerance the masked backtick is dropped and the pick takes the feasible fallback
  // `(z)`. So `(c)` vs `(z)` cleanly distinguishes the two paths.
  const SPEC: ScriptedBackendSpec = {
    prefill: "",
    eosId: EOS,
    // Script keyed by the KV-reconstructed prefix (WITH the backtick the backend commits).
    steps: new Map<string, ScriptEntry[]>([
      ["", step([1, 0.9, "`("], [3, 0.1, "(z)"])], // argmax ` `( ` (tolerated); `(z)` the no-tolerance fallback
      ["`(", step([2, 0.9, "c)"])], // after the tolerated backtick: the call body
      ["`(c)", step([EOS, 0.9, ""])], // EOS at the complete program
      ["(z)", step([EOS, 0.9, ""])], // the fallback's terminal
    ]),
  };
  // ORACLE-prefix feasibility (backtick-free — the oracle never sees the backtick).
  const LIVE = new Set<string>(["(", "(c)", "(z)"]);
  const CLOSEABLE = new Set<string>(["(c)", "(z)"]);

  it("strips the backtick: program is the bare call `(c)`, not the fallback `(z)`", async () => {
    const greedy = await GreedyStrategy.decode(context(SPEC, makeStubScanner(LIVE, CLOSEABLE)));
    expect(greedy.rawDecode).toBe("(c)");
  });
});

// fence-preamble.test.ts — MODEL-FREE proof of the optional markdown fence preamble (the NON-FC constrained
// path's steer). A `ScriptedDecodeBackend` drives the WHOLE preamble + Scheme descent with NO model, NO Metal:
//
//   (a) FENCE OPENED:   a backend whose FIRST token is ` ``` ` gets the canonical ` ```scheme\n ` force-emitted
//                       (committed to the KV, NOT to the Scheme oracle prefix), then the descent decodes the
//                       Scheme call from the post-fence distribution. The grown `ctx.prefix` is the bare call —
//                       the fence never enters the scanner's view.
//   (b) NO FENCE:       a backend whose first token is `(` commits NOTHING in the preamble and decodes
//                       BYTE-IDENTICALLY to a no-preamble run (the pure-addition guarantee).
//   (c) UNWRAP:         `stripFence` turns ` ```scheme\n(foo 1)\n``` ` into `(foo 1)`.
//
// All run in the default `__tests__` gate (the scripted backend's node-llama-cpp imports are type-only).

import { describe, expect, it } from "vitest";

import { ScriptedDecodeBackend, type ScriptEntry, type ScriptedBackendSpec } from "../../src/runners/local/backends/index.js";
import { FENCE_OPENER, maybeOpenFence, stripFence } from "../../src/runners/local/fence-preamble.js";
import { GreedyStrategy, type DecodeContext, type DecodeTelemetry } from "../../src/runners/local/strategies/index.js";
import type { OracleScanner, OracleState } from "../../src/oracle-types.js";

// ── the controllable stub oracle (mirrors rollback-strategy.test.ts) ──────────────────────────────────
//
// Feasibility is STRING-BASED on the SCHEME prefix only (the scanner NEVER sees the fence): a candidate `str`
// at accepted Scheme `prefix` is live iff `prefix + str` ∈ liveStrings. `closeable` reads off the prefix.
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

function telemetry(): DecodeTelemetry {
  return { generatedTokens: 0, overruledSteps: 0, forcedSlots: 0, tailPicks: 0, tailMass: 0 };
}

/** A `DecodeContext` over a fresh scripted backend, constrained by `scanner`. `prefix` is the SCHEME start
 *  (`""` on the fence path — the prompt prefill is empty; the model chooses the first content token). */
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

const EOS = 0;

// The synthetic fence tokenization: the canonical opener ` ```scheme\n ` is ONE id (100); the model's
// first-token fence argmax is a DIFFERENT id (99) that detokenizes to ` ```python ` (a leading backtick → the
// preamble fires). `stringForId` round-trips 100 → FENCE_OPENER so the force-emit guard passes.
const FENCE_OPENER_ID = 100;
const fenceTokenizer = {
  tokenize: (text: string): number[] => (text === FENCE_OPENER ? [FENCE_OPENER_ID] : [...text].map((_, i) => 200 + i)),
  stringForId: (id: number): string => (id === FENCE_OPENER_ID ? FENCE_OPENER : ""),
};

describe("fence preamble — (a) the model opens a fence", () => {
  // The model's FIRST token (at the empty prefill `""`) is ` ```python ` (id 99) — a fence opener. After the
  // preamble force-emits ` ```scheme\n ` (id 100), the backend's committed prefix is ` ```scheme\n `, and the
  // post-fence steps are keyed by that fence prefix + the growing SCHEME. The SCHEME oracle prefix stays bare.
  const SPEC: ScriptedBackendSpec = {
    prefill: "",
    eosId: EOS,
    tokenizer: fenceTokenizer,
    steps: new Map<string, ScriptEntry[]>([
      // First token at the empty prefix: the fence opener wins (the preamble peeks THIS and steers).
      ["", step([99, 0.9, "```python"], [1, 0.05, "("])],
      // Post-fence (committed prefix = the fence opener): the model writes the call, conditioned on the fence.
      [FENCE_OPENER, step([1, 0.95, "("], [2, 0.04, "x"])],
      [`${FENCE_OPENER}(`, step([3, 0.95, "foo 1)"], [4, 0.04, "bar"])],
      [`${FENCE_OPENER}(foo 1)`, step([EOS, 0.99, ""], [5, 0.01, " "])],
    ]),
  };
  // The SCHEME oracle sees ONLY the bare call (no fence): the live/closeable sets are fence-free.
  const LIVE = new Set<string>(["", "(", "(foo 1)"]);
  const CLOSEABLE = new Set<string>(["(foo 1)"]);

  it("force-emits the canonical ```scheme opener and then decodes the bare Scheme call", async () => {
    const ctx = context(SPEC, makeStubScanner(LIVE, CLOSEABLE));
    const fence = await maybeOpenFence(ctx.backend);
    expect(fence.fenceUsed).toBe(true);
    expect(fence.committed).toBe(FENCE_OPENER);
    // After the steer, the backend has the fence in its KV; the descent grows the SCHEME prefix from `""`.
    const { program, rawDecode } = await GreedyStrategy.decode(ctx);
    expect(program).toBe("(foo 1)");
    // rawDecode is the grown SCHEME prefix — the fence is in the backend KV ONLY, never in the oracle prefix.
    expect(rawDecode).toBe("(foo 1)");
    expect(rawDecode).not.toContain("`");
  });
});

describe("fence preamble — (a2) leading whitespace BEFORE the fence (rnj-1's `\\n\\n` then ```)", () => {
  // rnj-1's argmax at step 0 is `\n\n`, and the fence opener only at step 1. The preamble must CONSUME the
  // whitespace, then fire on the fence. The scripted steps are keyed by the committed prefix, so the post-fence
  // keys carry the `\n\n` + ` ```scheme\n ` the model actually saw; the SCHEME oracle still sees only the call.
  const WS = "\n\n"; // one whitespace token (id 50)
  const SPEC: ScriptedBackendSpec = {
    prefill: "",
    eosId: EOS,
    tokenizer: fenceTokenizer,
    steps: new Map<string, ScriptEntry[]>([
      ["", step([50, 0.8, WS], [1, 0.1, "("])], // first token: whitespace → the preamble consumes it
      [WS, step([99, 0.9, "```python"], [1, 0.05, "("])], // then the fence opener → the preamble fires
      [`${WS}${FENCE_OPENER}`, step([1, 0.95, "("], [2, 0.04, "x"])],
      [`${WS}${FENCE_OPENER}(`, step([3, 0.95, "foo 1)"], [4, 0.04, "bar"])],
      [`${WS}${FENCE_OPENER}(foo 1)`, step([EOS, 0.99, ""], [5, 0.01, " "])],
    ]),
  };
  const LIVE = new Set<string>(["", "(", "(foo 1)"]);
  const CLOSEABLE = new Set<string>(["(foo 1)"]);

  it("consumes leading whitespace, then steers the fence, then decodes the bare call", async () => {
    const ctx = context(SPEC, makeStubScanner(LIVE, CLOSEABLE));
    const fence = await maybeOpenFence(ctx.backend);
    expect(fence.fenceUsed).toBe(true);
    expect(fence.committed).toBe(WS + FENCE_OPENER); // the whitespace AND the fence are in the KV
    const { program, rawDecode } = await GreedyStrategy.decode(ctx);
    expect(program).toBe("(foo 1)");
    expect(rawDecode).not.toContain("`");
  });
});

describe("fence preamble — (b) no fence ⇒ byte-identical", () => {
  // The model's first token is `(` (NOT a backtick) → the preamble is a no-op, decode is byte-identical.
  const SPEC: ScriptedBackendSpec = {
    prefill: "",
    eosId: EOS,
    tokenizer: fenceTokenizer, // present, but never reached (no fence opens) — proves the gate, not the tokenizer.
    steps: new Map<string, ScriptEntry[]>([
      ["", step([1, 0.9, "("], [99, 0.05, "```python"])],
      ["(", step([3, 0.95, "foo 1)"], [4, 0.04, "bar"])],
      ["(foo 1)", step([EOS, 0.99, ""], [5, 0.01, " "])],
    ]),
  };
  const LIVE = new Set<string>(["", "(", "(foo 1)"]);
  const CLOSEABLE = new Set<string>(["(foo 1)"]);

  it("commits nothing in the preamble and decodes identically to a no-preamble run", async () => {
    const scanner = makeStubScanner(LIVE, CLOSEABLE);

    // WITH the preamble: it must be a no-op (first token is `(`, not a backtick).
    const ctxWith = context(SPEC, scanner);
    const fence = await maybeOpenFence(ctxWith.backend);
    expect(fence.fenceUsed).toBe(false);
    expect(fence.committed).toBe("");
    const withPreamble = await GreedyStrategy.decode(ctxWith);

    // WITHOUT the preamble: the baseline.
    const ctxBaseline = context(SPEC, scanner);
    const baseline = await GreedyStrategy.decode(ctxBaseline);

    expect(withPreamble.program).toBe(baseline.program);
    expect(withPreamble.rawDecode).toBe(baseline.rawDecode);
    expect(withPreamble.program).toBe("(foo 1)");
    // The backend position is identical too (the preamble committed nothing).
    expect(ctxWith.backend.position()).toBe(ctxBaseline.backend.position());
  });
});

describe("fence preamble — (c) unwrap", () => {
  it("strips a ```scheme fence wrapper to the bare program", () => {
    expect(stripFence("```scheme\n(foo 1)\n```")).toBe("(foo 1)");
  });

  it("strips an unlabeled fence and a no-trailing-newline close", () => {
    expect(stripFence("```\n(bar 2)```")).toBe("(bar 2)");
  });

  it("leaves non-fenced text unchanged", () => {
    expect(stripFence("(baz 3)")).toBe("(baz 3)");
  });
});

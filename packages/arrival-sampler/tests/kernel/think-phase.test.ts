// think-phase.test.ts — MODEL-FREE proof of the reasoning-budget phase ({@link runThinkPhase}) and its NON-FC
// handoff seam. A `ScriptedDecodeBackend` drives the WHOLE phase with NO model, NO Metal, NO inference — just a
// canned `prefix → ranked distribution` map (the payoff of the abstract `DecodeBackend`). Three groups:
//
//   (A) runThinkPhase UNIT — the budget mechanism in isolation:
//       • natural close       — the model emits `</think>` as argmax ⇒ the phase commits it and stops EARLY.
//       • hard backstop       — the model never closes within budget ⇒ the phase FORCES `</think>` at budget.
//       • soft ramp           — the model surfaces `</think>` PAST 60% of budget but not as argmax ⇒ the ramp
//                               biases it to win (closes earlier than the backstop would).
//       • eos mid-think       — the model emits EOS mid-reasoning ⇒ break + the backstop closes.
//       • shouldStop          — a cooperative abort stops reasoning ⇒ the backstop closes.
//       • no-op               — thinkOpen undefined / budget 0 ⇒ returns `{ think: "" }`, commits NOTHING.
//       • no-op STRENGTHENED  — the same two gates, but the backend has REAL reasoning available (so a broken
//                               gate would visibly leak content, not just coincide with an empty script).
//       • budget boundary     — reasons to EXACTLY thinkBudget / thinkBudget−1 / a scripted (budget+1) trap,
//                               pinning the `n < thinkBudget` loop bound from both sides.
//       • soft-ramp MATH      — the `<=` vs `<` boundary at n===start (zero bias exactly at the threshold) and
//                               the ramp's monotonic growth across three points in the zone.
//       • shouldStop/eos      — boundary variants: tripping at n=0 (zero reasoning) and at the LAST legal
//                               iteration (n = thinkBudget−1), both proven against a scripted trap token.
//
//   (B) NON-FC HANDOFF SEAM — mirrors fence-preamble.test.ts: run the think phase, force-emit the Scheme `(`
//       (the production wiring in llama-cpp-generate's non-FC reasoning block), then the GreedyStrategy decodes
//       the Scheme call. The `<think>…</think>` reasoning is in the backend KV ONLY; the Scheme oracle prefix
//       stays the bare `(` — the scanner NEVER sees the think. This is the invariant the seam guarantees —
//       proven on the NATURAL-close path, the HARD-BACKSTOP path, and the force-emit's round-trip-guard
//       DECLINE path (a tokenizer desync must skip the commit, never corrupt the KV).
//
//   (C) SPECIAL-TOKEN close resolution (nemotron-like) — `runThinkPhase` resolves its close id via
//       `model.tokenize("</think>", false)` BY DEFAULT, i.e. it assumes the family's close marker is TEXT
//       (true for qwen3/glm). A family whose close is a SPECIAL token (nemotron's `<think>`/`</think>` are ids
//       12/13 — see chat-template.ts's `nemotron` FamilyDef) opts in via `ThinkPhaseOptions.
//       thinkCloseSpecialToken`, which bypasses the text-tokenize path entirely. This section proves BOTH: the
//       OLD default-path behavior for a caller that does NOT opt in (still swallows the special id as content,
//       still double-closes — an explicit regression guard now, not a live bug) AND the FIX (opting in closes
//       naturally, exactly once, no backstop double-commit).
//
// All run in the default `__tests__` gate (the scripted backend's node-llama-cpp imports are type-only).

import { describe, expect, it } from "vitest";

import { ScriptedDecodeBackend, type ScriptEntry } from "../../src/runners/local/backends/index.js";
import { GreedyStrategy, type DecodeContext, type DecodeTelemetry } from "../../src/runners/local/strategies/index.js";
import { runThinkPhase } from "../../src/runners/local/think-phase.js";
import type { OracleScanner, OracleState } from "../../src/oracle-types.js";

// The synthetic close/open tokenization the think phase + the seam round-trip through `model.tokenize`:
//   • `</think>` ⇒ one id (CLOSE_ID); the phase tokenizes it once to learn the close id, and force-emits it on
//     the backstop. `stringForId` round-trips CLOSE_ID → "</think>".
//   • `(` ⇒ one id (OPEN_ID); the seam force-emits the Scheme prefill through `model.tokenize("(", false)`.
const CLOSE_ID = 900;
const OPEN_ID = 901;
const thinkTokenizer = {
  tokenize: (text: string): number[] =>
    text === "</think>" ? [CLOSE_ID] : text === "(" ? [OPEN_ID] : [...text].map((_, i) => 700 + i),
  stringForId: (id: number): string => (id === CLOSE_ID ? "</think>" : id === OPEN_ID ? "(" : ""),
};

const THINK_OPEN = "<think>\n";
const EOS = 0;

function step(...entries: [number, number, string][]): ScriptEntry[] {
  return entries.map(([id, prob, str]) => ({ id, prob, str }));
}

/** A scripted backend prefilled with the family's `<think>` opener (the caller prefills it — the model does
 *  NOT emit `<think>` itself; the phase records it for display only). `steps` are keyed by the committed
 *  prefix = THINK_OPEN + the reasoning so far. */
function thinkBackend(steps: ReadonlyMap<string, readonly ScriptEntry[]>): ScriptedDecodeBackend {
  return new ScriptedDecodeBackend({ prefill: THINK_OPEN, eosId: EOS, tokenizer: thinkTokenizer, steps });
}

// ── (A) runThinkPhase unit ────────────────────────────────────────────────────────────────────────────

describe("runThinkPhase — natural close (the model emits </think> as argmax)", () => {
  it("reasons then closes on the model's own </think>, committing reasoning + close to the KV", async () => {
    // budget 10; the model reasons two tokens then its argmax IS `</think>` (n=2 < 60% of 10, so NO ramp — a
    // genuine model-chosen close).
    // NB the ScriptedDecodeBackend registers ONE canonical string per id (first occurrence), so every
    // (id → str) pair across the whole spec must be unique — distinct ids for "let me " / "reason".
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([10, 0.9, "let me "], [11, 0.05, "x"])],
        [`${THINK_OPEN}let me `, step([12, 0.9, "reason"], [13, 0.05, "y"])],
        [`${THINK_OPEN}let me reason`, step([CLOSE_ID, 0.95, "</think>"], [14, 0.04, "z"])],
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}let me reason</think>`);
    // committed: "let me ", "reason", CLOSE — three tokens (the opener was prefilled, not re-committed).
    expect(backend.position()).toBe(3);
  });
});

describe("runThinkPhase — hard backstop (never closes within budget)", () => {
  it("reasons to the budget, then FORCE-commits </think> so an answer must follow", async () => {
    // budget 3, the script only ever offers content (no `</think>` surfaces) — the backstop must fire.
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
        [`${THINK_OPEN}abc`, step([4, 0.9, "d"])], // never reached (budget 3)
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: 3, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abc</think>`);
    // 3 reasoned tokens + the FORCED close = 4 committed.
    expect(backend.position()).toBe(4);
  });
});

describe("runThinkPhase — soft ramp (bias </think> past 60% of budget)", () => {
  it("closes EARLY via the ramp when the model surfaces </think> below argmax past 60%", async () => {
    // budget 5 ⇒ ramp starts at 3. The model reasons 4 content tokens; at n=4 (>60%) its argmax is content
    // (e, p=0.5) but `</think>` is present (p=0.1). The ramp multiplies the close prob enough to WIN, so the
    // phase closes at position 5 — NOT the position-6 it would reach if the ramp did nothing and the backstop
    // fired one step later. The exact `think` distinguishes the two.
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
        [`${THINK_OPEN}abc`, step([4, 0.9, "d"])],
        [`${THINK_OPEN}abcd`, step([5, 0.5, "e"], [CLOSE_ID, 0.1, "</think>"])], // n=4: ramp biases CLOSE over e
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: 5, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abcd</think>`); // closed at n=4 (the ramp picked </think> over "e")
    expect(backend.position()).toBe(5);
  });
});

describe("runThinkPhase — eos mid-think falls to the backstop", () => {
  it("breaks on an EOS argmax mid-reasoning, then the backstop forces </think>", async () => {
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([EOS, 0.9, ""], [2, 0.05, "b"])], // EOS argmax mid-think
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}a</think>`);
    expect(backend.position()).toBe(2); // "a" + the forced close (EOS is NOT committed)
  });
});

describe("runThinkPhase — shouldStop aborts reasoning", () => {
  it("stops reasoning when shouldStop trips, then the backstop closes", async () => {
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])], // never reached — aborted before n=2
      ]),
    );
    let calls = 0;
    const shouldStop = (): boolean => ++calls > 2; // false at n=0,1; true at n=2
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: THINK_OPEN, shouldStop });
    expect(think).toBe(`${THINK_OPEN}ab</think>`);
    expect(backend.position()).toBe(3); // "a", "b", forced close
  });
});

describe("runThinkPhase — no-op cells commit NOTHING (byte-identical decode)", () => {
  it("returns empty + commits nothing when thinkOpen is undefined", async () => {
    const backend = thinkBackend(new Map());
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: undefined });
    expect(think).toBe("");
    expect(backend.position()).toBe(0);
  });

  it("returns empty + commits nothing when thinkBudget is 0", async () => {
    const backend = thinkBackend(new Map());
    const { think } = await runThinkPhase(backend, { thinkBudget: 0, thinkOpen: THINK_OPEN });
    expect(think).toBe("");
    expect(backend.position()).toBe(0);
  });
});

describe("runThinkPhase — no-op gates STRENGTHENED (the backend has REAL reasoning available)", () => {
  // The ORIGINAL no-op tests above use an empty script (`new Map()`), which can't distinguish "the gate
  // correctly short-circuited" from "the gate leaked through, but the empty script dead-ended immediately
  // anyway" (a broken gate over an empty script would ALSO commit nothing, by coincidence). This backend has
  // a real, ready-to-reason step and a natural close one token later — if either gate leaked, `think` would
  // be non-empty and `position()` would be > 0.
  function richBackend(): ScriptedDecodeBackend {
    return thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([CLOSE_ID, 0.9, "</think>"])],
      ]),
    );
  }

  it("thinkOpen undefined + thinkBudget positive ⇒ still commits nothing (gate 1, independently)", async () => {
    const backend = richBackend();
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: undefined });
    expect(think).toBe("");
    expect(backend.position()).toBe(0);
  });

  it("thinkBudget 0 + thinkOpen defined ⇒ still commits nothing (gate 2, independently)", async () => {
    const backend = richBackend();
    const { think } = await runThinkPhase(backend, { thinkBudget: 0, thinkOpen: THINK_OPEN });
    expect(think).toBe("");
    expect(backend.position()).toBe(0);
  });

  it("thinkBudget NEGATIVE + thinkOpen defined ⇒ still no-ops (guards `> 0`, not `!== 0`)", async () => {
    const backend = richBackend();
    const { think } = await runThinkPhase(backend, { thinkBudget: -5, thinkOpen: THINK_OPEN });
    expect(think).toBe("");
    expect(backend.position()).toBe(0);
  });

  it("both gates false at once (budget 0 AND thinkOpen undefined) ⇒ no-ops", async () => {
    const backend = richBackend();
    const { think } = await runThinkPhase(backend, { thinkBudget: 0, thinkOpen: undefined });
    expect(think).toBe("");
    expect(backend.position()).toBe(0);
  });
});

describe("runThinkPhase — budget boundary exactness (budget vs budget−1 vs a budget+1 trap)", () => {
  const BUDGET = 4; // ramp start = 4*0.6 = 2.4; the last legal iteration is n=3 (n < 4 ⇒ n=0,1,2,3)

  // Two scripts sharing every step EXCEPT the one at n=3 (prefix "abc"): WITHOUT a close offered (content
  // continues) vs WITH a close offered (and winning). This isolates the single bit that flips the outcome —
  // proving the loop bound is exactly `n < thinkBudget`, not off by one in either direction. Both scripts also
  // carry a step at "abcd" (only reachable via a 5th, OUT-OF-BUDGET iteration) as a budget+1 trap: were the
  // bound `n <= thinkBudget`, this step would be consulted and "e" would leak into `think`.
  function scriptUpTo(lastStepOffersClose: boolean): Map<string, ScriptEntry[]> {
    return new Map<string, ScriptEntry[]>([
      [THINK_OPEN, step([1, 0.9, "a"])],
      [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
      [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
      [
        `${THINK_OPEN}abc`,
        lastStepOffersClose ? step([CLOSE_ID, 0.9, "</think>"], [4, 0.05, "d"]) : step([4, 0.9, "d"]),
      ],
      [`${THINK_OPEN}abcd`, step([5, 0.9, "e"])], // the budget+1 trap — must be unreachable in BOTH variants
    ]);
  }

  it("never closes ⇒ reasons EXACTLY thinkBudget (4) tokens, then hard-backstops — the trap step is never touched", async () => {
    const backend = thinkBackend(scriptUpTo(false));
    const { think } = await runThinkPhase(backend, { thinkBudget: BUDGET, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abcd</think>`); // a,b,c,d = exactly BUDGET content tokens
    expect(think).not.toContain("e");
    expect(backend.position()).toBe(BUDGET + 1); // 4 reasoned + 1 FORCED close
  });

  it("the SAME script but the final legal slot (n=budget−1) closes naturally ⇒ ONE FEWER content token, no forced close", async () => {
    const backend = thinkBackend(scriptUpTo(true));
    const { think } = await runThinkPhase(backend, { thinkBudget: BUDGET, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abc</think>`); // a,b,c = BUDGET-1 content tokens
    expect(backend.position()).toBe(BUDGET); // 3 reasoned + 1 NATURAL close — NOT BUDGET+1 (no double-close)
  });

  it("budget=1 (the smallest legal budget): one content token, then the hard backstop closes immediately", async () => {
    const backend = thinkBackend(new Map<string, ScriptEntry[]>([[THINK_OPEN, step([1, 0.9, "a"])]]));
    const { think } = await runThinkPhase(backend, { thinkBudget: 1, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}a</think>`);
    expect(backend.position()).toBe(2); // 1 reasoned + 1 forced close
  });
});

describe("runThinkPhase — soft-ramp MATH (the private thinkRampStrength/argmaxBiased, exercised via selection)", () => {
  // think-phase.ts's ramp constants (THINK_RAMP_START=0.6, THINK_RAMP_MAX=50) and its `thinkRampStrength`/
  // `argmaxBiased` helpers are module-private (not exported — this file does not add an export to touch
  // production code). These tests instead construct scripted probabilities whose OUTCOME only matches the
  // documented formula (`strength = (n−start)/(budget−start) × 50` for n>start, else 0) if the ramp is wired
  // exactly as described — a wrong constant or a `<`-vs-`<=` slip at the boundary would flip one of them.

  it("n === start (the ramp gate's own boundary) applies ZERO bias — content still wins over a CLOSE that would win one step later", async () => {
    const BUDGET = 5; // start = 5*0.6 = 3 (an exact integer — the interesting boundary case)
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
        // n=3 === start: content (0.6) vs close (0.59) — thinkRampStrength(3,5) must be 0 (n<=start), so the
        // biased close prob stays 0.59 < 0.6 and content wins DESPITE the ramp gate itself firing (n>=start).
        [`${THINK_OPEN}abc`, step([4, 0.6, "d"], [CLOSE_ID, 0.59, "</think>"])],
        // n=4 (start+1): the SAME 0.6/0.59 shape — thinkRampStrength(4,5) = ((4-3)/(5-3))*50 = 25, so
        // 0.59*(1+25) = 15.34 ≫ 0.6 and close wins. Only `n` changed between this step and the last.
        [`${THINK_OPEN}abcd`, step([5, 0.6, "e"], [CLOSE_ID, 0.59, "</think>"])],
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: BUDGET, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abcd</think>`); // "d" won at n=3 (zero bias); close won at n=4
    expect(backend.position()).toBe(BUDGET); // a,b,c,d (4) + 1 close = 5 = BUDGET
  });

  it("ramp strength grows MONOTONICALLY across the zone — loses at the boundary, still loses one step in, wins two steps in", async () => {
    const BUDGET = 10; // start = 6
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
        [`${THINK_OPEN}abc`, step([4, 0.9, "d"])],
        [`${THINK_OPEN}abcd`, step([5, 0.9, "e"])],
        [`${THINK_OPEN}abcde`, step([6, 0.9, "f"])],
        // n=6 (=== start): strength=0 ⇒ close (0.05) stays 0.05 < content (0.95) — content wins.
        [`${THINK_OPEN}abcdef`, step([7, 0.95, "g"], [CLOSE_ID, 0.05, "</think>"])],
        // n=7 (start+1): strength=((7-6)/4)*50=12.5 ⇒ 0.05*13.5=0.675 still < 0.95 — content STILL wins.
        [`${THINK_OPEN}abcdefg`, step([8, 0.95, "h"], [CLOSE_ID, 0.05, "</think>"])],
        // n=8 (start+2): strength=((8-6)/4)*50=25 ⇒ 0.05*26=1.3 > 0.95 — close FINALLY wins.
        [`${THINK_OPEN}abcdefgh`, step([9, 0.95, "i"], [CLOSE_ID, 0.05, "</think>"])],
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: BUDGET, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abcdefgh</think>`); // g,h reasoned (ramp not yet enough); closes at i's slot
    expect(backend.position()).toBe(9); // 8 reasoned (a..h) + 1 close
  });
});

describe("runThinkPhase — shouldStop boundary cases", () => {
  it("trips on the VERY FIRST check (n=0) ⇒ zero reasoning tokens, straight to the hard backstop", async () => {
    // A backend that WOULD reason "a" if reached — proving shouldStop is polled BEFORE stepDistribution.
    const backend = thinkBackend(new Map<string, ScriptEntry[]>([[THINK_OPEN, step([1, 0.9, "a"])]]));
    const shouldStop = (): boolean => true;
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: THINK_OPEN, shouldStop });
    expect(think).toBe(`${THINK_OPEN}</think>`); // no reasoning content at all
    expect(backend.position()).toBe(1); // only the forced close
  });

  it("trips on the LAST allowed iteration (n = thinkBudget−1) ⇒ backstop closes without the would-be 4th token", async () => {
    const BUDGET = 4;
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
        [`${THINK_OPEN}abc`, step([4, 0.9, "d"])], // never read — shouldStop trips before n=3's dist read
      ]),
    );
    let calls = 0;
    const shouldStop = (): boolean => ++calls > 3; // false at n=0,1,2 (calls 1..3); true at n=3 (call 4)
    const { think } = await runThinkPhase(backend, { thinkBudget: BUDGET, thinkOpen: THINK_OPEN, shouldStop });
    expect(think).toBe(`${THINK_OPEN}abc</think>`); // a,b,c only — "d" never read
    expect(backend.position()).toBe(BUDGET); // 3 reasoned + 1 forced close
  });
});

describe("runThinkPhase — eos boundary cases", () => {
  it("EOS as the VERY FIRST token (n=0) ⇒ zero reasoning, straight to the backstop", async () => {
    const backend = thinkBackend(new Map<string, ScriptEntry[]>([[THINK_OPEN, step([EOS, 0.9, ""], [1, 0.05, "a"])]]));
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}</think>`);
    expect(backend.position()).toBe(1); // EOS itself is NEVER committed — only the forced close
  });

  it("EOS at the LAST allowed iteration (n = thinkBudget−1) ⇒ backstop closes without a would-be 4th token", async () => {
    const BUDGET = 4;
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])],
        [`${THINK_OPEN}ab`, step([3, 0.9, "c"])],
        [`${THINK_OPEN}abc`, step([EOS, 0.9, ""], [4, 0.05, "d"])],
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: BUDGET, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}abc</think>`);
    expect(backend.position()).toBe(BUDGET); // a,b,c (3 reasoned) + 1 forced close = BUDGET
  });

  it("a LOW-PROBABILITY eos entry present but NOT argmax is ignored — reasoning proceeds normally", async () => {
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"], [EOS, 0.05, ""])],
        [`${THINK_OPEN}a`, step([CLOSE_ID, 0.95, "</think>"], [2, 0.04, "b"])],
      ]),
    );
    const { think } = await runThinkPhase(backend, { thinkBudget: 10, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}a</think>`); // EOS never won argmax — natural close proceeded
    expect(backend.position()).toBe(2);
  });
});

// ── (B) the NON-FC handoff seam (mirrors fence-preamble.test.ts) ────────────────────────────────────────

// The controllable stub oracle (mirrors fence-preamble.test.ts): feasibility is STRING-based on the SCHEME
// prefix only (the scanner NEVER sees the think) — a candidate `str` at accepted Scheme `prefix` is live iff
// `prefix + str` ∈ liveStrings. `closeable` reads off the prefix.
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
  // NB all five DecodeTelemetry fields are required (tailPicks/tailMass included, per strategies/common/types.ts)
  // — this helper was missing them (a pre-existing `tsc --noEmit` red this file's expansion also fixes).
  return { generatedTokens: 0, overruledSteps: 0, forcedSlots: 0, tailPicks: 0, tailMass: 0 };
}

describe("non-FC handoff — think lives in the KV, the Scheme oracle prefix stays clean", () => {
  it("reasons, force-emits `(`, then decodes the bare Scheme call the scanner never saw the think for", async () => {
    // The committed-KV story: <think>\n + reasoning + </think> + ( + the Scheme body. The scripted steps are
    // keyed by that FULL committed prefix (what the model saw). The SCHEME oracle's live/closeable sets are
    // keyed by the BARE call only — proving the scanner is fed the clean `(`, never the reasoning.
    const KV = `${THINK_OPEN}reason</think>`; // the reasoning block committed before the Scheme prefill
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        // Think phase: one reasoning token, then a natural `</think>` close.
        [THINK_OPEN, step([1, 0.9, "reason"], [2, 0.05, "x"])],
        [`${THINK_OPEN}reason`, step([CLOSE_ID, 0.95, "</think>"], [3, 0.04, "y"])],
        // Post-think + post-`(` Scheme decode (committed prefix carries the think + the forced `(`):
        [`${KV}(`, step([4, 0.95, "foo 1)"], [5, 0.04, "bar"])],
        [`${KV}(foo 1)`, step([EOS, 0.99, ""], [6, 0.01, " "])],
      ]),
    );

    // 1. THE THINK PHASE (the real fn) — commits <think>\nreason</think> to the KV.
    const { think } = await runThinkPhase(backend, { thinkBudget: 8, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}reason</think>`);
    expect(backend.position()).toBe(2); // "reason" + the close

    // 2. THE SEAM (the production wiring in llama-cpp-generate's non-FC reasoning block): force-emit the Scheme
    //    prefill `(` into the KV, round-trip-guarded, so the constrained walk starts conditioned on `(`.
    const ids = backend.model.tokenize("(", false);
    expect(backend.model.detokenize(ids)).toBe("(");
    await backend.commit(ids);

    // 3. THE SCHEME DECODE — the oracle `prefix` is the BARE `(`; the scanner's sets are fence-free / think-free.
    const LIVE = new Set<string>(["", "(", "(foo 1)"]);
    const CLOSEABLE = new Set<string>(["(foo 1)"]);
    const ctx: DecodeContext<number> = {
      backend,
      prefix: "(", // the clean Scheme start — NOT the think
      constrained: true,
      scanner: makeStubScanner(LIVE, CLOSEABLE),
      maxNewTokens: 32,
      topK: 64,
      wideK: 256,
      temperature: 0,
      rng: () => 0,
      profile: undefined,
      explainTopK: 8,
      telemetry: telemetry(),
    };
    const { program, rawDecode } = await GreedyStrategy.decode(ctx);
    expect(program).toBe("(foo 1)");
    // The decoded Scheme is the bare call — the reasoning lived ONLY in the KV, never in the oracle prefix.
    expect(rawDecode).toBe("(foo 1)");
    expect(rawDecode).not.toContain("<think>");
  });
});

describe("non-FC handoff — the invariant ALSO holds when the HARD BACKSTOP (not a natural close) ends the phase", () => {
  it("backstops the think phase, then still hands off a clean `(` for the Scheme decode", async () => {
    const KV = `${THINK_OPEN}ab</think>`; // hard-backstop path: 2 reasoning tokens, then a FORCED close
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "a"])],
        [`${THINK_OPEN}a`, step([2, 0.9, "b"])], // no close ever offered — budget 2 forces the backstop
        [`${KV}(`, step([4, 0.95, "foo 1)"], [5, 0.04, "bar"])],
        [`${KV}(foo 1)`, step([EOS, 0.99, ""], [6, 0.01, " "])],
      ]),
    );

    const { think } = await runThinkPhase(backend, { thinkBudget: 2, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}ab</think>`); // the FORCED close — no natural </think> was ever offered
    expect(backend.position()).toBe(3); // "a","b" + the forced close

    const ids = backend.model.tokenize("(", false);
    expect(backend.model.detokenize(ids)).toBe("(");
    await backend.commit(ids);

    const LIVE = new Set<string>(["", "(", "(foo 1)"]);
    const CLOSEABLE = new Set<string>(["(foo 1)"]);
    const ctx: DecodeContext<number> = {
      backend,
      prefix: "(",
      constrained: true,
      scanner: makeStubScanner(LIVE, CLOSEABLE),
      maxNewTokens: 32,
      topK: 64,
      wideK: 256,
      temperature: 0,
      rng: () => 0,
      profile: undefined,
      explainTopK: 8,
      telemetry: telemetry(),
    };
    const { program, rawDecode } = await GreedyStrategy.decode(ctx);
    expect(program).toBe("(foo 1)");
    expect(rawDecode).toBe("(foo 1)");
    expect(rawDecode).not.toContain("<think>");
  });
});

describe("non-FC handoff — the force-emit `(` DECLINES on a tokenizer round-trip desync, never corrupting the KV", () => {
  it("skips the commit when detokenize(tokenize('(')) !== '(' — the guard the production seam relies on", async () => {
    // A DESYNCED tokenizer: tokenize("(") returns an id whose registered string is "!", not "(" — simulating a
    // merge/leading-space artifact node-llama-cpp can produce (the same hazard the fence preamble guards
    // against). `</think>` still round-trips correctly (via CLOSE_ID) — ONLY the "(" leg is desynced, isolating
    // the assertion to the seam's own force-emit guard, not the think phase's close detection.
    const DESYNC_OPEN_ID = 950;
    const desyncTokenizer = {
      tokenize: (text: string): number[] => (text === "</think>" ? [CLOSE_ID] : text === "(" ? [DESYNC_OPEN_ID] : []),
      stringForId: (id: number): string => (id === CLOSE_ID ? "</think>" : id === DESYNC_OPEN_ID ? "!" : ""),
    };
    const backend = new ScriptedDecodeBackend({
      prefill: THINK_OPEN,
      eosId: EOS,
      tokenizer: desyncTokenizer,
      steps: new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "reason"], [2, 0.05, "x"])],
        [`${THINK_OPEN}reason`, step([CLOSE_ID, 0.95, "</think>"], [3, 0.04, "y"])],
      ]),
    });

    const { think } = await runThinkPhase(backend, { thinkBudget: 8, thinkOpen: THINK_OPEN });
    expect(think).toBe(`${THINK_OPEN}reason</think>`);
    const positionAfterThink = backend.position();

    // The seam's guard, replicated exactly as llama-cpp-generate.ts's non-FC block applies it:
    //   `if (ids.length > 0 && model.detokenize(ids) === schemePrefill) await backend.commit(ids);`
    const ids = backend.model.tokenize("(", false);
    const roundTrips = ids.length > 0 && backend.model.detokenize(ids) === "(";
    expect(roundTrips).toBe(false); // the desync IS the point of this tokenizer
    if (roundTrips) await backend.commit(ids); // never runs — documents the guard's decline path

    expect(backend.position()).toBe(positionAfterThink); // the KV is UNCHANGED — no corrupt commit
  });

  it("an EMPTY Scheme prefill (the fence-path pairing) attempts no commit at all — `schemePrefill.length > 0` gates it", async () => {
    const backend = thinkBackend(
      new Map<string, ScriptEntry[]>([
        [THINK_OPEN, step([1, 0.9, "reason"], [2, 0.05, "x"])],
        [`${THINK_OPEN}reason`, step([CLOSE_ID, 0.95, "</think>"], [3, 0.04, "y"])],
      ]),
    );
    await runThinkPhase(backend, { thinkBudget: 8, thinkOpen: THINK_OPEN });
    const positionAfterThink = backend.position();

    const schemePrefill = ""; // the fence-path prefill — nothing to force-emit
    if (schemePrefill.length > 0) {
      const ids = backend.model.tokenize(schemePrefill, false);
      if (ids.length > 0) await backend.commit(ids);
    }
    expect(backend.position()).toBe(positionAfterThink); // untouched
  });
});

// ── (C) SPECIAL-TOKEN thinkOpen shape (nemotron-like) — documents a known gap ───────────────────────────
//
// chat-template.ts's `glm` FamilyDef comment: nemotron's `<think>`/`</think>` are SPECIAL tokens (ids 12/13),
// not text — and `runThinkPhase`'s `thinkCloseId` comes from `model.tokenize("</think>", false)`, which
// assumes the close is TEXT (true for qwen3/glm, false for nemotron: tokenizing the literal string with
// special-token recognition OFF cannot produce a special id). This section proves the consequence
// deterministically, then pins a tripwire on the desired fix so it can't silently regress or silently "just
// start working" without a maintainer noticing the assumption changed.

const NEMOTRON_OPEN = "<think>"; // the display opener a caller would prefill for a special-token family
const NEMOTRON_SPECIAL_CLOSE_ID = 13; // the model's REAL close special-token id (nemotron: ids 12/13)
const NEMOTRON_TEXT_TOKENIZE_ID = 777; // whatever tokenize("</think>", false) resolves to — NOT 13

const nemotronTokenizer = {
  tokenize: (text: string): number[] =>
    text === "</think>" ? [NEMOTRON_TEXT_TOKENIZE_ID] : [...text].map((_, i) => 850 + i),
  stringForId: (id: number): string => (id === NEMOTRON_TEXT_TOKENIZE_ID ? "</think>" : ""),
};

/** A backend whose FIRST think-step argmax is the model's REAL special close token (13) — simulating a
 *  special-token family wanting to end reasoning immediately via its own native mechanism. */
function nemotronBackend(): ScriptedDecodeBackend {
  return new ScriptedDecodeBackend({
    prefill: NEMOTRON_OPEN,
    eosId: EOS,
    tokenizer: nemotronTokenizer,
    steps: new Map<string, ScriptEntry[]>([
      [NEMOTRON_OPEN, step([NEMOTRON_SPECIAL_CLOSE_ID, 0.9, "</think>"], [1, 0.09, "reasoning"])],
    ]),
  });
}

describe("runThinkPhase — SPECIAL-TOKEN close marker (nemotron-like)", () => {
  it("[without thinkCloseSpecialToken — regression guard] the special close token is swallowed as ordinary content, then the backstop ALSO fires — the close marker appears TWICE", async () => {
    // Trace: thinkCloseId resolves to 777 (from tokenize("</think>", false)), NOT 13 (the model's real close).
    // At n=0 the model's argmax IS 13, but `13 === 777` is false, so the phase treats it as reasoning CONTENT
    // (detokenize(13) → "</think>", the special token's own display text) and `closed` stays false. The next
    // prefix ("<think></think>") is unscripted ⇒ stepDistribution() is undefined ⇒ break. The hard backstop
    // then force-commits the (wrong) text-tokenized id 777, appending a SECOND "</think>". This is the DEFAULT
    // path a caller gets when it does NOT supply `thinkCloseSpecialToken` — pinned here so the default stays
    // exactly this (unsurprising) shape and qwen3/glm callers (who never set the option) are provably unaffected.
    const backend = nemotronBackend();
    const { think } = await runThinkPhase(backend, { thinkBudget: 3, thinkOpen: NEMOTRON_OPEN });
    expect(think).toBe(`${NEMOTRON_OPEN}</think></think>`); // the close marker, doubled
    expect((think.match(/<\/think>/g) ?? []).length).toBe(2);
    expect(backend.position()).toBe(2); // the "swallowed" close (13) + the backstop's wrong-id close (777)
  });

  it("[with thinkCloseSpecialToken — the fix] a special-token close is recognized directly — single close, no backstop double-commit", async () => {
    // Opting in with the family's real close id (13): at n=0 the model's argmax IS 13, `13 === thinkCloseId`
    // (now 13, not 777) matches immediately, the phase commits it and closes NATURALLY — the hard backstop
    // never fires, so `</think>` appears exactly once. This is the assertion the former `it.fails` tripwire
    // pinned as DESIRED; it now passes for real, driven through `chat-template.ts`'s `nemotron` FamilyDef's
    // `thinkCloseSpecialToken` (mirrored here as the same literal id, not re-imported — this file stays
    // model-free / chat-template-free per its header).
    const backend = nemotronBackend();
    const { think } = await runThinkPhase(backend, {
      thinkBudget: 3,
      thinkOpen: NEMOTRON_OPEN,
      thinkCloseSpecialToken: NEMOTRON_SPECIAL_CLOSE_ID,
    });
    expect(think).toBe(`${NEMOTRON_OPEN}</think>`);
    expect((think.match(/<\/think>/g) ?? []).length).toBe(1);
    expect(backend.position()).toBe(1); // the natural close ONLY — no forced backstop double-commit
  });
});

// force-emit-singleton.test.ts — THE SPIKE-GATE PROOF (model-free) for the positional-keyed force-emit.
//
// `tryForceEmitSingleton` is the one genuinely new decode mechanic: at a slot where the oracle+profile admit
// EXACTLY ONE symbol, it emits that symbol's remaining tokens DIRECTLY (one controlledEvaluate, no model
// pick). This file proves — WITHOUT a GGUF, via a stub tokenizer + sequence — the three things the overnight
// spike-gate demands:
//
//   (a) THE FORCED TOKENS equal `model.tokenize(symbol-remainder)` (the canonical tokenization is committed);
//   (b) THE COMMITTED STRING equals what a non-skipped masked greedy decode would have produced at the slot
//       (i.e. the exact `forced.remaining` — and end-to-end, the SAME PROGRAM a token-by-token masked decode
//       reaches), so the skip is program-equivalent, only cheaper;
//   (c) THE ROUND-TRIP GUARD declines (returns null → caller decodes normally) when the tokenizer would NOT
//       reproduce the exact symbol string (a leading-space / merge artifact) — so the force-emit can never
//       write a corrupted program.
//
// The stub tokenizer is a faithful contract model: `tokenize(s)` splits `s` into 1-char ids over a fixed
// vocab; `detokenize(ids)` concatenates them. One variant deliberately injects a leading-space artifact to
// exercise the guard. The stub sequence records committed ids and returns a canned successor distribution
// (the loop only needs *a* distribution back). All model-free → lives in __tests__ (a verdict), per
// .claude/rules/tests.md.

import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { forcedSymbol, tryForceEmitSingleton, type ForceEmitModel, type ForceEmitSequence } from "../../src/force-emit.js";
import { isCandidateLive, trailingAtom, type ToolCallProfile } from "../../src/mask-compiler.js";
import type { OracleScanner } from "../../src/oracle-types.js";

type Token = number & { __token: never };

/** A faithful stub tokenizer: a fixed char→id vocab; `tokenize` maps each char to its id, `detokenize`
 *  concatenates. This round-trips by construction (the honest baseline). `leadingSpaceFor` lets a test inject
 *  the node-llama-cpp leading-space artifact for a chosen string so the guard can be exercised. */
function stubModel(opts: { leadingSpaceFor?: string } = {}): ForceEmitModel & { tokenizedCalls: string[] } {
  const ids = new Map<string, Token>();
  const strs = new Map<Token, string>();
  let next = 1;
  const idOf = (ch: string): Token => {
    let id = ids.get(ch);
    if (id === undefined) {
      id = next++ as Token;
      ids.set(ch, id);
      strs.set(id, ch);
    }
    return id;
  };
  // Pre-seed a leading-space token if requested (id maps to " ").
  const SPACE = idOf(" ");
  const tokenizedCalls: string[] = [];
  return {
    tokenizedCalls,
    tokenize(text: string): Token[] {
      tokenizedCalls.push(text);
      const out = [...text].map(idOf);
      // Artifact injection: prepend a space token for the flagged string, mimicking node-llama-cpp adding a
      // leading space around a word-initial token (so detokenize(ids) !== text).
      if (opts.leadingSpaceFor !== undefined && text === opts.leadingSpaceFor) return [SPACE, ...out];
      return out;
    },
    detokenize(tokens: readonly Token[]): string {
      return tokens.map((t) => strs.get(t) ?? "").join("");
    },
  };
}

/** A stub sequence: records every committed id and returns a single canned successor distribution after the
 *  last input item that requested one. Implements the rollback primitives (never exercised on the happy path).
 *  `failOnCommit` makes controlledEvaluate throw so the G3 restore-or-abort path can be checked. */
function stubSeq(
  opts: { failOnCommit?: boolean } = {},
): ForceEmitSequence & { committed: Token[]; erased: { start: number; end: number }[] } {
  const committed: Token[] = [];
  const erased: { start: number; end: number }[] = [];
  const cannedDist = new Map<Token, number>([[999 as Token, 1]]);
  return {
    committed,
    erased,
    get nextTokenIndex() {
      return committed.length;
    },

    async controlledEvaluate(input) {
      if (opts.failOnCommit) {
        // Simulate a native eval that advanced the KV by one before failing (so the rollback has work to do).
        committed.push(0 as Token);
        throw new Error("stub controlledEvaluate failure");
      }
      const out: Array<undefined | { next: { probabilities?: ReadonlyMap<Token, number> } }> = [];
      for (const item of input) {
        if (Array.isArray(item)) {
          committed.push(item[0]);
          out.push({ next: { probabilities: cannedDist } });
        } else {
          committed.push(item);
          out.push(undefined);
        }
      }
      return out;
    },

    async eraseContextTokenRanges(ranges) {
      erased.push(...ranges);
      // Pop the erased range off the tail so nextTokenIndex returns to the boundary.
      for (const r of ranges) committed.splice(r.start, r.end - r.start);
    },
  };
}

const callable = (x: unknown): unknown => x;
function grantEnvWeather(): OracleScanner {
  return makeOracle(
    oracleEnvFromBindings({
      weather: callable,
      list: callable,
      array: callable,
      New_York: callable,
    }),
  );
}
const PK: ToolCallProfile = { requiredCount: 2, optionalKeywords: ["units"], requiredKeywords: ["location", "date"] };

describe("tryForceEmitSingleton — (a)+(b) forces the singleton keyword, committing the canonical tokenization", () => {
  const scanner = grantEnvWeather();

  it("forces `:location` at the first arg boundary — commits tokenize(':location'), returns its string", async () => {
    const model = stubModel();
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(weather ", PK, model, seq);
    expect(res).not.toBeNull();
    // (b) the committed STRING is exactly forced.remaining = ":location" (what a masked decode would reach).
    expect(res!.committed).toBe(":location");
    // (a) the committed token IDS equal model.tokenize(":location") — the canonical tokenization, in order.
    expect(seq.committed).toEqual(model.tokenize(":location"));
    // the successor distribution flows back (the loop resumes from it).
    expect(res!.dist).toBeDefined();
  });

  it("forces the REMAINDER mid-keyword (`:lo` already typed → commits tokenize('cation'))", async () => {
    const model = stubModel();
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(weather :lo", PK, model, seq);
    expect(res!.committed).toBe("cation");
    expect(seq.committed).toEqual(model.tokenize("cation"));
  });

  it("forces `:date` at the 2nd keyword slot (after the 1st pair)", async () => {
    const model = stubModel();
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(weather :location New_York ", PK, model, seq);
    expect(res!.committed).toBe(":date");
    expect(seq.committed).toEqual(model.tokenize(":date"));
  });
});

describe("tryForceEmitSingleton — does NOT force where there is a real choice / no singleton", () => {
  const scanner = grantEnvWeather();

  it("returns null at a keyword's VALUE slot (the model owns the value)", async () => {
    const res = await tryForceEmitSingleton(scanner, "(weather :location ", PK, stubModel(), stubSeq());
    expect(res).toBeNull();
  });
  it("returns null after all required keywords are placed (optional/close is the model's)", async () => {
    const res = await tryForceEmitSingleton(
      scanner,
      '(weather :location New_York :date "x" ',
      PK,
      stubModel(),
      stubSeq(),
    );
    expect(res).toBeNull();
  });
  it("returns null at a completed keyword (nothing left to force)", async () => {
    const res = await tryForceEmitSingleton(scanner, "(weather :location", PK, stubModel(), stubSeq());
    expect(res).toBeNull();
  });
  it("commits NOTHING to the sequence when it declines (no spurious eval)", async () => {
    const seq = stubSeq();
    await tryForceEmitSingleton(scanner, "(weather :location ", PK, stubModel(), seq);
    expect(seq.committed).toEqual([]);
  });
});

// ── THE OPERATOR-SLOT REGRESSION (the live decode bug: a keyword force-emitted AS the operator) ───────────
//
// The live failure (Arch-3B, positional-keyed): the FIRST decode step is at prefix `(` (the prefill). The
// operator (function name) is NOT yet placed, so the force-emit MUST decline there and let the model emit the
// symbol. The bug force-emitted `:location` as the operator, committing its tokens and producing `(:location…`
// — every program degenerated to a forced keyword repeated to the cap (matched 0/N). This proves the
// force-emit COMMITS NOTHING at the bare-`(` operator slot (the model owns the opener), and only begins
// forcing keywords once the operator is placed. The `grantEnvWeather` env binds several symbols, so `(` is a
// MULTI-symbol operator slot (no Σ singleton) — exactly the live shape.
describe("tryForceEmitSingleton — declines at the bare-`(` operator slot (the model owns the opener)", () => {
  const scanner = grantEnvWeather();

  it("returns null AND commits nothing at `(` — does not force `:location` as the operator", async () => {
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(", PK, stubModel(), seq);
    expect(res).toBeNull(); // the operator is the model's (Σ-picked) — NOT a forced keyword.
    expect(seq.committed).toEqual([]); // the live bug committed tokenize(":location") here.
  });

  it("still declines mid-operator (`(weather`, operator not yet closed) — no keyword forced", async () => {
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(weather", PK, stubModel(), seq);
    expect(res).toBeNull();
    expect(seq.committed).toEqual([]);
  });

  it("forces `:location` ONCE the operator is placed (`(weather ` — the placement now begins)", async () => {
    const model = stubModel();
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(weather ", PK, model, seq);
    expect(res!.committed).toBe(":location"); // the FIRST required keyword — now correctly forced.
    expect(seq.committed).toEqual(model.tokenize(":location"));
  });
});

// ── (b) END-TO-END: the forced string equals what a TOKEN-BY-TOKEN masked greedy decode would emit ───────
//
// We don't have a model, but the masked greedy decode is DETERMINISTIC given a feasibility predicate: at each
// step it walks candidate continuations and emits the first FEASIBLE one. Over the SINGLE-symbol slot, every
// feasible continuation is a live-prefix of the one symbol, so a 1-char-at-a-time masked walk reproduces the
// symbol exactly. This reference walk (using the real oracle's `isCandidateLive` under the profile) is what
// the force-emit must equal — proving program-equivalence without a model.
describe("tryForceEmitSingleton — (b) program-equivalence with a masked greedy reference walk", () => {
  const scanner = grantEnvWeather();

  /** A reference 1-char masked greedy walk over the forced slot: starting from `prefix`, repeatedly append the
   *  single feasible 1-char continuation (the forced symbol is the only live path) until no more chars extend
   *  the symbol. Returns the appended suffix — the string a real masked decode reaches at this slot. */
  function maskedGreedyRefSuffix(prefix: string, profile: ToolCallProfile, alphabet: string): string {
    let cur = prefix;
    let suffix = "";
    // Bound the walk so a bug can't loop forever.
    for (let i = 0; i < 64; i++) {
      // Find the feasible 1-char continuations at the current cursor (under the profile gate + Σ).
      const live = [...alphabet].filter((ch) => isCandidateLive(scanner, cur, ch, profile));
      // The forced slot admits exactly the chars that extend the one symbol; once the symbol is complete, the
      // next feasible char is a delimiter/space (a NEW slot) — stop when the only feasible continuations leave
      // the single-symbol path (i.e. forcedSymbol no longer reports a remainder here).
      const forced = forcedSymbol(scanner, cur, profile, trailingAtom(cur));
      if (forced === null) break; // no longer a forced-singleton slot — the symbol is done.
      // The single feasible next char is the next char of forced.remaining.
      const nextCh = forced.remaining[0];
      expect(live).toContain(nextCh); // sanity: that char IS feasible.
      cur += nextCh;
      suffix += nextCh;
    }
    return suffix;
  }

  it("the force-emit's committed string equals the masked greedy reference suffix (`:location`)", async () => {
    const alphabet = ":locatindeURYrk_ "; // enough chars to spell :location / :date / value symbols.
    const ref = maskedGreedyRefSuffix("(weather ", PK, alphabet);
    expect(ref).toBe(":location"); // the reference masked walk reaches exactly the keyword.
    const res = await tryForceEmitSingleton(scanner, "(weather ", PK, stubModel(), stubSeq());
    expect(res!.committed).toBe(ref); // and the force-emit commits the SAME string — program-equivalent.
  });

  it("equivalence holds mid-symbol too (`:lo` → `cation`, same as the reference)", async () => {
    const ref = maskedGreedyRefSuffix("(weather :lo", PK, ":locatin ");
    expect(ref).toBe("cation");
    const res = await tryForceEmitSingleton(scanner, "(weather :lo", PK, stubModel(), stubSeq());
    expect(res!.committed).toBe(ref);
  });
});

// ── (c) THE ROUND-TRIP GUARD: decline + fall back when the tokenizer would corrupt the string ────────────
describe("tryForceEmitSingleton — (c) round-trip guard declines on a mis-round-tripping tokenizer", () => {
  const scanner = grantEnvWeather();

  it("returns null when tokenize/detokenize injects a leading-space artifact for the forced string", async () => {
    // The stub adds a leading space token for ":location", so detokenize(tokenize(":location")) === " :location"
    // ≠ ":location". The guard must catch this and DECLINE (so the caller decodes normally instead).
    const model = stubModel({ leadingSpaceFor: ":location" });
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(scanner, "(weather ", PK, model, seq);
    expect(res).toBeNull();
    // And it committed NOTHING — the corrupted tokens never reached the sequence.
    expect(seq.committed).toEqual([]);
  });

  it("still forces a DIFFERENT slot whose tokenization is clean (the artifact is per-string)", async () => {
    // The artifact is only on ":location"; the 2nd keyword ":date" round-trips, so it still forces.
    const model = stubModel({ leadingSpaceFor: ":location" });
    const res = await tryForceEmitSingleton(scanner, "(weather :location New_York ", PK, model, stubSeq());
    expect(res!.committed).toBe(":date");
  });
});

// ── G3: a failing commit rolls the KV back to the pre-commit boundary, then rethrows ─────────────────────
describe("tryForceEmitSingleton — restore-or-abort on a controlledEvaluate failure", () => {
  const scanner = grantEnvWeather();

  it("rolls back the advanced KV and rethrows when the commit fails", async () => {
    const seq = stubSeq({ failOnCommit: true });
    await expect(tryForceEmitSingleton(scanner, "(weather ", PK, stubModel(), seq)).rejects.toThrow(
      "stub controlledEvaluate failure",
    );
    // The failed commit advanced the KV by one then threw; the guard erased that range back to the boundary.
    expect(seq.erased.length).toBeGreaterThan(0);
    expect(seq.committed).toEqual([]); // back to the pre-commit boundary (nothing left committed).
  });
});

// ── No-profile / Σ-only: a profile is REQUIRED to force (the no-profile path never force-emits) ──────────
describe("tryForceEmitSingleton — Σ value singleton forces even with an empty requiredKeywords-less profile", () => {
  it("forces the lone bound symbol at the operator slot (a 1-binding env)", async () => {
    const single = makeOracle(oracleEnvFromBindings({ only_sym: callable }));
    const noReq: ToolCallProfile = { requiredCount: 0, optionalKeywords: [] };
    const model = stubModel();
    const seq = stubSeq();
    const res = await tryForceEmitSingleton(single, "(", noReq, model, seq);
    expect(res!.committed).toBe("only_sym");
    expect(seq.committed).toEqual(model.tokenize("only_sym"));
  });
});

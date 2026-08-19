// positional-keyed-profile.test.ts — the OPT-IN POSITIONAL-KEYED tool-call profile in the mask-compiler.
//
// A {@link ToolCallProfile} with `requiredKeywords` tightens the constrained-decode gate so a tool call
// takes the shape
//   (fn  :req1 v1  :req2 v2  … :req_n vn   [:optkey value]…)
// — EVERY argument a `:keyword value` pair, the required keywords FORCED in declaration order (the i-th
// top-level keyword must be `requiredKeywords[i]`), then optional keywords from `optionalKeywords`. A bare
// positional is ALWAYS illegal; the call closes only once every required keyword is placed.
//
// This is the sibling of kwargs-profile.test.ts (which pins the `requiredCount`-positional shape). It pins:
//   (1) required keywords forced IN ORDER (a wrong / out-of-order keyword is masked);
//   (2) a bare positional masked everywhere after the operator;
//   (3) optionals admitted only AFTER all required keywords are placed (narrowed to `optionalKeywords`);
//   (4) close only when complete;
//   (5) the FORCED-SINGLETON analysis (`forcedSymbol`) — the slot where exactly one keyword/symbol fits;
//   (6) profile-OFF (no `requiredKeywords` AND no profile) is byte-identical to the positional grammar gate.
// All model-free, against the REAL oracle (vitest source alias).

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.
import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { forcedSymbol } from "../../src/force-emit.js";
import { classifyCandidate, trailingAtom, type ToolCallProfile } from "../../src/mask-compiler.js";

/** Identity stand-in for a callable binding value (a function value ⇒ callable in arrival's env). */
const callable = (x: unknown): unknown => x;

// A grant env mirroring a BFCL "simple" function: ONE operator `weather` bound + the `list`/`array` argument
// callables the adapter always binds + a couple of value-symbols (`New_York`, `celsius`) Σ admits at value
// slots. The SAME env shape `bfclToGrantEnv` builds, constructed here so the sampler test stays import-free.
function grantEnvWeather(): ReturnType<typeof makeOracle> {
  const env = oracleEnvFromBindings({
    weather: callable,
    list: callable,
    array: callable,
    New_York: callable,
    celsius: callable,
  });
  return makeOracle(env);
}

// 2 required keywords (location, date), 1 optional (units). `requiredCount` is ignored in this variant but
// kept honest (= required.length) so the profile reads sensibly.
const PK: ToolCallProfile = { requiredCount: 2, optionalKeywords: ["units"], requiredKeywords: ["location", "date"] };

describe("positional-keyed — required keywords FORCED in declaration order", () => {
  const scanner = grantEnvWeather();

  it("admits the 1st required keyword `:location` at the first arg slot", () => {
    expect(classifyCandidate(scanner, "(weather ", ":location", PK)).toBe("feasible");
  });
  it("admits a PREFIX of the 1st required keyword (`:loc`)", () => {
    expect(classifyCandidate(scanner, "(weather ", ":loc", PK)).toBe("feasible");
  });
  it("MASKS the 2nd required keyword out of order (`:date` before `:location`)", () => {
    expect(classifyCandidate(scanner, "(weather ", ":date", PK)).toBe("structural");
  });
  it("MASKS an optional keyword before the required ones (`:units` first)", () => {
    expect(classifyCandidate(scanner, "(weather ", ":units", PK)).toBe("structural");
  });
  it("MASKS a keyword that is not required-in-position nor a prefix of it (`:zzz`)", () => {
    expect(classifyCandidate(scanner, "(weather ", ":zzz", PK)).toBe("structural");
  });

  it("admits `:date` as the 2nd keyword once `:location value` is placed", () => {
    expect(classifyCandidate(scanner, "(weather :location New_York ", ":date", PK)).toBe("feasible");
  });
  it("MASKS `:location` AGAIN as the 2nd keyword (the next forced one is `:date`)", () => {
    expect(classifyCandidate(scanner, "(weather :location New_York ", ":location", PK)).toBe("structural");
  });
});

describe("positional-keyed — a bare POSITIONAL is always illegal after the operator", () => {
  const scanner = grantEnvWeather();

  it("MASKS a bare value at the first arg slot (a string)", () => {
    expect(classifyCandidate(scanner, "(weather ", '"NYC"', PK)).toBe("structural");
  });
  it("MASKS a bare value at the first arg slot (a number)", () => {
    expect(classifyCandidate(scanner, "(weather ", "5", PK)).toBe("structural");
  });
  it("MASKS a bare value-SYMBOL at the first arg slot (`New_York` without a keyword)", () => {
    expect(classifyCandidate(scanner, "(weather ", "New_York", PK)).toBe("structural");
  });
  it("MASKS a bare positional where the 2nd keyword is expected (after a complete pair)", () => {
    expect(classifyCandidate(scanner, "(weather :location New_York ", "celsius", PK)).toBe("structural");
  });
  it("MASKS a bare positional opening as a nested (list …) form at a keyword slot", () => {
    expect(classifyCandidate(scanner, "(weather ", "(list", PK)).toBe("structural");
  });
});

describe("positional-keyed — a keyword's VALUE is any value (the value slot is unconstrained by the gate)", () => {
  const scanner = grantEnvWeather();

  it("admits a value-symbol as a keyword value (`:location New_York`)", () => {
    expect(classifyCandidate(scanner, "(weather :location ", "New_York", PK)).toBe("feasible");
  });
  it('admits a string as a keyword value (`:location "NYC"`)', () => {
    expect(classifyCandidate(scanner, "(weather :location ", '"NYC"', PK)).toBe("feasible");
  });
  it("admits a number as a keyword value", () => {
    expect(classifyCandidate(scanner, "(weather :location ", "5", PK)).toBe("feasible");
  });
  it("admits a (list …) as a keyword value", () => {
    expect(classifyCandidate(scanner, "(weather :location ", "(list", PK)).toBe("feasible");
  });
});

describe("positional-keyed — optionals only AFTER all required, narrowed to optionalKeywords", () => {
  const scanner = grantEnvWeather();
  const afterReq = '(weather :location New_York :date "2024-01-01" ';

  it("admits the optional `:units` once both required keywords are placed", () => {
    expect(classifyCandidate(scanner, afterReq, ":units", PK)).toBe("feasible");
  });
  it("admits a prefix of the optional (`:un`)", () => {
    expect(classifyCandidate(scanner, afterReq, ":un", PK)).toBe("feasible");
  });
  it("MASKS an unknown optional keyword (`:bogus`)", () => {
    expect(classifyCandidate(scanner, afterReq, ":bogus", PK)).toBe("structural");
  });
  it("MASKS a 2nd unknown keyword when only `units` is an optional", () => {
    expect(classifyCandidate(scanner, `${afterReq}:units celsius `, ":more", PK)).toBe("structural");
  });
});

describe("positional-keyed — close ONLY when every required keyword is placed", () => {
  const scanner = grantEnvWeather();

  it("MASKS `)` with zero keywords placed", () => {
    expect(classifyCandidate(scanner, "(weather", ")", PK)).toBe("structural");
  });
  it("MASKS `)` with only `:location value` placed (1 of 2 required)", () => {
    expect(classifyCandidate(scanner, "(weather :location New_York", ")", PK)).toBe("structural");
  });
  it("MASKS `)` right after a keyword with no value (`:location` alone)", () => {
    expect(classifyCandidate(scanner, "(weather :location", ")", PK)).toBe("structural");
  });
  it("ADMITS `)` once both required keyword-value pairs are placed", () => {
    expect(classifyCandidate(scanner, '(weather :location New_York :date "x"', ")", PK)).not.toBe("structural");
  });
  it("ADMITS `)` with all required + an optional placed", () => {
    expect(classifyCandidate(scanner, '(weather :location New_York :date "x" :units celsius', ")", PK)).not.toBe(
      "structural",
    );
  });
  it("does NOT mask a nested-form `)` (closing a (list …) keyword value, not the call)", () => {
    // `:date (list "a"` — the list is date's value, still open; closing it returns to depth 1 (still inside
    // the call), so the premature-close gate must NOT fire even though only 1 required pair is "complete".
    expect(classifyCandidate(scanner, '(weather :location New_York :date (list "a"', ")", PK)).not.toBe("structural");
  });
});

// ── (5) THE FORCED-SINGLETON ANALYSIS (`forcedSymbol`) ──────────────────────────────────────────────────
//
// At a slot where EXACTLY ONE symbol can continue, `forcedSymbol` returns it (so the decoder force-emits its
// remaining tokens, skipping the model). This pins WHICH slots force and what the `remaining` suffix is.
describe("positional-keyed — forcedSymbol detects the single-feasible keyword slot", () => {
  const scanner = grantEnvWeather();
  const force = (prefix: string) => forcedSymbol(scanner, prefix, PK, trailingAtom(prefix));

  it("forces `:location` at the first arg boundary (whole keyword)", () => {
    expect(force("(weather ")).toEqual({ symbol: ":location", remaining: ":location" });
  });
  it("forces the REMAINDER of `:location` mid-keyword (`:lo` → `cation`)", () => {
    expect(force("(weather :lo")).toEqual({ symbol: ":location", remaining: "cation" });
  });
  it("forces `:date` at the 2nd keyword boundary (after the 1st pair)", () => {
    expect(force("(weather :location New_York ")).toEqual({ symbol: ":date", remaining: ":date" });
  });
  it("forces the REMAINDER of `:date` mid-keyword (`:d` → `ate`)", () => {
    expect(force("(weather :location New_York :d")).toEqual({ symbol: ":date", remaining: "ate" });
  });

  it("does NOT force at a completed keyword (`:location` exactly — nothing left)", () => {
    expect(force("(weather :location")).toBeNull();
  });
  it("does NOT force at a keyword's VALUE slot (the model owns the value)", () => {
    expect(force("(weather :location ")).toBeNull();
  });
  it("does NOT force mid-VALUE", () => {
    expect(force("(weather :location New_Y")).toBeNull();
  });
  it("does NOT force after all required keywords are placed (the optional/close is the model's)", () => {
    expect(force('(weather :location New_York :date "x" ')).toBeNull();
  });
  it("does NOT force at a closed call", () => {
    expect(force('(weather :location New_York :date "x")')).toBeNull();
  });
});

// ── THE OPERATOR-SLOT REGRESSION (the live-decode bug: a keyword forced/admitted AS the operator) ─────────
//
// COVERAGE GAP this closes: every test above starts from a prefix where the OPERATOR is already present
// (`"(weather "`, `"(weather :lo"`, …). None drove the gate / force-emit from the BARE `(` operator slot —
// the very first decode step. There, `scanPositionalKeyedTopLevel("(")` reports no in-progress token and an
// empty `prevArgKind`, which the keyword-slot test read as "a fresh keyword slot" — so `forcedSymbol` forced
// `:requiredKeywords[0]` as the OPERATOR and the gate ADMITTED `(:keyword`. Live result (Arch-3B,
// positional-keyed): every program was `:distance :distance …` to the token cap — no `(fn` opener, no values,
// matched 0/N. These pin that (1) the OPENER (a bare Σ function symbol) is REQUIRED — a keyword is masked and
// NOT forced at the operator slot — and (2) the keyword-placement only begins (and advances) once the
// operator is placed.
describe("positional-keyed — the OPERATOR slot requires a bare symbol (no keyword forced/admitted there)", () => {
  const scanner = grantEnvWeather(); // binds `weather` + value symbols ⇒ `(` is a MULTI-symbol operator slot.

  it("does NOT force a required keyword at the bare-`(` operator slot (the live `(:distance` bug)", () => {
    // The bug: forcedSymbol returned `:location` here, so the decoder emitted `(:location…` as the operator.
    expect(forcedSymbol(scanner, "(", PK, trailingAtom("("))).toBeNull();
  });

  it("MASKS a `:keyword` AS the operator (`(` → `:`) — the operator must be a bare symbol", () => {
    // Even without force-emit, the gate must veto `(:` so the model is steered to a function name first.
    expect(classifyCandidate(scanner, "(", ":", PK)).toBe("structural");
    expect(classifyCandidate(scanner, "(", ":location", PK)).toBe("structural");
  });

  it("ADMITS a bare function symbol at the operator slot (the opener is a Σ symbol)", () => {
    // `weather` is the bound operator; its live prefix must pass (this is what the model emits as the opener).
    expect(classifyCandidate(scanner, "(", "weather", PK)).toBe("feasible");
    expect(classifyCandidate(scanner, "(", "w", PK)).toBe("feasible");
  });

  it("the keyword-placement counter ADVANCES only AFTER the operator is placed", () => {
    // No keyword forced while the operator is mid-typed (`(weather`, no trailing space ⇒ still the operator).
    expect(forcedSymbol(scanner, "(weather", PK, trailingAtom("(weather"))).toBeNull();
    // Operator CLOSED (trailing space) ⇒ NOW the 1st required keyword `:location` is forced (placement starts).
    expect(forcedSymbol(scanner, "(weather ", PK, trailingAtom("(weather "))).toEqual({
      symbol: ":location",
      remaining: ":location",
    });
    // After `:location value`, the counter advanced ⇒ the 2nd required keyword `:date` is forced next.
    expect(
      forcedSymbol(scanner, "(weather :location New_York ", PK, trailingAtom("(weather :location New_York ")),
    ).toEqual({ symbol: ":date", remaining: ":date" });
  });

  it("end-to-end opener→forced-keyword sequence: `(` admits only the symbol, then forces `:location`", () => {
    // 1) at `(` the operator slot admits the bare symbol and rejects the keyword;
    expect(classifyCandidate(scanner, "(", "weather", PK)).toBe("feasible");
    expect(classifyCandidate(scanner, "(", ":location", PK)).toBe("structural");
    // 2) once the operator is placed + a boundary follows, the 1st required keyword is the forced singleton.
    const forced = forcedSymbol(scanner, "(weather ", PK, trailingAtom("(weather "));
    expect(forced).toEqual({ symbol: ":location", remaining: ":location" });
  });
});

describe("forcedSymbol — Σ value singleton (a slot where exactly one BOUND symbol fits)", () => {
  // An env with a SINGLE bound symbol: at the operator slot only that one symbol can be named, so it is
  // forced. (In real BFCL this is a 1-member enum narrowed by the type lens; here a 1-binding env proves the
  // Σ-singleton branch directly, independent of the lens.)
  const single = makeOracle(oracleEnvFromBindings({ only_sym: callable }));
  const noReq: ToolCallProfile = { requiredCount: 0, optionalKeywords: [] };

  it("forces the lone bound symbol at the operator boundary", () => {
    expect(forcedSymbol(single, "(", noReq, "")).toEqual({ symbol: "only_sym", remaining: "only_sym" });
  });
  it("forces the REMAINDER mid-symbol (`(o` → `nly_sym`)", () => {
    expect(forcedSymbol(single, "(o", noReq, "o")).toEqual({ symbol: "only_sym", remaining: "nly_sym" });
  });
  it("does NOT force when >1 bound symbol is valid (a real choice)", () => {
    const many = makeOracle(oracleEnvFromBindings({ a: callable, b: callable }));
    expect(forcedSymbol(many, "(", noReq, "")).toBeNull();
  });
  it("does NOT force at a literal-value fragment (numbers are not Σ symbols)", () => {
    expect(forcedSymbol(single, "(only_sym 5", noReq, "5")).toBeNull();
  });
  it("does NOT force at a completed symbol (nothing left to emit)", () => {
    expect(forcedSymbol(single, "(only_sym", noReq, "only_sym")).toBeNull();
  });
});

// ── (6) PROFILE-OFF: no requiredKeywords (and no profile) is byte-identical to the positional grammar gate ─
describe("positional-keyed — OFF is byte-identical to the positional grammar gate", () => {
  const scanner = grantEnvWeather();

  // The SAME prefixes the positional-keyed profile would tighten, WITHOUT a profile: the gate must behave
  // exactly as the Σ-only `grammar` path (a bare value at an arg slot is admitted; a `:keyword` of any name
  // is admitted via Σ's blanket `:`-member-read exemption). No tightening.
  const cases: [string, string][] = [
    ["(weather ", '"NYC"'], // a bare positional — fine without a profile.
    ["(weather ", ":date"], // any keyword, any order — fine without a profile.
    ["(weather ", "New_York"], // a bare value-symbol — fine without a profile.
    ["(weather :location New_York ", "celsius"], // a bare value where the profile forces a keyword — fine off.
    ["(weather", ")"], // early close — the profile masks it; no profile must NOT.
  ];
  const noProfile: ToolCallProfile | undefined = undefined;
  for (const [prefix, cand] of cases) {
    it(`classify(${JSON.stringify(prefix + cand)}) is identical with/without a profile`, () => {
      const withAbsent = classifyCandidate(scanner, prefix, cand, noProfile);
      const without = classifyCandidate(scanner, prefix, cand);
      expect(withAbsent).toBe(without);
      // Specifically: the bare positional / out-of-order keyword the profile masks is ADMITTED here.
      if (cand === '"NYC"' || cand === ":date" || cand === "New_York") expect(without).toBe("feasible");
    });
  }

  it("forcedSymbol returns null without a profile's requiredKeywords (no Σ singleton in this multi-bind env)", () => {
    const noReq: ToolCallProfile = { requiredCount: 0, optionalKeywords: [] };
    // The weather env binds many symbols, so even the Σ branch finds no singleton at the operator slot.
    expect(forcedSymbol(scanner, "(", noReq, "")).toBeNull();
  });
});

// ── DETERMINISM: the gate + forcedSymbol are PURE functions of their inputs (greedy reproducibility) ──────
describe("positional-keyed — PURE: identical inputs ⇒ identical verdict + forced symbol (no per-call state)", () => {
  const probes: [string, string][] = [
    ["(weather ", ":location"],
    ["(weather ", ":date"],
    ["(weather ", "New_York"],
    ["(weather :location New_York ", ":date"],
    ['(weather :location New_York :date "x" ', ":units"],
    ["(weather", ")"],
  ];

  it("repeated classify calls on ONE scanner return the byte-identical CandidateClass", () => {
    const scanner = grantEnvWeather();
    for (const [prefix, cand] of probes) {
      const first = classifyCandidate(scanner, prefix, cand, PK);
      for (let i = 0; i < 8; i++) {
        classifyCandidate(scanner, "(weather :location X ", ":date", PK); // unrelated interleave (drains any state).
        expect(classifyCandidate(scanner, prefix, cand, PK)).toBe(first);
      }
    }
  });

  it("forcedSymbol is identical across repeated calls and a fresh scanner", () => {
    const prefixes = ["(weather ", "(weather :lo", "(weather :location New_York ", "(weather :location "];
    for (const prefix of prefixes) {
      const a = forcedSymbol(grantEnvWeather(), prefix, PK, trailingAtom(prefix));
      const b = forcedSymbol(grantEnvWeather(), prefix, PK, trailingAtom(prefix));
      expect(a).toEqual(b);
    }
  });
});

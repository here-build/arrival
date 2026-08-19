// rule-attribution.test.ts — the PROOF that `classifyCandidate` fires its `onRuleHit` tap with the STABLE
// RuleId behind each masking / forgiving decision (the sweep's per-rule activation signal).
//
// This pins the ATTRIBUTION layer added to the gate stack: every gate now returns its DECISIVE `RuleId`
// (`RuleId | null`), the Σ gate returns `{admit, rule}`, and `classifyCandidate` fires the first decisive
// rule through the optional `onRuleHit` tap. The refactor is BEHAVIOR-PRESERVING — the verdict
// (feasible/structural/sigma) is unchanged — so this file asserts the NEW signal the tap carries: which
// `ruleId` fired and with which `decision` (enforce ⇒ masked, forgive ⇒ admitted).
//
// Model-free, like its siblings (tool-call-grammar / sigma / structure-gate-e2e / element-gate-e2e): real
// arrival oracles via `makeOracle(grantEnv)` + hand-built `OracleState` stamps (the type-layer's verdict)
// OR `narrowByTypeAsync` for the lens-stamped element/stringy axes. Runs in the DEFAULT suite (a verdict).

// Resolved to arrival SOURCE via the vitest alias (vitest.config.ts) — the REAL oracle (Σ + structure).

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate, type ToolCallProfile } from "../../src/mask-compiler.js";
import type { OracleState } from "../../src/oracle-types.js";
import type { RuleHit } from "../../src/rules.js";
import { violatesToolCallGrammar } from "../../src/structural-gates.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;

/** Collect every {@link RuleHit} fired by ONE `classifyCandidate` call. */
function hitsFor(
  scanner: ReturnType<typeof makeOracle>,
  prefix: string,
  candidate: string,
  profile?: ToolCallProfile,
  slotState?: OracleState,
): RuleHit[] {
  const hits: RuleHit[] = [];
  classifyCandidate(scanner, prefix, candidate, profile, slotState, (h) => hits.push(h));
  return hits;
}

/** A value-slot-START state (token boundary, application argument) the loop threads in as `slotState`. The
 *  structural fields mirror `analyze(prefix + " ")` at an argument boundary; the type STAMP activates a gate. */
function slot(stamp: Partial<OracleState>): OracleState {
  return {
    midToken: false,
    position: "argument",
    formKind: "application",
    closeable: false,
    overClosed: false,
    validSymbols: () => null,
    ...stamp,
  };
}

// ── ENFORCE — the tool-call grammar tightening (violatesToolCallGrammar) ──────────────────────────────
describe("rule-attribution — tool-call grammar (masked)", () => {
  const scanner = makeOracle(); // structural-only is enough — the grammar tightening is structural

  it("a Python comma is ADMITTED now — the reader reads `,` as an unquote lead (no rule fires)", () => {
    // The reader made `,` a lexer-level delimiter with a separator role inside the collection literals and
    // an unquote reading elsewhere — `(f 3, 2)` READS (an i_ corpus case), so Σ admits it (validity mirror).
    expect(classifyCandidate(scanner, "(f 3", ",")).not.toBe("structural");
    expect(hitsFor(scanner, "(f 3", ",")).toHaveLength(0);
  });

  it("R-UNQUOTE-QUASI — a quasiquote backtick is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f ", "`x");
    expect(hits).toContainEqual({ ruleId: "R-UNQUOTE-QUASI", decision: "masked", candidate: "`x" });
  });

  it("R-POST-QUOTE-PAREN — a quoted scalar (`'5`) is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f ", "'5");
    expect(hits).toContainEqual({ ruleId: "R-POST-QUOTE-PAREN", decision: "masked", candidate: "'5" });
  });

  it("R-BRACKET-MISMATCH — a `]` closing a `(`-opened frame is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f (list 1", "]");
    expect(hits).toContainEqual({ ruleId: "R-BRACKET-MISMATCH", decision: "masked", candidate: "]" });
  });

  it("R-DICT-KEY — a key atom completing key-less at a dict KEY position is masked, attributed", () => {
    // The suffix-keyword flip: `1` alone is still a live prefix of the declared key `1:` —
    // the mask fires at the step that COMPLETES the token without the trailing colon.
    const hits = hitsFor(scanner, "(f {", "1 ");
    expect(hits).toContainEqual({ ruleId: "R-DICT-KEY", decision: "masked", candidate: "1 " });
  });

  it("R-DICT-ARITY — a `}` at an odd dict element count is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f {:a", "}");
    expect(hits).toContainEqual({ ruleId: "R-DICT-ARITY", decision: "masked", candidate: "}" });
  });

  it("R-DICT-DUP-KEY — a repeated literal key is masked at the step that completes it, attributed", () => {
    const hits = hitsFor(scanner, "(f {:a 1 :a", " 2}");
    expect(hits).toContainEqual({ ruleId: "R-DICT-DUP-KEY", decision: "masked", candidate: " 2}" });
  });

  it("R-LITERAL-DOT — a dotted pair inside a vector literal is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f [a .", " b]");
    expect(hits).toContainEqual({ ruleId: "R-LITERAL-DOT", decision: "masked", candidate: " b]" });
  });

  it("R-EXPECTING-DATUM — a closer while an unquote awaits its datum is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f {:a ,", "}");
    expect(hits).toContainEqual({ ruleId: "R-EXPECTING-DATUM", decision: "masked", candidate: "}" });
  });

  it("a bare `[` is ADMITTED — the vector literal is first-class (R-NO-BRACKETS retired)", () => {
    expect(classifyCandidate(scanner, "(f ", "[")).not.toBe("structural");
    expect(hitsFor(scanner, "(f ", "[")).toHaveLength(0);
  });

  it("R-PHANTOM-LIST — `'(list` (bare `list` as a quote-list's first datum) is masked, attributed", () => {
    const hits = hitsFor(scanner, "(f ", "'(list");
    expect(hits).toContainEqual({ ruleId: "R-PHANTOM-LIST", decision: "masked", candidate: "'(list" });
  });

  it("R-HEAD-IS-SYMBOL — a sub-application head `((` is masked, attributed", () => {
    const hits = hitsFor(scanner, "(", "(calc");
    expect(hits).toContainEqual({ ruleId: "R-HEAD-IS-SYMBOL", decision: "masked", candidate: "(calc" });
  });
});

// The post-form fence: once the top-level form closes (depth 0), a trailing backtick/comma is the model
// closing its ```scheme code FENCE (end-of-code), NOT a scheme unquote — so it is ADMITTED. A mid-form
// (depth > 0) backtick/comma is still a real unquote and stays masked. Regression guard for the
// `)`+backtick fused close-token that R-UNQUOTE-QUASI was masking → forcing a spurious extra argument.
describe("R-UNQUOTE-QUASI — the post-form fence is honored as end-of-code (depth-aware)", () => {
  it("admits the `)`+backtick fused close-token (the model closing its ```scheme fence)", () => {
    expect(violatesToolCallGrammar("(light_travel_time 4)`")).toBeNull();
  });
  it("admits a full closing ``` fence after the form", () => {
    expect(violatesToolCallGrammar("(f 4)```")).toBeNull();
  });
  it("a mid-form comma is ADMITTED (the reader reads it as an unquote lead — validity mirror)", () => {
    expect(violatesToolCallGrammar("(f 3,")).toBeNull();
  });
  it("STILL masks a mid-form backtick (real quasiquote, depth > 0)", () => {
    expect(violatesToolCallGrammar("(f `x")).toBe("R-UNQUOTE-QUASI");
  });
  it("re-validates a parallel second form (depth re-opens) — its mid-form backtick is masked", () => {
    expect(violatesToolCallGrammar("(f 4) (g `")).toBe("R-UNQUOTE-QUASI");
  });
});

// ── ENFORCE — the type-derived structure gates (violatesValueStructure / violatesElementStructure) ────
describe("rule-attribution — type-derived value structure (masked)", () => {
  // A real oracle binding `fn` so `(fn …)` is a feasible application; the type STAMP rides in via slotState.
  const scanner = makeOracle(oracleEnvFromBindings({ fn: callable }));

  it("R-ARRAY-REJECTS-SCALAR — a scalar literal at an ARRAY slot is masked, attributed", () => {
    const hits = hitsFor(scanner, "(fn ", "945", undefined, slot({ slotIsArray: true }));
    expect(hits).toContainEqual({ ruleId: "R-ARRAY-REJECTS-SCALAR", decision: "masked", candidate: "945" });
  });

  it("R-SCALAR-REJECTS-LIST — a list-literal opener (`'`) at a SCALAR slot is masked, attributed", () => {
    const hits = hitsFor(scanner, "(fn ", "'", undefined, slot({ slotIsArray: false }));
    expect(hits).toContainEqual({ ruleId: "R-SCALAR-REJECTS-LIST", decision: "masked", candidate: "'" });
  });

  it("R-STRINGSLOT-REJECTS-NONSTRING — a number at a STRING-TYPED slot is masked, attributed", () => {
    const hits = hitsFor(scanner, "(fn ", "945", undefined, slot({ slotIsStringTyped: true, slotIsArray: false }));
    expect(hits).toContainEqual({ ruleId: "R-STRINGSLOT-REJECTS-NONSTRING", decision: "masked", candidate: "945" });
  });

  it("R-REACHABILITY-ARRAY-HEAD — a head that can ONLY return an array at a scalar slot is masked, attributed", () => {
    // `(fn (list` — the nested head `list` reaches no scalar (provably-array), masked at the scalar context.
    const reach = slot({
      arrayReturningHeads: new Set(["list"]),
      validSymbols: () => new Set(["list", "car"]),
    });
    const hits = hitsFor(scanner, "(fn ", "(list", undefined, reach);
    expect(hits).toContainEqual({ ruleId: "R-REACHABILITY-ARRAY-HEAD", decision: "masked", candidate: "(list" });
  });
});

// ── ENFORCE / NARROW — the array-element gates (lens-stamped, both array surfaces) ────────────────────
describe("rule-attribution — array-element structure (lens-stamped)", () => {
  function elemEnv(): OracleEnvΣ {
    return oracleEnvFromBindings({
      "set-diet": callable,
      "set-tags": callable,
      list: callable,
      vegan: callable,
      vegetarian: callable,
      ref: callable,
    });
  }
  const DIET = ["vegan", "vegetarian", "pescatarian"];
  function mockLens(): AsyncTypeLens {
    const owner = (prefix: string): "diet" | "tags" | null => {
      const inListCtor = /\(\s*list\b[^()]*$/.test(prefix);
      const inQuoteList = /'\([^()]*$/.test(prefix);
      if (!inListCtor && !inQuoteList) return null;
      if (/\(\s*set-diet\b/.test(prefix)) return "diet";
      if (/\(\s*set-tags\b/.test(prefix)) return "tags";
      return null;
    };
    return {
      getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
      getSlotIsArray: () => Promise.resolve(null),
      getSlotAcceptsBareWord: () => Promise.resolve(null),
      getSlotElementType: (scheme, off) => {
        const o = owner(scheme.slice(0, off));
        if (o === "diet") return Promise.resolve({ isStringy: false, enum: [...DIET] });
        if (o === "tags") return Promise.resolve({ isStringy: true, enum: null });
        return Promise.resolve({ isStringy: null, enum: null });
      },
    };
  }

  it("R-ELEM-FORCE-QUOTE — a bare-word element at a free-form string element slot is masked, attributed", async () => {
    const scanner = narrowByTypeAsync(makeOracle(elemEnv()), mockLens());
    const sl = "(set-tags '(";
    await scanner.prefill(sl);
    const state = scanner.analyze(sl);
    const hits: RuleHit[] = [];
    classifyCandidate(scanner, sl, "open", undefined, state, (h) => hits.push(h));
    expect(hits).toContainEqual({ ruleId: "R-ELEM-FORCE-QUOTE", decision: "masked", candidate: "open" });
  });

  it("R-ELEM-ENUM-NARROW — a non-member at a closed string-literal element slot is masked, attributed", async () => {
    const scanner = narrowByTypeAsync(makeOracle(elemEnv()), mockLens());
    const sl = "(set-diet '(";
    await scanner.prefill(sl);
    const state = scanner.analyze(sl);
    const hits: RuleHit[] = [];
    // `ref` is a BOUND symbol but NOT an enum member ⇒ narrowed out on the quote surface → R-ELEM-ENUM-NARROW.
    classifyCandidate(scanner, sl, "ref", undefined, state, (h) => hits.push(h));
    expect(hits).toContainEqual({ ruleId: "R-ELEM-ENUM-NARROW", decision: "masked", candidate: "ref" });
  });
});

// ── ENFORCE — the Σ layer (passesSigmaOnState), masked decisions ──────────────────────────────────────
describe("rule-attribution — Σ bound-symbol gate (masked)", () => {
  const scanner = makeOracle(oracleEnvFromBindings({ "some-bound-op": callable, car: callable }));

  it("R-LITERAL-NOT-OPERATOR — a number at the OPERATOR head is masked, attributed", () => {
    const hits = hitsFor(scanner, "(", "1");
    expect(hits).toContainEqual({ ruleId: "R-LITERAL-NOT-OPERATOR", decision: "masked", candidate: "1" });
  });

  it("a generic unbound operator atom has NO catalog rule (plain sigma — no hit fired)", () => {
    // The discriminator: a non-literal unbound operator symbol falls through to the plain `sigma` class with
    // a null rule, so the tap stays silent even though the verdict is "sigma".
    const verdict = classifyCandidate(scanner, "(", "nonexistent-tool");
    expect(verdict).toBe("sigma");
    expect(hitsFor(scanner, "(", "nonexistent-tool")).toHaveLength(0);
  });
});

// ── FORGIVE — Σ admits something it / structure would otherwise mask (admitted decisions) ─────────────
describe("rule-attribution — Σ forgivenesses (admitted)", () => {
  const scanner = makeOracle(oracleEnvFromBindings({ "some-bound-op": callable, car: callable }));

  it("R-KEYWORD-ACCESSOR — a `:`-keyword accessor is admitted, attributed", () => {
    const hits = hitsFor(scanner, "(car ", ":Field");
    expect(hits).toContainEqual({ ruleId: "R-KEYWORD-ACCESSOR", decision: "admitted", candidate: ":Field" });
  });

  it("R-LITERAL-ARG-EXEMPT — a literal value at an ARGUMENT slot is admitted, attributed", () => {
    const hits = hitsFor(scanner, "(some-bound-op ", "5");
    expect(hits).toContainEqual({ ruleId: "R-LITERAL-ARG-EXEMPT", decision: "admitted", candidate: "5" });
  });
});

describe("rule-attribution — R-BARE-WORD-STRING (admitted, lens-stamped)", () => {
  function strEnv(): OracleEnvΣ {
    return oracleEnvFromBindings({ note: callable, existing: callable });
  }
  const ATOM = /[^\s()[\]{}"';]/;
  function headOfOpenCall(prefix: string): string | null {
    const open = prefix.lastIndexOf("(");
    if (open === -1) return null;
    let i = open + 1;
    while (i < prefix.length && /\s/.test(prefix[i])) i++;
    let head = "";
    while (i < prefix.length && ATOM.test(prefix[i])) head += prefix[i++];
    return head === "" ? null : head;
  }
  function mockLens(): AsyncTypeLens {
    const head = (scheme: string, off: number): string | null => headOfOpenCall(scheme.slice(0, off));
    return {
      getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
      getSlotIsArray: (scheme, off) => Promise.resolve(head(scheme, off) === "note" ? false : null),
      getSlotAcceptsBareWord: (scheme, off) => Promise.resolve(head(scheme, off) === "note" ? true : null),
      getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
    };
  }

  it("an UNBOUND bare word at a free-form string slot is admitted, attributed", async () => {
    const scanner = narrowByTypeAsync(makeOracle(strEnv()), mockLens());
    const sl = "(note ";
    await scanner.prefill(sl);
    expect(scanner.analyze(sl).slotIsStringy).toBe(true);
    const hits: RuleHit[] = [];
    // `men` is UNBOUND — the forgive is DECISIVE (a bound symbol would pass Σ unaided, no hit).
    classifyCandidate(scanner, sl, "men", undefined, undefined, (h) => hits.push(h));
    expect(hits).toContainEqual({ ruleId: "R-BARE-WORD-STRING", decision: "admitted", candidate: "men" });
  });

  it("a BOUND symbol at the same slot fires NO R-BARE-WORD-STRING (Σ admits it unaided)", async () => {
    const scanner = narrowByTypeAsync(makeOracle(strEnv()), mockLens());
    const sl = "(note ";
    await scanner.prefill(sl);
    const hits: RuleHit[] = [];
    classifyCandidate(scanner, sl, "existing", undefined, undefined, (h) => hits.push(h));
    expect(hits.filter((h) => h.ruleId === "R-BARE-WORD-STRING")).toHaveLength(0);
  });
});

// ── FORGIVE — the mid-atom anti-misfire (R-ATOM-STAYS-OPEN, admitted) ─────────────────────────────────
describe("rule-attribution — R-ATOM-STAYS-OPEN (admitted)", () => {
  const scanner = makeOracle(oracleEnvFromBindings({ fn: callable }));

  it("a mid-atom continuation at a stamped slot is admitted, attributed", () => {
    // `(fn 19` is mid-number; `45` EXTENDS `1945`. With a slotState present, the protection is active and the
    // value-opener structure gates are skipped — the forgive fires (decision admitted).
    const hits = hitsFor(scanner, "(fn 19", "45", undefined, slot({ slotIsArray: true }));
    expect(hits).toContainEqual({ ruleId: "R-ATOM-STAYS-OPEN", decision: "admitted", candidate: "45" });
  });

  it("the SAME digit token as a FRESH opener fires R-ARRAY-REJECTS-SCALAR instead (the contrast)", () => {
    // A clean boundary (`(fn `) opens a fresh value → masked as a scalar-at-array, NOT the atom-stays-open forgive.
    const hits = hitsFor(scanner, "(fn ", "945", undefined, slot({ slotIsArray: true }));
    expect(hits.map((h) => h.ruleId)).not.toContain("R-ATOM-STAYS-OPEN");
    expect(hits).toContainEqual({ ruleId: "R-ARRAY-REJECTS-SCALAR", decision: "masked", candidate: "945" });
  });
});

// ── ENFORCE — the opt-in per-call profile shapes (violatesProfile) ────────────────────────────────────
describe("rule-attribution — kwargs / positional-keyed profiles (masked)", () => {
  const kwargsScanner = makeOracle(oracleEnvFromBindings({ find: callable, list: callable, array: callable }));
  const KWARGS: ToolCallProfile = { requiredCount: 3, optionalKeywords: ["dietary_requirements", "max_price"] };

  it("R-KWARGS-ARITY — a 4th bare positional past requiredCount is masked, attributed", () => {
    const hits = hitsFor(kwargsScanner, `(find "NYC" "Thai" 5 `, "7", KWARGS);
    expect(hits).toContainEqual({ ruleId: "R-KWARGS-ARITY", decision: "masked", candidate: "7" });
  });

  it("R-KWARGS-KEY-NARROW — a keyword prefixing no optional keyword is masked, attributed", () => {
    const hits = hitsFor(kwargsScanner, `(find "NYC" "Thai" 5 `, ":z", KWARGS);
    expect(hits).toContainEqual({ ruleId: "R-KWARGS-KEY-NARROW", decision: "masked", candidate: ":z" });
  });

  const pkScanner = makeOracle(
    oracleEnvFromBindings({
      weather: callable,
      list: callable,
      array: callable,
      New_York: callable,
      celsius: callable,
    }),
  );
  const PK: ToolCallProfile = { requiredCount: 2, optionalKeywords: ["units"], requiredKeywords: ["location", "date"] };

  it("R-POSKEYED-ORDER — a bare positional in a positional-keyed call is masked, attributed", () => {
    const hits = hitsFor(pkScanner, "(weather ", '"NYC"', PK);
    expect(hits).toContainEqual({ ruleId: "R-POSKEYED-ORDER", decision: "masked", candidate: '"NYC"' });
  });
});

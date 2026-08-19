// literal-admissibility.test.ts — the MASK-side admissible-set contract for the collection literals.
//
// The sibling of corpus-conformance.test.ts: the corpus runner proves whole-string feasibility against
// the reader's JSONL corpus (language-portable); THIS file pins the mask itself at specific prefixes via
// `classifyCandidate` — the per-candidate question constrained decode actually asks. Three axes:
//
//   1. COMMA OPTIONALITY = BOTH branches admissible. At every boundary where the reader allows a
//      separator comma, Σ must admit BOTH continuations — the comma AND the direct next-element/close.
//      The comma is OPTIONAL in the grammar; masking either spelling would force tail picks on models
//      that prefer the other (minimal intervention: every forced token off the model's top choice is
//      off-policy contamination).
//   2. FUSED MULTI-CHAR TOKENS (the BPE reality): real vocab entries fuse several delimiters into one
//      token (` [{`, `"}]`, `1, 2`) — each must pass AS A UNIT, because the mask judges whole candidate
//      strings, not chars.
//   3. TYPED-MODE (Σ∩T) NON-REGRESSION: the type-derived structure gate must not swallow the literals —
//      `[` at an array-typed slot rides the anticipatory isListLiteral path (now actually reachable);
//      `{` at an object/value-typed (scalar-stamped) slot is neutral (admitted, not masked).
//
// Model-free, over the REAL structural oracle (`makeOracle()`) like its siblings; typed-mode cases use a
// hand-built slot stamp in the structure-contract style.

import { makeOracle, oracleEnvFromBindings } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";
import type { OracleState } from "../../src/oracle-types.js";

const scanner = makeOracle(); // structural-only — admissibility of the GRAMMAR itself (Σ degrades)

const admissible = (prefix: string, cand: string): void => {
  expect(
    classifyCandidate(scanner, prefix, cand),
    `${JSON.stringify(prefix)} + ${JSON.stringify(cand)} must be admissible`,
  ).not.toBe("structural");
};
const masked = (prefix: string, cand: string): void => {
  expect(
    classifyCandidate(scanner, prefix, cand),
    `${JSON.stringify(prefix)} + ${JSON.stringify(cand)} must be masked`,
  ).toBe("structural");
};

// ── 1. Comma optionality — BOTH branches admissible at every separator boundary ──────────────────────
describe("literal-admissibility — comma optionality (both spellings live)", () => {
  it("dict even boundary `{:a 1`: comma, direct next key, close, and space-led comma ALL admissible", () => {
    admissible("{:a 1", ",");
    admissible("{:a 1", " :b");
    admissible("{:a 1", "}");
    admissible("{:a 1", " ,");
  });

  it("vector element boundary `[1`: comma, direct next element, and close ALL admissible", () => {
    admissible("[1", ",");
    admissible("[1", " 2");
    admissible("[1", "]");
  });

  it("separator consumed `{:a 1,`: the next key follows directly", () => {
    admissible("{:a 1,", " :b");
    admissible("{:a 1,", ":b");
  });

  it("double comma `{:a 1,` + `,:b` = the second comma is an UNQUOTE KEY (reader-faithful)", () => {
    admissible("{:a 1,", ",:b");
  });

  it("trailing separator `[1, 2` + `,]` — one trailing comma before the close is tolerated", () => {
    admissible("[1, 2", ",]");
    admissible("[1, 2", ",");
    admissible("[1, 2", "]");
  });

  it("the trailing-comma boundary is NOT a licence for a dangling unquote: `[1, 2` + `,,]` masked", () => {
    masked("[1, 2", ",,]"); // second comma = unquote; `]` with the datum missing = R-EXPECTING-DATUM
  });
});

// ── 2. Comma OUTSIDE literals = unquote lead (the reader reads it; Σ mirrors) ─────────────────────────
describe("literal-admissibility — `,` outside literals is an unquote lead", () => {
  it("`(fn ` + `,x` — an unquote datum at an argument slot is admissible", () => {
    admissible("(fn ", ",x");
  });
  it("`(fn a` + `,` — the comma delimits the atom and leads an unquote (the i_ corpus shape)", () => {
    admissible("(fn a", ",");
    admissible("(fn a", ",b"); // `(fn a, b)` reads as `(fn a (unquote b))` — reader-valid
  });
});

// ── 3. Fused multi-char tokens (the BPE reality) ──────────────────────────────────────────────────────
describe("literal-admissibility — fused tokens pass as units", () => {
  it("value-slot openers", () => {
    admissible("(fn ", " [{");
    admissible("(fn ", "[{:");
    admissible("(fn ", "{:a");
  });
  it("`, :b` at an even dict boundary — separator + next key in one token", () => {
    admissible("(fn {:a 1", ", :b");
  });
  it("`\"}]` — one token closing string + dict + vector", () => {
    admissible('(fn [{:a "x', '"}]');
  });
  it("`1, 2` inside a vector — element + separator + element in one token", () => {
    admissible("(fn [", "1, 2");
  });
  it("negatives: a stray closer and a fused mismatch stay masked", () => {
    masked("", "]"); // over-close — the base scanner
    masked("(fn ", "[)"); // R-BRACKET-MISMATCH inside the fused token
  });
});

// ── 3b. The suffix-keyword flip at dict KEY position (spec: "The suffix-keyword flip") ────────────────
// A symbol-start is admissible at key position PENDING its single trailing colon; the token that
// completes the key WITHOUT one is the token that gets masked (incremental completeness — a live
// prefix is never prematurely killed).
describe("literal-admissibility — the suffix-keyword flip", () => {
  it("fused `{flight` — a symbol-start at key position is admissible (pending the trailing colon)", () => {
    admissible("(fn ", "{flight");
    admissible("(fn {", "flight");
  });
  it("the key completes WITH the colon: `flight_number:` then its value — all admissible", () => {
    admissible("(fn {flight", "_number:");
    admissible("(fn {flight_number:", ' "HAT136"');
    admissible('(fn {flight_number: "HAT136"', ", date:"); // even-boundary separator + next suffix key
    admissible('(fn {flight_number: "HAT136", date: "2024-05-20"', "})"); // the airline shape closes
  });
  it("bare key then terminator: `{a` + ` ` masked AT THE SPACE (completed key-less)", () => {
    masked("(fn {a", " ");
    masked("(fn {a", " 1}");
  });
  it("glued teaching-door forms stay ungeneratable: `{a:1}` (digit after colon) and `{a:\"x\"` (quote glue)", () => {
    masked("(fn {a:1", "}"); // `a:1` completes at the close — key-less
    masked("(fn {a:", '"'); // the lexer GLUES `"` into the symbol token — masked at the quote
  });
  it("double trailing colon is not a flip: `{a::` masked when it completes", () => {
    masked("(fn {a::", " 1}");
  });
  it("flipped keys share the dup keyspace: `{:a 1 a:` masked as it completes; `\"a\"` twin masked too", () => {
    masked("(fn {:a 1 a:", " 2}"); // `a:` ≡ `:a` — R-DICT-DUP-KEY at completion
    masked('(fn {a: 1 "a"', ""); // string twin of a flipped key — dup at the closing quote
  });
  it("verbatim-JSON string-key colon: `{\"a\"` + `: 1}` admissible (one lone `:` absorbed at the odd boundary)", () => {
    admissible('(fn {"a"', ": 1}");
    admissible('(fn {"a":', " 1}");
    admissible('(fn {"a" : 1', "}");
  });
  it("position-scoped: `foo:` outside `{}` stays a plain (admissible) atom", () => {
    admissible("(fn ", "foo:");
    admissible("(fn [", "foo: bar]");
  });
});

// ── 4. Typed-mode (Σ∩T) non-regression — the literals at type-stamped slots ───────────────────────────
/** A value-slot-START state (token boundary, application argument) with a given array-ness — the
 *  structure-contract fixture style (the lens→state plumbing is pinned e2e elsewhere). */
const slot = (slotIsArray: boolean | null | undefined): OracleState => ({
  midToken: false,
  position: "argument",
  formKind: "application",
  closeable: false,
  overClosed: false,
  validSymbols: () => null,
  slotIsArray,
});

describe("literal-admissibility — typed-mode non-regression", () => {
  it("ARRAY-typed slot: `[` and ` [{` ride the isListLiteral path (admitted, now actually reachable)", () => {
    expect(classifyCandidate(scanner, "(fn ", "[", undefined, slot(true))).not.toBe("structural");
    expect(classifyCandidate(scanner, "(fn ", " [{", undefined, slot(true))).not.toBe("structural");
  });
  it("ARRAY-typed slot: scalar literals stay masked (the gate itself did not loosen)", () => {
    expect(classifyCandidate(scanner, "(fn ", '"a"', undefined, slot(true))).toBe("structural");
    expect(classifyCandidate(scanner, "(fn ", "5", undefined, slot(true))).toBe("structural");
  });
  it("object/value-typed (scalar-stamped) slot: `{` and `{:key` are NEUTRAL — admitted, not masked", () => {
    expect(classifyCandidate(scanner, "(fn ", "{", undefined, slot(false))).not.toBe("structural");
    expect(classifyCandidate(scanner, "(fn ", "{:key", undefined, slot(false))).not.toBe("structural");
  });
  it("scalar-stamped slot: the LIST literals stay masked (`[`/`'` — R-SCALAR-REJECTS-LIST unchanged)", () => {
    expect(classifyCandidate(scanner, "(fn ", "[", undefined, slot(false))).toBe("structural");
    expect(classifyCandidate(scanner, "(fn ", "'", undefined, slot(false))).toBe("structural");
  });
});

// ── 5. Σ-live literal elements — the deliberate first-element degrade ─────────────────────────────────
// The base scanner models `[…]`/`{…}` as generic application frames, so the FIRST element reads as
// "operator" and its Σ set is operator-FILTERED (callables-only) — masking a value symbol there would be
// off-policy contamination, so Σ DEGRADES on a literal's first element (admit; eval owns unbound
// symbols). Later elements read "argument" and keep the argument-filtered bound check — the pinned,
// documented asymmetry (see passesSigmaOnState).
describe("literal-admissibility — Σ-live literal elements", () => {
  const callable = (x: unknown): unknown => x;
  const live = makeOracle(oracleEnvFromBindings({ fn: callable, items: callable }));

  it("first vector element: an UNBOUND word is admitted (Σ degrades — no operator slot in a literal)", () => {
    expect(classifyCandidate(live, "(fn [", "zzz")).toBe("feasible");
  });
  it("first dict key: the `:`-keyword rides the keyword-accessor admit as ever", () => {
    expect(classifyCandidate(live, "(fn {", ":a")).toBe("feasible");
  });
  it("later vector elements keep the argument-position Σ check (unbound masked, bound/literals pass)", () => {
    expect(classifyCandidate(live, "(fn [items ", "zzz")).toBe("sigma");
    expect(classifyCandidate(live, "(fn [items ", "items")).toBe("feasible");
    expect(classifyCandidate(live, "(fn [items ", "5")).toBe("feasible");
  });
  it("a dict KEY atom is a DECLARATION, not a reference — Σ degrades on it even at a later key", () => {
    // Later keys report "argument"; without the keyAtom degrade the unbound `flight` would be
    // Σ-masked mid-typing and the suffix flip could never be generated in live mode.
    expect(classifyCandidate(live, "(fn {:a 1 ", "flight")).toBe("feasible");
    expect(classifyCandidate(live, "(fn {:a 1 flight", "_number:")).toBe("feasible");
    // …while an unbound symbol at a dict VALUE slot keeps the argument-position Σ check.
    expect(classifyCandidate(live, "(fn {:a 1 flight_number: ", "zzz")).toBe("sigma");
  });
});

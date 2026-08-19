// tool-call-grammar.test.ts — the sampler's NARROW tool-call tightening: the general oracle admits
// reader macros as valid arrival syntax; the gate masks only what the READER itself rejects plus the
// validated sublanguage tightenings (quasiquote `` ` ``, post-quote forcing, phantom-list,
// R-HEAD-IS-SYMBOL). Since the reader gained `[a b c]` vector / `{:k v}` dict literals (74ac6ad54a),
// the brackets are FIRST-CLASS array/object materializers — the old R-NO-BRACKETS blanket ban is
// retired (it had become a style rule; Σ's contract is validity, never style) and what it incidentally
// guarded is kept precise: bracket-kind mismatch (R-BRACKET-MISMATCH), stray closers (the base
// scanner's overClosed), and the dict-literal validity mirrors. Quote `'` is admitted at a value slot
// ONLY as `'(`/`'[`/`'{` via the post-quote forcing rule — degenerate `''` / `'atom` / `'5` cannot be
// generated. Comma mirrors the reader's position-scoped rule: a separator inside literals, an unquote
// lead elsewhere — admissible wherever a datum may start.

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { classifyCandidate } from "../../src/mask-compiler.js";

describe("tool-call grammar tightening (mask-compiler)", () => {
  const scanner = makeOracle(); // structural-only is enough — the tightening is structural

  // Masked "structural" in the tool-call sublanguage.
  const rejected: [string, string, string][] = [
    ["(f ", "`x", "quasiquote"],
    ["(f 'x", "'", "consecutive quote (spam) — post-quote char is not an opener"],
    ["(f ", "'5", "quoted scalar — post-quote char is not an opener"],
    ["(f ", "'foo", "quoted symbol — post-quote char is not an opener"],
    ["(f ", "' (a", "quote then space — post-quote char is not an opener"],
    ["(f average", "_temp'x", "quote glued to an atom tail — post-quote char is not an opener"],
    ["(f (list 1", "]", "R-BRACKET-MISMATCH: `]` closing a `(`-opened frame"],
    ["(f [1 2", ")", "R-BRACKET-MISMATCH: `)` closing a `[`-opened frame"],
    ["(f ", "{1 2}", "R-DICT-KEY: a number can never be a dict key (reader E-DICT-BAD-KEY)"],
    ["(f ", "{a 1}", "R-DICT-KEY: a bare symbol can never be a dict key"],
    ["(f {:a 1 ", ":a 2}", "R-DICT-DUP-KEY: a repeated literal key (reader E-DICT-DUP-KEY)"],
    ["(f {:a 1 ", '"a"', 'R-DICT-DUP-KEY: `"a"` repeats `:a` (both fold to key "a")'],
    ["(f {:a", "}", "R-DICT-ARITY: `}` at odd element count — a key without its value"],
    ["(f [a ", ". b]", "R-LITERAL-DOT: a dotted pair inside a vector literal"],
    ["(f {:a ", ". 1}", "R-LITERAL-DOT: a dotted pair inside a dict literal"],
    ["(f {:a ,", "}", "R-EXPECTING-DATUM: a closer while an unquote awaits its datum"],
  ];
  it.each(rejected)("rejects %j+%j (%s)", (prefix, cand) => {
    expect(classifyCandidate(scanner, prefix, cand)).toBe("structural");
  });

  // Valid Scheme the gate must NOT reject (canonicalization is the scorer's job, not the gate's).
  const ok: [string, string, string][] = [
    ["(f ", "1.0", "number"],
    ["(f ", '"a, b"', "comma INSIDE a string is fine"],
    ["(f ", "(list", "nested application"],
    ["(f ", "#t", "boolean"],
    ["(f ", '"a[b]c"', "brackets INSIDE a string are content — the masks apply OUTSIDE strings only"],
    ["(f ", "'(a", "quoted list — `'` admitted at a value slot, post-quote opener satisfied"],
    ["(f ", "'", "trailing quote — admitted; the next step forces an opener"],
    ["(f ", "'(", "quote followed by open — a legal quote shape"],
    ["(f ", "'[a b]", "quoted VECTOR literal — `'[` is a legal quote shape now"],
    ["(f ", "'{:a 1}", "quoted DICT literal — `'{` is a legal quote shape now"],
    ["(f ", "(list", "list arg via the bound (list …) call"],
    ["(f 1 2", ")", "close"],
    // The collection literals — the reader reads these; Σ must admit them (validity, never style).
    ["(f ", "[", "a bare `[` OPENS a vector literal — first-class array materializer"],
    ["(f ", '["a" "b"]', "a complete vector literal argument"],
    ["(f ", "[1, 2, 3]", "JSON-gravity separator commas inside a vector"],
    ["(f ", "[1, 2,]", "one trailing separator comma is tolerated"],
    ["(f ", "[{:a 1}]", "a dict literal nested as a vector element"],
    ["(f ", "{:a 1 :b 2}", "a dict literal argument (keyword keys)"],
    ["(f ", '{"a" 1}', "a dict literal with a string key"],
    ["(f ", '{:a 1 "b" 2}', "mixed keyword/string keys"],
    ["(f ", "{:a 1, :b 2}", "a separator comma at an even dict boundary"],
    ["(f ", "{}", "an empty dict"],
    ["(f ", "[]", "an empty vector"],
    ["(f ", "{:a [1 2]}", "a vector literal as a dict value"],
    ["(f ", "[1 (+ 1 1) 3]", "elements are FORMS — a call inside a vector element evaluates"],
    ["(f ", "{:a (g x)}", "a call as a dict value"],
    // Comma = unquote-lead outside literals — the reader reads it; admissible wherever a datum may start.
    ["(f 3", ",", "a comma after an argument — unquote lead (the reader reads `(f 3, 2)` fine)"],
    ["(f ", ",x", "an unquote datum at an argument slot"],
    ["(f ", "[,a]", "a leading comma inside a vector is unquote"],
    ["(f ", "[a ,,b]", "second comma at a boundary is unquote"],
    ["(f ", "[1 ,@xs]", "`,@` is always unquote-splicing, never a separator"],
    ["(f ", "{:a ,x}", "an odd-boundary dict comma is unquote (the value)"],
    ["(f ", "{:a 1, ,k v}", "an unquote-form KEY after a separator comma"],
    ["(f ", "{:a ,quoted,,anotherQuoted ,quotedValue}", "the spec's canonical mixed-comma-roles dict"],
  ];
  it.each(ok)("keeps %j+%j feasible (%s)", (prefix, cand) => {
    expect(classifyCandidate(scanner, prefix, cand)).not.toBe("structural");
  });

  // PARITY: a tool call that uses neither quote nor bracket is byte-identical to the old gate — the new
  // branches only fire on `'` / its successor, never on the plain `(list …)` path.
  it("leaves the no-quote / no-bracket path untouched (parity)", () => {
    expect(classifyCandidate(scanner, "(f ", "(list 1 2 3)")).not.toBe("structural");
    expect(classifyCandidate(scanner, "(f ", '"hello"')).not.toBe("structural");
    expect(classifyCandidate(scanner, "(f 1 2 3", ")")).not.toBe("structural");
  });

  // PHANTOM-LIST veto: `'(list …)` — the bare symbol `list` as the FIRST DATUM of a `'(` quote-list. The
  // model conflates the constructor `(list …)` with the quote-list `'(…)`; the scorer then reads the literal
  // `list` as element #0 of the array. Masked "structural" — but ONLY the exact `list` atom, first-datum.
  describe("phantom `'(list …)` veto", () => {
    const phantom: [string, string, string][] = [
      ["(f ", "'(list", "`list` as the first datum of a quote-list (the phantom)"],
      ["(f ", "'(list ", "…with the terminating space"],
      ["(f ", `'(list "a" "b")`, "the full chimera the scorer mis-reads"],
      ["(f '(", "list", "candidate `list` landing in a freshly-opened quote-list's first slot"],
      ["(f ", "'(  list", "leading interior whitespace before the first datum"],
    ];
    it.each(phantom)("vetoes %j+%j (%s)", (prefix, cand) => {
      expect(classifyCandidate(scanner, prefix, cand)).toBe("structural");
    });

    // PRECISION — these must STAY legal (the veto is surgical: only the complete `list` atom, first-datum).
    const survives: [string, string, string][] = [
      ["(f ", "(list", "the real constructor `(list …)` — no leading quote"],
      ["(f ", "(list 1 2 3)", "the real constructor, complete"],
      ["(f ", `'("a" list)`, "`list` as a LATER element of a quote-list"],
      ["(f ", "'(list-ref", "a longer atom STARTING with `list` (not the bare `list`)"],
      ["(f ", "'(list->vector", "another `list`-prefixed atom"],
      ["(f ", "'(lister", "`lister` — `list` is only a prefix"],
      ["(f '(", "lis", "an in-progress PREFIX of `list` / `list-ref` — not yet the complete atom"],
      ["(f ", "'(open", "a normal first datum (symbol)"],
      ["(f ", `'("foo"`, "a normal first datum (string)"],
      ["(f ", "'(1 2", "a normal first datum (number)"],
      ["(f ", "'((list) x)", "`list` NESTED one level deeper, not the outer first datum"],
    ];
    it.each(survives)("keeps %j+%j feasible (%s)", (prefix, cand) => {
      expect(classifyCandidate(scanner, prefix, cand)).not.toBe("structural");
    });
  });

  // R-HEAD-IS-SYMBOL: every non-quoted application head must be a NAMED SYMBOL. A `(`/`[`/`{` opening at the
  // HEAD slot (parent application frame elems===0) is a sub-application head — the parallel-collapse
  // `((call)(call))` the BFCL run surfaced — and is masked. Argument-position nesting, quoted lists, and the
  // parallel top-level sequence `(c1) (c2)` stay legal.
  describe("operator-head-is-symbol (R-HEAD-IS-SYMBOL)", () => {
    const head: [string, string, string][] = [
      ["(", "(", "the `((` collapse — a sub-application opens at the head slot"],
      ["(", "(calc", "candidate `(calc` — a `(`-led head is a sub-application head"],
      ["(", "(get_x) (", "the model's `((get_x) …` curry wrap, caught at the inner `(`"],
      ["(f 1) ", "((g 2))", "the parallel second call double-wrapped `((g 2))` — caught at its inner `(`"],
    ];
    it.each(head)("masks %j+%j (%s)", (prefix, cand) => {
      expect(classifyCandidate(scanner, prefix, cand)).toBe("structural");
    });

    // PRECISION — these must STAY legal: the head slot is symbol-only, but a nested `(` is fine at an ARGUMENT
    // slot, inside a quote, and a `(` opening a TOP-LEVEL call (no parent) is the parallel sequence.
    const legal: [string, string, string][] = [
      ["(fn ", "(g x)", "argument-position nested call — parent already has its head"],
      ["(fn ", "(list 1 2)", "argument-position list constructor"],
      ["(fn (g ", "(h x))", "deeper argument nesting"],
      ["(fn ", "'((a) (b))", "parens INSIDE a quoted list are data, not operators"],
      ["(c1) ", "(", "the parallel TOP-LEVEL sequence — the next `(` has no parent frame"],
      ["", "(", "the very first `(` of a program — top-level, no parent"],
      ["(", "calc", "a SYMBOL head — admitted (the whole point)"],
      // MULTI-TOKEN SYMBOLS: a `/`-containing head (`declare/overridable`, a real bound symbol in some envs) is
      // ONE atom — `/` is not an atom terminator — so it is a symbol head, never a sub-application. The head
      // must survive being built across the commit boundary token by token.
      ["(", "declare/overridable", "a `/`-containing symbol head — one atom, a symbol not a sub-application"],
      ["(declare", "/overridable", "the `/`-symbol head split across tokens — `/overridable` continues the atom"],
      ["(declare/over", "ridable", "mid-symbol continuation of a `/`-head — still one atom, not a new form"],
    ];
    it.each(legal)("keeps %j+%j feasible (%s)", (prefix, cand) => {
      expect(classifyCandidate(scanner, prefix, cand)).not.toBe("structural");
    });
  });
});

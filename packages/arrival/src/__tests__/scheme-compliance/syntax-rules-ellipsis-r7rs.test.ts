// R7RS §4.3.2 syntax-rules conformance table — ellipsis depth, tails, vectors, escapes.
//
// Law shape: every row is `[title, rules, use, expected]`; the macro under test is always
// bound as `m` via let-syntax and the use-site is evaluated to a printed value. Each row pins
// one clause of the spec (pattern variables are bound at their ELLIPSIS DEPTH; the transcriber
// drives `...` by the variables beneath it; all variables under one ellipsis repeat equally).
import { describe, expect, it } from "vitest";
import { freshEnv } from "../_fresh-env.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { AVector } from "../../values/primitives/AVector.js";

const env = await freshEnv();

async function run(form: string): Promise<string> {
  const { values } = await execState(form, { env });
  const out = values[0];
  return out instanceof AVector ? `#(${out.__vector__.map(String).join(" ")})` : String(out);
}

const prog = (rules: string, use: string) => `(let-syntax ((m (syntax-rules ${rules}))) ${use})`;

type Row = readonly [title: string, rules: string, use: string, expected: string];

const DEPTH_ROWS: readonly Row[] = [
  ["depth 1: compound template repeats", "() ((_ x ...) (list (list x x) ...))", "(m 1 2)", "((1 1) (2 2))"],
  ["depth 1: quoted element repeats", "() ((_ a ...) (list 'a ...))", "(m 1 2)", "(1 2)"],
  ["depth 1: list-valued arguments", "() ((_ a ...) (list 'a ...))", "(m (1 2) (3))", "((1 2) (3))"],
  [
    "two sibling ellipsis variables pair up",
    "() ((_ (x ...) (y ...)) '((x y) ...))",
    "(m (1 2) (3 4))",
    "((1 3) (2 4))",
  ],
  ["depth 2: nested, same shape", "() ((_ (a b ...) ...) '((b ... a) ...))", "(m (1 2 3) (4 5))", "((2 3 1) (5 4))"],
  [
    "depth 2: mixed depths ((a b ...) ...)",
    "() ((_ (a b ...) ...) '((a (b ...)) ...))",
    "(m (1 2 3) (4) (5 6))",
    "((1 (2 3)) (4 ()) (5 (6)))",
  ],
  [
    "depth 2: outer variable constant under inner ellipsis",
    "() ((_ k (v ...) ...) '((k v ...) ...))",
    "(m 0 (1 2) (3))",
    "((0 1 2) (0 3))",
  ],
  ["depth 2: x ... ... flattens", "() ((_ (a ...) ...) '(a ... ...))", "(m (1 2) (3) () (4 5))", "(1 2 3 4 5)"],
  ["depth 3: flatten fully", "() ((_ ((a ...) ...) ...) '(a ... ... ...))", "(m ((1 2) (3)) () ((4)))", "(1 2 3 4)"],
  [
    "depth 3: preserve structure",
    "() ((_ ((a ...) ...) ...) '(((a ...) ...) ...))",
    "(m ((1 2) (3)) ((4)))",
    "(((1 2) (3)) ((4)))",
  ],
  ["depth 2 variable used with a shallower sibling", "() ((_ (a b ...) ...) '(a ...))", "(m (1 2) (3 4 5))", "(1 3)"],
  ["compound sub-pattern ((n v) ...)", "() ((_ (n v) ...) '((n . v) ...))", "(m (a 1) (b 2))", "((a . 1) (b . 2))"],
  ["compound pattern, split templates", "() ((_ (n v) ...) '((n ...) (v ...)))", "(m (a 1) (b 2))", "((a b) (1 2))"],
];

const EMPTY_ROWS: readonly Row[] = [
  ["zero repetitions at depth 1", "() ((_ a ...) (list a ...))", "(m)", "()"],
  ["zero repetitions keep fixed neighbours", "() ((_ h a ... z) '(h (a ...) z))", "(m 1 2)", "(1 () 2)"],
  ["zero outer repetitions at depth 2", "() ((_ (a b ...) ...) '((a b ...) ...))", "(m)", "()"],
  ["empty inner repetitions at depth 2", "() ((_ (a b ...) ...) '((b ...) ...))", "(m (1) (2))", "(() ())"],
  ["empty repetition under a constant outer variable", "() ((_ k a ...) '(k a ... end))", "(m 0)", "(0 end)"],
];

const TAIL_ROWS: readonly Row[] = [
  ["tail after ellipsis: p ... q", "() ((_ a ... z) '(z a ...))", "(m 1 2 3)", "(3 1 2)"],
  ["tail after ellipsis: p ... q r", "() ((_ a ... y z) '(z y (a ...)))", "(m 1 2 3 4)", "(4 3 (1 2))"],
  ["tail after ellipsis, no repetitions", "() ((_ a ... y z) '(z y (a ...)))", "(m 1 2)", "(2 1 ())"],
  ["head + ellipsis + tail", "() ((_ h a ... z) '(h z (a ...)))", "(m 1 2 3 4)", "(1 4 (2 3))"],
  [
    "tail after a compound ellipsis",
    "() ((_ (a b) ... z) '((a ...) (b ...) z))",
    "(m (1 2) (3 4) end)",
    "((1 3) (2 4) end)",
  ],
  ["dotted pattern tail binds the rest", "() ((_ a . r) '(a r))", "(m 1 2 3)", "(1 (2 3))"],
  ["dotted pattern tail on an improper use", "() ((_ a . r) '(a r))", "(m 1 2 . 3)", "(1 (2 . 3))"],
  ["ellipsis then dotted tail (proper use)", "() ((_ a ... . r) '((a ...) r))", "(m 1 2 3)", "((1 2 3) ())"],
  ["ellipsis then dotted tail (improper use)", "() ((_ a ... . r) '((a ...) r))", "(m 1 2 . 3)", "((1 2) 3)"],
  ["ellipsis, fixed tail, dotted tail", "() ((_ a ... z . r) '((a ...) z r))", "(m 1 2 3 . 4)", "((1 2) 3 4)"],
  ["template dotted tail after ellipsis", "() ((_ a ... z) '(a ... . z))", "(m 1 2 3)", "(1 2 . 3)"],
];

const VECTOR_ROWS: readonly Row[] = [
  ["vector pattern, fixed", "() ((_ #(a b)) (+ a b))", "(m #(7 8))", "15"],
  ["vector pattern with ellipsis", "() ((_ #(a ...)) (+ a ...))", "(m #(1 2 3 4))", "10"],
  ["vector pattern with ellipsis and tail", "() ((_ #(a ... z)) '(z a ...))", "(m #(1 2 3))", "(3 1 2)"],
  ["vector pattern vs wrong length", "() ((_ #(a b)) 'two) ((_ x) 'other)", "(m #(1 2 3))", "other"],
  ["vector pattern vs non-vector", "() ((_ #(a ...)) 'vec) ((_ x) 'other)", "(m (1 2))", "other"],
  ["list pattern does not match a vector", "() ((_ (a ...)) 'list) ((_ x) 'other)", "(m #(1 2))", "other"],
  ["vector template emits a vector", "() ((_ a b) #(a b))", "(m 5 6)", "#(5 6)"],
  ["vector template with ellipsis", "() ((_ a ...) #(a ... end))", "(m 1 2)", "#(1 2 end)"],
  ["vector pattern to vector template", "() ((_ #(a ...)) #(a ... a ...))", "(m #(1 2))", "#(1 2 1 2)"],
  ["nested vector inside list pattern", "() ((_ (#(a ...) ...)) '((a ...) ...))", "(m (#(1 2) #()))", "((1 2) ())"],
];

const MISC_ROWS: readonly Row[] = [
  ["escape (... ...) emits a literal ellipsis", "() ((_ a) '(a (... ...)))", "(m 1)", "(1 ...)"],
  ["escape (... (x ...)) keeps ellipsis literal", "() ((_ x) '(... (x ...)))", "(m 1)", "(1 ...)"],
  ["custom ellipsis identifier", "::: () ((_ a :::) (list a :::))", "(m 1 2 3)", "(1 2 3)"],
  ["custom ellipsis frees `...` as data", "::: () ((_ a b :::) '(a ... (b :::)))", "(m 1 2 3)", "(1 ... (2 3))"],
  [
    "custom ellipsis, nested depth",
    "::: () ((_ (a b :::) :::) '((b ::: a) :::))",
    "(m (1 2 3) (4 5))",
    "((2 3 1) (5 4))",
  ],
  ["literal matches its keyword", "(=>) ((_ a => b) (cons a b)) ((_ a b c) 'no)", "(m 1 => 2)", "(1 . 2)"],
  ["literal rejects other identifiers", "(=>) ((_ a => b) (cons a b)) ((_ a b c) 'no)", "(m 1 2 3)", "no"],
  ["underscore matches anything and binds nothing", "() ((_ _ _ c) c)", "(m 1 2 3)", "3"],
  ["underscore may repeat in a pattern", "() ((_ (_ ...) c) c)", "(m (1 2 3) 4)", "4"],
  ["first matching rule wins", "() ((_) 'zero) ((_ a) 'one) ((_ a b ...) 'many)", "(m 1 2)", "many"],
  [
    "prototype-named variables are ordinary",
    "() ((_ toString constructor ...) '(constructor ... toString))",
    "(m 1 2 3)",
    "(2 3 1)",
  ],
  ["__proto__ as a pattern variable", "() ((_ __proto__ ...) '(__proto__ ...))", "(m 1 2)", "(1 2)"],
];

describe("R7RS §4.3.2 syntax-rules conformance", () => {
  describe.each([
    ["ellipsis depth", DEPTH_ROWS],
    ["empty repetitions", EMPTY_ROWS],
    ["tails and dotted patterns", TAIL_ROWS],
    ["vectors", VECTOR_ROWS],
    ["escapes, custom ellipsis, literals, underscore", MISC_ROWS],
  ] as const)("%s", (_group, rows) => {
    it.each(rows)("%s", async (_title, rules, use, expected) => {
      expect(await run(prog(rules, use))).toBe(expected);
    });
  });

  describe("macro-defining macros", () => {
    it("(... ...) escapes the inner macro's ellipsis", async () => {
      const src = `(let-syntax ((def (syntax-rules () ((_ name) (let-syntax ((name (syntax-rules () ((_ a (... ...)) (list a (... ...)))))) (name 1 2)))))) (def foo))`;
      expect(await run(src)).toBe("(1 2)");
    });

    it("an inner custom ellipsis passes through the outer template untouched", async () => {
      const src = `(let-syntax ((def (syntax-rules () ((_ name) (let-syntax ((name (syntax-rules ::: () ((_ a :::) (list a :::))))) (name 1 2)))))) (def foo))`;
      expect(await run(src)).toBe("(1 2)");
    });
  });

  describe("mismatched repetition counts are a teaching door", () => {
    it.each([
      ["two siblings of different length", "() ((_ (x ...) (y ...)) '((x y) ...))", "(m (1 2) (3))"],
      [
        "inner lengths differ under a shared outer ellipsis",
        "() ((_ (a ...) (b ...) ...) '((a b) ...))",
        "(m (1 2) (3))",
      ],
    ])("%s", async (_title, rules, use) => {
      await expect(run(prog(rules, use))).rejects.toThrow(/repeated different numbers of times/);
    });

    it("an ellipsis with no pattern variable beneath it", async () => {
      await expect(run(prog("() ((_ a) '(1 ...))", "(m 1)"))).rejects.toThrow(/no pattern variable to repeat/);
    });

    it("a repeated variable used without its ellipsis", async () => {
      await expect(run(prog("() ((_ a ...) 'a)", "(m 1 2)"))).rejects.toThrow(/missing ellipsis/);
    });

    it("an ellipsis in head position of a multi-element list", async () => {
      await expect(run(prog("() ((_ a) '(... a b))", "(m 1)"))).rejects.toThrow(/misplaced/);
    });
  });
});

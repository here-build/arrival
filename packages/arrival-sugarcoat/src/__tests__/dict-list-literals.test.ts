import { describe, expect, it } from "vitest";

import { schemeToSugarcoat, printScheme, parseSexprs, nodeEq } from "../sugarcoat-render.js";
import { readSugarcoatExpr, readSugarcoat } from "../sugarcoat-read.js";

const render = (scheme: string, opts = {}): string => schemeToSugarcoat(scheme, opts).trim();
const read1 = (sugarcoat: string): string => printScheme(readSugarcoatExpr(sugarcoat));
const canon = (scheme: string): string => printScheme(parseSexprs(scheme)[0]);
const roundtrip = (scheme: string, opts = {}): string => printScheme(readSugarcoatExpr(render(scheme, opts)));

describe("dict {} (even kv) vs n-expr {} (odd operand·op·operand)", () => {
  it("empty {} is dict", () => {
    expect(read1("{}")).toBe("(dict)");
    expect(render("(dict)")).toBe("{}");
  });
  it("even pairs read as dict", () => {
    expect(read1("{:a 1 :b 2}")).toBe("(dict :a 1 :b 2)");
    expect(read1('{name: "Ada" age: 36}')).toBe('(dict :name "Ada" :age 36)');
  });
  it("renders dict as braces", () => {
    expect(render("(dict :a 1 :b 2)")).toBe("{:a 1 :b 2}");
  });
  it("n-expr still wins on odd op alternation", () => {
    expect(read1("{a + b}")).toBe("(+ a b)");
    expect(read1("{a and b}")).toBe("(and a b)");
    expect(read1("{a == b or c == d}")).toBe("(or (equal? a b) (equal? c d))");
    expect(render("(+ a b)")).toBe("{a + b}");
  });
  it("single-form curly unwraps (SRFI-105)", () => {
    expect(read1("{x}")).toBe("x");
    expect(read1("{(f x)}")).toBe("(f x)");
  });
  it("nested dict inside n-expr", () => {
    expect(read1("{d == {:a 1}}")).toBe("(equal? d (dict :a 1))");
  });
  it("broken infix is a door, not a silent dict", () => {
    // Neither silently becomes a dict. Odd non-infix / truncated infix land on the
    // close-check or odd/even door (both name the operator vocabulary).
    expect(() => readSugarcoat("{a + b c}")).toThrowError(/infix operator|ambiguous|broken/i);
    expect(() => readSugarcoat("{a b c}")).toThrowError(/infix operator|ambiguous|broken/i);
  });
  it("round-trips dict and mixed forms", () => {
    for (const s of ["(dict)", "(dict :a 1)", "(dict :a 1 :b 2)", "(equal? d (dict :k v))", "(and p (dict :ok #t))"])
      expect(roundtrip(s)).toBe(canon(s));
  });
  // Legacy block form still folds (I-expression kwarg head).
  it("legacy dict block form still reads", () => {
    const got = readSugarcoat("dict\n  a: 1\n  b: 2")[0]!;
    expect(nodeEq(got, parseSexprs("(dict :a 1 :b 2)")[0]!)).toBe(true);
  });
});

describe("vector [] free-standing vs tight subscript", () => {
  it("free [] is vector", () => {
    expect(read1("[]")).toBe("(vector)");
    expect(read1("[1 2 3]")).toBe("(vector 1 2 3)");
    expect(read1("[:a :b]")).toBe("(vector :a :b)");
  });
  it("renders vector as brackets", () => {
    expect(render("(vector)")).toBe("[]");
    expect(render("(vector 1 2 3)")).toBe("[1 2 3]");
  });
  it("lists stay prefix — [] is not a list", () => {
    expect(render("(list)")).toBe("(list)");
    expect(render("(list 1 2 3)")).toBe("(list 1 2 3)");
    expect(read1("[1 2 3]")).not.toBe("(list 1 2 3)");
  });
  it("tight subscript still peels", () => {
    expect(read1("xs[0]")).toBe("(car xs)");
    expect(read1("f[:verdict]")).toBe("(:verdict f)");
    expect(render("(car xs)")).toBe("xs[0]");
  });
  it("vector as an argument is free, not a subscript", () => {
    expect(read1("(f [1 2])")).toBe("(f (vector 1 2))");
    expect(render("(f (vector 1 2))")).toBe("(f [1 2])");
  });
  it("vector of dicts", () => {
    expect(read1("[{:a 1} {:b 2}]")).toBe("(vector (dict :a 1) (dict :b 2))");
    expect(render("(vector (dict :a 1) (dict :b 2))")).toBe("[{:a 1} {:b 2}]");
  });
  it("round-trips", () => {
    for (const s of ["(vector)", "(vector 1 2 3)", "(vector (dict :a 1))", "(map f (vector 1 2))"])
      expect(roundtrip(s)).toBe(canon(s));
  });
});

describe("dedicated surface outranks peel (vector/dict/list/str are not method steps)", () => {
  it("(f (vector x)) stays prefix-on-literal, not x.vector.f", () => {
    expect(render('(compile-skill (vector (dict :path "SKILL.md" :content markdown)))')).toBe(
      '(compile-skill [{:path "SKILL.md" :content markdown}])',
    );
    expect(render("(g (vector x))")).toBe("(g [x])");
  });
  it("(vector (f x)) is still a vector literal, not x.f.vector", () => {
    expect(render("(vector (f x))")).toBe("[(f x)]");
  });
  it("HOF on a vector literal still peels: [x].map(f)", () => {
    expect(render("(map f (vector 1 2))")).toBe("[1 2].map(f)");
  });
  it("(list …) stays prefix; not a method on its element", () => {
    expect(render("(list 1 2 3)")).toBe("(list 1 2 3)");
    expect(render("(compile-skill (list x))")).toBe("(compile-skill (list x))");
  });
  it("(foo (str x)) does not become x.str.foo", () => {
    expect(render("(foo (str x))")).toBe("(foo (str x))");
  });
});

describe("R7RS #(…) is not a constant-vector datum on this forest", () => {
  it("parseSexprs splits # from the parens", () => {
    expect(parseSexprs("#(1 2 3)").map((n) => printScheme(n))).toEqual(["#", "(1 2 3)"]);
  });
  it("sugarcoat-read I-expr groups them as a call of #", () => {
    expect(readSugarcoat("#(1 2 3)").map((n) => printScheme(n))).toEqual(["(# (1 2 3))"]);
  });
  it("the evaluating-vector spelling is […]", () => {
    expect(render("(vector 1 2 3)")).toBe("[1 2 3]");
  });
});

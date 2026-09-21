/**
 * Arity at Scheme-side application (R7RS §4.1.4) — issue #4.
 *
 * Surplus arguments are not dropped; missing arguments are not `undefined`. The check
 * fires at `(f …)`, `(apply f …)`, and `=>`, for user lambdas and for every native /
 * rosetta symbol whose contract declares a positional tuple. Unknown arity (`{0, null}`:
 * bare host fns, door procedures, opaque contracts, keyword accessors) is never enforced,
 * and the host→Scheme callback path (`applyCallback`) keeps JS conventions on purpose.
 */
import { describe, it, expect } from "vitest";
import { exec } from "../index.js";
import { ArityMismatchError } from "../errors.js";

const rejectsArity = async (src: string, pattern: RegExp) => {
  const p = exec(src);
  await expect(p).rejects.toThrow(ArityMismatchError);
  await expect(p).rejects.toThrow(pattern);
  await expect(p).rejects.toMatchObject({ "arrival/error-category": "arity-mismatch" });
};

describe("arity — user lambdas", () => {
  it("surplus argument is an error, naming the parameters", () =>
    rejectsArity("((lambda (x) x) 1 2)", /lambda: expected exactly 1 argument, got 2 — the parameters are \(x\)/));

  it("missing argument is an error, not undefined", () =>
    rejectsArity("((lambda (x y) x) 1)", /lambda: expected exactly 2 arguments, got 1 — the parameters are \(x y\)/));

  it("a define'd procedure reports its own name", () =>
    rejectsArity("(define (f a b) a) (f 1)", /^f: expected exactly 2 arguments, got 1 — the parameters are \(a b\)/));

  it("rest parameter accepts any surplus", async () => {
    const [r] = await exec("((lambda (a . rest) (length rest)) 1 2 3 4)");
    expect(r).toBe(3);
  });

  it("rest parameter still requires the fixed head", () =>
    rejectsArity(
      "((lambda (a b . rest) a))",
      /expected at least 2 arguments, got 0 — the parameters are \(a b \. rest\)/,
    ));

  it("zero-parameter lambda refuses arguments", () =>
    rejectsArity("((lambda () 1) 2)", /expected exactly 0 arguments, got 1/));
});

describe("arity — natives and rosetta symbols (contract-derived bounds)", () => {
  it("SRFI-13 start/end are not silently ignored: string-index is 2-ary", () =>
    rejectsArity('(string-index "abcdefd" #\\d 4)', /string-index: expected exactly 2 arguments, got 3/));

  it("string-contains is 2-ary", () =>
    rejectsArity('(string-contains "abcabc" "abc" 1)', /string-contains: expected exactly 2 arguments, got 3/));

  it("substring takes 2 to 3 (end is optional here), never 4", () =>
    rejectsArity('(substring "abcdefg" 1 3 99)', /substring: expected 2 to 3 arguments, got 4/));

  it("missing argument does not become undefined: (string-length) is an error, not 9", () =>
    rejectsArity("(string-length)", /string-length: expected exactly 1 argument, got 0/));

  it("(car x y) is an error", () => rejectsArity("(car (list 1) (list 2))", /car: expected exactly 1 argument, got 2/));

  it("an optional trailing slot lowers min but not max: make-list", async () => {
    const [one, two] = await exec("(make-list 2) (make-list 2 'x)");
    expect(one).toEqual([false, false]);
    expect(two).toEqual(["x", "x"]);
    await rejectsArity("(make-list 2 'x 'y)", /make-list: expected 1 to 2 arguments, got 3/);
  });

  it("variadic natives stay variadic", async () => {
    const [sum, cat, none] = await exec('(+ 1 2 3 4 5) (string-append "a" "b" "c") (string-append)');
    expect(sum).toBe(15);
    expect(cat).toBe("abc");
    expect(none).toBe("");
  });

  it("the surplus message says why", () =>
    rejectsArity('(string-index "a" #\\a 0)', /Surplus arguments are not ignored/));

  it("the missing message says why", () => rejectsArity('(substring "abc")', /Missing arguments do not default/));
});

describe("arity — apply and =>", () => {
  it("(apply f list) checks the spliced count", () =>
    rejectsArity("(apply (lambda (x) x) '(1 2))", /lambda: expected exactly 1 argument, got 2/));

  it("(apply f a b list) counts leading args too", async () => {
    const [r] = await exec("(apply + 1 2 '(3 4))");
    expect(r).toBe(10);
    await rejectsArity("(apply (lambda (a b) a) 1 '(2 3))", /expected exactly 2 arguments, got 3/);
  });

  it("=> receiver must take exactly one argument", () =>
    rejectsArity(
      "(cond ((assv 2 '((1 . a) (2 . b))) => (lambda () 'x)) (else 'none))",
      /expected exactly 0 arguments, got 1/,
    ));

  it("=> with a unary receiver works", async () => {
    const [r] = await exec("(cond ((assv 2 '((1 . a) (2 . b))) => cdr) (else 'none))");
    expect(r).toBe("b");
  });
});

describe("arity — what is deliberately NOT enforced", () => {
  it("keyword accessors declare no arity and keep working", async () => {
    const [a, missing] = await exec("(:a {:a 1}) (:zzz {:a 1})");
    expect(a).toBe(1);
    expect(missing).toEqual([]); // nil exits as the empty list
  });

  it("host HOF callbacks (map / vector-map / filter) are exact-count calls and pass", async () => {
    const [m, v, f] = await exec(
      "(map (lambda (x) (* x x)) '(1 2 3)) (vector-map (lambda (x) x) #(1 2)) (filter (lambda (x) (> x 1)) '(1 2 3))",
    );
    expect(m).toEqual([1, 4, 9]);
    expect(v).toEqual([1, 2]);
    expect(f).toEqual([2, 3]);
  });
});

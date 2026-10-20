// syntax-rules engine review findings: deep pass-through, synthesized c[ad]+r in templates,
// nested macros, keyword position, duplicate pattern variables, the syntax-rules door, and
// definitions spliced from an expansion into the use site.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";
import { ArrivalError } from "../../errors.js";
import { SyntaxRulesError } from "../../eval/syntax-rules/error.js";

const last = async (src: string) => {
  const rs = (await exec(src)) as unknown[];
  return rs[rs.length - 1];
};
const thrown = async (src: string): Promise<unknown> => {
  try {
    await exec(src);
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};
const iota = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(" ");

describe("deep call-site fragments pass through restore_data_gensyms", () => {
  it.each([10_000, 50_000])("(length x) over a %i-element call-site list", async (n) => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ x) (length x)))) (m (list ${iota(n)}))`)).toBe(n);
  });
  it.each([10_000, 50_000])("quoted ellipsis capture of %i arguments", async (n) => {
    const r = (await last(`(define-syntax m (syntax-rules () ((_ a ...) '(a ...)))) (m ${iota(n)})`)) as number[];
    expect(r).toHaveLength(n);
    expect(r[n - 1]).toBe(n);
  });
});

describe("c[ad]+r inside templates (synthesized by the resolver, not bound)", () => {
  it.each([
    ["car", "'(1 2)", 1],
    ["cdr", "'(1 2)", [2]],
    ["cadr", "'(1 2 3)", 2],
    ["cddr", "'(1 2 3)", [3]],
    ["caar", "'((7) 2)", 7],
  ])("%s", async (op, arg, want) => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ a) (${op} a)))) (m ${arg})`)).toEqual(want);
  });
  it("stays hygienic: a use-site binding of the name does not capture the template's", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ a) (car a)))) (let ((car cdr)) (m '(1 2)))`)).toBe(1);
  });
});

describe("nested syntax-rules in a template", () => {
  it("inner pattern variables under quote are substituted", async () => {
    expect(
      await last(
        `(let-syntax ((d (syntax-rules () ((_ n) (let-syntax ((n (syntax-rules () ((_ a) 'a)))) (n 1)))))) (d q))`,
      ),
    ).toBe(1);
  });
  it("depth-2 inner ellipsis under quote", async () => {
    expect(
      await last(
        `(let-syntax ((d (syntax-rules () ((_ n)
           (let-syntax ((n (syntax-rules () ((_ (a b (... ...)) (... ...)) '((b (... ...) a) (... ...))))))
             (n (1 2 3) (4 5)))))))
           (d q))`,
      ),
    ).toEqual([
      [2, 3, 1],
      [5, 4],
    ]);
  });
  it("an inner macro sees a binding the outer expansion introduced", async () => {
    expect(
      await last(
        `(define-syntax m (syntax-rules () ((_ a) (let ((x a)) (let-syntax ((n (syntax-rules () ((_) x)))) (n))))))
         (m 9)`,
      ),
    ).toBe(9);
  });
});

describe("pattern shape (R7RS 4.3.2)", () => {
  it("the keyword position is neither variable nor literal", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((list a) (list a a)))) (m 1)`)).toEqual([1, 1]);
  });
  it("a duplicate pattern variable is a taught door", async () => {
    const e = await thrown(`(define-syntax m (syntax-rules () ((_ a a) 'dup))) (m 1 2)`);
    expect(e).toBeInstanceOf(SyntaxRulesError);
    expect((e as SyntaxRulesError).message).toMatch(/pattern variable `a' occurs more than once/);
    expect((e as SyntaxRulesError).hint).toMatch(/equal\?/);
  });
  it("vector patterns still demand the exact length", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ #(a b)) (+ a b)))) (m #(1 2))`)).toBe(3);
    const e = await thrown(`(define-syntax m (syntax-rules () ((_ #(a b)) (+ a b)))) (m #(1 2 3))`);
    expect(e).toBeInstanceOf(SyntaxRulesError);
  });
});

describe("the syntax-rules door", () => {
  it("no matching syntax: ArrivalError class, use-site location, rule shapes taught", async () => {
    const e = (await thrown(
      `(define-syntax m (syntax-rules () ((_ a) a) ((_ a b ...) b)))\n\n  (m)`,
    )) as SyntaxRulesError;
    expect(e).toBeInstanceOf(ArrivalError);
    expect(e).toBeInstanceOf(SyntaxRulesError);
    expect(e["arrival/error-category"]).toBe("unsupported-form");
    expect(e.message).toMatch(/no matching syntax in macro \(m\)/);
    expect(e.hint).toBe("this macro accepts: (_ a) | (_ a b ...)");
    expect(e.message).toContain("this macro accepts: (_ a) | (_ a b ...)");
    expect(e.location).toMatchObject({ line: 3, col: 2 });
  });
  it("engine rejections keep their hint and gain the use-site location", async () => {
    const e = (await thrown(`(define-syntax m (syntax-rules () ((_ a ...) (a))))\n(m 1 2)`)) as SyntaxRulesError;
    expect(e).toBeInstanceOf(SyntaxRulesError);
    expect(e.hint).toMatch(/`\.\.\.`/);
    expect(e.location).toMatchObject({ line: 2 });
    expect(e.message).toMatch(/in macro:/);
  });
});

describe("a macro that expands to definitions", () => {
  it("top-level begin of defines binds the user's names", async () => {
    expect(
      await last(
        `(define-syntax def2 (syntax-rules () ((_ a b v) (begin (define a v) (define b v)))))
         (def2 x y 9) (list x y)`,
      ),
    ).toEqual([9, 9]);
  });
  it("single define, and inside a body", async () => {
    expect(await last(`(define-syntax d (syntax-rules () ((_ a v) (define a v)))) (define (f) (d z 3) z) (f)`)).toBe(3);
  });
  it("a macro-defining macro", async () => {
    expect(
      await last(
        `(define-syntax dm (syntax-rules () ((_ n) (define-syntax n (syntax-rules () ((_) 1)))))) (dm foo) (foo)`,
      ),
    ).toBe(1);
  });
  it("a template-introduced name stays invisible outside the expansion (hygiene)", async () => {
    expect(
      await last(`(define-syntax h (syntax-rules () ((_ v) (begin (define tmp v) tmp)))) (define tmp 'mine) (h 4) tmp`),
    ).toBe("mine");
  });
});

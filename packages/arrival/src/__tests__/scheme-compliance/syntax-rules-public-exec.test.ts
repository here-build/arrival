// syntax-rules on the PUBLIC `exec` path: a template naming a builtin (`list`, `quote`,
// `if`, `lambda`, `+`) must expand and run. Hygiene renames each template identifier to a
// gensym and copies its bound value onto it; that lookup used to consult only the lexical
// scope, so on a default-capability run (builtins live in the capability base, not the scope)
// `list` came back "Unbound variable Symbol(#:list)".
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";

const last = async (src: string) => {
  const rs = (await exec(src)) as unknown[];
  return rs[rs.length - 1];
};

describe("syntax-rules templates resolve capability-base builtins", () => {
  it("list", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ a) (list a)))) (m 1)`)).toEqual([1]);
  });
  it("quote", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ a) (quote a)))) (m (x y))`)).toEqual(["x", "y"]);
  });
  it("if", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ c a b) (if c a b)))) (m #f 1 2)`)).toBe(2);
  });
  it("lambda", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ x) ((lambda (y) (+ y 1)) x)))) (m 41)`)).toBe(42);
  });
  it("+", async () => {
    expect(await last(`(define-syntax add (syntax-rules () ((_ a b) (+ a b)))) (add 2 3)`)).toBe(5);
  });
  it("a lexically shadowed name wins over the builtin", async () => {
    expect(
      await last(`
        (define-syntax m (syntax-rules () ((_ a) (list a))))
        (define (list . xs) 'shadowed)
        (m 1)`),
    ).toBe("shadowed");
  });
});

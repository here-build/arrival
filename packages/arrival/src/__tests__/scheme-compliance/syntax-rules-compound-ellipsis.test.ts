// syntax-rules: templates that repeat over a COMPOUND sub-pattern — `((n v) ...)` in the
// pattern, `n ...` / `(f n v) ...` in the template. The matcher binds each inner variable
// per repetition; the template expander must read those per-repetition cells back.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";

const last = async (src: string) => {
  const rs = (await exec(src)) as unknown[];
  return rs[rs.length - 1];
};

describe("syntax-rules compound-ellipsis template expansion", () => {
  it("my-let: ((n v) ...) body -> ((lambda (n ...) body) v ...)", async () => {
    expect(
      await last(`
        (define-syntax my-let
          (syntax-rules ()
            ((_ ((n v) ...) body) ((lambda (n ...) body) v ...))))
        (my-let ((a 1) (b 2)) (+ a b))`),
    ).toBe(3);
  });

  it("(a b) ... -> (f a b) ...", async () => {
    expect(
      await last(`
        (define (f x y) (+ x y))
        (define-syntax m (syntax-rules () ((_ (a b) ...) (list (f a b) ...))))
        (m (1 2) (3 4))`),
    ).toEqual([3, 7]);
  });

  it("((n v) ...) -> (f n ...) with a separate (f v ...)", async () => {
    expect(
      await last(`
        (define-syntax m (syntax-rules () ((_ ((n v) ...)) (list (list 'n ...) (list v ...)))))
        (m ((a 1) (b 2)))`),
    ).toEqual([
      ["a", "b"],
      [1, 2],
    ]);
  });
});

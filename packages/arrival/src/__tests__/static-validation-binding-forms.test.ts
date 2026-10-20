// static-validation-binding-forms — differential: every program here is valid at runtime, so
// `staticValidation: "on"` must neither reject it as unbound nor change its value.
// Binder shapes mirror the evaluator's `normalizeBindings`; body-define shapes mirror walkBody.

import { describe, expect, it } from "vitest";
import { exec } from "../index.js";

const CASES: ReadonlyArray<readonly [string, string, unknown]> = [
  ["bracket whole-list let", "(let [a 1] a)", 1],
  ["bracket whole-list let, two bindings", "(let [a 1 b 2] (+ a b))", 3],
  ["paren list of bracket entries", "(let ([a 1]) a)", 1],
  ["bracket whole-list let*", "(let* [a 1 b a] b)", 1],
  ["bracket whole-list letrec", "(letrec [f (lambda () 1)] (f))", 1],
  ["named let with bracket entries", "(let loop ([i 0]) (if (< i 3) (loop (+ i 1)) i))", 3],
  ["named let with bracket whole-list", "(let loop [i 0] (if (< i 3) (loop (+ i 1)) i))", 3],
  ["do with bracket entries", "(do ([i 0 (+ i 1)]) ((= i 3) i))", 3],
  ["case clause =>", "(let ((f (lambda (x) (* x 2)))) (case 1 ((1) => f)))", 2],
  ["case else =>", "(let ((f (lambda (x) (* x 2)))) (case 5 (else => f)))", 10],
  ["cond clause =>", "(let ((f (lambda (x) (* x 2)))) (cond (4 => f)))", 8],
  ["define inside nested begin", "(let () (begin (define z 1)) z)", 1],
  ["define in when body", "(when #t (define y 1) y)", 1],
  ["define in unless body", "(unless #f (define y 1) y)", 1],
  ["define in cond clause body", "(cond (#t (define y 1) y))", 1],
  ["define in case clause body", "(case 1 ((1) (define y 1) y))", 1],
];

describe("staticValidation: binder and body shapes the evaluator accepts", () => {
  for (const [name, program, expected] of CASES) {
    it(name, async () => {
      const [off] = await exec(program, { staticValidation: "off" });
      const [on] = await exec(program, { staticValidation: "on" });
      expect(off).toBe(expected);
      expect(on).toBe(expected);
    });
  }

  it("a genuinely unbound name inside a bracket binding still reports", async () => {
    await expect(exec("(let [a nope] a)", { staticValidation: "on" })).rejects.toThrow(/nope/);
  });

  it("set! is a door (not a special form): validation reports it before anything runs", async () => {
    await expect(exec("(define x 1) (set! x 2) x", { staticValidation: "on" })).rejects.toThrow(
      /Static validation.*set!.*not available/s,
    );
  });
});

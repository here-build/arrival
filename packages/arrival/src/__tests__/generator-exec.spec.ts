/**
 * Tests for the generator-exec entry point
 *
 * Verifies that the generator-based evaluator works correctly when
 * wired to the LIPS parser.
 */

import { describe, expect, it } from "vitest";
import { theVoid } from "../values/primitives/AVoid.js";
import { execExpr, execState, parse, type ExecOptions } from "../eval/generator-exec.js";
import { ABool } from "../values/primitives/ABool.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact } from "../values/primitives/AExact.js";
import { APair } from "../values/primitives/APair.js";
import { AString } from "../values/primitives/AString.js";
import { nil } from "../values/primitives/ANil.js";
import { freshEnv } from "./_fresh-env.js";
import type { SchemeValue } from "../values/types.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue } from "../env/AmbientRuntime.js";

// This whole file exercises the EVALUATOR's correctness (arithmetic, special forms,
// macros, …) through box-shaped assertions (`toBeInstanceOf`, `.num`, `.__name__`) —
// a boxed-state concern (RULINGS.md R1), not the SIMPLE-tier `exec`'s plain-JS exit.
// Local `exec` shadows the barrel export with the COMPLEX tier (execState), so every
// call site below is unchanged and still reads the boxed SchemeValue[] it always did.
async function exec(code: string, options?: ExecOptions): Promise<SchemeValue[]> {
  return (await execState(code, options)).values.slice();
}

describe("generator-exec", () => {
  describe("exec() - basic operations", () => {
    // INVARIANT: string-source arithmetic evaluates through the full parser+evaluator pipeline
    it("should evaluate simple arithmetic", async () => {
      const [result] = await exec("(+ 1 2 3)");
      expect(result).toBeInstanceOf(AExact);
      expect((result as AExact).num).toBe(6);
    });

    // INVARIANT: multiple top-level expressions each produce one result, in order
    it("should evaluate multiple expressions and return all results", async () => {
      const results = await exec("1 2 3");
      expect(results).toHaveLength(3);
      expect((results[0] as AExact).num).toBe(1);
      expect((results[1] as AExact).num).toBe(2);
      expect((results[2] as AExact).num).toBe(3);
    });

    // INVARIANT: define binds a value (returning void) and later top-level forms see the binding
    it("should handle define and use defined values", async () => {
      const results = await exec("(define x 42) (+ x 8)");
      expect(results).toHaveLength(2);
      // define returns the void value (unspecified)
      expect(results[0]).toBe(theVoid);
      // x + 8 = 50
      expect((results[1] as AExact).num).toBe(50);
    });

    // INVARIANT: lambdas parsed from string source evaluate/apply correctly
    it("should evaluate lambdas", async () => {
      const [result] = await exec("((lambda (x) (+ x 1)) 5)");
      expect((result as AExact).num).toBe(6);
    });

    // INVARIANT: nested arithmetic expressions compose correctly from string source
    it("should handle nested expressions", async () => {
      const [result] = await exec("(+ (* 2 3) (- 10 4))");
      // 2*3 + (10-4) = 6 + 6 = 12
      expect((result as AExact).num).toBe(12);
    });
  });

  describe("exec() - special forms", () => {
    // INVARIANT: if from string source selects the correct branch for both #t and #f
    it("should handle if expressions", async () => {
      const [result1] = await exec("(if #t 1 2)");
      expect((result1 as AExact).num).toBe(1);

      const [result2] = await exec("(if #f 1 2)");
      expect((result2 as AExact).num).toBe(2);
    });

    // INVARIANT: let bindings from string source resolve correctly
    it("should handle let bindings", async () => {
      const [result] = await exec("(let ((x 3) (y 4)) (+ x y))");
      expect((result as AExact).num).toBe(7);
    });

    // INVARIANT: let* sequential bindings from string source resolve correctly
    it("should handle let* bindings", async () => {
      const [result] = await exec("(let* ((x 3) (y (+ x 1))) (+ x y))");
      // x=3, y=4, x+y=7
      expect((result as AExact).num).toBe(7);
    });

    // INVARIANT: letrec supports recursive definition (factorial) from string source
    it("should handle letrec for recursion", async () => {
      const [result] = await exec(`
        (letrec ((fact (lambda (n)
                         (if (< n 2)
                             1
                             (* n (fact (- n 1)))))))
          (fact 5))
      `);
      expect((result as AExact).num).toBe(120);
    });

    // INVARIANT: begin sequencing from string source returns the last value
    it("should handle begin", async () => {
      const [result] = await exec("(begin 1 2 3)");
      expect((result as AExact).num).toBe(3);
    });

    // INVARIANT: and/or short-circuit and value semantics hold from string source
    it("should handle and/or", async () => {
      const [and1] = await exec("(and #t #t)");
      expect((and1 as ABool).valueOf()).toBe(true);

      const [and2] = await exec("(and #t #f)");
      expect((and2 as ABool).valueOf()).toBe(false);

      const [or1] = await exec("(or #f #t)");
      expect((or1 as ABool).valueOf()).toBe(true);

      const [or2] = await exec("(or #f #f)");
      expect((or2 as ABool).valueOf()).toBe(false);
    });

    // INVARIANT: cond with else from string source selects the matching clause
    it("should handle cond", async () => {
      const [result] = await exec(`
        (cond
          (#f 1)
          (#t 2)
          (else 3))
      `);
      expect((result as AExact).num).toBe(2);
    });

    // INVARIANT: case dispatch from string source selects the matching clause
    it("should handle case", async () => {
      const [result] = await exec(`
        (case 2
          ((1) 'one)
          ((2) 'two)
          (else 'other))
      `);
      expect(result).toBeInstanceOf(ASymbol);
      expect((result as ASymbol).__name__).toBe("two");
    });
  });

  describe("exec() - data structures", () => {
    // INVARIANT: quote from string source produces pair structure, not evaluated
    it("should handle quote", async () => {
      const [result] = await exec("'(1 2 3)");
      expect(result).toBeInstanceOf(APair);
    });

    // INVARIANT: quasiquote+unquote inside a let produces the correctly spliced list
    it("should handle quasiquote with unquote", async () => {
      const [result] = await exec("(let ((x 42)) `(a ,x c))");
      expect(result).toBeInstanceOf(APair);
      const list = result as APair<ASymbol, APair<AExact, any>>;
      expect(list.car.__name__).toBe("a");
      expect(list.cdr.car.num).toBe(42);
    });

    // INVARIANT: cons/car/cdr operate correctly on quoted list data from string source
    it("should handle cons/car/cdr", async () => {
      const [carResult] = await exec("(car '(1 2 3))");
      expect((carResult as AExact).num).toBe(1);

      const [cdrResult] = await exec("(cdr '(1 2 3))");
      expect(cdrResult).toBeInstanceOf(APair);
    });
  });

  describe("exec() - named let", () => {
    // INVARIANT: named let performs iterative accumulation (factorial via loop) correctly
    it("should handle named let for iteration", async () => {
      const [result] = await exec(`
        (let loop ((n 5) (acc 1))
          (if (< n 2)
              acc
              (loop (- n 1) (* acc n))))
      `);
      expect((result as AExact).num).toBe(120);
    });
  });

  describe("exec() - macros", () => {
    // INVARIANT: a define-macro definition and its use can appear in the same source text
    // and expand correctly
    it("should handle define-macro", async () => {
      const [result] = await exec(`
        (begin
          (define-macro (when test . body)
            \`(if ,test (begin ,@body)))
          (when #t 1 2 3))
      `);
      expect((result as AExact).num).toBe(3);
    });
  });

  describe("exec() - do loop", () => {
    // INVARIANT: a do loop accumulates a running sum correctly across iterations
    it("should handle do loop", async () => {
      const [result] = await exec(`
        (do ((i 0 (+ i 1))
             (sum 0 (+ sum i)))
            ((>= i 5) sum))
      `);
      // sum of 0+1+2+3+4 = 10
      expect((result as AExact).num).toBe(10);
    });
  });

  describe("parse()", () => {
    // INVARIANT: parse() returns parsed forms without evaluating them
    it("should parse code without evaluating", async () => {
      const parsed = await parse("(+ 1 2)");
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toBeInstanceOf(APair);
    });

    // INVARIANT: parse() returns one entry per top-level form
    it("should parse multiple expressions", async () => {
      const parsed = await parse("1 2 3");
      expect(parsed).toHaveLength(3);
    });
  });

  describe("execExpr()", () => {
    // INVARIANT: execExpr evaluates a single already-parsed expression
    it("should evaluate a single parsed expression", async () => {
      const [parsed] = await parse("(+ 1 2)");
      const result = await execExpr(parsed);
      expect((result as AExact).num).toBe(3);
    });
  });

  describe("error handling", () => {
    // INVARIANT: referencing an unbound variable throws an "Unbound variable" error
    it("should throw on unbound variable", async () => {
      await expect(exec("undefined-variable")).rejects.toThrow(/Unbound variable/);
    });

    // INVARIANT: unterminated/malformed source throws a parse error
    it("should throw on syntax error", async () => {
      await expect(exec("(+ 1")).rejects.toThrow();
    });
  });

  // REWRITE (2026-07-09 suite consolidation, [P15]):
  // renamed from "async/promise handling" / "should handle promises returned from JS
  // functions" — `async-add` here is a pure Scheme `(lambda (a b) (+ a b))`, no async fn, no
  // promise anywhere. It only tests that a lambda defined in one top-level form persists into
  // the next form's evaluation (a real, legitimate invariant) — mislabeled, not broken.
  describe("cross-form lambda persistence", () => {
    it("a lambda defined in one top-level form is callable from the next", async () => {
      const results = await exec(`
        (define async-add (lambda (a b)
          (+ a b)))
        (async-add 1 2)
      `);
      expect((results[1] as AExact).num).toBe(3);
    });
  });

  describe("try/catch/finally", () => {
    // INVARIANT: try returns the body's value when no exception is raised
    it("should handle try with successful body", async () => {
      const [result] = await exec(`
        (try
          42
          (catch (e) 0))
      `);
      expect((result as AExact).num).toBe(42);
    });

    // INVARIANT: a raised exception inside try's body is caught by its catch clause,
    // whose value is returned
    it("should catch exceptions in body", async () => {
      const [result] = await exec(`
        (try
          (raise "error!")
          (catch (e) 99))
      `);
      expect((result as AExact).num).toBe(99);
    });

    // Skip this test until we improve error object handling
    it.skip("should bind error to catch variable", async () => {
      const [result] = await exec(`
        (try
          (error #f "test error")
          (catch (e)
            (if (error-object? e)
                (error-object-message e)
                "not an error")))
      `);
      // The error message should be accessible
      expect(typeof result).toBe("string");
    });

    // Clause-execution/ordering is observed with a JS-side log (the same NO-scheme-set!
    // technique arrival's chibi-harness uses): each clause calls a bound `log` function,
    // so the order lives in JS, not in a mutated guest binding (set! is doored under the
    // purity invariant). Pure dataflow from the guest — it just calls a function.
    // INVARIANT: try's finally clause runs after a successful body, after the body
    it("should run finally clause after success", async () => {
      const log: string[] = [];
      const env = await freshEnv();
      bindValue(env, "log", (tag: AString) => {
        log.push(String(tag.valueOf()));
        return nil;
      });
      await exec(
        `(try
           (log "body")
           (finally (log "finally")))`,
        { env },
      );
      // body runs, then finally runs after it
      expect(log).toEqual(["body", "finally"]);
    });

    // INVARIANT: try's finally clause runs after catch handles a raised exception,
    // in body→catch→finally order
    it("should run finally clause after catch", async () => {
      const log: string[] = [];
      const env = await freshEnv();
      bindValue(env, "log", (tag: AString) => {
        log.push(String(tag.valueOf()));
        return nil;
      });
      await exec(
        `(try
           (begin (log "body") (raise "error"))
           (catch (e) (log "catch"))
           (finally (log "finally")))`,
        { env },
      );
      // body runs and raises, catch handles it, finally runs last — in order
      expect(log).toEqual(["body", "catch", "finally"]);
    });
  });

  describe("guard (R7RS exception handling)", () => {
    // INVARIANT: guard's matching clause (#t) catches a raised exception and returns
    // the clause's value
    it("should handle guard with matching clause", async () => {
      const [result] = await exec(`
        (guard (exn
          (#t 42))
          (raise "error"))
      `);
      expect((result as AExact).num).toBe(42);
    });

    // INVARIANT: guard returns the body's value unchanged when no exception is raised
    it("should return body value when no exception", async () => {
      const [result] = await exec(`
        (guard (exn
          (#t 0))
          (+ 1 2))
      `);
      expect((result as AExact).num).toBe(3);
    });

    // Skip until error-object? works correctly with generator evaluator
    it.skip("should match specific error conditions", async () => {
      const [result] = await exec(`
        (guard (exn
          ((error-object? exn) (error-object-message exn))
          (else "unknown"))
          (error #f "specific error"))
      `);
      expect(result).toBe("specific error");
    });
  });

  // Skip parameterize tests for now - requires make-parameter macro support
  describe.skip("parameterize", () => {
    it("should create and use parameters", async () => {
      const results = await exec(`
        (define my-param (make-parameter 10))
        (my-param)
      `);
      // my-param returns 10
      expect((results[1] as AExact).num).toBe(10);
    });

    it("should allow parameterize to rebind values", async () => {
      const results = await exec(`
        (define my-param (make-parameter 10))
        (parameterize ((my-param 42))
          (my-param))
      `);
      // Inside parameterize, my-param returns 42
      expect((results[1] as AExact).num).toBe(42);
    });

    it("should restore parameter values after parameterize", async () => {
      const results = await exec(`
        (define my-param (make-parameter 10))
        (parameterize ((my-param 42))
          (my-param))
        (my-param)
      `);
      // After parameterize, my-param returns 10 again
      expect((results[1] as AExact).num).toBe(42);
      expect((results[2] as AExact).num).toBe(10);
    });
  });
});

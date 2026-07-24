/**
 * Tests for the generator-based evaluator using real LIPS types
 */

import { beforeEach, describe, expect, it } from "vitest";
import { theVoid } from "../../values/primitives/AVoid.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { ResolvingAmbient, mintResolvingFrame } from "../../env/AmbientRuntime.js";
import run from "../../eval/evaluator.js";
// `execExpr` is the COMPLEX-tier form-at-a-time entry (SchemeValue in, boxed
// SchemeValue out, never unwrapped) — the direct replacement for the retired
// evaluator-internal `exec` wrapper this spec used to import (byte-identical
// glass-env behavior; see RULINGS.md R1).
//
// String-based exec with the full default env (provides `=`, `-`, etc.) — used
// only by the tail-call optimization test, which exercises the trampoline's
// cross-`run()` recursion shape and needs real `if`/`=`/`-` rather than the
// minimal hand-rolled `env` above.
import { execExprOverFrame, exec as execSource } from "../../eval/generator-exec.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { schemeTrue, schemeFalse } from "../../values/primitives/ABool.js";
import { AString } from "../../values/primitives/AString.js";
import { APair } from "../../values/primitives/APair.js";
import { nil } from "../../values/primitives/ANil.js";
import { ALambda, hostFnToCallable } from "../../values/primitives/ACallable.js";
import { ANativeProcedure } from "../../values/primitives/ANativeProcedure.js";
import { EMPTY_PROVENANCE } from "../../values/primitives/AValue.js";
import { type SchemeValue } from "../../values/types.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue } from "../../env/AmbientRuntime.js";

describe("Generator Evaluator with Real LIPS Types", () => {
  // `ResolvingAmbient`, not the plain `AmbientRuntime` its raw evaluator-level content
  // would otherwise need: `execExprOverFrame(code, { env })` types `env` as `SchemeEnv` (V2,
  // arrival-environment-privatization.md §II.3/D2), which `ResolvingAmbient`
  // structurally satisfies and plain `AmbientRuntime` does not — a byte-identical stand-in
  // here (no resolver ever registered), see the file header for why this test builds a
  // hand-rolled env instead of the default base.
  let env: ResolvingAmbient;

  beforeEach(() => {
    // Create a minimal environment with basic operations
    // Note: SchemeExact has num/denom (for rationals), not value
    // RE-PINNED (one-number rework, RATIO — docs/design-history/arrival-one-number-rework.md
    // §2.1): AExact's payload is a safe-int `number` now, not `bigint` — this hand-rolled test
    // env's arithmetic helpers ported bigint accumulators/comparisons to plain number ones
    // (`0`→`0`, `BigInt(...)`→direct number use, the dead `typeof arg === "bigint"` arm
    // dropped since a raw host bigint is now an opaque pass-through the interpreter never
    // hands this test helper — §2.3).
    env = mintResolvingFrame("test-env", {
      "+": (...args: unknown[]) => {
        let result = 0;
        let hasInexact = false;
        for (const arg of args) {
          if (arg instanceof AExact) {
            result += arg.num;
          } else if (arg instanceof AInexact) {
            hasInexact = true;
            result += Math.floor(arg.real);
          } else if (typeof arg === "number") {
            hasInexact = true;
            result += Math.floor(arg);
          }
        }
        return hasInexact ? new AInexact(result) : new AExact(result);
      },
      "-": (...args: unknown[]) => {
        if (args.length === 0) return new AExact(0);
        let result = args[0] instanceof AExact ? args[0].num : (args[0] as number);
        if (args.length === 1) return new AExact(-result);
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          result -= arg instanceof AExact ? arg.num : (arg as number);
        }
        return new AExact(result);
      },
      "*": (...args: unknown[]) => {
        let result = 1;
        for (const arg of args) {
          result *= arg instanceof AExact ? arg.num : (arg as number);
        }
        return new AExact(result);
      },
      "/": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : (a as number);
        const bVal = b instanceof AExact ? b.num : (b as number);
        return new AInexact(aVal / bVal);
      },
      "<": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : (a as number);
        const bVal = b instanceof AExact ? b.num : (b as number);
        return aVal < bVal;
      },
      ">": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : (a as number);
        const bVal = b instanceof AExact ? b.num : (b as number);
        return aVal > bVal;
      },
      "<=": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : (a as number);
        const bVal = b instanceof AExact ? b.num : (b as number);
        return aVal <= bVal;
      },
      ">=": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : (a as number);
        const bVal = b instanceof AExact ? b.num : (b as number);
        return aVal >= bVal;
      },
      "=": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : (a as number);
        const bVal = b instanceof AExact ? b.num : (b as number);
        return aVal === bVal;
      },
      list: (...args: SchemeValue[]) => APair.fromArray(CONSTANT_CTX, args, false),
      car: (pair: APair<any, any>) => pair.car,
      cdr: (pair: APair<any, any>) => pair.cdr,
      cons: (a: SchemeValue, b: SchemeValue) => new APair(a, b),
      "null?": (x: unknown) => x === nil || (x !== null && typeof x === "object" && (x as ANil).toString?.() === "()"),
      not: (x: unknown) => x === false || x === nil,
      "#t": schemeTrue,
      "#f": schemeFalse });
  });

  describe("run() trampoline", () => {
    // INVARIANT: run() drives a bare generator to completion and returns its final return value
    it("should run a simple generator to completion", async () => {
      function* simple() {
        yield 1;
        yield 2;
        return 3;
      }
      const result = await run(simple());
      expect(result).toBe(3);
    });

    // INVARIANT: run() awaits a yielded Promise and resumes with its resolved value
    it("should await yielded promises", async () => {
      function* withPromise() {
        const a = yield Promise.resolve(10);
        const b = yield Promise.resolve(20);
        return (a as number) + (b as number);
      }
      const result = await run(withPromise());
      expect(result).toBe(30);
    });

    // INVARIANT: run() rejects when a yielded promise rejects, propagating the error
    it("should handle errors from promises", async () => {
      function* withError() {
        yield Promise.reject(new Error("test error"));
        return "should not reach";
      }
      await expect(run(withError())).rejects.toThrow("test error");
    });
  });

  describe("evaluate()", () => {
    // INVARIANT: self-evaluating atoms (exact number, string, nil) evaluate to themselves
    it("should evaluate atoms to themselves", async () => {
      expect(await execExprOverFrame(new AExact(42), { env })).toEqual(new AExact(42));
      const hello = new AString("hello");
      expect(await execExprOverFrame(hello, { env })).toBe(hello);
      expect(await execExprOverFrame(nil, { env })).toBe(nil);
    });

    // INVARIANT: symbol evaluation looks up the value bound in the environment
    it("should look up symbols in environment", async () => {
      bindValue(env, "x", new AExact(10));
      bindValue(env, "y", new AExact(20));
      expect(await execExprOverFrame(new ASymbol("x"), { env })).toEqual(new AExact(10));
      expect(await execExprOverFrame(new ASymbol("y"), { env })).toEqual(new AExact(20));
    });

    // INVARIANT: a function-call form evaluates operator and operands, then applies
    it("should evaluate simple function calls", async () => {
      // (+ 1 2 3)
      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2), new AExact(3)], false);
      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(6));
    });

    // INVARIANT: nested function calls evaluate inside-out
    it("should evaluate nested function calls", async () => {
      // (+ (* 2 3) (* 4 5))
      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), APair.fromArray(CONSTANT_CTX, [new ASymbol("*"), new AExact(2), new AExact(3)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("*"), new AExact(4), new AExact(5)], false)], false);
      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(26)); // 6 + 20
    });

    // INVARIANT: a host-fn-as-callable (hostFnToCallable → ARosettaProcedure) that returns a
    // promise is awaited and its result boxes through the reverse membrane.
    // W8: bare env-resident host fns are doored; mint via hostFnToCallable.
    it("should handle JS functions that return promises", async () => {
      bindValue(
        env,
        "async-add",
        hostFnToCallable(
          CONSTANT_CTX,
          async (a: unknown, b: unknown) => {
            await new Promise((r) => setTimeout(r, 1));
            return (a as number) + (b as number);
          },
          EMPTY_PROVENANCE,
        ),
      );

      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("async-add"), new AExact(10), new AExact(20)], false);
      const result = await execExprOverFrame(code, { env });
      expect((result as AExact)["arrival/toJS"]()).toBe(30);
    });
  });

  describe("special forms", () => {
    describe("quote", () => {
      // INVARIANT: (quote x) returns its argument unevaluated, structure intact
      it("should return its argument unevaluated", async () => {
        // (quote (1 2 3))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)], false)], false);
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(1));
        expect((result.cdr as APair<any, any>).car).toEqual(new AExact(2));
      });

      // INVARIANT: (quote symbol) returns the symbol itself, not its bound value
      it("should quote a symbol", async () => {
        // (quote x)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("x")], false);
        const result = (await execExprOverFrame(code, { env })) as ASymbol;
        expect(result.__name__).toBe("x");
      });
    });

    describe("quasiquote", () => {
      // INVARIANT: a quasiquoted list with no unquotes returns unevaluated, like quote
      it("should return simple list unevaluated", async () => {
        // `(1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("quasiquote"), APair.fromArray(CONSTANT_CTX, [new AExact(1), new AExact(2), new AExact(3)], false)], false);
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(1));
      });

      // INVARIANT: (unquote expr) inside quasiquote evaluates expr and splices the value in place
      it("should evaluate unquoted expressions", async () => {
        // `(1 ,(+ 1 1) 3)
        bindValue(env, "x", new AExact(10));
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("quasiquote"), APair.fromArray(CONSTANT_CTX, [new AExact(1), APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote"), new ASymbol("x")], false), new AExact(3)], false)], false);
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(1));
        expect((result.cdr as APair<any, any>).car).toEqual(new AExact(10));
        expect(((result.cdr as APair<any, any>).cdr as APair<any, any>).car).toEqual(new AExact(3));
      });

      // INVARIANT: (unquote-splicing expr) evaluates expr to a list and splices its
      // elements into the surrounding list
      it("should handle unquote-splicing", async () => {
        // `(1 ,@(list 2 3) 4)
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("quasiquote"),
          APair.fromArray(CONSTANT_CTX, [new AExact(1), APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote-splicing"), APair.fromArray(CONSTANT_CTX, [new ASymbol("list"), new AExact(2), new AExact(3)], false)], false), new AExact(4)], false),
        ], false);
        const result = await execExprOverFrame(code, { env });
        const arr = (result as APair<any, any>).to_array();
        expect(arr.length).toBe(4);
      });
    });

    describe("if", () => {
      // [P15 redundancy] DELETED (2026-07-08 invariant-verdict sweep):
      // "then branch when true" /
      // "else branch when false" point-duplicated generator-exec.spec.ts's own
      // "should handle if expressions" (which asserts both branches already). Kept the
      // if-without-else, nil-truthy, and nested-if cases below (evaluator-only content).
      // INVARIANT: if treats '() (nil) as truthy — only #f is false
      it("should evaluate then branch when condition is nil (Scheme: only #f is false)", async () => {
        // (if () 1 2) - in R7RS Scheme, only #f is false, () is truthy
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), nil, new AExact(1), new AExact(2)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(1));
      });

      // INVARIANT: if with no else-branch returns the unspecified/void value when the test is false
      it("should return undefined when no else branch and condition is false", async () => {
        // (if #f 1)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), schemeFalse, new AExact(1)], false);
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });

      // INVARIANT: nested if expressions select the correct branch at each level
      it("should evaluate nested if expressions", async () => {
        // (if (< 1 2) (if (> 3 2) 100 200) 300)
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("if"),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("<"), new AExact(1), new AExact(2)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), APair.fromArray(CONSTANT_CTX, [new ASymbol(">"), new AExact(3), new AExact(2)], false), new AExact(100), new AExact(200)], false),
          new AExact(300),
        ], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(100));
      });
    });

    describe("begin", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if above): "expressions in
      // order, return last value" point-duplicated generator-exec.spec.ts's own
      // "should handle begin" test. Kept empty-begin (evaluator-only) and side-effects
      // (verifies execution ORDER/count, not just the return value — distinct point).
      // INVARIANT: an empty begin returns the unspecified/void value
      it("should return undefined for empty begin", async () => {
        // (begin)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("begin")], false);
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });

      // INVARIANT: begin executes every expression for its side effects, in sequence
      it("should execute side effects", async () => {
        let sideEffect = 0;
        bindValue(
          env,
          "inc!",
          new ANativeProcedure({
            name: "inc!",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              sideEffect++;
              return new AExact(sideEffect);
            } }),
        );

        // (begin (inc!) (inc!) (inc!))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("begin"), APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false)], false);
        const result = await execExprOverFrame(code, { env });
        expect(result).toEqual(new AExact(3));
        expect(sideEffect).toBe(3);
      });
    });

    describe("define", () => {
      // INVARIANT: (define x v) evaluates v and binds it in the environment (pins
      // implementation, not behavior)
      it("should define a simple variable", async () => {
        // (define x 42)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("define"), new ASymbol("x"), new AExact(42)], false);
        await execExprOverFrame(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(new AExact(42));
      });

      // INVARIANT: define evaluates the value expression before binding (not the literal
      // form) (pins implementation, not behavior)
      it("should evaluate the value expression", async () => {
        // (define x (+ 1 2))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("define"), new ASymbol("x"), APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2)], false)], false);
        await execExprOverFrame(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(new AExact(3));
      });

      // INVARIANT: (define (f args) body) shorthand defines f as a callable ALambda
      // carrying that name
      it("should define a function with shorthand syntax", async () => {
        // (define (add a b) (+ a b))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("define"), APair.fromArray(CONSTANT_CTX, [new ASymbol("add"), new ASymbol("a"), new ASymbol("b")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("a"), new ASymbol("b")], false)], false);
        await execExprOverFrame(code, { env });
        const add = env._lookupWithResolvers("add");
        // Scheme lambdas are ALambda values (callable-as-value) carrying a mutable __name__.
        expect(add).toBeInstanceOf(ALambda);
        expect((add as { __name__?: string }).__name__).toBe("add");
      });
    });

    // set! removed — lexical variable rebinding is doored under the purity invariant
    // (r7rs/binding); arrival is pure dataflow, so there is no rebind form to test.

    describe("lambda", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if/begin above): "create a
      // callable function" / "execute with arguments" point-duplicated generator-exec.spec.ts's
      // own "should evaluate lambdas" (basic `((lambda (x) ...) ...)` call). Kept
      // closures and rest-params below (evaluator-only content, not covered by the
      // single generator-exec lambda test).
      // INVARIANT: a lambda closes over its defining environment
      it("should capture closure environment", async () => {
        // (define a 10)
        // ((lambda (x) (+ a x)) 5)
        await execExprOverFrame(APair.fromArray(CONSTANT_CTX, [new ASymbol("define"), new ASymbol("a"), new AExact(10)], false), { env });
        const code = APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol("lambda"), APair.fromArray(CONSTANT_CTX, [new ASymbol("x")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("a"), new ASymbol("x")], false)], false), new AExact(5)], false);
        const result = await execExprOverFrame(code, { env });
        expect(result).toEqual(new AExact(15));
      });

      // INVARIANT: a symbol (non-list) parameter spec binds all arguments as a
      // rest-parameter list
      it("should handle rest parameters", async () => {
        // ((lambda args args) 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol("lambda"), new ASymbol("args"), new ASymbol("args")], false), new AExact(1), new AExact(2), new AExact(3)], false);
        const result = (await execExprOverFrame(code, { env })) as APair<any, any>;
        expect(result.to_array()).toEqual([new AExact(1), new AExact(2), new AExact(3)]);
      });
    });

    describe("let", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if/begin/lambda above):
      // "bind variables in body" point-duplicated generator-exec.spec.ts's own
      // "should handle let bindings"; "named let for loops" point-duplicated
      // generator-exec.spec.ts's dedicated "execExprOverFrame() - named let" describe (same
      // factorial-via-accumulator pattern). Kept parallel-binding-semantics (a
      // distinct scoping/shadowing invariant not covered by either).
      // INVARIANT: let uses parallel binding semantics — an init expression cannot
      // see sibling bindings
      it("should use parallel binding semantics", async () => {
        // (let ((x 1) (y x)) y) - should fail because x isn't bound yet
        bindValue(env, "x", new AExact(100));
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("let"), APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol("x"), new AExact(1)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("y"), new ASymbol("x")], false)], false), new ASymbol("y")], false);
        // y should be 100 (outer x), not 1 (inner x)
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(100));
      });
    });

    // [P15 redundancy] let*'s sole test ("bind variables sequentially") and letrec's sole
    // test ("allow recursive bindings") DELETED (same sweep/rationale as above) — both
    // point-duplicated generator-exec.spec.ts's own "should handle let* bindings" /
    // "should handle letrec for recursion" (both compute a small factorial). The
    // describe blocks are removed with them (zero surviving evaluator-only content).

    describe("and", () => {
      // INVARIANT: (and) with no operands returns #t
      it("should return true for empty and", async () => {
        // (and) ⇒ #t (R7RS §6.3): the boxed schemeTrue singleton IS the Scheme #t.
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("and")], false);
        expect(await execExprOverFrame(code, { env })).toBe(schemeTrue);
      });

      // INVARIANT: and short-circuits on the first #f without evaluating the rest
      it("should short-circuit on false", async () => {
        let called = false;
        bindValue(
          env,
          "side-effect",
          new ANativeProcedure({
            name: "side-effect",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              called = true;
              return schemeTrue;
            } }),
        );
        // (and #f (side-effect))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("and"), schemeFalse, APair.fromArray(CONSTANT_CTX, [new ASymbol("side-effect")], false)], false);
        expect(await execExprOverFrame(code, { env })).toBe(schemeFalse);
        expect(called).toBe(false);
      });

      // INVARIANT: and returns the value of its last operand when all are true
      it("should return last value if all true", async () => {
        // (and 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("and"), new AExact(1), new AExact(2), new AExact(3)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });
    });

    describe("or", () => {
      // INVARIANT: (or) with no operands returns #f
      it("should return false for empty or", async () => {
        // (or) ⇒ #f (R7RS §6.3): the boxed schemeFalse singleton IS the Scheme #f.
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("or")], false);
        expect(await execExprOverFrame(code, { env })).toBe(schemeFalse);
      });

      // INVARIANT: or short-circuits on the first truthy value without evaluating the rest
      it("should short-circuit on true", async () => {
        let called = false;
        bindValue(
          env,
          "side-effect",
          new ANativeProcedure({
            name: "side-effect",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              called = true;
              return schemeFalse;
            } }),
        );
        // (or 1 (side-effect))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("or"), new AExact(1), APair.fromArray(CONSTANT_CTX, [new ASymbol("side-effect")], false)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(1));
        expect(called).toBe(false);
      });

      // INVARIANT: or returns the value of its last operand when all are false (0 is truthy)
      it("should return last value if all false", async () => {
        // (or #f #f 0) - 0 is truthy in Scheme
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("or"), schemeFalse, schemeFalse, new AExact(0)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(0));
      });
    });

    describe("cond", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if/begin/lambda/let above):
      // "evaluate matching clause" point-duplicated generator-exec.spec.ts's own
      // "should handle cond" (also selects a truthy clause over a false one, falling
      // through to else). Kept else-clause, no-expressions, and => (evaluator-only
      // content — none of these edge cases are exercised by the single generator-exec
      // cond test).
      // INVARIANT: cond evaluates the else clause when no test matches
      it("should evaluate else clause when nothing matches", async () => {
        // (cond ((> 1 2) 'no) (else 'yes))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("cond"),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(">"), new AExact(1), new AExact(2)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("no")], false)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("else"), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("yes")], false)], false),
        ], false);
        const result = (await execExprOverFrame(code, { env })) as ASymbol;
        expect(result.__name__).toBe("yes");
      });

      // INVARIANT: a clause with only a test (no body) returns the test's value
      it("should return test value when no expressions", async () => {
        // (cond (5)) => 5
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("cond"), APair.fromArray(CONSTANT_CTX, [new AExact(5)], false)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(5));
      });

      // INVARIANT: (test => proc) applies proc to the test's value when the test is truthy.
      // W8: hostFnToCallable mints ARosettaProcedure (scheme args → JS, result boxes back).
      it("should handle => syntax", async () => {
        // (cond ((+ 1 2) => double))
        bindValue(
          env,
          "double",
          hostFnToCallable(CONSTANT_CTX, (x: unknown) => (x as number) * 2, EMPTY_PROVENANCE),
        );
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("cond"), APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2)], false), new ASymbol("=>"), new ASymbol("double")], false)], false);
        expect(((await execExprOverFrame(code, { env })) as AExact)["arrival/toJS"]()).toBe(6);
      });
    });

    describe("case", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as cond above): "match datum"
      // point-duplicated generator-exec.spec.ts's own "should handle case" (matches
      // datum 2 → 'two, identical shape). Kept "else when no match" (a distinct edge
      // case — the generator-exec case test never exercises its own else branch, since
      // its datum always matches a listed clause).
      // INVARIANT: case falls back to else when no datum list matches
      it("should use else when no match", async () => {
        // (case 5 ((1) 'one) ((2) 'two) (else 'other))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("case"),
          new AExact(5),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new AExact(1)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("one")], false)], false),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new AExact(2)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("two")], false)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("else"), APair.fromArray(CONSTANT_CTX, [new ASymbol("quote"), new ASymbol("other")], false)], false),
        ], false);
        const result = (await execExprOverFrame(code, { env })) as ASymbol;
        expect(result.__name__).toBe("other");
      });
    });

    describe("when", () => {
      // INVARIANT: when executes its body and returns the last value when the test is true
      it("should execute body when test is true", async () => {
        // (when #t 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("when"), schemeTrue, new AExact(1), new AExact(2), new AExact(3)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });

      // INVARIANT: when returns the unspecified/void value when the test is false
      it("should return undefined when test is false", async () => {
        // (when #f 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("when"), schemeFalse, new AExact(1), new AExact(2), new AExact(3)], false);
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });
    });

    describe("unless", () => {
      // INVARIANT: unless executes its body and returns the last value when the test is false
      it("should execute body when test is false", async () => {
        // (unless #f 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("unless"), schemeFalse, new AExact(1), new AExact(2), new AExact(3)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });

      // INVARIANT: unless returns the unspecified/void value when the test is true
      it("should return undefined when test is true", async () => {
        // (unless #t 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("unless"), schemeTrue, new AExact(1), new AExact(2), new AExact(3)], false);
        expect(await execExprOverFrame(code, { env })).toBe(theVoid);
      });
    });

    describe("do", () => {
      // INVARIANT: do iterates, re-evaluating step expressions, until the test clause is
      // true, then returns the result expression
      it("should iterate until test is true", async () => {
        // (do ((i 0 (+ i 1))) ((>= i 5) i))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("do"),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol("i"), new AExact(0), APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("i"), new AExact(1)], false)], false)], false),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(">="), new ASymbol("i"), new AExact(5)], false), new ASymbol("i")], false),
        ], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(5));
      });

      // INVARIANT: do executes the command body once per iteration for its side effects
      it("should execute body on each iteration", async () => {
        let count = 0;
        bindValue(
          env,
          "inc!",
          new ANativeProcedure({
            name: "inc!",
            arity: { min: 0, max: 0 },
            contract: undefined,
            impl: () => {
              count++;
              return theVoid;
            } }),
        );
        // (do ((i 0 (+ i 1))) ((>= i 3)) (inc!))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("do"),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol("i"), new AExact(0), APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new ASymbol("i"), new AExact(1)], false)], false)], false),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(">="), new ASymbol("i"), new AExact(3)], false)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol("inc!")], false),
        ], false);
        await execExprOverFrame(code, { env });
        expect(count).toBe(3);
      });
    });

    describe("define-macro", () => {
      // INVARIANT: define-macro's quasiquote/unquote-splicing template rewrites the call
      // site, and the rewritten form is then evaluated
      it("should define a simple macro", async () => {
        // (define-macro (my-when test . body) `(if ,test (begin ,@body)))
        // Then: (my-when #t 1 2 3)
        const defineMacro = APair.fromArray(CONSTANT_CTX, [
          new ASymbol("define-macro"),
          new APair(new ASymbol("my-when"), new APair(new ASymbol("test"), new ASymbol("body"))),
          APair.fromArray(CONSTANT_CTX, [
            new ASymbol("quasiquote"),
            APair.fromArray(CONSTANT_CTX, [
              new ASymbol("if"),
              APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote"), new ASymbol("test")], false),
              // (begin ,@body) = (begin (unquote-splicing body))
              APair.fromArray(CONSTANT_CTX, [new ASymbol("begin"), APair.fromArray(CONSTANT_CTX, [new ASymbol("unquote-splicing"), new ASymbol("body")], false)], false),
            ], false),
          ], false),
        ], false);
        await execExprOverFrame(defineMacro, { env });

        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol("my-when"), schemeTrue, new AExact(1), new AExact(2), new AExact(3)], false);
        expect(await execExprOverFrame(code, { env })).toEqual(new AExact(3));
      });
    });

    // NOTE: the former describe("raise/error") block was removed with audit Action 1
    // (X1): `raise`/`error` are no longer evaluator special forms — they resolve to the
    // R7RS bootstrap procedures (which walk *current-exception-handlers*). Those tests
    // asserted the old R6RS `(error who message)` arity and string-coerced `raise`
    // against a minimal env without bootstrap; correct R7RS exception coverage now lives
    // in generator-exec.spec.ts against a bootstrap-loaded env.

    // delay/force — OMITTED by the purity invariant (delayed evaluation defers a
    // value's identity to force-time, severing construction-rooted provenance).
    // Removed from the special-form table; doored in core.ts. The full door
    // surface (delay/force/make-promise/delay-force) is pinned in
    // doors/purity.law.test.ts; here we just confirm the special form is gone.
    describe("delay/force — omitted by the purity invariant", () => {
      // INVARIANT: delay is no longer a working special form — evaluating (delay …)
      // throws rather than deferring
      it("(delay …) is no longer a working special form", async () => {
        // This raw env has no bootstrap loaded, so `delay` is unbound here (the
        // teaching door — "omitted from arrival by design" — is a bootstrap macro,
        // verified at the full-env layer in doors/purity.law.test.ts). The point at
        // THIS layer: delay no longer evaluates lazily; it is gone from the
        // special-form table.
        await expect(execExprOverFrame(APair.fromArray(CONSTANT_CTX, [new ASymbol("delay"), APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(2)], false)], false), { env })).rejects.toThrow();
      });
    });
  });

  describe("performance - deep recursion", () => {
    // INVARIANT: a deeply right-nested (+ 1 (+ 1 … 0)) expression (10k levels) evaluates
    // without stack overflow
    it("should handle deep recursion without stack overflow", async () => {
      // Create a deeply nested expression: (+ 1 (+ 1 (+ 1 ... (+ 1 0)...)))
      let code: APair<any, any> | typeof nil = APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), new AExact(0)], false);

      // 10,000 levels of nesting
      for (let i = 0; i < 10000; i++) {
        code = APair.fromArray(CONSTANT_CTX, [new ASymbol("+"), new AExact(1), code], false);
      }

      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(10001));
    });

    // INVARIANT: a deeply nested if-expression chain (10k levels) evaluates without
    // stack overflow
    it("should handle deeply nested if expressions", async () => {
      // Create deeply nested ifs: (if #t (if #t (if #t ... 42 ...)))
      let code: SchemeValue = new AExact(42);

      for (let i = 0; i < 10000; i++) {
        code = APair.fromArray(CONSTANT_CTX, [new ASymbol("if"), schemeTrue, code, new AExact(0)], false);
      }

      const result = await execExprOverFrame(code, { env });
      expect(result).toEqual(new AExact(42));
    });

    it("tail recursion to 10k depth does not overflow", async () => {
      // R7RS §3.5: a self-call in tail position must run in O(1) space. This
      // is different from the nested-`+` test above — that nesting lives in a
      // single `run()` generator's stack[]. Here each `(loop (- n 1))` is a
      // FRESH lambda invocation; before TCO (task #46) each one minted a new
      // `run()` Promise the outer trampoline awaited, growing the host call
      // stack one frame per level and overflowing V8 at ~10k ("Maximum call
      // stack size exceeded"). With tail-call collapse + the bounce protocol
      // the loop iterates flat, so 10k completes cleanly.
      const [, result] = await execSource("(define (loop n) (if (= n 0) 'done (loop (- n 1)))) (loop 10000)");
      // `execSource` (generator-exec `exec`, RULINGS.md R1) is the SIMPLE-tier
      // plain-JS exit: a symbol's toJS is apostrophe-prefixed (ASymbol's
      // documented, deferred opaque-exit marker — still design-pending).
      expect(String(result)).toBe("done"); // symbol egress = plain interned name (⚖️ 2026-07-14, constitution §2.1)
    }, 15000);
  });
});

// Type for Nil
interface ANil {
  toString(): string;
}

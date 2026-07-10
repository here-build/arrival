/**
 * Tests for the generator-based evaluator using real LIPS types
 */

import { beforeEach, describe, expect, it } from "vitest";
import { theVoid } from "../values/primitives/AVoid.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { ResolvingEnvironment } from "../Environment.js";
import run from "../eval/evaluator.js";
// `execExpr` is the COMPLEX-tier form-at-a-time entry (SchemeValue in, boxed
// SchemeValue out, never unwrapped) — the direct replacement for the retired
// evaluator-internal `exec` wrapper this spec used to import (byte-identical
// glass-env behavior; see two-tier-exec-api.md §3).
//
// String-based exec with the full default env (provides `=`, `-`, etc.) — used
// only by the tail-call optimization test, which exercises the trampoline's
// cross-`run()` recursion shape and needs real `if`/`=`/`-` rather than the
// minimal hand-rolled `env` above.
import { execExpr, exec as execSource } from "../eval/generator-exec.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { schemeTrue, schemeFalse } from "../values/primitives/ABool.js";
import { AString } from "../values/primitives/AString.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { ALambda } from "../values/primitives/ACallable.js";
import { type SchemeValue } from "../values/types.js";

describe("Generator Evaluator with Real LIPS Types", () => {
  // `ResolvingEnvironment`, not the plain `Environment` its raw evaluator-level content
  // would otherwise need: `execExpr(code, { env })` types `env` as `SchemeEnv` (V2,
  // arrival-environment-privatization.md §II.3/D2), which `ResolvingEnvironment`
  // structurally satisfies and plain `Environment` does not — a byte-identical stand-in
  // here (no resolver ever registered), see the file header for why this test builds a
  // hand-rolled env instead of the default base.
  let env: ResolvingEnvironment;

  beforeEach(() => {
    // Create a minimal environment with basic operations
    // Note: SchemeExact has num/denom (for rationals), not value
    env = new ResolvingEnvironment("test-env", {
      "+": (...args: unknown[]) => {
        let result = 0n;
        let hasInexact = false;
        for (const arg of args) {
          if (arg instanceof AExact) {
            result += arg.num;
          } else if (arg instanceof AInexact) {
            hasInexact = true;
            result += BigInt(Math.floor(arg.real));
          } else if (typeof arg === "number") {
            hasInexact = true;
            result += BigInt(Math.floor(arg));
          } else if (typeof arg === "bigint") {
            result += arg;
          }
        }
        return hasInexact ? new AInexact(CONSTANT_CTX, Number(result)) : new AExact(CONSTANT_CTX, result);
      },
      "-": (...args: unknown[]) => {
        if (args.length === 0) return new AExact(CONSTANT_CTX, 0n);
        let result = args[0] instanceof AExact ? args[0].num : BigInt(args[0] as number);
        if (args.length === 1) return new AExact(CONSTANT_CTX, -result);
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          result -= arg instanceof AExact ? arg.num : BigInt(arg as number);
        }
        return new AExact(CONSTANT_CTX, result);
      },
      "*": (...args: unknown[]) => {
        let result = 1n;
        for (const arg of args) {
          result *= arg instanceof AExact ? arg.num : BigInt(arg as number);
        }
        return new AExact(CONSTANT_CTX, result);
      },
      "/": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? Number(a.num) : (a as number);
        const bVal = b instanceof AExact ? Number(b.num) : (b as number);
        return new AInexact(CONSTANT_CTX, aVal / bVal);
      },
      "<": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : BigInt(a as number);
        const bVal = b instanceof AExact ? b.num : BigInt(b as number);
        return aVal < bVal;
      },
      ">": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : BigInt(a as number);
        const bVal = b instanceof AExact ? b.num : BigInt(b as number);
        return aVal > bVal;
      },
      "<=": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : BigInt(a as number);
        const bVal = b instanceof AExact ? b.num : BigInt(b as number);
        return aVal <= bVal;
      },
      ">=": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : BigInt(a as number);
        const bVal = b instanceof AExact ? b.num : BigInt(b as number);
        return aVal >= bVal;
      },
      "=": (a: unknown, b: unknown) => {
        const aVal = a instanceof AExact ? a.num : BigInt(a as number);
        const bVal = b instanceof AExact ? b.num : BigInt(b as number);
        return aVal === bVal;
      },
      list: (...args: SchemeValue[]) => APair.fromArray(CONSTANT_CTX, args, false),
      car: (pair: APair<any, any>) => pair.car,
      cdr: (pair: APair<any, any>) => pair.cdr,
      cons: (a: SchemeValue, b: SchemeValue) => new APair(CONSTANT_CTX, a, b),
      "null?": (x: unknown) => x === nil || (x !== null && typeof x === "object" && (x as ANil).toString?.() === "()"),
      not: (x: unknown) => x === false || x === nil,
      "#t": schemeTrue,
      "#f": schemeFalse,
    });
  });

  describe("run() trampoline", () => {
    it("should run a simple generator to completion", async () => {
      function* simple() {
        yield 1;
        yield 2;
        return 3;
      }
      const result = await run(simple());
      expect(result).toBe(3);
    });

    it("should await yielded promises", async () => {
      function* withPromise() {
        const a = yield Promise.resolve(10);
        const b = yield Promise.resolve(20);
        return (a as number) + (b as number);
      }
      const result = await run(withPromise());
      expect(result).toBe(30);
    });

    it("should handle errors from promises", async () => {
      function* withError() {
        yield Promise.reject(new Error("test error"));
        return "should not reach";
      }
      await expect(run(withError())).rejects.toThrow("test error");
    });
  });

  describe("evaluate()", () => {
    it("should evaluate atoms to themselves", async () => {
      expect(await execExpr(new AExact(CONSTANT_CTX, 42n), { env })).toEqual(new AExact(CONSTANT_CTX, 42n));
      const hello = new AString(CONSTANT_CTX, "hello");
      expect(await execExpr(hello, { env })).toBe(hello);
      expect(await execExpr(nil, { env })).toBe(nil);
    });

    it("should look up symbols in environment", async () => {
      env.set("x", new AExact(CONSTANT_CTX, 10n));
      env.set("y", new AExact(CONSTANT_CTX, 20n));
      expect(await execExpr(new ASymbol(CONSTANT_CTX, "x"), { env })).toEqual(new AExact(CONSTANT_CTX, 10n));
      expect(await execExpr(new ASymbol(CONSTANT_CTX, "y"), { env })).toEqual(new AExact(CONSTANT_CTX, 20n));
    });

    it("should evaluate simple function calls", async () => {
      // (+ 1 2 3)
      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
      const result = await execExpr(code, { env });
      expect(result).toEqual(new AExact(CONSTANT_CTX, 6n));
    });

    it("should evaluate nested function calls", async () => {
      // (+ (* 2 3) (* 4 5))
      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "*"), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "*"), new AExact(CONSTANT_CTX, 4n), new AExact(CONSTANT_CTX, 5n)], false)], false);
      const result = await execExpr(code, { env });
      expect(result).toEqual(new AExact(CONSTANT_CTX, 26n)); // 6 + 20
    });

    // [RETAGGED 2026-07-09, B4 — was INVERTS: reverse-membrane/P1] `env.set("async-add", ...)`
    // binds a bare JS fn directly (bypassing EnvCapability), and `expect(result).toBe(30)`
    // asserts raw unboxed pass-through via the evaluator call-head's `Reflect.apply` fallback
    // (ACallable.ts / evaluator.ts:3125-3135, kept deliberately per
    // docs/working-proposals/reverse-membrane-for-callables.md §5 item 5 — "keep, demoted to
    // the legacy-defineRosetta compatibility path; delete with step 6"). Does NOT die with the
    // B1-B3 reverse-membrane landing (cxr pilot + capability.ts binder cut + region discipline
    // — all landed 2026-07-09): none of those steps touch bare `env.set`. Real gate: step 6
    // (`AProcedure` arm removal from `SchemeValue`), itself gated on the legacy
    // `env.defineRosetta` arm's retirement — see ledger row "defineRosetta legacy arm
    // authoring form" (gate: McpEnvCapability annotation-lifting, undone — McpEnvCapability
    // still authors every verb as a bare fn / RosettaSpec-shaped object; downstream consumers
    // confirmed live: inhuman/sift-submission/mcp/src/packs/*.ts, here.build/saas/server/{mcp,
    // arrival}, inhuman/saas/mcp).
    it("should handle JS functions that return promises", async () => {
      // With membrane, JS functions receive JS values (not SchemeExact)
      env.set("async-add", async (a: number, b: number) => {
        await new Promise((r) => setTimeout(r, 1));
        return a + b;
      });

      const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "async-add"), new AExact(CONSTANT_CTX, 10n), new AExact(CONSTANT_CTX, 20n)], false);
      const result = await execExpr(code, { env });
      // The bare-fn boxing seam (evaluator main apply arm) boxes the raw return — the
      // pre-seam raw-30 passthrough was the R1 leak, not the contract. This spec's
      // `execExpr` is the COMPLEX-tier form-at-a-time wrapper (no toJS exit), so the
      // assertion reads the BOX honestly.
      expect((result as AExact)["arrival/toJS"]()).toBe(30);
    });
  });

  describe("special forms", () => {
    describe("quote", () => {
      it("should return its argument unevaluated", async () => {
        // (quote (1 2 3))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false)], false);
        const result = (await execExpr(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(CONSTANT_CTX, 1n));
        expect((result.cdr as APair<any, any>).car).toEqual(new AExact(CONSTANT_CTX, 2n));
      });

      it("should quote a symbol", async () => {
        // (quote x)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), new ASymbol(CONSTANT_CTX, "x")], false);
        const result = (await execExpr(code, { env })) as ASymbol;
        expect(result.__name__).toBe("x");
      });
    });

    describe("quasiquote", () => {
      it("should return simple list unevaluated", async () => {
        // `(1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quasiquote"), APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false)], false);
        const result = (await execExpr(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(CONSTANT_CTX, 1n));
      });

      it("should evaluate unquoted expressions", async () => {
        // `(1 ,(+ 1 1) 3)
        env.set("x", new AExact(CONSTANT_CTX, 10n));
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quasiquote"), APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "unquote"), new ASymbol(CONSTANT_CTX, "x")], false), new AExact(CONSTANT_CTX, 3n)], false)], false);
        const result = (await execExpr(code, { env })) as APair<any, any>;
        expect(result.car).toEqual(new AExact(CONSTANT_CTX, 1n));
        expect((result.cdr as APair<any, any>).car).toEqual(new AExact(CONSTANT_CTX, 10n));
        expect(((result.cdr as APair<any, any>).cdr as APair<any, any>).car).toEqual(new AExact(CONSTANT_CTX, 3n));
      });

      it("should handle unquote-splicing", async () => {
        // `(1 ,@(list 2 3) 4)
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "quasiquote"),
          APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "unquote-splicing"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "list"), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false)], false), new AExact(CONSTANT_CTX, 4n)], false),
        ], false);
        const result = await execExpr(code, { env });
        const arr = (result as APair<any, any>).to_array();
        expect(arr.length).toBe(4);
      });
    });

    describe("if", () => {
      // [P15 redundancy] DELETED (2026-07-08 test-invariant-atlas sweep,
      // docs/test-invariant-atlas/verdicts/evaluator.md): "then branch when true" /
      // "else branch when false" point-duplicated generator-exec.spec.ts's own
      // "should handle if expressions" (which asserts both branches already). Kept the
      // if-without-else, nil-truthy, and nested-if cases below (evaluator-only content).
      it("should evaluate then branch when condition is nil (Scheme: only #f is false)", async () => {
        // (if () 1 2) - in R7RS Scheme, only #f is false, () is truthy
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "if"), nil, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 1n));
      });

      it("should return undefined when no else branch and condition is false", async () => {
        // (if #f 1)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "if"), schemeFalse, new AExact(CONSTANT_CTX, 1n)], false);
        expect(await execExpr(code, { env })).toBe(theVoid);
      });

      it("should evaluate nested if expressions", async () => {
        // (if (< 1 2) (if (> 3 2) 100 200) 300)
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "if"),
          APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "<"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "if"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, ">"), new AExact(CONSTANT_CTX, 3n), new AExact(CONSTANT_CTX, 2n)], false), new AExact(CONSTANT_CTX, 100n), new AExact(CONSTANT_CTX, 200n)], false),
          new AExact(CONSTANT_CTX, 300n),
        ], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 100n));
      });
    });

    describe("begin", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if above): "expressions in
      // order, return last value" point-duplicated generator-exec.spec.ts's own
      // "should handle begin" test. Kept empty-begin (evaluator-only) and side-effects
      // (verifies execution ORDER/count, not just the return value — distinct point).
      it("should return undefined for empty begin", async () => {
        // (begin)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "begin")], false);
        expect(await execExpr(code, { env })).toBe(theVoid);
      });

      it("should execute side effects", async () => {
        let sideEffect = 0;
        env.set("inc!", () => {
          sideEffect++;
          return new AExact(CONSTANT_CTX, BigInt(sideEffect));
        });

        // (begin (inc!) (inc!) (inc!))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "begin"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "inc!")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "inc!")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "inc!")], false)], false);
        const result = await execExpr(code, { env });
        expect(result).toEqual(new AExact(CONSTANT_CTX, 3n));
        expect(sideEffect).toBe(3);
      });
    });

    describe("define", () => {
      it("should define a simple variable", async () => {
        // (define x 42)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "define"), new ASymbol(CONSTANT_CTX, "x"), new AExact(CONSTANT_CTX, 42n)], false);
        await execExpr(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(new AExact(CONSTANT_CTX, 42n));
      });

      it("should evaluate the value expression", async () => {
        // (define x (+ 1 2))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "define"), new ASymbol(CONSTANT_CTX, "x"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)], false)], false);
        await execExpr(code, { env });
        expect(env._lookupWithResolvers("x")).toEqual(new AExact(CONSTANT_CTX, 3n));
      });

      it("should define a function with shorthand syntax", async () => {
        // (define (add a b) (+ a b))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "define"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "add"), new ASymbol(CONSTANT_CTX, "a"), new ASymbol(CONSTANT_CTX, "b")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new ASymbol(CONSTANT_CTX, "a"), new ASymbol(CONSTANT_CTX, "b")], false)], false);
        await execExpr(code, { env });
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
      it("should capture closure environment", async () => {
        // (define a 10)
        // ((lambda (x) (+ a x)) 5)
        await execExpr(APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "define"), new ASymbol(CONSTANT_CTX, "a"), new AExact(CONSTANT_CTX, 10n)], false), { env });
        const code = APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "lambda"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "x")], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new ASymbol(CONSTANT_CTX, "a"), new ASymbol(CONSTANT_CTX, "x")], false)], false), new AExact(CONSTANT_CTX, 5n)], false);
        const result = await execExpr(code, { env });
        expect(result).toEqual(new AExact(CONSTANT_CTX, 15n));
      });

      it("should handle rest parameters", async () => {
        // ((lambda args args) 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "lambda"), new ASymbol(CONSTANT_CTX, "args"), new ASymbol(CONSTANT_CTX, "args")], false), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        const result = (await execExpr(code, { env })) as APair<any, any>;
        expect(result.to_array()).toEqual([new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)]);
      });
    });

    describe("let", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if/begin/lambda above):
      // "bind variables in body" point-duplicated generator-exec.spec.ts's own
      // "should handle let bindings"; "named let for loops" point-duplicated
      // generator-exec.spec.ts's dedicated "execExpr() - named let" describe (same
      // factorial-via-accumulator pattern). Kept parallel-binding-semantics (a
      // distinct scoping/shadowing invariant not covered by either).
      it("should use parallel binding semantics", async () => {
        // (let ((x 1) (y x)) y) - should fail because x isn't bound yet
        env.set("x", new AExact(CONSTANT_CTX, 100n));
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "let"), APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "x"), new AExact(CONSTANT_CTX, 1n)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "y"), new ASymbol(CONSTANT_CTX, "x")], false)], false), new ASymbol(CONSTANT_CTX, "y")], false);
        // y should be 100 (outer x), not 1 (inner x)
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 100n));
      });
    });

    // [P15 redundancy] let*'s sole test ("bind variables sequentially") and letrec's sole
    // test ("allow recursive bindings") DELETED (same sweep/rationale as above) — both
    // point-duplicated generator-exec.spec.ts's own "should handle let* bindings" /
    // "should handle letrec for recursion" (both compute a small factorial). The
    // describe blocks are removed with them (zero surviving evaluator-only content).

    describe("and", () => {
      it("should return true for empty and", async () => {
        // (and) ⇒ #t (R7RS §6.3): the boxed schemeTrue singleton IS the Scheme #t.
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "and")], false);
        expect(await execExpr(code, { env })).toBe(schemeTrue);
      });

      it("should short-circuit on false", async () => {
        let called = false;
        env.set("side-effect", () => {
          called = true;
          return true;
        });
        // (and #f (side-effect))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "and"), schemeFalse, APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "side-effect")], false)], false);
        expect(await execExpr(code, { env })).toBe(schemeFalse);
        expect(called).toBe(false);
      });

      it("should return last value if all true", async () => {
        // (and 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "and"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 3n));
      });
    });

    describe("or", () => {
      it("should return false for empty or", async () => {
        // (or) ⇒ #f (R7RS §6.3): the boxed schemeFalse singleton IS the Scheme #f.
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "or")], false);
        expect(await execExpr(code, { env })).toBe(schemeFalse);
      });

      it("should short-circuit on true", async () => {
        let called = false;
        env.set("side-effect", () => {
          called = true;
          return false;
        });
        // (or 1 (side-effect))
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "or"), new AExact(CONSTANT_CTX, 1n), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "side-effect")], false)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 1n));
        expect(called).toBe(false);
      });

      it("should return last value if all false", async () => {
        // (or #f #f 0) - 0 is truthy in Scheme
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "or"), schemeFalse, schemeFalse, new AExact(CONSTANT_CTX, 0n)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 0n));
      });
    });

    describe("cond", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as if/begin/lambda/let above):
      // "evaluate matching clause" point-duplicated generator-exec.spec.ts's own
      // "should handle cond" (also selects a truthy clause over a false one, falling
      // through to else). Kept else-clause, no-expressions, and => (evaluator-only
      // content — none of these edge cases are exercised by the single generator-exec
      // cond test).
      it("should evaluate else clause when nothing matches", async () => {
        // (cond ((> 1 2) 'no) (else 'yes))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "cond"),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, ">"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), new ASymbol(CONSTANT_CTX, "no")], false)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "else"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), new ASymbol(CONSTANT_CTX, "yes")], false)], false),
        ], false);
        const result = (await execExpr(code, { env })) as ASymbol;
        expect(result.__name__).toBe("yes");
      });

      it("should return test value when no expressions", async () => {
        // (cond (5)) => 5
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "cond"), APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 5n)], false)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 5n));
      });

      // [RETAGGED 2026-07-09, B4 — was INVERTS: reverse-membrane/P1] `env.set("double", ...)`
      // bare-fn producer, same still-valid Reflect.apply-fallback pattern/gate as the "JS
      // functions that return promises" test above (see that comment for the full gate chain:
      // step 6 / AProcedure removal, gated on the undone McpEnvCapability annotation-lifting
      // migration, NOT on B1-B3 which already landed).
      it("should handle => syntax", async () => {
        // (cond ((+ 1 2) => (lambda (x) (* x 2))))
        // With membrane, JS functions receive JS values (not SchemeExact)
        env.set("double", (x: number) => x * 2);
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "cond"), APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)], false), new ASymbol(CONSTANT_CTX, "=>"), new ASymbol(CONSTANT_CTX, "double")], false)], false);
        // The bare-fn boxing seam boxes the => builtin's raw return; this spec's
        // `execExpr` surfaces the box — unwrap to assert the value.
        expect(((await execExpr(code, { env })) as AExact)["arrival/toJS"]()).toBe(6);
      });
    });

    describe("case", () => {
      // [P15 redundancy] DELETED (same sweep/rationale as cond above): "match datum"
      // point-duplicated generator-exec.spec.ts's own "should handle case" (matches
      // datum 2 → 'two, identical shape). Kept "else when no match" (a distinct edge
      // case — the generator-exec case test never exercises its own else branch, since
      // its datum always matches a listed clause).
      it("should use else when no match", async () => {
        // (case 5 ((1) 'one) ((2) 'two) (else 'other))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "case"),
          new AExact(CONSTANT_CTX, 5n),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), new ASymbol(CONSTANT_CTX, "one")], false)], false),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 2n)], false), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), new ASymbol(CONSTANT_CTX, "two")], false)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "else"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "quote"), new ASymbol(CONSTANT_CTX, "other")], false)], false),
        ], false);
        const result = (await execExpr(code, { env })) as ASymbol;
        expect(result.__name__).toBe("other");
      });
    });

    describe("when", () => {
      it("should execute body when test is true", async () => {
        // (when #t 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "when"), schemeTrue, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 3n));
      });

      it("should return undefined when test is false", async () => {
        // (when #f 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "when"), schemeFalse, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        expect(await execExpr(code, { env })).toBe(theVoid);
      });
    });

    describe("unless", () => {
      it("should execute body when test is false", async () => {
        // (unless #f 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "unless"), schemeFalse, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 3n));
      });

      it("should return undefined when test is true", async () => {
        // (unless #t 1 2 3)
        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "unless"), schemeTrue, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        expect(await execExpr(code, { env })).toBe(theVoid);
      });
    });

    describe("do", () => {
      it("should iterate until test is true", async () => {
        // (do ((i 0 (+ i 1))) ((>= i 5) i))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "do"),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "i"), new AExact(CONSTANT_CTX, 0n), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new ASymbol(CONSTANT_CTX, "i"), new AExact(CONSTANT_CTX, 1n)], false)], false)], false),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, ">="), new ASymbol(CONSTANT_CTX, "i"), new AExact(CONSTANT_CTX, 5n)], false), new ASymbol(CONSTANT_CTX, "i")], false),
        ], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 5n));
      });

      it("should execute body on each iteration", async () => {
        let count = 0;
        env.set("inc!", () => {
          count++;
          return undefined;
        });
        // (do ((i 0 (+ i 1))) ((>= i 3)) (inc!))
        const code = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "do"),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "i"), new AExact(CONSTANT_CTX, 0n), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new ASymbol(CONSTANT_CTX, "i"), new AExact(CONSTANT_CTX, 1n)], false)], false)], false),
          APair.fromArray(CONSTANT_CTX, [APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, ">="), new ASymbol(CONSTANT_CTX, "i"), new AExact(CONSTANT_CTX, 3n)], false)], false),
          APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "inc!")], false),
        ], false);
        await execExpr(code, { env });
        expect(count).toBe(3);
      });
    });

    describe("define-macro", () => {
      it("should define a simple macro", async () => {
        // (define-macro (my-when test . body) `(if ,test (begin ,@body)))
        // Then: (my-when #t 1 2 3)
        const defineMacro = APair.fromArray(CONSTANT_CTX, [
          new ASymbol(CONSTANT_CTX, "define-macro"),
          new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, "my-when"), new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, "test"), new ASymbol(CONSTANT_CTX, "body"))),
          APair.fromArray(CONSTANT_CTX, [
            new ASymbol(CONSTANT_CTX, "quasiquote"),
            APair.fromArray(CONSTANT_CTX, [
              new ASymbol(CONSTANT_CTX, "if"),
              APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "unquote"), new ASymbol(CONSTANT_CTX, "test")], false),
              // (begin ,@body) = (begin (unquote-splicing body))
              APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "begin"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "unquote-splicing"), new ASymbol(CONSTANT_CTX, "body")], false)], false),
            ], false),
          ], false),
        ], false);
        await execExpr(defineMacro, { env });

        const code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "my-when"), schemeTrue, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n), new AExact(CONSTANT_CTX, 3n)], false);
        expect(await execExpr(code, { env })).toEqual(new AExact(CONSTANT_CTX, 3n));
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
    // purity-doors.test.ts; here we just confirm the special form is gone.
    describe("delay/force — omitted by the purity invariant", () => {
      it("(delay …) is no longer a working special form", async () => {
        // This raw env has no bootstrap loaded, so `delay` is unbound here (the
        // teaching door — "omitted from arrival by design" — is a bootstrap macro,
        // verified at the full-env layer in purity-doors.test.ts). The point at
        // THIS layer: delay no longer evaluates lazily; it is gone from the
        // special-form table.
        await expect(execExpr(APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "delay"), APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)], false)], false), { env })).rejects.toThrow();
      });
    });
  });

  describe("performance - deep recursion", () => {
    it("should handle deep recursion without stack overflow", async () => {
      // Create a deeply nested expression: (+ 1 (+ 1 (+ 1 ... (+ 1 0)...)))
      let code: APair<any, any> | typeof nil = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 0n)], false);

      // 10,000 levels of nesting
      for (let i = 0; i < 10000; i++) {
        code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "+"), new AExact(CONSTANT_CTX, 1n), code], false);
      }

      const result = await execExpr(code, { env });
      expect(result).toEqual(new AExact(CONSTANT_CTX, 10001n));
    });

    it("should handle deeply nested if expressions", async () => {
      // Create deeply nested ifs: (if #t (if #t (if #t ... 42 ...)))
      let code: SchemeValue = new AExact(CONSTANT_CTX, 42n);

      for (let i = 0; i < 10000; i++) {
        code = APair.fromArray(CONSTANT_CTX, [new ASymbol(CONSTANT_CTX, "if"), schemeTrue, code, new AExact(CONSTANT_CTX, 0n)], false);
      }

      const result = await execExpr(code, { env });
      expect(result).toEqual(new AExact(CONSTANT_CTX, 42n));
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
      // documented, deferred opaque-exit marker — two-tier-exec-api.md §9).
      expect(String(result)).toBe("'done");
    }, 15000);
  });
});

// Type for Nil
interface ANil {
  toString(): string;
}

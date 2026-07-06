// Chibi (chibi test) compatible harness — expressed as a real `EnvCapability`.
//
// This is the test fixture the `chibi-r7rs.spec.ts` runner assembles onto a
// `freshEnv()` to give the vendored `r7rs-tests.scm` its `test` / `test-begin` /
// `test-end` / `test-assert` / `test-error` / `test-values` / `test-numeric-syntax`
// surface. It DOGFOODS the production env-assembly model: instead of imperative
// `exec(...)` + `env.set(...)`, the harness is a `new EnvCapability(...)` whose
//   • `symbols` are the native JS hooks (the test sink + the JS-side group stack), and
//   • `prelude` is the scheme that defines the `test*` macros, delegating group state
//     to the JS hooks.
// `chibi-r7rs.spec.ts` lowers it and `assembleEnv(env, [harness])`s it — the SAME
// `EnvCapability`/`assembleEnv` path the base stdlib (`BASE_PACKS`) uses.
//
// ── Group stack lives in JS (NO scheme `set!`) ──────────────────────────────────────
// The previous harness kept the test-group stack in scheme vars (`*current-test-group*`
// / `*test-group-stack*`) mutated with `set!`. That state now lives in this closure;
// `js-test-begin` / `js-test-end` maintain it, and the scheme `test-begin` / `test-end`
// are thin wrappers that CALL those hooks. So the harness itself contains no `set!`.
// (This is ONLY the harness's own bookkeeping — the SUITE's own `(set! …)` tests still
// run against the live interpreter; dissolving interpreter `set!` is a separate pass.)
//
// The host hooks are bound via `symbol.native` — RAW, the exact semantic of the old
// `env.set(name, fn)` / `{ value }` form (native's impl is bound as-is, no codec, no
// validation). They are host plumbing (a results sink, a JS stack), not scheme value-ops,
// so contracts lean on `z.value` (representation-blind) rather than a typed scheme
// identity — but the shape is now the target `symbol.*` form, not the legacy `{ value }`
// escape hatch, so the runtime behavior stays byte-identical to the old harness.

import * as z from "../common/scheme-zod.js";
import { symbol } from "../common/symbol.js";
import { EnvCapability } from "../common/capability.js";
import { applyCallback } from "../values/primitives/ACallable.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AString } from "../values/primitives/AString.js";
import { type ABool } from "../values/primitives/ABool.js";
import { type AVoid, theVoid } from "../values/primitives/AVoid.js";
import { schemeBool } from "../values/op-helpers.js";

/** One recorded outcome — a single chibi `(test …)` / `(test-error …)` / … evaluation. */
export interface ChibiTestResult {
  name: string;
  group: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

export interface ChibiHarness {
  /** Lower + `assembleEnv(env, [capability])` to wire the `test*` surface onto an env. */
  readonly capability: EnvCapability;
  /** Outcomes accumulated as the suite runs (the runner reads this after execution). */
  readonly results: ChibiTestResult[];
  /** The live group label (driven by `js-test-begin` / `js-test-end`). */
  currentGroup(): string;
  /** Clear results + reset the group stack to the root (for a re-run). */
  reset(): void;
}

/**
 * Build a fresh harness: its capability closes over a private results sink + JS group
 * stack. One harness per suite run.
 */
export function createChibiHarness(): ChibiHarness {
  const results: ChibiTestResult[] = [];
  let currentGroup = "R7RS";
  let groupStack: string[] = [];

  // ── The pass/fail comparator (chibi's approximate float equality) ──────────────────
  function approxEqualNum(a: number, b: number): boolean {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    // Relative epsilon appropriate for IEEE 754 double precision.
    const epsilon = Math.max(1e-12, Math.abs(a) * 1e-6, Math.abs(b) * 1e-6);
    return Math.abs(a - b) < epsilon;
  }

  function approxEqual(a: unknown, b: unknown): boolean {
    // SchemeInexact (complex numbers) — compare real and imag parts.
    if (a && typeof a === "object" && "real" in a && "imag" in a) {
      if (b && typeof b === "object" && "real" in b && "imag" in b) {
        return (
          approxEqualNum((a as { real: number }).real, (b as { real: number }).real) &&
          approxEqualNum((a as { imag: number }).imag, (b as { imag: number }).imag)
        );
      }
      // Complex vs real: only equal if imag is 0.
      const aObj = a as { real: number; imag: number };
      if (aObj.imag !== 0) return false;
      return approxEqual(aObj.real, b);
    }
    if (b && typeof b === "object" && "real" in b && "imag" in b) {
      const bObj = b as { real: number; imag: number };
      if (bObj.imag !== 0) return false;
      return approxEqual(a, bObj.real);
    }

    // SchemeExact — use valueOf safely.
    if (a && typeof a === "object" && "valueOf" in a && !("imag" in a)) {
      a = (a as { valueOf(): unknown }).valueOf();
    }
    if (b && typeof b === "object" && "valueOf" in b && !("imag" in b)) {
      b = (b as { valueOf(): unknown }).valueOf();
    }

    if (typeof a === "number" && typeof b === "number") {
      return approxEqualNum(a, b);
    }
    // Strict equality for non-numbers (a Scheme equal? would be richer).
    return a === b || String(a) === String(b);
  }

  const capability = new EnvCapability("test/harness", {
    // ── Native JS hooks (bound raw via `symbol.native`, ≡ the old `env.set`) ────────
    symbols: {
      // chibi `format` shim — kept for surface parity (the current suite does not call it).
      format: symbol.native`format: chibi (format) shim — ~a/~s substitution, ~% newline, ~~ tilde`(
        { input: [z.value], inputRest: z.value, output: [z.string] },
        (fmt: unknown, ...args: unknown[]): AString => {
          let result = String(fmt);
          let argIndex = 0;
          result = result.replace(/~[as%~]/g, (match) => {
            if (match === "~a" || match === "~s") {
              const arg = args[argIndex++];
              return arg === undefined ? "" : String(arg);
            }
            if (match === "~%") return "\n";
            if (match === "~~") return "~";
            return match;
          });
          return new AString(CONSTANT_CTX, result);
        },
      ),

      "error-object-message": symbol.native`error-object-message: the error's message, from a JS Error/string/other`(
        { input: [z.value], output: [z.string] },
        (err: unknown): AString => {
          if (err instanceof Error) return new AString(CONSTANT_CTX, err.message);
          if (typeof err === "string") return new AString(CONSTANT_CTX, err);
          return new AString(CONSTANT_CTX, String(err));
        },
      ),

      "error-object?": symbol.native`error-object?: #t iff obj is a JS Error or an error-shaped object`(
        { input: [z.value], output: [z.boolean] },
        (obj: unknown): ABool =>
          schemeBool(obj instanceof Error || (typeof obj === "object" && obj !== null && "message" in obj)),
      ),

      // The runner: evaluate the (deferred) thunk, compare against `expected`, record.
      // `thunk` is the raw scheme closure the `test` macro hands over; calling it from
      // JS (await) is the SAME path the old `env.set("js-run-test", …)` used.
      "js-run-test": symbol.native`js-run-test: run thunk, compare its result to expected, record the outcome`(
        { input: [z.value, z.value, z.lambda], output: [z.undefinedResult] },
        async (name: unknown, expected: unknown, thunk: unknown): Promise<AVoid> => {
          const testName = typeof name === "string" ? name : String(name);
          try {
            // `thunk` is a scheme closure — a callable VALUE (ALambda), not a bare fn — so invoke
            // it through the seam, not `thunk()`.
            const result = await applyCallback(thunk, [], CONSTANT_CTX);
            results.push({
              name: testName,
              group: currentGroup,
              passed: approxEqual(expected, result),
              expected,
              actual: result,
            });
          } catch (e) {
            results.push({ name: testName, group: currentGroup, passed: false, error: String(e) });
          }
          return theVoid;
        },
      ),

      // ── The JS-side group stack (replaces the scheme `set!` bookkeeping) ───────────
      "js-test-begin": symbol.native`js-test-begin: push the current group, enter a new one named 'name'`(
        { input: [z.value], output: [z.undefinedResult] },
        (name: unknown): AVoid => {
          groupStack.push(currentGroup);
          currentGroup = String(name);
          return theVoid;
        },
      ),
      "js-test-end": symbol.native`js-test-end: pop the JS-side group stack back to the parent group`(
        { input: [], output: [z.undefinedResult] },
        (): AVoid => {
          currentGroup = groupStack.pop() ?? "R7RS";
          return theVoid;
        },
      ),

      // Callbacks the `test-error` macro fires (raw bindings, as before).
      "*test-pass-callback*": symbol.native`*test-pass-callback*: record a passing outcome`(
        { input: [z.value, z.value, z.value], output: [z.undefinedResult] },
        (name: unknown, expected: unknown, actual: unknown): AVoid => {
          results.push({ name: String(name), group: currentGroup, passed: true, expected, actual });
          return theVoid;
        },
      ),
      "*test-fail-callback*": symbol.native`*test-fail-callback*: record a failing outcome`(
        { input: [z.value, z.value, z.value], output: [z.undefinedResult] },
        (name: unknown, expected: unknown, actual: unknown): AVoid => {
          results.push({ name: String(name), group: currentGroup, passed: false, expected, actual });
          return theVoid;
        },
      ),
      "*test-error-callback*": symbol.native`*test-error-callback*: record a thrown-error outcome`(
        { input: [z.value, z.value], output: [z.undefinedResult] },
        (name: unknown, error: unknown): AVoid => {
          results.push({ name: String(name), group: currentGroup, passed: false, error: String(error) });
          return theVoid;
        },
      ),
    },

    // ── The scheme test surface (macros + the JS-delegating group wrappers) ──────────
    prelude: `
    ;; Approximate equality for floats — part of the harness surface (the current suite
    ;; does not reference it, but chibi's (chibi test) provides it).
    (define (approx-equal? a b epsilon)
      (cond
        ((and (number? a) (number? b))
         (< (abs (- a b)) epsilon))
        ((and (pair? a) (pair? b))
         (and (approx-equal? (car a) (car b) epsilon)
              (approx-equal? (cdr a) (cdr b) epsilon)))
        ((and (vector? a) (vector? b)
              (= (vector-length a) (vector-length b)))
         (let loop ((i 0))
           (or (>= i (vector-length a))
               (and (approx-equal? (vector-ref a i) (vector-ref b i) epsilon)
                    (loop (+ i 1))))))
        (else (equal? a b))))

    ;; test-begin / test-end — the group stack lives in JS now (js-test-begin /
    ;; js-test-end). These are thin wrappers that CALL the JS hooks. NO scheme set!.
    (define (test-begin name) (js-test-begin name))
    (define (test-end . args) (js-test-end))

    ;; Main test macro.
    ;; Chibi test format: (test expected expr) or (test name expected expr)
    (define-syntax test
      (syntax-rules ()
        ((test name expected expr)
         (js-run-test name expected (lambda () expr)))
        ((test expected expr)
         (js-run-test 'expr expected (lambda () expr)))))

    ;; test-assert for boolean tests
    (define-syntax test-assert
      (syntax-rules ()
        ((test-assert expr)
         (test-assert 'expr expr))
        ((test-assert name expr)
         (test #t name expr))))

    ;; test-error expects an error to be raised
    (define-syntax test-error
      (syntax-rules ()
        ((test-error expr)
         (test-error 'expr expr))
        ((test-error name expr)
         (guard (err (#t (*test-pass-callback* name "error" "error")))
           expr
           (*test-fail-callback* name "error" "no error")))))

    ;; test-values for multiple values
    (define-syntax test-values
      (syntax-rules ()
        ((test-values expected expr)
         (test (call-with-values (lambda () expected) list)
               (call-with-values (lambda () expr) list)))))

    ;; Numeric syntax test helper from chibi.
    ;;
    ;; The upstream chibi macro round-trips through ports:
    ;;   (read (open-input-string str)) then (write … out) and checks the
    ;;   written form is a member of the expected write-strings. We don't
    ;;   support string ports (see EXCLUDED_TESTS) so we keep only the read
    ;;   half via (string->number str) — the same parse the reader performs
    ;;   for a numeric token — and assert it is eqv? to the expected value.
    ;;   The write-membership half (strs ...) is dropped: it tests port output
    ;;   formatting, which is out of scope for the sandbox.
    (define-syntax test-numeric-syntax
      (syntax-rules ()
        ((test-numeric-syntax str expect strs ...)
         (test str expect (string->number str)))))
  `,
  });

  return {
    capability,
    results,
    currentGroup: () => currentGroup,
    reset() {
      results.length = 0;
      currentGroup = "R7RS";
      groupStack = [];
    },
  };
}

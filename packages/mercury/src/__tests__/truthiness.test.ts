/**
 * Law T (truthiness) — Phase 0 conservative forms (design doc §5.2 / Appendix B
 * truthiness cells). Scheme truthiness is `x !== false`: ONLY `#f` is false —
 * `0`, `""`, and `'()` are truthy. Interpreter ground truth (verified):
 * `(if 0 'a 'b)` → `'a`; `(and 0 1)` → `1`. These pin the compiler side.
 *
 * Two layers:
 *  1. EMITTED-STRING pins — the conservative spellings: the `!== false` if-guard,
 *     `=== false` for `not`, the value-returning and-ternary chain, the or-temp
 *     IIFE (each operand binds AT MOST once; short-circuit preserved).
 *  2. EXECUTION pins — `eval` of the formatted read-view: the read-view is plain
 *     JS, so `eval`'s completion value is a zero-infrastructure oracle for the
 *     Appendix-B literal cells. Full compiled≡interpreted agreement (both
 *     strategies, plus the tsc --strict gate) runs over the same cells in
 *     `conformance/corpus/truthiness-*.scm`.
 */
import { describe, expect, it } from "vitest";

import { containsAwaitToken } from "../names.js";
import { projectToJs } from "../project.js";
import { emitTypes } from "../types-emit.js";

const p = (src: string) => projectToJs(src);
const run = (src: string) => projectToJs(src, { target: "run" });

/** Evaluate the formatted read-view; the last expression statement's completion
 *  value is the program's value (direct `eval` keeps `const`s in its own scope). */
const evalRead = async (src: string): Promise<unknown> => eval(await p(src)) as unknown;

describe("Law T — emitted forms (conservative: no type facts in Phase 0)", () => {
  it("if guards every condition with `!== false`", async () => {
    expect(await p("(define (f c a b) (if c a b))")).toContain("c !== false ? a : b");
  });

  it("run-view self-tail loop guards its statement-`if` condition too", async () => {
    const out = await run("(define (count n) (let go ((i 0)) (if (< i n) (go (+ i 1)) i)))");
    expect(out).toContain("if (i < n !== false)");
  });

  it("and is a value-returning ternary chain, not JS &&", async () => {
    const out = await p("(define (f a b) (and a b))");
    expect(out).toContain("a === false ? false : b");
    expect(out).not.toContain("&&");
  });

  it("a 3-ary and chains right (each operand evaluated at most once)", async () => {
    const out = await p("(define (f a b c) (and a b c))");
    expect(out).toContain("a === false ? false : b === false ? false : c");
  });

  it("or binds each head operand once (__t) and tests `!== false`, not JS ||", async () => {
    const out = await p("(define (f a b) (or a b))");
    expect(out).toContain("((__t) => (__t !== false ? __t : b))(a)");
    expect(out).not.toContain("||");
  });

  it("a 3-ary or nests right — the outer temp is never referenced inside the tail", async () => {
    const out = await p("(define (f a b c) (or a b c))");
    expect(out).toContain("((__t) => (__t !== false ? __t : ((__t) => (__t !== false ? __t : c))(b)))(a)");
  });

  it("not is the exact #f test `=== false`, never JS `!`", async () => {
    const out = await p("(define (f x) (not x))");
    expect(out).toContain("x === false");
    expect(out).not.toContain("!x");
  });

  it("not as an ARGUMENT (op-as-argument table) is `=== false` too", async () => {
    const out = await p("(define (f xs) (map not xs))");
    expect(out).toContain("=== false");
    expect(out).not.toContain("!x");
  });

  it("(and) / (or) are the identities #t / #f, not the `()` syntax error", async () => {
    expect(await evalRead("(and)")).toBe(true);
    expect(await evalRead("(or)")).toBe(false);
  });
});

describe("Law T — Appendix B literal cells, EXECUTED (read-view ≡ interpreter ground truth)", () => {
  it("(if 0 'a 'b) → 'a — 0 is truthy", async () => {
    expect(await evalRead("(if 0 'a 'b)")).toBe("a");
  });

  it('(if "" \'a \'b) → \'a — "" is truthy', async () => {
    expect(await evalRead(`(if "" 'a 'b)`)).toBe("a");
  });

  it("(and 0 1) → 1 — and returns the LAST operand when none is #f", async () => {
    expect(await evalRead("(and 0 1)")).toBe(1);
  });

  it("(or 0 999) → 0 — or returns the FIRST non-#f operand", async () => {
    expect(await evalRead("(or 0 999)")).toBe(0);
  });

  it("(not 0) → #f", async () => {
    expect(await evalRead("(not 0)")).toBe(false);
  });

  it("the #f cases stay right: (and 1 #f) → #f, (or #f 7) → 7", async () => {
    expect(await evalRead("(and 1 #f)")).toBe(false);
    expect(await evalRead("(or #f 7)")).toBe(7);
  });

  it("(when 0 'x) runs; (unless 0 'x) skips — 0 is truthy through the sugar", async () => {
    expect(await evalRead("(when 0 'x)")).toBe("x");
    expect(await evalRead("(unless 0 'x)")).toBeUndefined();
  });

  it("short-circuit: the tail is not evaluated once the value is decided", async () => {
    // `boom` is unbound — if the tail evaluated, eval would throw ReferenceError.
    expect(await evalRead("(or 1 (boom))")).toBe(1);
    expect(await evalRead("(and #f (boom))")).toBe(false);
  });

  it("value position: (define x (and 0 5)) binds 5; (or #f 0) is 0", async () => {
    expect(await evalRead("(define x (and 0 5))\nx")).toBe(5);
    expect(await evalRead("(define y (or #f 0))\ny")).toBe(0);
  });
});

describe("Law T — type plane (__scmTruth wrap, v1 plain-boolean)", () => {
  it("every emitted if condition wraps in __scmTruth", () => {
    const { ts } = emitTypes("(define (pick c a b) (if c a b))");
    expect(ts).toContain("__scmTruth(c) ? a : b");
  });

  it("and/or/not stay __arr calls in the type plane (no native &&/||/!)", () => {
    const { ts } = emitTypes("(define (f a b) (or a (not b)))");
    expect(ts).toContain("__arr.or(");
    expect(ts).toContain("__arr.not(");
  });
});

describe("Law T — the await-sniff false-positive class (containsAwaitToken)", () => {
  it('a string literal containing "await" never triggers the async or-wrap', async () => {
    // Pre-fix this emitted `await` inside a SYNC arrow — a SyntaxError at load
    // (the string-plane sniff disagreed with the scheme-plane asyncNames).
    const out = await run(`(define (f a) (or a "await"))\n(f 0)`);
    // The literal itself (and its inferred type) legitimately CONTAIN the
    // substring — the assertion is token-aware: no real await keyword, no
    // async wrap around the or-IIFE.
    expect(containsAwaitToken(out)).toBe(false);
    expect(out).not.toContain("async");
    expect(await evalRead(`(define (f a) (or a "await"))\n(f 0)`)).toBe(0);
  });

  it("containsAwaitToken: literals don't count, interpolation interiors do", () => {
    expect(containsAwaitToken('f("await")')).toBe(false);
    expect(containsAwaitToken("f('await', `await`)")).toBe(false);
    expect(containsAwaitToken("awaited(x)")).toBe(false);
    expect(containsAwaitToken("await f(x)")).toBe(true);
    expect(containsAwaitToken("`${await f(x)}`")).toBe(true);
    expect(containsAwaitToken('`${g({ a: "}" })} ${await h()}`')).toBe(true);
    expect(containsAwaitToken('"\\" await"')).toBe(false); // escaped quote stays inside the literal
  });
});

describe("Law T — predicate-result boundary (filter/every/some consume with ToBoolean)", () => {
  it("(filter (lambda (x) x) '(0 1 #f)) keeps the Scheme-truthy 0", async () => {
    expect(await evalRead("(filter (lambda (x) x) (list 0 1 #f))")).toEqual([0, 1]);
  });

  it("emitted predicate results carry the !== false guard", async () => {
    const out = await p("(define (f xs) (filter (lambda (x) x) xs))");
    expect(out).toContain("!== false");
  });
});

/**
 * Nested trampolines (HOF callbacks, `apply`, `try` clauses) are heap-bounded: depth never
 * overflows the host stack, and budget / abort / nesting bookkeeping hold at every depth.
 */
import type { CallCtx } from "../run/CallCtx.js";
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../common/capability.js";
import { exec, execState } from "../eval/generator-exec.js";

const sleepy = EnvCapability.define("test/sleepy", {
  symbols: (symbol, sz) => ({
    sleepy: symbol.rosetta`sleepy: resolve n after 40ms`(
      { input: [sz.number], output: [sz.number] },
      function (this: CallCtx, n) {
        return new Promise<number>((resolve) => setTimeout(() => resolve(n as number), 40));
      },
    ),
  }),
});

describe("nested trampolines are heap-bounded", () => {
  it("recursion through map at 5000", async () => {
    const r = await exec(`(define (f n) (if (= n 0) 0 (car (map (lambda (x) (f (- x 1))) (list n))))) (f 5000)`);
    expect(r.at(-1)).toBe(0);
  });
  it("recursion through apply at 20000", async () => {
    const r = await exec(`(define (h n) (if (= n 0) 0 (+ 1 (apply h (list (- n 1)))))) (h 20000)`);
    expect(r.at(-1)).toBe(20_000);
  });
  it("recursion through try at 5000", async () => {
    const r = await exec(`(define (t n) (if (= n 0) 0 (try (+ 1 (t (- n 1))) (catch (e) -1)))) (t 5000)`);
    expect(r.at(-1)).toBe(5000);
  });
  it("recursion through reduce at 5000", async () => {
    const r = await exec(
      `(define (f n) (if (= n 0) 0 (reduce (lambda (x acc) (+ 1 (f (- x 1)))) 0 (list n)))) (f 5000)`,
    );
    expect(r.at(-1)).toBe(5000);
  });
  it("error thrown 3000 levels deep through map surfaces as the raised error, not a host overflow", async () => {
    await expect(
      exec(`(define (f n) (if (= n 0) (error "bottom") (car (map (lambda (x) (f (- x 1))) (list n))))) (f 3000)`),
    ).rejects.toThrow(/bottom/);
  });
  it("try/catch 3000 levels deep catches a scheme error at the bottom", async () => {
    const r = await exec(
      `(define (t n) (if (= n 0) (error "bottom") (try (+ 1 (t (- n 1))) (catch (e) 100)))) (t 3000)`,
    );
    expect(r.at(-1)).toBe(100 + 2999);
  });
});

describe("nesting bookkeeping", () => {
  it("depth returns to 0 after success, after failure, and across a reused runCtx", async () => {
    const st = await execState(`(define (f n) (if (= n 0) 0 (car (map (lambda (x) (f (- x 1))) (list n))))) (f 500)`);
    expect(st.runCtx.bound.nesting.depth).toBe(0);
    await expect(
      execState(`(define (g n) (if (= n 0) (error "x") (car (map (lambda (x) (g (- x 1))) (list n))))) (g 500)`, {
        runCtx: st.runCtx,
        scope: st.scope,
      }),
    ).rejects.toThrow(/x/);
    expect(st.runCtx.bound.nesting.depth).toBe(0);
    await execState(`(f 100)`, { runCtx: st.runCtx, scope: st.scope });
    expect(st.runCtx.bound.nesting.depth).toBe(0);
  });
});

describe("fan concurrency is preserved", () => {
  it("map over async callbacks still runs the fan concurrently", async () => {
    const opts = { capabilities: [sleepy], config: {} };
    await exec(`(sleepy 1)`, opts); // warm-up: prelude + capability assembly
    const t1 = performance.now();
    await exec(`(begin (sleepy 1) (sleepy 2) (sleepy 3) (sleepy 4) (sleepy 5))`, opts);
    const sequential = performance.now() - t1;
    const t0 = performance.now();
    const r = await exec(`(map (lambda (x) (sleepy x)) (list 1 2 3 4 5))`, opts);
    const fan = performance.now() - t0;
    expect(r.at(-1)).toEqual([1, 2, 3, 4, 5]);
    expect(fan).toBeLessThan(sequential * 0.6);
  });
  it("deep recursion whose callbacks await a host promise at the bottom", async () => {
    const r = await exec(
      `(define (f n) (if (= n 0) (sleepy 7) (car (map (lambda (x) (f (- x 1))) (list n))))) (f 2000)`,
      { capabilities: [sleepy], config: {} },
    );
    expect(r.at(-1)).toBe(7);
  });
});

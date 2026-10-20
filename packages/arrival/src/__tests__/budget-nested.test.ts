/**
 * budgetMs reaches every nested trampoline (try body/handlers/finally, HOF callbacks,
 * macro expansion) and is armed PER CALL on a reused run handle (docs/execution.md §5).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { exec, execState } from "../eval/generator-exec.js";
import { BudgetExceededError } from "../errors.js";

const BUDGET = 200;
// The law is "bounded, not hung" (the pre-fix failure mode never settled at all), so the
// ceiling is generous: a loaded CI box must not turn wall-clock jitter into red.
const LIMIT = BUDGET + 4000;

async function bounded(code: string, extra: object = {}): Promise<number> {
  const t0 = performance.now();
  await expect(exec(code, { budgetMs: BUDGET, ...extra })).rejects.toThrow(BudgetExceededError);
  const dt = performance.now() - t0;
  expect(dt).toBeLessThan(LIMIT);
  return dt;
}

describe("budgetMs in nested trampolines", () => {
  // Pay module-load + JIT warm-up once, outside every timed row.
  beforeAll(() => exec("(+ 1 1)"));

  it("top-level loop", () => bounded("(let loop () (loop))"));
  it("try/catch around an infinite loop is not caught", () => bounded("(try (let loop () (loop)) (catch (e) 1))"));
  it("try/finally around an infinite loop", () => bounded("(try (let loop () (loop)) (finally 1))"));
  it("guard around an infinite loop", () => bounded("(guard (e (#t 1)) (let loop () (loop)))"));
  it("HOF callback loop", () => bounded("(map (lambda (x) (let loop () (loop))) (list 1))"));
  it("loop inside a catch handler", () => bounded('(try (error "x") (catch (e) (let loop () (loop))))'));

  it("a reused runCtx is re-armed with each call's fresh budget", async () => {
    const st = await execState("(define x 1)", { budgetMs: 5000 });
    const t0 = performance.now();
    await expect(
      execState("(try (let loop () (loop)) (catch (e) 1))", { runCtx: st.runCtx, scope: st.scope, budgetMs: BUDGET }),
    ).rejects.toThrow(BudgetExceededError);
    expect(performance.now() - t0).toBeLessThan(LIMIT);
    // the earlier tight budget does not poison the next call
    await expect(execState("(+ x 1)", { runCtx: st.runCtx, scope: st.scope, budgetMs: 5000 })).resolves.toBeDefined();
  });
});

describe("budget and abort reach a deep nested tower", () => {
  beforeAll(() => exec("(+ 1 1)"));

  it("infinite recursion through map", () =>
    bounded("(define (f n) (car (map (lambda (x) (f (+ x 1))) (list n)))) (f 0)"));
  it("infinite recursion through try", () => bounded("(define (f n) (try (+ 1 (f (+ n 1))) (catch (e) -1))) (f 0)"));
  it("infinite recursion through apply", () => bounded("(define (f n) (+ 1 (apply f (list (+ n 1))))) (f 0)"));

  it("abort fires inside infinite recursion through map / try / apply", async () => {
    for (const code of [
      "(define (f n) (car (map (lambda (x) (f (+ x 1))) (list n)))) (f 0)",
      "(define (f n) (try (+ 1 (f (+ n 1))) (catch (e) -1))) (f 0)",
      "(define (f n) (+ 1 (apply f (list (+ n 1))))) (f 0)",
    ]) {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(new Error("host abort")), BUDGET);
      const t0 = performance.now();
      await expect(exec(code, { signal: ctl.signal })).rejects.toThrow(/host abort/);
      expect(performance.now() - t0).toBeLessThan(LIMIT);
    }
  });
});

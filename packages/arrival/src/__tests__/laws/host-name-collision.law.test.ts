// LAW: a user identifier that spells an Object.prototype member (`toString`, `constructor`,
// `__proto__`, `valueOf`, `hasOwnProperty`, `__defineGetter__`) is an ORDINARY identifier —
// every binding position behaves as it would for any other name, and an unbound reference
// is the ordinary "Unbound variable" door, never a host-object leak or an internal error.
// Subjects: the evaluator's special-form dispatch table, the env frame storage, and the
// syntax-rules binding cells / gensym table — all keyed by user-controlled names.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";

const NAMES = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty", "__defineGetter__"] as const;

const last = async (src: string) => ((await exec(src)) as unknown[]).at(-1);

describe.each(NAMES)("host-name collision: %s", (n) => {
  it("unbound reference is the ordinary unbound-variable door", async () => {
    await expect(exec(n)).rejects.toThrow(/Unbound variable/);
    await expect(exec(`(${n} 1)`)).rejects.toThrow(/Unbound variable/);
  });

  it("define variable", async () => {
    expect(await last(`(define ${n} 41) (+ ${n} 1)`)).toBe(42);
  });

  it("define function", async () => {
    expect(await last(`(define (${n} x) (* x 2)) (${n} 21)`)).toBe(42);
  });

  it("lambda parameter", async () => {
    expect(await last(`((lambda (${n}) (+ ${n} 1)) 41)`)).toBe(42);
  });

  it("rest parameter", async () => {
    expect(await last(`((lambda ${n} ${n}) 1 2)`)).toEqual([1, 2]);
  });

  it("let binding", async () => {
    expect(await last(`(let ((${n} 41)) (+ ${n} 1))`)).toBe(42);
  });

  it("macro name", async () => {
    expect(await last(`(define-syntax ${n} (syntax-rules () ((_ a) (list a a)))) (${n} 4)`)).toEqual([4, 4]);
  });

  it("pattern variable", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ ${n}) (list ${n} ${n})))) (m 5)`)).toEqual([5, 5]);
  });

  it("ellipsis pattern variable", async () => {
    expect(await last(`(define-syntax m (syntax-rules () ((_ ${n} ...) (list ${n} ...)))) (m 1 2 3)`)).toEqual([
      1, 2, 3,
    ]);
  });

  it("template-introduced identifier", async () => {
    expect(
      await last(`
        (define-syntax m (syntax-rules () ((_ a) (let ((${n} a)) (+ ${n} 1)))))
        (m 41)`),
    ).toBe(42);
  });
});

import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec";
import { inferenceEnv } from "../inference-env";
import { is_nil, is_false } from "../eval/guards";

/**
 * car/cdr nil-tolerance across interpreter modes × all primitive types.
 *
 * The interpreter has two nil-tolerance modes (ExecOptions.strict -> EvalContext.strict,
 * read run-scoped via isStrict() in evaluator.ts). The INFERENCE-PLANE projection ops
 * (env/fl-interop.ts car/cdr) honor it:
 *   - default (strict:false): an ABSENT value (nil/'()) projects to nil — a multi-leaf
 *     proof grounds its OTHER leaves instead of crashing on one absent read.
 *   - strict:true: an absent projection throws (R7RS-faithful pair typecheck).
 * A WRONG-TYPE arg (number/string/vector/…) is a type error, NOT absence, so it throws
 * in BOTH modes — tolerance is scoped to the absent value, it does not swallow mistakes.
 *
 * This matrix pins that the ONLY mode-dependent cell is the absent value; every other
 * primitive behaves identically in both modes. The base R7RS env (user_env) is untouched
 * and throws in BOTH modes (tolerance is an inference-plane property, not a global default).
 *
 * (Per feedback-live-verify-is-the-gate: the green suite proved nothing RELIED on the old
 * throw-on-nil; it did NOT prove the new tolerant behavior — this matrix does.)
 */

// Run in the INFERENCE env (where the fl-interop overlay car/cdr live); a plain exec uses
// user_env's base car/cdr, which always throw.
const run = (code: string, strict: boolean) =>
  exec(code, { env: inferenceEnv.inherit("nil-tol"), strict });

// Args that are NEITHER a list/pair NOR the absent value -> type errors (throw in BOTH modes).
// #f is included deliberately: it is a real boolean, NOT "absent", so projecting it is a type error.
const TYPE_ERRORS: [string, string][] = [
  ["a vector", "#(1 2 3)"],
  ["a string", `"ab"`],
  ["a number", "5"],
  ["true", "#t"],
  ["false", "#f"],
  ["a char", "(integer->char 65)"],
  ["a symbol", "'sym"],
];

describe("car/cdr nil-tolerance: absent value '() — the ONLY mode-dependent cell", () => {
  it("default (tolerant): (car '()) and (cdr '()) resolve to nil", async () => {
    expect(is_nil((await run("(car '())", false))[0])).toBe(true);
    expect(is_nil((await run("(cdr '())", false))[0])).toBe(true);
  });
  it("strict: (car '()) and (cdr '()) throw the R7RS pair typecheck", async () => {
    await expect(run("(car '())", true)).rejects.toThrow();
    await expect(run("(cdr '())", true)).rejects.toThrow();
  });
});

describe.each([false, true])("a pair projects identically — strict=%s", (strict) => {
  it("(car '(7 8 9)) = 7 and (cdr '(7 8 9)) = (8 9)", async () => {
    expect(is_false((await run("(equal? (car '(7 8 9)) 7)", strict))[0])).toBe(false);
    expect(is_false((await run("(equal? (cdr '(7 8 9)) '(8 9))", strict))[0])).toBe(false);
  });
});

describe.each([false, true])("non-list non-absent args throw in BOTH modes — strict=%s", (strict) => {
  it.each(TYPE_ERRORS)("(car %s) and (cdr %s) throw", async (_label, expr) => {
    await expect(run(`(car ${expr})`, strict)).rejects.toThrow();
    await expect(run(`(cdr ${expr})`, strict)).rejects.toThrow();
  });
});

describe.each([false, true])("an un-forced lazy-seq is a programmer error in BOTH modes — strict=%s", (strict) => {
  it("(car (lazy-seq '(1 2 3))) and (cdr …) throw force-first", async () => {
    await expect(run("(car (lazy-seq '(1 2 3)))", strict)).rejects.toThrow();
    await expect(run("(cdr (lazy-seq '(1 2 3)))", strict)).rejects.toThrow();
  });
});

describe.each([false, true])("base R7RS env (user_env) stays strict regardless of mode — strict=%s", (strict) => {
  it("(car '()) and (cdr '()) throw — tolerance is inference-only, base is untouched", async () => {
    await expect(exec("(car '())", { strict })).rejects.toThrow(); // default env = user_env
    await expect(exec("(cdr '())", { strict })).rejects.toThrow();
  });
});

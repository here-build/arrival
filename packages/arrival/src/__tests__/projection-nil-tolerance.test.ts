import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec";
import { inferenceEnv } from "../inference-env";
import { is_nil, is_false } from "../eval/guards";

/**
 * car/cdr nil-tolerance across interpreter modes × all primitive types.
 *
 * car/cdr are a UNIFIED tagless-final algebra ON the primitives: APair projects (with
 * provenance), ANil is the nil-projection, AJSArray unwraps, and any term carrying NO
 * car algebra (a vector, a number) is a totalic "does not support car" throw —
 * the whole type matrix falls out of one question, "does the receiver carry the algebra?".
 * The ONE mode-dependent cell is the empty list: ANil's car/cdr read the run's strict
 * (ExecOptions.strict -> EvalContext.strict -> the threaded runCtx):
 *   - default (strict:false): an ABSENT value (nil/'()) projects to nil — a multi-leaf
 *     proof grounds its OTHER leaves instead of crashing on one absent read.
 *   - strict:true: an absent projection throws (R7RS-faithful pair typecheck).
 * A WRONG-TYPE arg (number/string/vector/…) is a type error, NOT absence, so it throws in
 * BOTH modes — now the totalic "the <kind> primitive does not support car" throw.
 *
 * Because the algebra lives on the primitives, the base env (user_env) and the inference
 * env share ONE car/cdr — the mode is the per-run strict bit, not the env. (Earlier this was
 * a base-vs-inference split: stdlib's always-strict car + an fl-interop tolerant overlay; the
 * split dissolved into runCtx.strict with the tagless-final unification.)
 *
 * (Per feedback-live-verify-is-the-gate: the green suite proved nothing RELIED on the old
 * throw-on-nil; it did NOT prove the new tolerant behavior — this matrix does.)
 */

// The inference env and a plain exec (user_env) share the unified car/cdr algebra, so both
// track the run's strict bit identically. `run` exercises the inference env; the final block
// pins that user_env behaves the same — strict drives it, not the env.
const run = (code: string, strict: boolean) =>
  exec(code, { env: inferenceEnv.inherit("nil-tol"), strict });

// Args that are NEITHER a list/pair NOR the absent value -> type errors (throw in BOTH modes).
// #f is included deliberately: it is a real boolean, NOT "absent", so projecting it is a type error.
// A vector is NOT here: in LOOSE mode car/cdr read it list-like (see the dedicated block below).
// These are genuinely non-pair, non-vector, non-absent values → a type error in BOTH modes.
const TYPE_ERRORS: [string, string][] = [
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

// A vector is not a pair, but LOOSE mode reads it list-like (car → index 0, cdr → a vector
// slice) — the tolerant-loose / faithful-strict split, same as map/filter on a vector. STRICT
// throws (a vector is not a pair → vector-ref). So `(car borrowed-array)` keeps working loose.
describe("car/cdr on a vector — loose reads it list-like, strict throws", () => {
  it("loose: (car #(1 2 3)) → 1 and (cdr #(1 2 3)) → #(2 3)", async () => {
    expect(is_false((await run("(equal? (car #(1 2 3)) 1)", false))[0])).toBe(false);
    expect(is_false((await run("(equal? (cdr #(1 2 3)) #(2 3))", false))[0])).toBe(false);
  });
  it("strict: (car #(1 2 3)) and (cdr #(1 2 3)) throw (a vector is not a pair)", async () => {
    await expect(run("(car #(1 2 3))", true)).rejects.toThrow();
    await expect(run("(cdr #(1 2 3))", true)).rejects.toThrow();
  });
});

// The base env (user_env) shares the unified nil-projection — strict drives it, not the env.
// (Was: "base stays strict regardless of mode" — the old two-car split. Now ONE algebra on the
// term, so user_env tracks the run's strict exactly like the inference env above.)
describe("base env (user_env) shares the unified nil-projection — strict drives it, not the env", () => {
  it("strict: (car '()) and (cdr '()) throw the R7RS pair typecheck", async () => {
    await expect(exec("(car '())", { strict: true })).rejects.toThrow();
    await expect(exec("(cdr '())", { strict: true })).rejects.toThrow();
  });
  it("default (tolerant): (car '()) and (cdr '()) project to nil — uniform with the inference env", async () => {
    expect(is_nil((await exec("(car '())", { strict: false }))[0])).toBe(true);
    expect(is_nil((await exec("(cdr '())", { strict: false }))[0])).toBe(true);
  });
});

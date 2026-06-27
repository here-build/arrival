import { describe, it, expect } from "vitest";
import { freshEnv } from "./_fresh-env.js";
import { exec } from "../eval/generator-exec.js";
import { schemeToJs } from "../rosetta.js";

/**
 * Guards the `freshEnv()` test helper: a fresh, per-call capability-assembled env
 * must expose the WHOLE current Scheme surface regardless of where each builtin is
 * sourced — native value-domain (GLOBAL_NATIVE_PACKS), the BASE_PACKS scheme layer,
 * the cxr kernel unfold, AND builtins still bound inline on global_env (dict / find)
 * that the husk dissolution hasn't relocated to packs yet. As those migrate
 * inline → pack, this env keeps resolving them — that invariance is the whole point.
 */
describe("freshEnv (capability-assembled test env)", () => {
  it("resolves native, BASE_PACK, cxr-kernel, AND still-inline builtins", async () => {
    const env = await freshEnv();
    const run = async (src: string): Promise<unknown> => schemeToJs((await exec(src, { env }))[0], {});

    expect(await run("(+ 1 2)")).toBe(3); // native value-domain
    expect(await run("(list 1 2 3)")).toEqual([1, 2, 3]); // BASE_PACK r7rs/lists
    expect(await run("(map (lambda (x) (* x x)) (list 2 3))")).toEqual([4, 9]); // BASE_PACK map
    expect(await run('(string-length "abc")')).toBe(3); // BASE_PACK strings → native
    expect(await run("(car (cdr (list 10 20 30)))")).toBe(20); // cxr kernel unfold
    expect(await run("(dict :a 1 :b 2)")).toEqual({ a: 1, b: 2 }); // stdlib INLINE (not yet a pack)
    expect(await run("(find odd? (list 2 4 5))")).toBe(5); // stdlib INLINE
  });

  it("isolates definitions per call (fresh layer each time)", async () => {
    const a = await freshEnv();
    await exec("(define probe 42)", { env: a });
    expect(schemeToJs((await exec("probe", { env: a }))[0], {})).toBe(42);

    // a second fresh env does NOT see the first's define
    const b = await freshEnv();
    await expect(exec("probe", { env: b })).rejects.toThrow();
  });
});

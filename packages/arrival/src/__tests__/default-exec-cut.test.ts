/**
 * Ejection P3 3b.3 step 5 — the FLIP witnesses for the DEFAULT (no-env) exec path.
 *
 * Post-cut, default `exec(code)` resolves through `new Resolver(lexicalRoot,
 * Capabilities.assembled(user_env))`: top-level user `define`s land in a realm-cached,
 * null-rooted `lexicalRoot` (CUT from the base), while builtins resolve through the assembled
 * base. Two properties this must preserve / establish:
 *   1. cross-exec persistence — default defines accumulate across calls (the realm cache), as
 *      they did when they landed in the shared `user_env`.
 *   2. the cut — those defines do NOT leak into `user_env`, yet builtins still resolve.
 * Custom-env callers (arrival-chain/inhuman) stay glass and are covered by the rest of the suite.
 */
import { describe, expect, it } from "vitest";

import { exec, execState } from "../eval/generator-exec.js";
import { user_env } from "../env-roots.js";
import { schemeToJs } from "../rosetta.js";

describe("default exec — the 3b.3 cut", () => {
  it("default-path defines persist across exec calls (realm-cached lexical root)", async () => {
    await exec("(define cut-persist-witness 41)");
    // execState (COMPLEX tier): schemeToJs wants the BOXED value — `exec` already unwraps.
    const [v] = (await execState("(+ cut-persist-witness 1)")).values;
    expect(schemeToJs(v, {})).toBe(42);
  });

  it("default-path defines do NOT land in user_env, builtins still resolve", async () => {
    await exec("(define cut-leak-witness 7)");
    // The define landed in the null-rooted lexicalRoot, NOT the capability base.
    expect(user_env.has("cut-leak-witness")).toBe(false);
    // …yet a builtin still resolves — through the assembled base, not the lexical chain.
    const [sum] = (await execState("(+ 1 2)")).values;
    expect(schemeToJs(sum, {})).toBe(3);
  });
});

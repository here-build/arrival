// core-symbol-define-migration.test.ts — W4 pack migration rows for `scheme/core`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// SCOPE: this pack's `symbols` record is MOSTLY out of scope for this wave — the 20
// `symbol.keyword` entries are `KEYWORD_SYNTAX_BASELINE` itself (define-bake.ts:91),
// not prelude, and `gensym` was already a `symbol.native`. Only the FOUR forms that
// were genuinely `prelude:` text (`true`/`false`/`NaN`/`single`) migrate here — see
// `env/core/core.ts`'s file header for the full inventory.
//
// THE LIVE CATCH this migration surfaces (the same class srfi-43/-235/-189 already
// hit): `single`'s body calls `pair?`/`not` (scheme/r7rs/equality), previously an
// UNDECLARED cross-capability reference that worked only via the two-phase bootstrap's
// runtime guarantee (NATIVE_PACKS → global_env before ANY BASE_PACKS prelude runs).
// `deps: [equality]` on `scheme/core` converts that luck into a declared, bake-checked
// edge. Two rows below pin it: the pack bakes clean AS MIGRATED, and a LOCAL
// reproduction of the pre-fix shape (same body, no declared deps) throws
// `DefineLocalityError` — proving the bug was real.
//
// A SECOND finding, preserved not fixed: `single` is LIVE-VERIFIED to return `#f` for
// EVERY input (including a genuine one-element list) — it predates the nil/false split
// (R7RS: only `#f` is falsy; `(cdr '(a))` is nil, not `#f`) and has zero call sites
// elsewhere in the codebase. §4.2's gate is SEMANTIC EQUIVALENCE with the pre-migration
// pack, not "make it correct" — the migrated body is byte-identical to the original
// prelude form, so this always-`#f` behavior is pinned as-is, not repaired.
import { describe, expect, it } from "vitest";
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { global_env } from "../../env-roots.js";
import { initBridge } from "../../index.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import { DefineLocalityError } from "../../errors.js";
import core from "../core/core.js";

// Mirrors every other migration suite's injected evalScheme (srfi-235/-43/-189's own
// `__tests__/*-symbol-define.test.ts`).
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as never, skipBootstrapWait: true });

describe("scheme/core — behavior equivalence (semantic-equivalence gate, §4.2)", () => {
  it("true / false: the canonical boolean constants", async () => {
    const env = await freshEnv();
    const [t] = await exec("true", { env });
    const [f] = await exec("false", { env });
    expect(t).toBe(true);
    expect(f).toBe(false);
  });

  it("NaN: the canonical not-a-number constant — a real, non-finite JS NaN", async () => {
    const env = await freshEnv();
    const [n] = await exec("NaN", { env });
    expect(Number.isNaN(n)).toBe(true);
  });

  it("single: (pre-existing bug, preserved) returns #f for a genuine one-element list — nil isn't #f", async () => {
    const env = await freshEnv();
    const [result] = await exec("(single (list 'a))", { env });
    expect(result).toBe(false);
  });

  it("single: #f for a multi-element list too (not a pair-shaped false positive either)", async () => {
    const env = await freshEnv();
    const [result] = await exec("(single (list 'a 'b))", { env });
    expect(result).toBe(false);
  });

  it("single: #f for the empty list (not even a pair)", async () => {
    const env = await freshEnv();
    const [result] = await exec("(single '())", { env });
    expect(result).toBe(false);
  });
});

describe("scheme/core — contract ENFORCEMENT fires at the call boundary", () => {
  it("single: a wrong-arity call is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState("(single 1 2)", { env })).rejects.toThrow();
  });
});

describe("scheme/core — the §2.1 bake FV locality law (the live catch, now a declared edge)", () => {
  it("scheme/core lowers cleanly with its declared `equality` dep — never DefineLocalityError", async () => {
    await initBridge();
    const env = global_env.inherit("test-core-fv-law-ok");
    await expect(core.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — single's exact body with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    const env = await freshEnv();
    const undeclaredSingle = symbol.define`bad-single: reproduces the pre-migration scheme/core bug (no declared dep on pair?/not)`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (list) (and (pair? list) (not (cdr list))))`,
    );
    // Deliberately NO `deps` field — the exact shape `core.ts` had before this migration
    // (a bare `symbols` record with no dep declaration; `pair?`/`not` resolved purely
    // via the two-phase bootstrap's runtime guarantee, invisible to the static FV law).
    const undeclaredCap = new EnvCapability("test/core-pre-fix-repro", {
      symbols: { "bad-single": undeclaredSingle },
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

describe("scheme/core — constants validate ONCE at bake and bind a plain value (§1.2)", () => {
  it("true/false/NaN are bound as plain values, not procedures", async () => {
    const env = await freshEnv();
    const [tType] = await exec("(procedure? true)", { env });
    const [fType] = await exec("(procedure? false)", { env });
    const [nType] = await exec("(procedure? NaN)", { env });
    expect(tType).toBe(false);
    expect(fType).toBe(false);
    expect(nType).toBe(false);
  });
});

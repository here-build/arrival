// core-symbol-define-migration.test.ts — W4 pack migration rows for `scheme/core`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// SCOPE: this pack's `symbols` record is MOSTLY out of scope for this wave — the 20
// `symbol.keyword` entries are `KEYWORD_SYNTAX_BASELINE` itself (define-bake.ts:91),
// not prelude, and `gensym` was already a `symbol.native`. Only the constants that
// were genuinely `prelude:` text (`true`/`false`/`NaN`) migrate here — see
// `env/core/core.ts`'s file header for the full inventory.
//
// `single` (the blob's fourth form) was DELETED post-migration (W4-H4 residual,
// V ruling 2026-07-10 "stay aligned to srfi where we can": non-SRFI LIPS heritage,
// always-`#f` body predating the nil/false split, zero call sites). What survives it
// is the LIVE-CATCH regression pin below: its body's `pair?`/`not` calls were an
// UNDECLARED cross-capability reference (scheme/r7rs/equality) that worked only via
// the two-phase bootstrap's runtime guarantee (NATIVE_PACKS → global_env before ANY
// BASE_PACKS prelude runs). The pin reproduces that shape LOCALLY (a bare `symbols`
// record, no `deps`) and proves the bake FV law rejects it with `DefineLocalityError`
// — the law that class of bug is caught by, kept independent of the deleted symbol.
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

  it("single: DELETED (V ruling 2026-07-10, srfi alignment) — unbound, not silently-wrong", async () => {
    const env = await freshEnv();
    await expect(execState("(single (list 'a))", { env })).rejects.toThrow(/Unbound variable/);
  });
});

describe("scheme/core — the §2.1 bake FV locality law", () => {
  it("scheme/core lowers cleanly (dep-free since single's deletion) — never DefineLocalityError", async () => {
    await initBridge();
    const env = global_env.inherit("test-core-fv-law-ok");
    await expect(core.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) the live-catch shape — a scheme body calling pair?/not with NO declared deps — throws DefineLocalityError", async () => {
    const env = await freshEnv();
    const undeclaredSingle = symbol.define`bad-single: reproduces the pre-migration scheme/core bug (no declared dep on pair?/not)`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (list) (and (pair? list) (not (cdr list))))`,
    );
    // Deliberately NO `deps` field — the exact shape `core.ts` had before the W4
    // migration (a bare `symbols` record with no dep declaration; `pair?`/`not`
    // resolved purely via the two-phase bootstrap's runtime guarantee, invisible to
    // the static FV law). The `single` symbol itself is deleted from scheme/core;
    // this pin keeps the LAW covered with a local reproduction.
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

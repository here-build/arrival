// srfi-235-symbol-define.test.ts — W4/H1 pack migration rows for `scheme/srfi-235`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// THE LATENT BUG this migration fixes (design doc §2.1's "live catch", §4.1's census
// row): `complement`'s body called `compose` — a `scheme/polyglot` define — with NO
// declared `deps` edge; it only worked because `base-packs.ts` happened to assemble
// polyglot earlier in the same phase (assembly-order luck). The bake FV law
// (`define-bake.ts`) refuses an undeclared free reference, so the fix is a REAL `deps`
// edge. The SAME migration surfaced a further instance of the identical bug class —
// `not` (scheme/equality), `length`/`apply`/`append` (scheme/lists), `>=`
// (scheme/numeric) — every one a cross-capability reference the OLD text-blob prelude
// got away with via the two-phase bootstrap's runtime guarantee (env-roots.ts:
// NATIVE_PACKS → global_env, THEN BASE_PACKS → user_env), which the STATIC bake FV
// law does not (and should not) consult. `deps: [equality, numeric, lists, polyglot]`
// on the pack (srfi-235.ts) is the complete, empirically-verified fix.
//
// Five rows, matching the pack's migration checklist:
//
//   1. combinator behavior equivalence — complement/constantly/always/curry produce
//      the SAME results the pre-migration text-blob prelude did (§4.2's "semantic
//      equivalence, not byte-identity" gate).
//   2. the dep edge is REAL, not decorative: standalone `.apply()` (bypassing
//      `assembleEnv`'s C3 dep-walk) leaves the declared deps UNAPPLIED — calling a
//      combinator that reaches them then fails with the ordinary unbound-variable
//      teaching door, pinning that these names are genuine runtime dependencies. The
//      REAL orchestration path (`assembleEnv`, which every production caller uses)
//      DOES walk `deps`, and combinators work.
//   3. contract enforcement fires — a scheme-face type mismatch throws at the call
//      boundary, before the body ever runs.
//   4. the §2.1 bake FV law passes for this pack as migrated (with declared deps) —
//      and, mirrored, a LOCAL reproduction of the pre-fix shape (same bodies, NO
//      declared deps) throws `DefineLocalityError` — pinning that the bug this
//      migration fixes was real and is now caught, not merely worked around.
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../../AmbientRuntime.js";
import * as z from "../../../common/scheme-zod.js";
import { symbol } from "../../../common/symbol.js";
import { EnvCapability } from "../../../common/capability.js";
import { exec, execState } from "../../../eval/generator-exec.js";
import { global_env } from "../../../env-roots.js";
import { initBridge } from "../../../index.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { assembleEnv } from "../../../common/kernel.js";
import { DefineLocalityError } from "../../../errors.js";
import srfi235 from "../srfi-235.js";
import type { SchemeEnv } from "../../../common/scheme-env.js";
import type { ResolvingAmbient } from "../../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingAmbient, skipBootstrapWait: true });

describe("scheme/srfi-235 — combinator behavior equivalence (semantic-equivalence gate, §4.2)", () => {
  it("complement: negates a predicate's result", async () => {
    const env = await freshEnv();
    const [t] = await exec("((complement not) #t)", { env });
    const [f] = await exec("((complement not) #f)", { env });
    expect(t).toBe(true); // (not #t) = #f, negated = #t
    expect(f).toBe(false); // (not #f) = #t, negated = #f
  });

  it("constantly: ignores every argument, always returns the closed-over value", async () => {
    const env = await freshEnv();
    const [result] = await exec("((constantly 42) 1 2 3)", { env });
    expect(result).toBe(42);
  });

  it("always / never: SRFI-235 — ignore args, return #t / #f (not constantly)", async () => {
    const env = await freshEnv();
    const [t] = await exec("(always 7 8 9)", { env });
    const [f] = await exec("(never 7 8 9)", { env });
    expect(t).toBe(true);
    expect(f).toBe(false);
  });

  it("curry: accumulates args across calls until fn's min arity, then applies", async () => {
    const env = await freshEnv();
    await exec("(define (add3 a b c) (+ a b c))", { env });
    const [direct] = await exec("(curry add3 1 2 3)", { env }); // full arity in one call
    const [partial3] = await exec("(((curry add3 1) 2) 3)", { env }); // one arg per call
    const [partial2] = await exec("((curry add3 1 2) 3)", { env }); // two then one
    expect(direct).toBe(6);
    expect(partial3).toBe(6);
    expect(partial2).toBe(6);
  });

  it("curry: an intermediate partial application is a real callable value, reusable", async () => {
    const env = await freshEnv();
    await exec("(define (add2 a b) (+ a b))", { env });
    await exec("(define add-five (curry add2 5))", { env });
    const [a] = await exec("(add-five 1)", { env });
    const [b] = await exec("(add-five 100)", { env });
    expect(a).toBe(6);
    expect(b).toBe(105);
  });
});

describe("scheme/srfi-235 — the dep edge is real (§2.1's undeclared-dep bug, now a declared edge)", () => {
  it("standalone .apply() (bypassing assembleEnv's C3 dep-walk) leaves deps UNAPPLIED — complement's `compose`/`not` are genuinely unbound, and the call fails with the teaching door", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi235-standalone-unbound");
    await srfi235.lower({ evalScheme }).apply(env, undefined as never);
    await expect(execState("(complement not)", { env })).rejects.toThrow();
  });

  it("bake itself succeeds even with deps unapplied — the FV law is a STATIC declared-`deps` check, not a runtime-binding probe", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi235-standalone-bake-ok");
    await expect(srfi235.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("assembleEnv (the real orchestration path — every production caller) DOES walk deps: complement/curry work standalone", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi235-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [srfi235.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingAmbient;
    const [complementResult] = await exec("((complement not) #t)", { env: typedEnv });
    expect(complementResult).toBe(true);
    await exec("(define (add1 a) (+ a 1))", { env: typedEnv });
    const [curryResult] = await exec("((curry add1) 41)", { env: typedEnv });
    expect(curryResult).toBe(42);
  });
});

describe("scheme/srfi-235 — contract ENFORCEMENT fires at the call boundary", () => {
  it("complement: a non-procedure argument is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(complement "not-a-procedure")', { env })).rejects.toThrow();
  });

  it("curry: a non-procedure `fn` is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(curry 5)', { env })).rejects.toThrow();
  });
});

describe("scheme/srfi-235 — the §2.1 bake FV law passes for this pack AS MIGRATED", () => {
  it("lowers cleanly with its declared deps — never DefineLocalityError", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi235-fv-law-ok");
    await expect(srfi235.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — the same `compose`/`not` bodies with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    const env = await freshEnv();
    const undeclaredComplement = symbol.define`bad-complement: reproduces the pre-migration srfi-235 bug (no declared dep on compose/not)`(
      { input: [z.lambda], output: [z.lambda] },
      `(lambda (fn) (compose not fn))`,
    );
    // Deliberately NO `deps` field — this is the exact shape srfi-235.ts had before
    // this migration (a bare `symbols` record with no dep declaration).
    const undeclaredCap = new EnvCapability("test/srfi-235-pre-fix-repro", {
      symbols: { "bad-complement": undeclaredComplement },
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

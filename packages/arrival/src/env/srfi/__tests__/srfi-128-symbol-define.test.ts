// srfi-128-symbol-define.test.ts — W4/H2b pack migration rows for `scheme/srfi-128`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// THE LUCK CLASS, BOTH FLAVORS AT ONCE (srfi-128.ts's header): `pair?`/`eq?`/
// `null?`/`boolean?`/`string?`/`symbol?`/`symbol->string`/`equal?`/`not`
// (scheme/equality), `number?`/`=`/`<` (scheme/numeric), `char?`/`char<?`
// (scheme/chars), `string<?` (scheme/strings) are ALL NATIVE_PACKS members —
// srfi-43's luck class: already bound on `global_env` by the two-phase bootstrap,
// so a standalone `.apply()` with `deps` unwalked still resolves them (runtime
// luck, not a declared edge). `list` (scheme/lists), by contrast, is a BASE_PACKS
// member — srfi-235's luck class: genuinely ABSENT without walking `deps`, since
// `lists` only assembles onto `user_env` in phase 2. `deps: [equality, numeric,
// chars, strings, lists]` on the pack converts every one of these five into a
// real, checked edge. `pnpm test` is the proof.
//
// Five rows, matching the pack's migration checklist:
//
//   1. comparator behavior equivalence — the existing baseline suite
//      (`src/__tests__/srfi.test.ts`'s "SRFI-128 — comparators" describe block,
//      §4.2's "semantic equivalence, not byte-identity" gate) already pins
//      default-comparator ordering/chaining/cross-type-order/hashable?; this file
//      adds the coverage that baseline does NOT have — make-comparator/
//      comparator?/the three accessors, and the =?/<?/>?/<=?/>=? family directly
//      (not just through default-comparator).
//   2. the dep edge is real, BOTH luck classes demonstrated in one pack: a
//      standalone `.apply()` (bypassing assembleEnv's C3 dep-walk) still resolves
//      calls that only touch NATIVE_PACKS-sourced free names (equality/numeric/
//      chars/strings — srfi-43's luck), but `make-comparator` itself — the one
//      body that calls `list`, a BASE_PACKS-only name — genuinely fails (srfi-235's
///     luck). The REAL orchestration path (`assembleEnv`, every production caller)
//      walks `deps`, and everything works.
//   3. contract enforcement fires — a scheme-face type mismatch throws at the call
//      boundary, before the body ever runs (including the comparatorSchema shape
//      check on a non-comparator argument to an accessor).
//   4. the §2.1 bake FV law passes for this pack as migrated (with declared deps)
//      — and, mirrored, a LOCAL reproduction of the pre-fix shape (the same `list`
//      free reference, NO declared deps) throws `DefineLocalityError`, pinning
//      that the bug this migration fixes was real and is now caught.
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
import srfi128 from "../srfi-128.js";
import type { SchemeEnv } from "../../../common/scheme-env.js";
import type { ResolvingAmbient } from "../../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingAmbient, skipBootstrapWait: true });

describe("scheme/srfi-128 — comparator behavior equivalence (semantic-equivalence gate, §4.2)", () => {
  it("make-comparator + comparator? + the three accessors", async () => {
    const env = await freshEnv();
    const [isComparator] = await exec(
      "(comparator? (make-comparator number? = <))",
      { env },
    );
    const [notComparator] = await exec("(comparator? 5)", { env });
    expect(isComparator).toBe(true);
    expect(notComparator).toBe(false);

    await exec("(define c (make-comparator number? = <))", { env });
    const [tt] = await exec("((comparator-type-test-predicate c) 3)", { env });
    const [eq] = await exec("((comparator-equality-predicate c) 3 3)", { env });
    const [lt] = await exec("((comparator-ordering-predicate c) 2 3)", { env });
    expect(tt).toBe(true);
    expect(eq).toBe(true);
    expect(lt).toBe(true);
  });

  it("the 4th (hash) arg to make-comparator is accepted and ignored", async () => {
    const env = await freshEnv();
    const [ok] = await exec("(comparator? (make-comparator number? = < (lambda (x) 0)))", { env });
    expect(ok).toBe(true);
  });

  it("=?/<?/>?/<=?/>=? chain across more than two arguments", async () => {
    const env = await freshEnv();
    const [eqChain] = await exec("(=? (default-comparator) 1 1 1)", { env });
    const [ltChain] = await exec("(<? (default-comparator) 1 2 3)", { env });
    const [gtChain] = await exec("(>? (default-comparator) 3 2 1)", { env });
    const [leChain] = await exec("(<=? (default-comparator) 1 1 2)", { env });
    const [geChain] = await exec("(>=? (default-comparator) 2 2 1)", { env });
    const [ltBroken] = await exec("(<? (default-comparator) 1 3 2)", { env });
    expect(eqChain).toBe(true);
    expect(ltChain).toBe(true);
    expect(gtChain).toBe(true);
    expect(leChain).toBe(true);
    expect(geChain).toBe(true);
    expect(ltBroken).toBe(false);
  });

  it("default-comparator's total order ranks by type first, then within-type — matches the baseline suite's cross-type case", async () => {
    const env = await freshEnv();
    const [numBeforeStr] = await exec('(<? (default-comparator) 1 "a")', { env });
    const [charBeforeStr] = await exec(`(<? (default-comparator) #\\a "aa")`, { env });
    const [symBeforeNull] = await exec("(<? (default-comparator) 'sym '())", { env });
    const [falseBeforeTrue] = await exec("(<? (default-comparator) #f #t)", { env });
    expect(numBeforeStr).toBe(true);
    expect(charBeforeStr).toBe(true);
    expect(symBeforeNull).toBe(true);
    expect(falseBeforeTrue).toBe(true);
  });

  it("comparator-hashable? is always #f — matches the baseline suite", async () => {
    const env = await freshEnv();
    const [hashable] = await exec("(comparator-hashable? (default-comparator))", { env });
    expect(hashable).toBe(false);
  });

  it("make-default-comparator and default-comparator behave identically", async () => {
    const env = await freshEnv();
    const [a] = await exec("(<? (make-default-comparator) 1 2)", { env });
    const [b] = await exec("(<? (default-comparator) 1 2)", { env });
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe("scheme/srfi-128 — the dep edge is real, both luck classes in one pack (§2.1's undeclared-dep bug class, now declared edges)", () => {
  it("standalone .apply() (deps unwalked): calls touching ONLY NATIVE_PACKS-sourced free names still resolve — the same two-phase-bootstrap luck srfi-43.ts's header names (equality/numeric/chars/strings are already on global_env post-initBridge)", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi128-standalone-native-luck");
    await srfi128.lower({ evalScheme }).apply(env, undefined as never);
    // %type-rank's body reaches boolean?/number?/char?/string?/symbol?/null?/pair?
    // (all NATIVE_PACKS-sourced, via scheme/equality + scheme/numeric + scheme/chars)
    // and NOTHING from `list` — resolves via runtime chain lookup regardless of
    // whether `deps` was walked, exactly srfi-43's own luck-class demonstration.
    await expect(execState('(%type-rank "a")', { env })).resolves.not.toThrow();
  });

  it("standalone .apply() (deps unwalked): make-comparator genuinely fails — `list` is a BASE_PACKS-only name, absent from global_env, srfi-235's own luck class (NOT runtime luck)", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi128-standalone-list-unbound");
    await srfi128.lower({ evalScheme }).apply(env, undefined as never);
    await expect(execState("(make-comparator number? = <)", { env })).rejects.toThrow();
  });

  it("bake itself succeeds even with deps unapplied — the FV law is a STATIC declared-`deps` check, not a runtime-binding probe", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi128-standalone-bake-ok");
    await expect(srfi128.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("assembleEnv (the real orchestration path — every production caller) DOES walk deps: make-comparator works standalone", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi128-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [srfi128.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingAmbient;
    const [ok] = await exec("(comparator? (make-comparator number? = <))", { env: typedEnv });
    expect(ok).toBe(true);
  });
});

describe("scheme/srfi-128 — contract ENFORCEMENT fires at the call boundary", () => {
  it("make-comparator: a non-procedure type-test is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(make-comparator "not-a-procedure" = <)', { env })).rejects.toThrow();
  });

  it("comparator-type-test-predicate: a non-comparator argument is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState("(comparator-type-test-predicate 5)", { env })).rejects.toThrow();
  });

  it("comparator-ordering-predicate: a plain pair that isn't a well-formed comparator is rejected", async () => {
    const env = await freshEnv();
    await expect(execState("(comparator-ordering-predicate (cons 1 2))", { env })).rejects.toThrow();
  });

  it("comparator? itself accepts ANY value without throwing — a predicate's contract, not a comparator's", async () => {
    const env = await freshEnv();
    await expect(execState("(comparator? 5)", { env })).resolves.not.toThrow();
    await expect(execState('(comparator? "hello")', { env })).resolves.not.toThrow();
  });
});

describe("scheme/srfi-128 — the §2.1 bake FV law passes for this pack AS MIGRATED", () => {
  it("lowers cleanly with its declared deps — never DefineLocalityError", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi128-fv-law-ok");
    await expect(srfi128.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — the same `list` free reference with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    const env = await freshEnv();
    const undeclaredMakeComparator = symbol.define`bad-make-comparator: reproduces the pre-migration srfi-128 bug (no declared dep on list)`(
      { input: [z.lambda, z.lambda, z.lambda], output: [z.list([z.symbol, z.lambda, z.lambda, z.lambda])] },
      `(lambda (type-test equality ordering) (list 'comparator type-test equality ordering))`,
    );
    // Deliberately NO `deps` field — this is the exact shape srfi-128.ts had before
    // this migration (a bare `prelude` text blob, no dep declaration possible at all).
    const undeclaredCap = new EnvCapability("test/srfi-128-pre-fix-repro", {
      symbols: { "bad-make-comparator": undeclaredMakeComparator },
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

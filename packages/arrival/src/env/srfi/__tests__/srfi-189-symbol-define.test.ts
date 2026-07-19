// srfi-189-symbol-define.test.ts — W4/H2b pack migration rows for `scheme/srfi-189`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§4).
//
// THE SAME LUCK CLASS srfi-235 (W4/H1) and srfi-43 (W4/H2) found, here for THREE
// targets at once (srfi-189.ts's header): every body reaches for `list`/`car`/`cdr`/
// `null?` (list construction/access), `pair?`/`eq?` (equality), and `error` (the
// exception-handling procedure) — none declared pre-migration. `car`/`cdr` need no
// dep (the resolver-synth cxr family); `equality` is a NATIVE_PACKS member (no
// base-packs.ts repositioning needed, srfi-43's own precedent); `lists`/`exceptions`
// are BASE_PACKS-only members — `lists` already repositioned by srfi-235's H1 fix,
// `exceptions` newly repositioned by THIS migration (base-packs.ts, alongside
// `lists`/`polyglot`) to satisfy the identical C3 "good head" requirement.
//
// Six rows, matching the pack's migration checklist:
//
//   1. behavior equivalence — every constructor/predicate/accessor/combinator
//      produces the SAME results the pre-migration text-blob prelude did (§4.2's
//      "semantic equivalence, not byte-identity" gate).
//   2. the dep edge is REAL, not decorative: unlike srfi-43 (whose deps were ALL
//      NATIVE_PACKS members, so a standalone repro could only prove the bug via the
//      static bake check), `lists`/`exceptions` are BASE_PACKS-only — a standalone
//      `.apply()` (bypassing `assembleEnv`'s C3 dep-walk) onto a bare `global_env`
//      child genuinely leaves `list`/`error` UNBOUND (srfi-235's own demonstrable-
//      break shape), while `pair?`/`eq?`-only bodies (`just?`) still resolve via
//      NATIVE_PACKS runtime luck — both are pinned. The REAL orchestration path
//      (`assembleEnv`, every production caller) walks `deps`, and everything works.
//   3. contract enforcement fires — a scheme-face type mismatch (non-procedure where
//      a callback slot is declared) throws at the call boundary, before the body runs.
//   4. the §2.1 bake FV law passes for this pack as migrated (with declared deps) —
//      and, mirrored, a LOCAL reproduction of the pre-fix shape (the same `list` free
//      reference, NO declared deps) throws `DefineLocalityError`.
//   5. faithfulness: `maybe-ref`/`either-ref`'s default failure path calls the REAL
//      scheme `error` procedure (not a bare JS throw) — it integrates with
//      `with-exception-handler`'s handler-stack machinery, exactly as pre-migration.
//   6. `maybe->list`/`either->list`'s tightened `z.list(z.value)` output contract is
//      VALIDATE-ONLY — the returned value is still a real scheme list a sibling
//      `(car …)`/`(cdr …)` can walk, never a decoded JS array leaking through.
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
import srfi189 from "../srfi-189.js";
import type { SchemeEnv } from "../../../common/scheme-env.js";
import type { ResolvingAmbient } from "../../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingAmbient, skipBootstrapWait: true });

async function printed(env: ResolvingAmbient, src: string): Promise<string> {
  const { values: r } = await execState(src, { env });
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("scheme/srfi-189 — constructors + predicates (semantic-equivalence gate, §4.2)", () => {
  it("just / nothing / just? / nothing? / maybe?", async () => {
    const env = await freshEnv();
    const [justIsJust] = await exec("(just? (just 42))", { env });
    const [justIsNotNothing] = await exec("(nothing? (just 42))", { env });
    const [nothingIsNothing] = await exec("(nothing? (nothing))", { env });
    const [nothingIsNotJust] = await exec("(just? (nothing))", { env });
    const [maybeJust] = await exec("(maybe? (just 1))", { env });
    const [maybeNothing] = await exec("(maybe? (nothing))", { env });
    const [maybeNeither] = await exec('(maybe? "not-a-maybe")', { env });
    expect(justIsJust).toBe(true);
    expect(justIsNotNothing).toBe(false);
    expect(nothingIsNothing).toBe(true);
    expect(nothingIsNotJust).toBe(false);
    expect(maybeJust).toBe(true);
    expect(maybeNothing).toBe(true);
    expect(maybeNeither).toBe(false);
  });

  it("left / right / left? / right? / either?", async () => {
    const env = await freshEnv();
    const [leftIsLeft] = await exec("(left? (left 'err))", { env });
    const [rightIsRight] = await exec("(right? (right 42))", { env });
    const [leftIsNotRight] = await exec("(right? (left 'err))", { env });
    const [eitherLeft] = await exec("(either? (left 'err))", { env });
    const [eitherRight] = await exec("(either? (right 1))", { env });
    const [eitherNeither] = await exec("(either? 42)", { env });
    expect(leftIsLeft).toBe(true);
    expect(rightIsRight).toBe(true);
    expect(leftIsNotRight).toBe(false);
    expect(eitherLeft).toBe(true);
    expect(eitherRight).toBe(true);
    expect(eitherNeither).toBe(false);
  });
});

describe("scheme/srfi-189 — Maybe accessors/combinators", () => {
  it("maybe-ref: unwraps a Just; calls the failure thunk on Nothing", async () => {
    const env = await freshEnv();
    const [unwrapped] = await exec("(maybe-ref (just 7))", { env });
    const [viaFailure] = await exec("(maybe-ref (nothing) (lambda () 'fallback))", { env });
    expect(unwrapped).toBe(7);
    expect(String(viaFailure)).toBe("fallback"); // ASymbol print repr — the quote is the print convention, not a bug
  });

  it("maybe-ref: errors on Nothing with no failure thunk (default behavior unchanged)", async () => {
    const env = await freshEnv();
    await expect(execState("(maybe-ref (nothing))", { env })).rejects.toThrow(/maybe-ref: Nothing/);
  });

  it("maybe-ref/default", async () => {
    const env = await freshEnv();
    const [fromJust] = await exec("(maybe-ref/default (just 1) 99)", { env });
    const [fromNothing] = await exec("(maybe-ref/default (nothing) 99)", { env });
    expect(fromJust).toBe(1);
    expect(fromNothing).toBe(99);
  });

  it("maybe-bind: applies f and short-circuits on Nothing", async () => {
    const env = await freshEnv();
    const [bound] = await exec("(just? (maybe-bind (just 1) (lambda (x) (just (+ x 1)))))", { env });
    const [boundValue] = await exec("(maybe-ref (maybe-bind (just 1) (lambda (x) (just (+ x 1)))))", { env });
    const [shortCircuit] = await exec("(nothing? (maybe-bind (nothing) (lambda (x) (just x))))", { env });
    expect(bound).toBe(true);
    expect(boundValue).toBe(2);
    expect(shortCircuit).toBe(true);
  });

  it("maybe-map: maps f over the wrapped value, preserving Nothing", async () => {
    const env = await freshEnv();
    const [mapped] = await exec("(maybe-ref (maybe-map (lambda (x) (* x 2)) (just 5)))", { env });
    const [preserved] = await exec("(nothing? (maybe-map (lambda (x) (* x 2)) (nothing)))", { env });
    expect(mapped).toBe(10);
    expect(preserved).toBe(true);
  });

  it("maybe->list / list->maybe round-trip", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(maybe->list (just 5))")).toBe("(5)");
    expect(await printed(env, "(maybe->list (nothing))")).toBe("()");
    const [fromEmpty] = await exec("(nothing? (list->maybe '()))", { env });
    const [fromNonEmpty] = await exec("(maybe-ref (list->maybe '(9 10)))", { env });
    expect(fromEmpty).toBe(true);
    expect(fromNonEmpty).toBe(9);
  });

  it("maybe->either", async () => {
    const env = await freshEnv();
    const [fromJust] = await exec("(right? (maybe->either (just 1) 'no-just))", { env });
    const [fromNothing] = await exec("(left? (maybe->either (nothing) 'no-just))", { env });
    const [leftValue] = await exec("(either-ref/default (maybe->either (nothing) 'no-just) 'unused)", { env });
    expect(fromJust).toBe(true);
    expect(fromNothing).toBe(true);
    expect(String(leftValue)).toBe("unused"); // left? path, so either-ref/default falls to `default` — pinning the branch taken
  });
});

describe("scheme/srfi-189 — Either accessors/combinators", () => {
  it("either-ref: unwraps a Right; calls failure with the Left value", async () => {
    const env = await freshEnv();
    const [unwrapped] = await exec("(either-ref (right 7))", { env });
    const [viaFailure] = await exec("(either-ref (left 'boom) (lambda (v) v))", { env });
    expect(unwrapped).toBe(7);
    expect(String(viaFailure)).toBe("boom"); // ASymbol print repr
  });

  it("either-ref: errors on Left with no failure procedure (default behavior unchanged)", async () => {
    const env = await freshEnv();
    await expect(execState("(either-ref (left 'boom))", { env })).rejects.toThrow(/either-ref: Left/);
  });

  it("either-ref/default", async () => {
    const env = await freshEnv();
    const [fromRight] = await exec("(either-ref/default (right 1) 99)", { env });
    const [fromLeft] = await exec("(either-ref/default (left 'boom) 99)", { env });
    expect(fromRight).toBe(1);
    expect(fromLeft).toBe(99);
  });

  it("either-bind: applies f to the Right value, short-circuits on Left", async () => {
    const env = await freshEnv();
    const [boundValue] = await exec("(either-ref (either-bind (right 1) (lambda (x) (right (+ x 1)))))", { env });
    const [shortCircuit] = await exec("(left? (either-bind (left 'boom) (lambda (x) (right x))))", { env });
    expect(boundValue).toBe(2);
    expect(shortCircuit).toBe(true);
  });

  it("either-map: maps f over a Right, preserving Left", async () => {
    const env = await freshEnv();
    const [mapped] = await exec("(either-ref (either-map (lambda (x) (* x 2)) (right 5)))", { env });
    const [preserved] = await exec("(left? (either-map (lambda (x) (* x 2)) (left 'boom)))", { env });
    expect(mapped).toBe(10);
    expect(preserved).toBe(true);
  });

  it("either->list", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(either->list (right 5))")).toBe("(5)");
    expect(await printed(env, "(either->list (left 'boom))")).toBe("()");
  });

  it("either-swap: swaps Left/Right, errors on a non-Either", async () => {
    const env = await freshEnv();
    const [swappedToRight] = await exec("(right? (either-swap (left 'x)))", { env });
    const [swappedToLeft] = await exec("(left? (either-swap (right 1)))", { env });
    await expect(execState('(either-swap "not-an-either")', { env })).rejects.toThrow(/either-swap: not an Either/);
    expect(swappedToRight).toBe(true);
    expect(swappedToLeft).toBe(true);
  });
});

describe("scheme/srfi-189 — the dep edge is real (§2.1's undeclared-dep bug class, now a declared edge)", () => {
  it("standalone .apply() (bypassing assembleEnv's C3 dep-walk): a `list`-needing call (BASE_PACKS-only `scheme/lists`) genuinely fails unbound", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi189-standalone-list-unbound");
    await srfi189.lower({ evalScheme }).apply(env, undefined as never);
    await expect(execState("(just 1)", { env })).rejects.toThrow();
  });

  it("standalone .apply(): a pair?/eq?-only call (NATIVE_PACKS `scheme/equality`, already on global_env) resolves via runtime luck — the mirror of srfi-43's own finding", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi189-standalone-equality-luck");
    await srfi189.lower({ evalScheme }).apply(env, undefined as never);
    await expect(execState('(just? "not-a-just")', { env })).resolves.not.toThrow();
  });

  it("bake itself succeeds even with deps unapplied — the FV law is a STATIC declared-`deps` check, not a runtime-binding probe", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi189-standalone-bake-ok");
    await expect(srfi189.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("assembleEnv (the real orchestration path — every production caller) DOES walk deps: list/error-needing ops work standalone", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi189-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [srfi189.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingAmbient;
    const [justResult] = await exec("(maybe-ref (just 42))", { env: typedEnv });
    expect(justResult).toBe(42);
    await expect(execState("(maybe-ref (nothing))", { env: typedEnv })).rejects.toThrow(/maybe-ref: Nothing/);
  });
});

describe("scheme/srfi-189 — contract ENFORCEMENT fires at the call boundary", () => {
  it("maybe-bind: a non-procedure f is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(maybe-bind (just 1) "not-a-procedure")', { env })).rejects.toThrow();
  });

  it("either-map: a non-procedure f is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(either-map "not-a-procedure" (right 1))', { env })).rejects.toThrow();
  });
});

describe("scheme/srfi-189 — the §2.1 bake FV law passes for this pack AS MIGRATED", () => {
  it("lowers cleanly with its declared deps — never DefineLocalityError", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi189-fv-law-ok");
    await expect(srfi189.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — the same `list` free reference with NO declared deps — throws DefineLocalityError: the bug this migration fixes was real", async () => {
    const env = await freshEnv();
    const undeclaredJust = symbol.define`bad-just: reproduces the pre-migration srfi-189 bug (no declared dep on scheme/lists' list)`(
      { input: [z.value], output: [z.value] },
      `(lambda (x) (list 'just x))`,
    );
    // Deliberately NO `deps` field — this is the exact shape srfi-189.ts had before
    // this migration (a bare `prelude` string with no dep declaration at all).
    const undeclaredCap = new EnvCapability("test/srfi-189-pre-fix-repro", {
      symbols: { "bad-just": undeclaredJust },
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

describe("scheme/srfi-189 — faithfulness: `error`'s handler-stack integration survives migration", () => {
  it("maybe-ref's default failure path invokes an installed with-exception-handler handler — not a bare JS throw that bypasses it entirely", async () => {
    const env = await freshEnv();
    // `raise` (which `error` ultimately calls) is NON-continuable: R7RS §6.11 says a
    // handler that RETURNS NORMALLY for a non-continuable raise triggers a SECONDARY
    // exception ("exception handler returned for non-continuable exception" —
    // r7rs/exceptions.ts's own `raise` body). If migration had bypassed the real
    // `error`/`raise` machinery (a bare JS `throw`), this handler would never run at
    // all and the ORIGINAL "maybe-ref: Nothing" message would surface instead — so
    // seeing the SECONDARY message here is the positive proof the handler WAS invoked.
    await expect(
      execState(
        `(with-exception-handler
           (lambda (exn) 'caught-by-handler)
           (lambda () (maybe-ref (nothing))))`,
        { env },
      ),
    ).rejects.toThrow(/exception handler returned for non-continuable exception/);
  });

  it("either-swap's non-Either error path is likewise a real raise, catchable by guard", async () => {
    const env = await freshEnv();
    const [caught] = await exec(`(guard (exn (#t 'caught)) (either-swap 42))`, { env });
    expect(String(caught)).toBe("caught"); // symbol egress = plain interned name (⚖️ 2026-07-14, constitution §2.1)
  });
});

describe("scheme/srfi-189 — the maybe->list/either->list contract is validate-only, never JS-decoded", () => {
  it("a sibling define can still car/cdr the returned list (a real scheme AListAlike, not a decoded JS array)", async () => {
    const env = await freshEnv();
    const [firstOfList] = await exec("(car (maybe->list (just 5)))", { env });
    const [nullOnEmpty] = await exec("(null? (maybe->list (nothing)))", { env });
    expect(firstOfList).toBe(5);
    expect(nullOnEmpty).toBe(true);
  });
});

// srfi-1-symbol-define.test.ts — W4/H3 pack migration rows for `scheme/srfi-1`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2.1/§4/§4.5).
//
// Dep edges (current pack): `deps: [equality, numeric, exceptions, lists]` —
// NATIVE free names (`not`/`equal?`/`pair?`/`null?`, `+`/`-`/…) + BASE free names
// (`error`, `cons`/`reverse`/`append`/`member`/`length`/`map`/`apply`/`list`).
// Multi-return is doored on binding; this pack does NOT depend on binding —
// span/break/partition return `(list a b)` products, not `values`.
//
// §4.5 PERF LEDGER (historical migration pin — median of 5 after warmup):
//   (partition odd? (iota 2000))                    381.5ms → 361.4ms   (≈equal)
//   (take (iota 2000) 1000)                         235.9ms → 226.3ms   (≈equal)
//   (zip (iota 150) (iota 150))                      24.7ms →  27.3ms   (+10%)
//   (every (lambda (x) (< x 999999)) (iota 500))     46.1ms →  42.7ms   (≈equal)
//   (map first (map list (iota 1000)))               40.1ms →  46.4ms   (+16%)
// Verdict: boundary decode is noise-to-16% against interpretation cost. Named-let
// bodies keep recursion off the contract boundary; `validate:false` unused.
//
// Row families:
//   1. behavior equivalence — srfi.test.ts baseline + dotted-tail take/drop, etc.
//   2. two-list products — span/break/partition return `(list a b)` (not multi-values).
//   3. dep edges are real — standalone .apply() leaves BASE-only names unbound.
//   4. contract enforcement on cold entries; first/first? teaching below the boundary.
//   5. bake FV law — free `values` with no binding dep still throws DefineLocalityError
//      (historical multi-return shape, still a valid locality repro).
//   6. base-packs C3 — exceptions/lists appear after scheme/srfi-1.
//   7. implement-or-door — 2026-07-13 ruling: any?/every? are the honest booleans,
//      some aliases any?, bare any/every are SRFI value-returning; ! / pure-
//      unshipped names are doors.
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../AmbientRuntime.js";
import { EnvCapability } from "../../../common/capability.js";
import { exec, execState } from "../../../eval/generator-exec.js";
import { global_env } from "../../env-roots.js";
import { initBridge } from "../../../index.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { assembleEnv } from "../../../common/kernel.js";
import { DefineLocalityError } from "../../../errors.js";
import { BASE_PACKS } from "../../base-packs.js";
import srfi1 from "../srfi-1.js";
import type { SchemeEnv } from "../../../common/scheme-env.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { printValue } from "../../../values/print.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingAmbient, skipBootstrapWait: true });

// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format) —
// needed for list-shaped results, where exec()'s SIMPLE-tier `toJS` unwrap egresses
// an R9 lazy proxy rather than a plain comparable value (mirrors
// src/__tests__/srfi.test.ts's own `run` helper).
//
// `printValue` (values/print.ts), NOT `x.toString()`: the print protocol is
// `arrival/print`, not `toString` — APair happens to also define `toString` as a
// delegating alias (APair.ts), which is why a bare `.toString()` accidentally worked
// for every list-shaped row this suite had before the vector rows below. AVector
// answers `arrival/print` only (no `toString` override), so `.toString()` on a vector
// result falls through to `Object.prototype.toString` ("[object Object]") — `printValue`
// is the representation-blind printer every value (list OR vector) actually answers.
async function printed(env: ResolvingAmbient, src: string): Promise<string> {
  const { values: r } = await execState(src, { env });
  const x = r[r.length - 1] as unknown;
  return printValue(x);
}

describe("scheme/srfi-1 — behavior equivalence (§4.2 gate), weighted toward the named-let-normalized bodies", () => {
  it("take / drop — SRFI-1's dotted-tail tolerance preserved; the old any-value-at-n>0 tolerance is now a loud crash (tagless-final dispatcher migration)", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(take '(1 2 3 4 5) 2)")).toBe("(1 2)");
    expect(await printed(env, "(drop '(1 2 3 4 5) 2)")).toBe("(3 4 5)");
    // SRFI-1: "(take '(1 2 3 . d) 2) ⇒ (1 2)"; "(drop '(1 2 3 . d) 2) ⇒ (3 . d)"
    expect(await printed(env, "(take '(1 2 3 . d) 2)")).toBe("(1 2)");
    expect(await printed(env, "(drop '(1 2 3 . d) 2)")).toBe("(3 . d)");
    // n beyond length — still tolerated (the receiver's own term's job, not the
    // dispatcher's)
    expect(await printed(env, "(take '(1 2) 99)")).toBe("(1 2)");
    // A non-pair/non-vector xs used to silently answer '()/xs itself (the prelude-era
    // "lis may be any value" tolerance) — that tolerance is GONE. `5` declares neither
    // `arrival/tagless-final/take` nor `arrival/tagless-final/drop`, so the dispatcher's
    // term-lookup gate crashes loudly instead of masking the mistake.
    await expect(printed(env, "(take 5 3)")).rejects.toThrow(/does not support take/);
    await expect(printed(env, "(drop 5 3)")).rejects.toThrow(/does not support drop/);
  });

  it("take / drop / take-while / drop-while on vectors — same-kind (vector→vector), non-collection crashes loudly", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(take #(1 2 3 4 5) 2)")).toBe("#(1 2)");
    expect(await printed(env, "(drop #(1 2 3) 1)")).toBe("#(2 3)");
    expect(await printed(env, "(take #(1 2) 99)")).toBe("#(1 2)");
    expect(await printed(env, "(drop #(1 2) 99)")).toBe("#()");
    expect(await printed(env, "(take-while even? #(2 4 6 1 8))")).toBe("#(2 4 6)");
    expect(await printed(env, "(drop-while even? #(2 4 6 1 8))")).toBe("#(1 8)");
    // Empty-input edge rows — both representations answer their own empty form.
    expect(await printed(env, "(take-while even? '())")).toBe("()");
    expect(await printed(env, "(take '() 3)")).toBe("()");
    // A receiver declaring neither term (a bare number) crashes loudly, not silently.
    await expect(printed(env, "(take-while even? 42)")).rejects.toThrow(/does not support/);
    await expect(printed(env, "(drop-while even? 42)")).rejects.toThrow(/does not support/);
  });

  it("first…tenth walk through %list-nth (named-let normalized) and keep the teaching error", async () => {
    const env = await freshEnv();
    const [first] = await exec("(first '(1 2 3))", { env });
    const [tenth] = await exec("(tenth '(1 2 3 4 5 6 7 8 9 10))", { env });
    expect(first).toBe(1);
    expect(tenth).toBe(10);
    // '() passes the listAlike boundary DELIBERATELY so %list-nth's message stays
    // the error surface (srfi-1.ts's first…tenth comment) — not a zod rejection.
    await expect(execState("(first '())", { env })).rejects.toThrow(/first: list has no elements/);
    await expect(execState("(third '(1 2))", { env })).rejects.toThrow(/third: list has fewer than 3 elements/);
  });

  it("any? / every? / some / %any-null? (named-let normalized) — HONEST #t/#f results, vacuous truths, parallel lists (2026-07-13 ruling: bare any/every are SRFI value-returning now — see the dedicated describe block below)", async () => {
    const env = await freshEnv();
    const [someT] = await exec("(some odd? '(2 4 5))", { env });
    const [someF] = await exec("(some odd? '(2 4 6))", { env });
    const [someEmpty] = await exec("(some odd? '())", { env });
    const [anyQT] = await exec("(any? odd? '(2 4 5))", { env });
    const [anyQF] = await exec("(any? odd? '(2 4 6))", { env });
    const [anyQEmpty] = await exec("(any? odd? '())", { env });
    const [everyQT] = await exec("(every? odd? '(1 3 5))", { env });
    const [everyQF] = await exec("(every? odd? '(1 3 4))", { env });
    const [everyQEmpty] = await exec("(every? odd? '())", { env });
    const [parallel] = await exec("(some (lambda (a b) (= (+ a b) 5)) '(1 2 3) '(9 3 9))", { env });
    expect(someT).toBe(true);
    expect(someF).toBe(false);
    expect(someEmpty).toBe(false);
    expect(anyQT).toBe(true);
    expect(anyQF).toBe(false);
    expect(anyQEmpty).toBe(false);
    expect(everyQT).toBe(true);
    expect(everyQF).toBe(false);
    expect(everyQEmpty).toBe(true);
    expect(parallel).toBe(true);
  });

  it("any / every (2026-07-13 ruling) — SRFI-1 value-returning: any → first truthy predicate RESULT or #f; every → LAST predicate result if all truthy, #t on empty, #f on first falsy", async () => {
    const env = await freshEnv();
    // any: the predicate RESULT propagates, not a collapsed #t — assv returns the
    // matched (key . value) pair, and that pair IS any's return value.
    expect(await printed(env, "(any (lambda (x) (assv x '((1 . a)))) '(0 1))")).toBe("(1 . a)");
    // any: no element's result is truthy → #f, same shape as any?/some.
    const [anyMiss] = await exec("(any odd? '(2 4))", { env });
    expect(anyMiss).toBe(false);
    // every: once every element-tuple is truthy, the LAST predicate result wins —
    // (* 2 2) = 4 is the value every returns, not #t.
    const [everyLast] = await exec("(every (lambda (x) (* x 2)) '(1 2))", { env });
    expect(everyLast).toBe(4);
    // every: a predicate that only ever answers #t/#f (odd?) still surfaces that
    // #t/#f as the LAST result — every and every? coincide for boolean-only preds.
    const [everyBoolLast] = await exec("(every odd? '(1 3 5))", { env });
    expect(everyBoolLast).toBe(true);
    // empty-list rows: any is #f (no element to be truthy); every is #t (vacuous
    // truth, same base case as every?).
    const [anyEmpty] = await exec("(any odd? '())", { env });
    const [everyEmpty] = await exec("(every odd? '())", { env });
    expect(anyEmpty).toBe(false);
    expect(everyEmpty).toBe(true);
    // R7RS truthiness (only #f is false — arrival's own fix, commits c16dfd2ef7):
    // a '()-returning predicate is a TRUTHY match, so any returns '() itself — the
    // `(if r r (loop ...))` bind-the-result idiom must not collapse it to #t.
    expect(await printed(env, "(any (lambda (x) '()) '(1))")).toBe("()");
  });

  it("zip (named-let normalized) — transpose, stops at the shortest, () on empty", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(zip '(1 2 3) '(a b))")).toBe("((1 a) (2 b))");
    expect(await printed(env, "(zip '() '(a b))")).toBe("()");
    expect(await printed(env, "(zip)")).toBe("()");
  });

  it("take-while / drop-while / find-tail / list-index / unfold", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(take-while even? '(2 4 6 1 8))")).toBe("(2 4 6)");
    expect(await printed(env, "(drop-while even? '(2 4 6 1 8))")).toBe("(1 8)");
    expect(await printed(env, "(find-tail odd? '(2 4 5 6))")).toBe("(5 6)");
    const [noTail] = await exec("(find-tail odd? '(2 4 6))", { env });
    expect(noTail).toBe(false);
    const [idx] = await exec("(list-index odd? '(2 4 5 6))", { env });
    const [noIdx] = await exec("(list-index odd? '(2 4 6))", { env });
    expect(idx).toBe(2);
    expect(noIdx).toBe(false);
    expect(await printed(env, "(unfold (lambda (x) (if (< x 4) (cons x (+ x 1)) #f)) 1)")).toBe("(1 2 3)");
  });

  it("iota / range / list-tabulate / delete / delete-duplicates / remove", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(iota 4)")).toBe("(0 1 2 3)");
    expect(await printed(env, "(iota 3 1 2)")).toBe("(1 3 5)");
    expect(await printed(env, "(range 3)")).toBe("(0 1 2)");
    expect(await printed(env, "(list-tabulate 4 (lambda (i) (* i i)))")).toBe("(0 1 4 9)");
    expect(await printed(env, "(delete 2 '(1 2 3 2 4))")).toBe("(1 3 4)");
    expect(await printed(env, "(delete-duplicates '(1 2 1 3 2))")).toBe("(1 2 3)");
    expect(await printed(env, "(remove odd? '(1 2 3 4))")).toBe("(2 4)");
  });

  it("fold-right / reduce-right / concatenate / append-reverse / append-map / filter-map / count", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(fold-right cons '() '(1 2 3))")).toBe("(1 2 3)");
    const [rr] = await exec("(reduce-right - 0 '(2 3 4))", { env });
    expect(rr).toBe(3); // (- 2 (- 3 4))
    const [rrEmpty] = await exec("(reduce-right - 42 '())", { env });
    expect(rrEmpty).toBe(42);
    expect(await printed(env, "(concatenate '((1 2) () (3)))")).toBe("(1 2 3)");
    expect(await printed(env, "(append-reverse '(3 2 1) '(4 5))")).toBe("(1 2 3 4 5)");
    expect(await printed(env, "(append-map (lambda (x) (list x x)) '(1 2))")).toBe("(1 1 2 2)");
    expect(await printed(env, "(filter-map (lambda (x) (if (odd? x) (* x 10) #f)) '(1 2 3))")).toBe("(10 30)");
    const [c] = await exec("(count odd? '(1 2 3 4 5))", { env });
    expect(c).toBe(3);
  });

  it("last / last-pair / first? / first-or / length+", async () => {
    const env = await freshEnv();
    const [last] = await exec("(last '(1 2 3))", { env });
    expect(last).toBe(3);
    expect(await printed(env, "(last-pair '(1 2 3))")).toBe("(3)");
    // first?'s falsy-on-empty contract is THE load-bearing semantics (file header)
    const [fq] = await exec("(first? '())", { env });
    const [fqVal] = await exec("(first? '(7))", { env });
    const [fqNonList] = await exec("(first? 5)", { env });
    const [fo] = await exec("(first-or '() 9)", { env });
    expect(fq).toBe(false);
    expect(fqVal).toBe(7);
    expect(fqNonList).toBe(false); // z.value input: TOTAL tolerance is the contract
    expect(fo).toBe(9);
    const [len] = await exec("(length+ '(1 2 3))", { env });
    const [lenDotted] = await exec("(length+ '(1 2 . 3))", { env });
    expect(len).toBe(3);
    expect(lenDotted).toBe(2); // counts pairs up to the dotted tail — prelude-era behavior, preserved
  });
});

describe("scheme/srfi-1 — two-list products (single value; multi-return is doored)", () => {
  it("partition / span / break return (list a b)", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(partition even? '(1 2 3 4 5 6))")).toBe("((2 4 6) (1 3 5))");
    expect(await printed(env, "(span even? '(2 4 1 3))")).toBe("((2 4) (1 3))");
    expect(await printed(env, "(break even? '(1 3 2 4))")).toBe("((1 3) (2 4))");
  });
});

describe("scheme/srfi-1 — the dep edges are real (§2.1's undeclared-dep bug class, now declared)", () => {
  it("standalone .apply() (bypassing assembleEnv's C3 dep-walk): a BASE_PACKS-only name genuinely fails unbound — the srfi-189 shape of the luck, not srfi-43's", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi1-standalone-unbound");
    await srfi1.lower({ evalScheme }).apply(env, undefined as never);
    // NATIVE_PACKS names exist on global_env — BASE_PACKS-only (`cons`/`list` @ lists,
    // `error` @ exceptions) do not without assembleEnv. partition uses `list`/`cons`.
    await expect(execState("(partition odd? '(1 2))", { env: env as unknown as ResolvingAmbient })).rejects.toThrow(
      /Unbound variable/,
    );
  });

  it("assembleEnv (the real orchestration path — every production caller) walks deps: everything works standalone", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi1-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [srfi1.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingAmbient;
    expect(await printed(typedEnv, "(partition odd? '(1 2 3))")).toBe("((1 3) (2))");
    const [second] = await exec("(second '(1 2 3))", { env: typedEnv });
    expect(second).toBe(2);
  });
});

describe("scheme/srfi-1 — contract ENFORCEMENT fires at the call boundary (cold entries)", () => {
  it("delete-duplicates: a non-list is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(delete-duplicates "not-a-list")', { env })).rejects.toThrow();
  });

  it("fold-right: a non-procedure f is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState('(fold-right "not-a-procedure" 0 (list 1 2))', { env })).rejects.toThrow();
  });

  it("length+: a non-list is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState("(length+ 42)", { env })).rejects.toThrow();
  });

  it("last-pair: '() is now a boundary rejection (z.pair — SRFI's non-empty domain), the §4.2 sanctioned error-surface move off loose-cdr luck", async () => {
    const env = await freshEnv();
    await expect(execState("(last-pair '())", { env })).rejects.toThrow();
  });
});

describe("scheme/srfi-1 — the §2.1 bake FV law passes AS MIGRATED", () => {
  it("lowers cleanly with its declared deps — never DefineLocalityError", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi1-fv-law-ok");
    await expect(srfi1.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL repro of the PRE-FIX shape — a free `values` reference with NO declared deps — throws DefineLocalityError: the luck this migration converts into structure was real", async () => {
    const env = await freshEnv();
    const undeclaredCap = EnvCapability.define("test/srfi-1-pre-fix-repro", {
      symbols: (symbol, z) => ({
        "bad-span":
          symbol.define`bad-span: reproduces the pre-migration srfi-1 bug (free values reference, no declared dep on scheme/binding)`(
            { input: [z.lambda, z.union([z.pair, z.nil])], output: [z.values] },
            `(lambda (pred xs) (values xs xs))`,
          ),
      }),
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

describe("scheme/srfi-1 — base-packs C3 positioning for declared deps (exceptions, lists)", () => {
  it("exceptions and lists appear exactly once each, AFTER scheme/srfi-1", () => {
    const names = BASE_PACKS.map((pack) => pack.name);
    const srfi1Index = names.indexOf("scheme/srfi-1");
    expect(srfi1Index).toBeGreaterThan(-1);
    for (const dep of ["scheme/r7rs/exceptions", "scheme/lists"] as const) {
      expect(names.filter((n) => n === dep)).toHaveLength(1);
      expect(names.indexOf(dep)).toBeGreaterThan(srfi1Index);
    }
  });
});

describe("scheme/srfi-1 — implement-or-door + the any?/every?/some split (2026-07-13 ruling)", () => {
  it("any is NO LONGER the SRFI name for some — it's SRFI-1's own value-returning quantifier; some aliases any? instead", async () => {
    const env = await freshEnv();
    // A predicate returning a non-#t truthy VALUE makes the split concrete: any
    // propagates that value; any?/some collapse it to the honest #t.
    const [a] = await exec("(any (lambda (x) (if (odd? x) 99 #f)) '(2 4 5))", { env });
    const [anyQ] = await exec("(any? odd? '(2 4 5))", { env });
    const [s] = await exec("(some odd? '(2 4 5))", { env });
    expect(a).toBe(99);
    expect(anyQ).toBe(true);
    expect(s).toBe(true);
    const [none] = await exec("(any odd? '(2 4))", { env });
    expect(none).toBe(false);
  });

  it("linear-update and pure-unshipped names are doors, not silent absences", () => {
    // Stage A2: each entry is now a minted A-value — `harvestContracts` pulls the AEntity
    // CONTRACT (still carrying `.kind`) off each one.
    const symbols = harvestContracts(srfi1.spec.symbols);
    for (const name of ["take!", "filter!", "reverse!", "xcons", "lset-union", "car+cdr", "split-at"] as const) {
      expect(symbols[name]?.kind, name).toBe("door");
    }
    // live family still live
    expect(symbols.take?.kind).not.toBe("door");
    expect(symbols.some?.kind).not.toBe("door");
    expect(symbols["any?"]?.kind).not.toBe("door");
    expect(symbols["every?"]?.kind).not.toBe("door");
    expect(symbols.any?.kind).not.toBe("door");
    expect(symbols.every?.kind).not.toBe("door");
  });
});

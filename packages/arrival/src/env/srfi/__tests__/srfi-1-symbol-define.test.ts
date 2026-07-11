// srfi-1-symbol-define.test.ts — W4/H3 pack migration rows for `scheme/srfi-1`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§4/§4.5).
//
// BOTH luck classes at once (srfi-1.ts's header): the 37 former prelude defines
// freely referenced `not`/`equal?`/`eq?`/`pair?`/`null?` (equality), `<=`/`<`/`>=`/
// `=`/`+`/`-`/`*` (numeric) — the NATIVE_PACKS runtime-guarantee class srfi-43
// found — AND `values` (binding), `error` (exceptions), `cons`/`reverse`/`append`/
// `member`/`length`/`map`/`apply` (lists) — the BASE_PACKS assembly-order class
// srfi-235 found. `deps: [equality, numeric, binding, exceptions, lists]` converts
// all of it into declared, bake-checked edges; `binding` is the FOURTH BASE_PACKS
// tail-block repositioning (base-packs.ts's header).
//
// §4.5 PERF LEDGER (the hot-path pack's measured protocol — median of 5 after
// warmup, same machine, prelude-era HEAD vs this migration, enforcement ON):
//   (partition odd? (iota 2000))                    381.5ms → 361.4ms   (≈equal)
//   (take (iota 2000) 1000)                         235.9ms → 226.3ms   (≈equal)
//   (zip (iota 150) (iota 150))                      24.7ms →  27.3ms   (+10%)
//   (every (lambda (x) (< x 999999)) (iota 500))     46.1ms →  42.7ms   (≈equal)
//   (map first (map list (iota 1000)))               40.1ms →  46.4ms   (+16%)
// Verdict: boundary decode is noise-to-16% against interpretation cost. The seven
// prelude-era DIRECT self-recursers (take, drop, %list-nth, %any-null?, %some,
// %every, zip) were normalized to the file's dominant named-let idiom so recursion
// never re-crosses the contract boundary — enforcement stays ON for all 37 defines
// and the §1.2 `validate:false` valve is UNUSED (evidence-gated, per §4.5; the
// numbers above are the evidence it is not needed).
//
// Row families:
//   1. behavior equivalence (§4.2 semantic-equivalence gate) — the existing
//      srfi.test.ts baseline plus direct rows here, weighted toward the seven
//      named-let-normalized bodies and the SRFI-blessed edge shapes (dotted-tail
//      take/drop, length+ on a dotted list, empty-list vacuous truths).
//   2. multi-values — span/break/partition return ONE `Values` box; the new
//      `z.values` orphan schema (scheme-zod.ts, the z.error precedent) validates it.
//   3. dep edges are real — standalone .apply() (no C3 dep-walk) leaves the
//      BASE_PACKS-only names (`values`) genuinely unbound; assembleEnv works.
//   4. contract enforcement fires on COLD entries — boundary rejection before the
//      body runs — AND the teaching surfaces deliberately kept BELOW the boundary
//      (first on '() still says "first: list has no elements"; first? stays total).
//   5. the §2.1 bake FV law passes as migrated; a local repro of the pre-fix shape
//      (free `values` reference, no deps) throws DefineLocalityError.
//   6. base-packs C3 positioning — `binding` sits AFTER `scheme/srfi-1` (the actual
//      C3 requirement its repositioning exists to satisfy), pinned shape-free so
//      sibling migrations can extend the tail block without touching this row.
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
import { BASE_PACKS } from "../../base-packs.js";
import srfi1 from "../srfi-1.js";
import type { SchemeEnv } from "../../../common/scheme-env.js";
import type { ResolvingAmbient } from "../../../AmbientRuntime.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingAmbient, skipBootstrapWait: true });

// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format) —
// needed for list-shaped results, where exec()'s SIMPLE-tier `toJS` unwrap egresses
// an R9 lazy proxy rather than a plain comparable value (mirrors
// src/__tests__/srfi.test.ts's own `run` helper).
async function printed(env: ResolvingAmbient, src: string): Promise<string> {
  const { values: r } = await execState(src, { env });
  const x = r[r.length - 1] as { toString(): string } | undefined;
  return String(x?.toString?.() ?? x);
}

describe("scheme/srfi-1 — behavior equivalence (§4.2 gate), weighted toward the named-let-normalized bodies", () => {
  it("take / drop — including SRFI-1's dotted-tail and any-value tolerances (xs is z.value BY SPEC)", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(take '(1 2 3 4 5) 2)")).toBe("(1 2)");
    expect(await printed(env, "(drop '(1 2 3 4 5) 2)")).toBe("(3 4 5)");
    // SRFI-1: "(take '(1 2 3 . d) 2) ⇒ (1 2)"; "(drop '(1 2 3 . d) 2) ⇒ (3 . d)"
    expect(await printed(env, "(take '(1 2 3 . d) 2)")).toBe("(1 2)");
    expect(await printed(env, "(drop '(1 2 3 . d) 2)")).toBe("(3 . d)");
    // n beyond length / n<=0 / non-pair xs — the prelude-era tolerances, preserved
    expect(await printed(env, "(take '(1 2) 99)")).toBe("(1 2)");
    expect(await printed(env, "(take 5 3)")).toBe("()");
    expect(await printed(env, "(drop 5 3)")).toBe("5");
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

  it("some / every / %any-null? (named-let normalized) — #t/#f results, vacuous truths, parallel lists", async () => {
    const env = await freshEnv();
    const [someT] = await exec("(some odd? '(2 4 5))", { env });
    const [someF] = await exec("(some odd? '(2 4 6))", { env });
    const [someEmpty] = await exec("(some odd? '())", { env });
    const [everyT] = await exec("(every odd? '(1 3 5))", { env });
    const [everyF] = await exec("(every odd? '(1 3 4))", { env });
    const [everyEmpty] = await exec("(every odd? '())", { env });
    const [parallel] = await exec("(some (lambda (a b) (= (+ a b) 5)) '(1 2 3) '(9 3 9))", { env });
    expect(someT).toBe(true);
    expect(someF).toBe(false);
    expect(someEmpty).toBe(false);
    expect(everyT).toBe(true);
    expect(everyF).toBe(false);
    expect(everyEmpty).toBe(true);
    expect(parallel).toBe(true);
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

describe("scheme/srfi-1 — multi-values cross the boundary as ONE Values box (z.values, the z.error-precedent orphan schema)", () => {
  it("partition / span / break — (values a b), consumed via call-with-values", async () => {
    const env = await freshEnv();
    expect(await printed(env, "(call-with-values (lambda () (partition even? '(1 2 3 4 5 6))) list)")).toBe(
      "((2 4 6) (1 3 5))",
    );
    expect(await printed(env, "(call-with-values (lambda () (span even? '(2 4 1 3))) list)")).toBe("((2 4) (1 3))");
    expect(await printed(env, "(call-with-values (lambda () (break even? '(1 3 2 4))) list)")).toBe("((1 3) (2 4))");
  });
});

describe("scheme/srfi-1 — the dep edges are real (§2.1's undeclared-dep bug class, now declared)", () => {
  it("standalone .apply() (bypassing assembleEnv's C3 dep-walk): a BASE_PACKS-only name genuinely fails unbound — the srfi-189 shape of the luck, not srfi-43's", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi1-standalone-unbound");
    await srfi1.lower({ evalScheme }).apply(env, undefined as never);
    // NATIVE_PACKS names (pair?, null?, =) exist on global_env — but the BASE_PACKS-
    // only class (`cons`/`reverse` @ scheme/lists, `values` @ scheme/r7rs/binding,
    // `error` @ scheme/r7rs/exceptions) does not: the assembly-order luck the static
    // FV law refuses to consult, demonstrated at runtime (partition's body dies at
    // its first BASE_PACKS-only lookup, `cons`).
    await expect(execState("(partition odd? '(1 2))", { env: env as unknown as ResolvingAmbient })).rejects.toThrow(
      /Unbound variable/,
    );
  });

  it("assembleEnv (the real orchestration path — every production caller) walks deps: everything works standalone", async () => {
    await initBridge();
    const env = mintFrame(global_env, "test-srfi1-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [srfi1.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingAmbient;
    expect(await printed(typedEnv, "(call-with-values (lambda () (partition odd? '(1 2 3))) list)")).toBe(
      "((1 3) (2))",
    );
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
    const undeclaredSpan = symbol.define`bad-span: reproduces the pre-migration srfi-1 bug (free values reference, no declared dep on scheme/binding)`(
      { input: [z.lambda, z.union([z.pair, z.nil])], output: [z.values] },
      `(lambda (pred xs) (values xs xs))`,
    );
    const undeclaredCap = new EnvCapability("test/srfi-1-pre-fix-repro", {
      symbols: { "bad-span": undeclaredSpan },
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

describe("scheme/srfi-1 — base-packs C3 positioning for the binding repositioning", () => {
  it("scheme/r7rs/binding appears exactly once, AFTER scheme/srfi-1 (the C3 'dependency ranks below its dependent' requirement) — shape-free so sibling tail-block additions never touch this row", () => {
    const names = BASE_PACKS.map((pack) => pack.name);
    expect(names.filter((n) => n === "scheme/r7rs/binding")).toHaveLength(1);
    const bindingIndex = names.indexOf("scheme/r7rs/binding");
    const srfi1Index = names.indexOf("scheme/srfi-1");
    expect(srfi1Index).toBeGreaterThan(-1);
    expect(bindingIndex).toBeGreaterThan(srfi1Index);
  });
});

// cond / case / when / unless — kernel SPECIAL FORMS that are also first-class KEYWORDS.
//
// "Make them all special form" (V): these stay evaluator handlers (evalCond/evalCase/
// evalWhen/evalUnless) — TCO-correct, unlike the nested-genRun syntax-rules path, which
// overflows a 50k-deep tail loop (see tail-call.test.ts). The honest §7.3 syntax-rules
// lowering is blocked on a tail-proper macro engine; the special-form handlers are the
// kernel-direct implementation (the "let is as special as car/cdr" logic, extended).
//
// They are ALSO keyword markers (env/core/core.ts), so — like if/begin/let — they are
// uniformly first-class: aliasable, and resolvable from a USER syntax-rules template (the
// hygiene renamer binds the renamed head to the marker; value-first dispatch fires the
// handler). The auxiliary keywords `else`/`=>` survive hygiene because evalCond/evalCase
// match them by `.literal()` (the un-renamed name), not the renamed symbol description.
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../env/AmbientRuntime.js";
import { exec, schemeToJs } from "../../index.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../env/inference-env.js";

const val = (rs: unknown[]) => schemeToJs(rs[rs.length - 1] as never, {});
// `exec` (RULINGS.md R1) now returns the plain-JS unwrap: a symbol's toJS is
// apostrophe-prefixed (ASymbol's documented, deferred opaque-exit marker —
// still design-pending — unchanged by this migration, only newly VISIBLE
// through exec's exit instead of a boxed `.toString()`).
const repr = (rs: unknown[]) => String(rs[rs.length - 1]);

describe("cond/case/when/unless — special forms that are first-class keywords", () => {
  it("alias a control form: (define c cond) → c IS cond", async () => {
    expect(val(await exec(`(define c cond) (c (#f 1) (#t 2) (else 3))`, { env: mintFrame(sandboxedEnv, "cf1") }))).toBe(2);
  });

  it("alias when: (define w when) → w IS when", async () => {
    expect(val(await exec(`(define w when) (w #t 41 42)`, { env: mintFrame(sandboxedEnv, "cf2") }))).toBe(42);
  });

  it("user syntax-rules macro expanding to `when` resolves the keyword", async () => {
    const src = `
      (define-syntax twice-when
        (syntax-rules () ((twice-when t a) (when t (+ a a)))))
      (twice-when #t 21)`;
    expect(val(await exec(src, { env: mintFrame(sandboxedEnv, "cf3") }))).toBe(42);
  });

  it("user macro expanding to `cond` with else — else survives hygiene (.literal() match)", async () => {
    const src = `
      (define-syntax classify
        (syntax-rules ()
          ((classify n) (cond ((< n 0) 'neg) ((= n 0) 'zero) (else 'pos)))))
      (classify 5)`;
    expect(repr(await exec(src, { env: mintFrame(sandboxedEnv, "cf4") }))).toBe("pos");
  });

  it("user macro expanding to `case` with => and else — both auxiliary keywords survive hygiene", async () => {
    const src = `
      (define-syntax bucket
        (syntax-rules ()
          ((bucket k) (case k ((1 2 3) => (lambda (x) (* x 100))) (else 'big)))))
      (bucket 2)`;
    expect(val(await exec(src, { env: mintFrame(sandboxedEnv, "cf5") }))).toBe(200);
  });
});

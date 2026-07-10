// polyglot-symbol-define.test.ts — W4/H3 pack migration rows for `scheme/polyglot`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§3.4/§4).
//
// THE BIG PACK: ~315 prelude lines decomposed into 37 `symbol.define` (34
// procedures + 3 constants: nil/comp/flow) + 4 `symbol.defineSyntax`
// declarations, contract-enforced from day one (§1.2 rev2 ruling). The pre-migration behavior baseline is `polyglot.test.ts` (run
// unmodified except its ONE representation-pinning assertion — flagged there),
// plus `threading-composition.test.ts`. This file adds the migration-specific
// rows, mirroring the H1/H2 precedents (srfi-235/-128/-189):
//
//   1. THE FIRST PRODUCTION `macroAttribute: "expression"` — the threading family
//      (`->`/`->>`/`~>`/`~>>`) declares expression-space arguments, so the static
//      validator WALKS them: `(-> 5 never-bound)` REPORTS at parse phase. This is
//      the row §3.4's table promised and LAW 4 could only pin synthetically.
//   2. deps are REAL edges (§2.1's luck-into-structure): the old prelude reached
//      `filter`/`reduce` (srfi-1), `error` (exceptions), `map`/`apply`/… (lists)
//      and half of NATIVE_PACKS on two-phase-bootstrap luck. Standalone `.apply()`
//      (bypassing assembleEnv's C3 dep-walk) leaves the BASE_PACKS-only names
//      genuinely unbound; the real orchestration path works.
//   3. contract enforcement fires at the call boundary — and, mirrored, the
//      dict-family's `z.value` input judgment PRESERVES the %dict-guard teaching
//      door (a `z.dict()` input contract would have preempted it with a bare zod
//      error — the door is the pack's own errors-as-doors surface).
//   4. the §2.1 bake FV law passes as migrated; a local reproduction of the
//      pre-fix shape (same body, no deps) throws DefineLocalityError.
//   5. C3 tail-order pin: polyglot now LEADS base-packs' tail block (it is both a
//      deps target — srfi-235 — and a dependent), with srfi-1 repositioned after
//      it. (lists' own migration test ROW 7 re-pins `lists`-is-last; this row
//      pins polyglot's side of the same fact.)
//   6. the `applicable` contract admits keyword accessors (`(compose :b :a)`) —
//      the pack's own documented idiom, which a bare `z.lambda` would reject.
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { global_env } from "../../env-roots.js";
import { initBridge } from "../../index.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import { assembleEnv } from "../../common/kernel.js";
import { DefineLocalityError } from "../../errors.js";
import { StaticValidationError } from "../../static-validation/validate-program.js";
import { BASE_PACKS } from "../base-packs.js";
import polyglot from "../polyglot.js";
import type { SchemeEnv } from "../../common/scheme-env.js";
import type { ResolvingEnvironment } from "../../Environment.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingEnvironment, skipBootstrapWait: true });

const defs = polyglot.spec.symbols as Record<string, { kind?: string; macroAttribute?: string; callable?: boolean }>;

describe("scheme/polyglot — the FIRST production expression attribution (§3.4)", () => {
  it.each(["->", "->>", "~>", "~>>"])("%s declares macroAttribute: \"expression\"", (name) => {
    expect(defs[name]?.kind).toBe("define-syntax");
    expect(defs[name]?.macroAttribute).toBe("expression");
  });

  it("the attribution is LIVE: the validator WALKS threading-macro arguments — an unbound step REPORTS at parse phase", async () => {
    // (-> 5 never-bound-thread-step) expands to (never-bound-thread-step 5); under
    // "expression" the argument is walked BEFORE expansion or evaluation — the
    // diagnostic fires at parse phase (an "opaque" declaration would have
    // firewalled it into a runtime unbound instead).
    await expect(exec("(-> 5 never-bound-thread-step-xyz)", { staticValidation: "on" })).rejects.toThrow(
      StaticValidationError,
    );
    await expect(exec("(->> (list 1 2) (map never-bound-mapper-xyz))", { staticValidation: "on" })).rejects.toThrow(
      StaticValidationError,
    );
  });

  it("control: legal threading programs validate clean and run (no false positives from the walk)", async () => {
    const [a] = await exec("(-> 5 (+ 1) (* 2))", { staticValidation: "on" });
    expect(a).toBe(12);
    // Keyword accessors in thread position never enter the FV walk (keyword-shaped
    // names are excluded by construction, §3.5) — the pack's flagship idiom stays clean.
    const [b] = await exec('(->> (dict :a (dict :b 2)) :a :b)', { staticValidation: "on" });
    expect(b).toBe(2);
    const [c] = await exec("(~>> 5 (- 20))", { staticValidation: "on" });
    expect(c).toBe(15);
  });
});

describe("scheme/polyglot — deps are real edges (§2.1 luck-into-structure)", () => {
  it("standalone .apply() (bypassing assembleEnv's C3 dep-walk): a `reduce`-needing call (BASE_PACKS-only, srfi-1) genuinely fails unbound", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-standalone-unbound");
    await polyglot.lower({ evalScheme }).apply(env, undefined as never);
    // frequencies' own natives (@/dict/%dict-set) bound standalone; `repr`/`+`/
    // `string?` are NATIVE_PACKS (global_env — the runtime-luck arm srfi-43's
    // suite documents); `reduce` is srfi-1's, bound only through the dep walk.
    await expect(execState('(frequencies (list "a" "a"))', { env })).rejects.toThrow();
  });

  it("bake itself succeeds with deps unapplied — the FV law is a STATIC declared-`deps` check, not a runtime-binding probe", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-standalone-bake-ok");
    await expect(polyglot.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("assembleEnv (the real orchestration path) walks deps: the srfi-1/exceptions/lists reaches all work standalone", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [polyglot.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingEnvironment;
    const [freq] = await exec('(@ (frequencies (list "a" "b" "a")) "a")', { env: typedEnv }); // reduce (srfi-1)
    expect(Number(freq)).toBe(2);
    const [removed] = await exec("(remove-if (lambda (x) (> x 2)) (list 1 2 3 4))", { env: typedEnv }); // filter (srfi-1)
    expect(String(removed)).toContain("1");
    await expect(execState('(dict-ref "not-a-dict" :a)', { env: typedEnv })).rejects.toThrow(
      /dict-ref: expected a dict/, // error (exceptions) — the door composes through the dep edge
    );
  });
});

describe("scheme/polyglot — contract ENFORCEMENT fires at the call boundary (§1.2 enforced-day-one)", () => {
  it("partial: a non-applicable `f` (neither callable nor symbol) is rejected before the body runs", async () => {
    const env = await freshEnv();
    await expect(execState("(partial 5 1 2)", { env })).rejects.toThrow();
  });

  it("zipmap: a non-list `ks` is rejected at the boundary (z.list spine codec)", async () => {
    const env = await freshEnv();
    await expect(execState("(zipmap 5 (list 1))", { env })).rejects.toThrow();
  });

  it("update-in: a non-applicable updater is rejected", async () => {
    const env = await freshEnv();
    await expect(execState("(update-in (dict :a 1) (list :a) 42)", { env })).rejects.toThrow();
  });

  it("the applicable union ADMITS keyword accessors — (compose :b :a) is the pack's own documented idiom", async () => {
    const env = await freshEnv();
    const [nested] = await exec("((compose :b :a) (dict :a (dict :b 7)))", { env });
    expect(Number(nested)).toBe(7);
    const [grouped] = await exec('(@ (group-by :kind (list (dict :kind "x") (dict :kind "x"))) "x")', { env });
    expect(String(grouped)).toBeTruthy(); // a keyword accessor as group-by's f — applicable, not z.lambda
  });

  it("JUDGMENT PIN — the dict family's `d` stays z.value so the %dict-guard TEACHING door survives (never preempted by a zod boundary error)", async () => {
    const env = await freshEnv();
    await expect(execState("(dict-ref (list 1 2) :a)", { env })).rejects.toThrow(
      /dict-ref: expected a dict .* got a pair\/list.*use @ for an origin-agnostic read/,
    );
    await expect(execState('(dict-count "nope")', { env })).rejects.toThrow(/dict-count: expected a dict .* got a string/);
  });
});

describe("scheme/polyglot — the §2.1 bake FV law passes AS MIGRATED", () => {
  it("lowers cleanly with its declared deps — never DefineLocalityError", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-fv-law-ok");
    await expect(polyglot.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("(regression pin) a LOCAL reproduction of the PRE-FIX shape — a `reduce`/`filter`-reaching body with NO declared deps — throws DefineLocalityError", async () => {
    const env = await freshEnv();
    const undeclaredFrequencies = symbol.define`bad-frequencies: reproduces the pre-migration polyglot luck (no declared dep on srfi-1's reduce)`(
      { input: [z.value], output: [z.value] },
      `(lambda (coll) (reduce (lambda (x acc) (+ acc 1)) 0 coll))`,
    );
    const undeclaredCap = new EnvCapability("test/polyglot-pre-fix-repro", {
      symbols: { "bad-frequencies": undeclaredFrequencies },
    });
    await expect(undeclaredCap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(
      DefineLocalityError,
    );
  });
});

describe("scheme/polyglot — constants and shape (the eager aliases)", () => {
  it("nil / comp / flow are CONSTANT defines (callable: false) aliasing their siblings", () => {
    expect(defs["nil"]?.kind).toBe("define");
    expect(defs["nil"]?.callable).toBe(false);
    expect(defs["comp"]?.callable).toBe(false);
    expect(defs["flow"]?.callable).toBe(false);
    expect(defs["compose"]?.callable).toBe(true);
    expect(defs["pipe"]?.callable).toBe(true);
  });

  it("the aliases bind the SAME procedure values (eager RHS sees the earlier sibling — §2.3 sequential-RHS)", async () => {
    const env = await freshEnv();
    const [same] = await exec("(eq? comp compose)", { env });
    expect(same).toBe(true);
    const [flowSame] = await exec("(eq? flow pipe)", { env });
    expect(flowSame).toBe(true);
    const [nilIsEmpty] = await exec("(null? nil)", { env });
    expect(nilIsEmpty).toBe(true);
  });
});

describe("scheme/polyglot — C3 tail positioning (polyglot is BOTH a deps target and a dependent)", () => {
  it("BASE_PACKS tail runs [polyglot, srfi-1, …, lists]: polyglot after its consumer (srfi-235), before its own deps", () => {
    const names = BASE_PACKS.map((pack) => pack.name);
    const srfi235Index = names.indexOf("scheme/srfi-235");
    const polyglotIndex = names.indexOf("scheme/polyglot");
    const srfi1Index = names.indexOf("scheme/srfi-1");
    const exceptionsIndex = names.indexOf("scheme/r7rs/exceptions");
    const listsIndex = names.indexOf("scheme/lists");
    expect(srfi235Index).toBeGreaterThan(-1);
    // consumer → dependent → its deps, in declared-order agreement with polyglot's
    // own deps array ([…, srfi1, exceptions, lists]).
    expect(srfi235Index).toBeLessThan(polyglotIndex);
    expect(polyglotIndex).toBeLessThan(srfi1Index);
    expect(srfi1Index).toBeLessThan(exceptionsIndex);
    expect(exceptionsIndex).toBeLessThan(listsIndex);
  });

  it("the default bootstrap C3-linearizes and serves the whole idiom family (smoke)", async () => {
    // Bare exec (no env) = the production default path: NATIVE_PACKS + BASE_PACKS
    // through initBridge's assembleEnv — an AssembleLinearizationError anywhere in
    // the reshuffled tail would fail HERE, before any assertion.
    const [threaded] = await exec("(-> 5 (+ 1) (* 2))");
    expect(threaded).toBe(12);
    const [piped] = await exec("((pipe (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)");
    expect(piped).toBe(12);
    const [counted] = await exec("(dict-count (dict :a 1 :b 2))");
    expect(Number(counted)).toBe(2);
  });
});

// polyglot-symbol-define.test.ts — W4/H3 pack migration rows for `scheme/polyglot`
// (docs/working-proposals/symbol-define-static-program-validation.md §1/§2.1/§3.4/§4),
// RE-POINTED to the four post-split packs (V, 2026-07-10 dialect split —
// polyglot.ts's header has the full rationale, per-pack test files carry the
// bulk of the behavior coverage: polyglot.test.ts / polyglot-clojure.test.ts /
// polyglot-lisp.test.ts / polyglot-racket.test.ts). This file keeps the
// MIGRATION-SPECIFIC rows the H1/H2 precedents established (srfi-235/-128/-189):
//
//   1. THE FIRST PRODUCTION `macroAttribute: "expression"` — the threading family
//      (`->`/`->>` in polyglot-clojure, `~>`/`~>>` in polyglot-racket) declares
//      expression-space arguments, so the static validator WALKS them:
//      `(-> 5 never-bound)` REPORTS at parse phase.
//   2. deps are REAL edges (§2.1's luck-into-structure) — verified per pack now,
//      since each dialect pack reaches a DIFFERENT BASE_PACKS-only capability
//      (clojure→srfi-1's reduce, lisp→srfi-1's filter, racket→exceptions' error).
//   3. contract enforcement fires at the call boundary — and, mirrored, the
//      dict-family's `z.value` input judgment PRESERVES the %dict-guard teaching
//      door (a `z.dict()` input contract would have preempted it with a bare zod
//      error — the door is polyglot-racket's own errors-as-doors surface).
//   4. the §2.1 bake FV law passes as migrated, per pack; a local reproduction of
//      the pre-fix shape (same body, no deps) throws DefineLocalityError.
//   5. C3 tail-order pin: the tail now runs [racket, clojure, lisp, polyglot,
//      srfi-1, binding, exceptions, lists] — base-packs.ts's header has the full
//      derivation.
//   6. the `applicable` contract admits keyword accessors (`(compose :b :a)`) —
//      the pack family's own documented idiom, which a bare `z.lambda` would reject.
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
import polyglotClojure from "../polyglot-clojure.js";
import polyglotLisp from "../polyglot-lisp.js";
import polyglotRacket from "../polyglot-racket.js";
import type { SchemeEnv } from "../../common/scheme-env.js";
import type { ResolvingEnvironment } from "../../Environment.js";

// Mirrors `_fresh-env.ts`'s own injected evalScheme — `skipBootstrapWait` because
// these execs run against an env this suite is itself assembling/re-lowering onto,
// not the shared realm-cached bootstrap.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingEnvironment, skipBootstrapWait: true });

type Defs = Record<string, { kind?: string; macroAttribute?: string; callable?: boolean }>;
const coreDefs = polyglot.spec.symbols as Defs;
const clojureDefs = polyglotClojure.spec.symbols as Defs;
const lispDefs = polyglotLisp.spec.symbols as Defs;
const racketDefs = polyglotRacket.spec.symbols as Defs;

describe("scheme/polyglot-clojure & scheme/polyglot-racket — the FIRST production expression attribution (§3.4)", () => {
  it.each(["->", "->>"] as const)("%s (polyglot-clojure) declares macroAttribute: \"expression\"", (name) => {
    expect(clojureDefs[name]?.kind).toBe("define-syntax");
    expect(clojureDefs[name]?.macroAttribute).toBe("expression");
  });

  it.each(["~>", "~>>"] as const)("%s (polyglot-racket) declares macroAttribute: \"expression\"", (name) => {
    expect(racketDefs[name]?.kind).toBe("define-syntax");
    expect(racketDefs[name]?.macroAttribute).toBe("expression");
  });

  it("the attribution is LIVE: the validator WALKS threading-macro arguments — an unbound step REPORTS at parse phase", async () => {
    // (-> 5 never-bound-thread-step) expands to (never-bound-thread-step 5); under
    // "expression" the argument is walked BEFORE expansion or evaluation — the
    // diagnostic fires at parse phase (an "opaque" declaration would have
    // firewalled it into a runtime unbound instead). Bare `exec` (no explicit env)
    // = the default assembled env, which includes every dialect pack.
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
    // names are excluded by construction, §3.5) — the pack family's flagship idiom
    // stays clean.
    const [b] = await exec('(->> (dict :a (dict :b 2)) :a :b)', { staticValidation: "on" });
    expect(b).toBe(2);
    const [c] = await exec("(~>> 5 (- 20))", { staticValidation: "on" });
    expect(c).toBe(15);
  });
});

describe("scheme/polyglot-clojure — deps are real edges (§2.1 luck-into-structure)", () => {
  // NEW CHARACTERISTIC vs the pre-split monolith (found empirically, first draft
  // of this suite): `comp`'s RHS is the bare identifier `compose` — a CONSTANT
  // define, evaluated EAGERLY at apply time (§2.3 sequential-RHS), not a lazy
  // lambda body. In the old monolith `compose`/`comp` lived in the SAME
  // capability, so `comp`'s eager lookup was always self-satisfied by
  // declaration order, regardless of `deps`. Post-split, `compose` lives in a
  // DIFFERENT capability (`scheme/polyglot`, core) — exactly the cross-
  // capability edge the dialect table calls out ("comp aliases compose — deps
  // on shared"). So standalone `.apply()` of JUST polyglot-clojure (bypassing
  // assembleEnv's C3 dep-walk, which would apply core FIRST) now fails
  // IMMEDIATELY on `comp`, before any lazy body (frequencies' `reduce`) is ever
  // reached.
  it("standalone .apply() of clojure ALONE fails immediately on comp's EAGER cross-capability alias, not on any lazy body", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-clojure-standalone-unbound");
    await expect(polyglotClojure.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(/compose/);
  });

  it("once compose is bound (core applied first), bake+apply succeed even with srfi-1 unapplied — the FV law is a STATIC declared-`deps` check, not a runtime-binding probe; the LAZY frequencies (needs srfi-1's reduce) only fails when CALLED", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-clojure-standalone-bake-ok");
    await polyglot.lower({ evalScheme }).apply(env, undefined as never); // core: binds compose
    await expect(polyglotClojure.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
    const typedEnv = env as unknown as ResolvingEnvironment;
    const [same] = await exec("(eq? comp compose)", { env: typedEnv }); // comp resolved — compose was bound
    expect(same).toBe(true);
    // frequencies' own natives (@/dict/%dict-set) bound standalone from core;
    // `repr`/`+`/`string?` are NATIVE_PACKS (global_env — the runtime-luck arm
    // srfi-43's suite documents); `reduce` is srfi-1's, bound only through the
    // dep walk — never applied here, so the LAZY body fails only when CALLED.
    await expect(execState('(frequencies (list "a" "a"))', { env })).rejects.toThrow();
  });

  it("assembleEnv (the real orchestration path) walks deps: the srfi-1 reach works standalone", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-clojure-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [polyglotClojure.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingEnvironment;
    const [freq] = await exec('(@ (frequencies (list "a" "b" "a")) "a")', { env: typedEnv }); // reduce (srfi-1)
    expect(Number(freq)).toBe(2);
  });
});

describe("scheme/polyglot-lisp — deps are real edges (§2.1 luck-into-structure)", () => {
  it("assembleEnv walks deps: the srfi-1 `filter` reach works standalone (no core dep needed)", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-lisp-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [polyglotLisp.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingEnvironment;
    const [removed] = await exec("(remove-if (lambda (x) (> x 2)) (list 1 2 3 4))", { env: typedEnv }); // filter (srfi-1)
    expect(String(removed)).toContain("1");
  });
});

describe("scheme/polyglot-racket — deps are real edges (§2.1 luck-into-structure)", () => {
  it("assembleEnv walks deps: the exceptions `error` reach (via %dict-guard) works standalone", async () => {
    await initBridge();
    const env = global_env.inherit("test-polyglot-racket-assembleEnv-ok") as unknown as SchemeEnv;
    await assembleEnv(env, [polyglotRacket.lower({ evalScheme })]);
    const typedEnv = env as unknown as ResolvingEnvironment;
    await expect(execState('(dict-ref "not-a-dict" :a)', { env: typedEnv })).rejects.toThrow(
      /dict-ref: expected a dict/, // error (exceptions) — the door composes through the dep edge
    );
  });
});

describe("scheme/polyglot family — contract ENFORCEMENT fires at the call boundary (§1.2 enforced-day-one)", () => {
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

  it("the applicable union ADMITS keyword accessors — (compose :b :a) is the shared core's own documented idiom", async () => {
    const env = await freshEnv();
    const [nested] = await exec("((compose :b :a) (dict :a (dict :b 7)))", { env });
    expect(Number(nested)).toBe(7);
    const [grouped] = await exec('(@ (group-by :kind (list (dict :kind "x") (dict :kind "x"))) "x")', { env });
    expect(String(grouped)).toBeTruthy(); // a keyword accessor as group-by's f — applicable, not z.lambda
  });

  it("JUDGMENT PIN — the dict family's `d` stays z.value so polyglot-racket's %dict-guard TEACHING door survives (never preempted by a zod boundary error)", async () => {
    const env = await freshEnv();
    await expect(execState("(dict-ref (list 1 2) :a)", { env })).rejects.toThrow(
      /dict-ref: expected a dict .* got a pair\/list.*use @ for an origin-agnostic read/,
    );
    await expect(execState('(dict-count "nope")', { env })).rejects.toThrow(/dict-count: expected a dict .* got a string/);
  });
});

describe("scheme/polyglot family — the §2.1 bake FV law passes AS MIGRATED, per pack", () => {
  // scheme/polyglot-clojure is EXCLUDED from this table on purpose: its `comp`
  // constant eagerly evaluates `compose` (core, a DIFFERENT capability) at apply
  // time, so a bare standalone `.apply()` genuinely throws Unbound-variable
  // unless core is applied first — see the dedicated pair of tests in the
  // "deps are real edges" describe block above, which prove the SAME bake-FV-is-
  // static-not-runtime property for clojure once that one eager cross-capability
  // need is satisfied.
  it.each([
    ["scheme/polyglot (core)", polyglot],
    ["scheme/polyglot-lisp", polyglotLisp],
    ["scheme/polyglot-racket", polyglotRacket],
  ] as const)("%s lowers cleanly with its declared deps — never DefineLocalityError", async (_label, pack) => {
    await initBridge();
    const env = global_env.inherit(`test-fv-law-ok-${pack.name.replace(/\//g, "-")}`);
    await expect(pack.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
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

describe("scheme/polyglot (core) — constants and shape (the eager aliases)", () => {
  it("nil / flow are CONSTANT defines (callable: false); comp (Clojure's alias, now in polyglot-clojure) too", () => {
    expect(coreDefs["nil"]?.kind).toBe("define");
    expect(coreDefs["nil"]?.callable).toBe(false);
    expect(coreDefs["flow"]?.callable).toBe(false);
    expect(coreDefs["compose"]?.callable).toBe(true);
    expect(coreDefs["pipe"]?.callable).toBe(true);
    expect(clojureDefs["comp"]?.callable).toBe(false);
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

describe("scheme/polyglot family — C3 tail positioning (each dialect pack is BOTH a deps target and a dependent)", () => {
  it("BASE_PACKS tail runs [racket, clojure, lisp, polyglot, srfi-1, …, lists]: srfi-235 (a polyglot consumer) precedes the whole tail", () => {
    const names = BASE_PACKS.map((pack) => pack.name);
    const srfi235Index = names.indexOf("scheme/srfi-235");
    const racketIndex = names.indexOf("scheme/polyglot-racket");
    const clojureIndex = names.indexOf("scheme/polyglot-clojure");
    const lispIndex = names.indexOf("scheme/polyglot-lisp");
    const polyglotIndex = names.indexOf("scheme/polyglot");
    const srfi1Index = names.indexOf("scheme/srfi-1");
    const exceptionsIndex = names.indexOf("scheme/r7rs/exceptions");
    const listsIndex = names.indexOf("scheme/lists");
    expect(srfi235Index).toBeGreaterThan(-1);
    // consumer (srfi-235) → dependents (racket, clojure, lisp) → their shared
    // dependency (core) → its own deps, in declared-order agreement with each
    // pack's own `deps` array (base-packs.ts's header has the full derivation).
    expect(srfi235Index).toBeLessThan(racketIndex);
    expect(racketIndex).toBeLessThan(clojureIndex); // racket depends on clojure
    expect(clojureIndex).toBeLessThan(polyglotIndex); // clojure depends on core
    expect(lispIndex).toBeGreaterThan(-1); // lisp: an independent branch, no ordering pin against racket/clojure
    expect(polyglotIndex).toBeLessThan(srfi1Index);
    expect(srfi1Index).toBeLessThan(exceptionsIndex);
    expect(exceptionsIndex).toBeLessThan(listsIndex);
  });

  it("the default bootstrap C3-linearizes and serves the whole idiom family (smoke)", async () => {
    // Bare exec (no env) = the production default path: NATIVE_PACKS + BASE_PACKS
    // through initBridge's assembleEnv — an AssembleLinearizationError anywhere in
    // the reshuffled tail would fail HERE, before any assertion.
    const [threaded] = await exec("(-> 5 (+ 1) (* 2))"); // polyglot-clojure
    expect(threaded).toBe(12);
    const [rackThreaded] = await exec("(~> 5 (+ 1) (* 2))"); // polyglot-racket, aliasing ->
    expect(rackThreaded).toBe(12);
    const [piped] = await exec("((pipe (lambda (x) (+ x 1)) (lambda (x) (* x 2))) 5)"); // polyglot (core)
    expect(piped).toBe(12);
    const [mapped] = await exec("(mapcar (lambda (x) (* x x)) (list 1 2 3))"); // polyglot-lisp
    // SIMPLE-tier `exec` auto-unboxes a scheme list to a plain JS array.
    expect(mapped).toEqual([1, 4, 9]);
    const [counted] = await exec("(dict-count (dict :a 1 :b 2))"); // polyglot-racket
    expect(Number(counted)).toBe(2);
  });
});

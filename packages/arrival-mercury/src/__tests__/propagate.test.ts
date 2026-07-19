/**
 * CONSTANT / COPY PROPAGATION (structural-optimization lane; `../propagate/
 * index.ts`), tested at the same three layers `prevalue.test.ts` (its
 * composition partner) uses:
 *   - the pure decisions (`propagationDecisionAt`, `propagateTopLevelDefines`,
 *     `sameBranchDecisionAt`) at the CoreForm-shape layer;
 *   - a LOCAL emit pipeline (classify → walk(registry, propagationOf,
 *     prevalueOf, sameBranchOf) → render) proving the walker consults both
 *     new views, INCLUDING the composition with static prevaluation
 *     (`(let ((flag #t)) (if flag A B))` → propagate → prevalue folds → `A`)
 *     and the three soundness invariants named in the mission: value
 *     preservation, the `infer` binding is never duplicated, and effect
 *     order is preserved;
 *   - one proof that the REAL `compileGreenfield` harness runs both folds
 *     end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { ClassifyResult, CoreForm, If, Let } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import {
  cleanupOracleScratch,
  compileGreenfield,
  openOracleSession,
  type OracleSession,
  phase1Rules,
  runOracle,
  withRules,
} from "../index.js";
import { prevalueDecisionAt } from "../prevalue/index.js";
import { isTriviallyPure, propagateTopLevelDefines, propagationDecisionAt, sameBranchDecisionAt } from "../propagate/index.js";
import type { EmitRegistry } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { walk, type WalkOptions } from "../walker/index.js";

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

/** Every fixture here is a single top-level expression — mirrors
 *  `prevalue.test.ts`'s own `topFormOf`. */
function topFormOf(src: string): CoreForm {
  const result = cf(src);
  expect(result.forms, "fixture must have exactly one top-level form").toHaveLength(1);
  return result.forms[0]!;
}

function assertKind<K extends CoreForm["kind"]>(f: CoreForm, kind: K): Extract<CoreForm, { kind: K }> {
  expect(f.kind).toBe(kind);
  return f as Extract<CoreForm, { kind: K }>;
}

// ── the local emit pipeline: classify → walk(registry, propagationOf, prevalueOf,
// sameBranchOf) → render. Mirrors `prevalue.test.ts`'s own `compile`/`emit` helpers,
// with the two new views wired in exactly where `oracle/harness.ts`'s
// `compileGreenfield` wires them.
const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
// A bare "infer" presence row — SOLELY to make the symbol resolvable (rung-3 RuntimeRef
// shim), the identical convention `peepholes.test.ts`/`prevalue.test.ts` already use.
const INFER_REGISTRY = withRules(EMPTY, { ...phase1Rules, infer: {} });
const compile = (src: string, registry: EmitRegistry = EMPTY, over: Partial<WalkOptions> = {}): CompilationUnit =>
  walk(cf(src), {
    registry,
    register: "run",
    propagationOf: propagationDecisionAt,
    prevalueOf: prevalueDecisionAt,
    sameBranchOf: sameBranchDecisionAt,
    ...over,
  });
const emit = (src: string, registry: EmitRegistry = EMPTY, over: Partial<WalkOptions> = {}): string =>
  render(compile(src, registry, over));

/** One row per (source, kind, verdict) triple — the purity floor's whole law
 *  surface, named per row so a regression points at the exact source (mirrors
 *  `prevalue.test.ts`'s PV_ROWS). `kind` pins the CoreForm shape the source
 *  must classify to (the original assertions' own `assertKind` half). */
const PURE_ROWS: readonly { src: string; kind: CoreForm["kind"]; pure: boolean }[] = [
  // Lit/Quote/Ref are trivially pure
  { src: `5`, kind: "Lit", pure: true },
  { src: `"a"`, kind: "Lit", pure: true },
  { src: `#t`, kind: "Lit", pure: true },
  { src: `'(1 2)`, kind: "Quote", pure: true },
  { src: `x`, kind: "Ref", pure: true },

  // App/If/Let/Lambda/And/Or are never trivially pure — the one gate
  { src: `(f x)`, kind: "App", pure: false },
  { src: `(infer "m" "p")`, kind: "App", pure: false },
  { src: `(if x 1 2)`, kind: "If", pure: false },
  { src: `(let ((y 1)) y)`, kind: "Let", pure: false },
  { src: `(lambda (x) x)`, kind: "Lambda", pure: false },
  { src: `(and x y)`, kind: "And", pure: false },
];

describe("isTriviallyPure — the purity floor", () => {
  for (const row of PURE_ROWS) {
    it(`isTriviallyPure(${row.src}) → ${row.pure}`, () => {
      expect(isTriviallyPure(assertKind(topFormOf(row.src), row.kind))).toBe(row.pure);
    });
  }
});

describe("propagationDecisionAt — let/let*", () => {
  it("let: a literal binding drops, body substitutes to the literal verbatim", () => {
    const n = assertKind(topFormOf(`(let ((flag #t)) (if flag 1 2))`), "Let");
    const folded = propagationDecisionAt(n);
    expect(folded).toBeDefined();
    expect(folded!.bindings).toHaveLength(0);
    const ifNode = assertKind(folded!.body[0]!, "If");
    expect(ifNode.cond).toBe(n.bindings[0]!.init); // the SAME #t node, reused verbatim
  });

  it("let: a copy (bare-Ref) binding drops, body substitutes to a Ref of the copy source", () => {
    const n = assertKind(topFormOf(`(let ((y x)) (f y y))`), "Let");
    const folded = propagationDecisionAt(n);
    expect(folded!.bindings).toHaveLength(0);
    const app = assertKind(folded!.body[0]!, "App");
    const [a, b] = app.positionalArgs;
    expect(assertKind(a!, "Ref").name).toBe("x");
    expect(assertKind(b!, "Ref").name).toBe("x");
  });

  it("let: a binding to an App (unknown purity — e.g. would be `(infer …)` in a real program) never propagates", () => {
    const n = assertKind(topFormOf(`(let ((r (f x))) (g r r))`), "Let");
    expect(propagationDecisionAt(n)).toBeUndefined();
  });

  it("let: siblings never see each other — a plain let's binding init is NOT substituted by an earlier sibling", () => {
    // (let ((a 5) (b a)) ...) — `b`'s `a` refers to the OUTER scope, not the
    // new local `a`. Only `a` propagates; `b` survives with its RAW (un-
    // substituted) init, verbatim.
    const n = assertKind(topFormOf(`(let ((a 5) (b a)) (list a b))`), "Let");
    const folded = propagationDecisionAt(n)!;
    expect(folded.bindings).toHaveLength(1);
    expect(folded.bindings[0]!.name).toBe("b");
    expect(folded.bindings[0]!.init).toBe(n.bindings[1]!.init); // untouched
  });

  it("let*: a chain resolves fully — (let* ((a 5) (b a)) (f a b)) propagates BOTH", () => {
    const n = assertKind(topFormOf(`(let* ((a 5) (b a)) (f a b))`), "Let");
    const folded = propagationDecisionAt(n)!;
    expect(folded.bindings).toHaveLength(0);
    const app = assertKind(folded.body[0]!, "App");
    const [a, b] = app.positionalArgs;
    expect(assertKind(a!, "Lit").value).toEqual({ kind: "number", text: "5" });
    expect(assertKind(b!, "Lit").value).toEqual({ kind: "number", text: "5" });
  });

  it("let*: re-shadowing within the same let* evicts the stale entry, keeps the surviving binding", () => {
    // (let* ((x 1) (x (f x))) x) — the SECOND x's init sees the first (→ (f 1)),
    // but is itself an App (not propagatable), so it survives — and the body's
    // `x` must resolve to THIS surviving binding, never the stale literal `1`.
    const n = assertKind(topFormOf(`(let* ((x 1) (x (f x))) x)`), "Let");
    const folded = propagationDecisionAt(n)!;
    expect(folded.bindings).toHaveLength(1);
    expect(folded.bindings[0]!.name).toBe("x");
    const app = assertKind(folded.bindings[0]!.init, "App");
    expect(assertKind(app.positionalArgs[0]!, "Lit").value).toEqual({ kind: "number", text: "1" });
    // the body's own `x` is UNTOUCHED (still a bare Ref) — it must resolve to
    // the surviving binding at walk-time, not a stale propagated literal.
    expect(folded.body[0]).toBe(n.body[0]);
  });

  it("letrec/letrec* decline unconditionally — self/mutual reference is out of this lane's scope", () => {
    expect(propagationDecisionAt(assertKind(topFormOf(`(letrec ((x 1)) x)`), "Let"))).toBeUndefined();
    expect(propagationDecisionAt(assertKind(topFormOf(`(letrec* ((x 1)) x)`), "Let"))).toBeUndefined();
  });

  it("nothing propagatable declines entirely (undefined, the walker's cue to lower normally)", () => {
    expect(propagationDecisionAt(assertKind(topFormOf(`(let ((r (f x))) r)`), "Let"))).toBeUndefined();
  });

  it("capture-avoidance: a copy's target rebound by a DEEPER nested Let inside the body declines (not just an immediate sibling)", () => {
    // (let ((a x)) (let ((x 10)) (f a))) — `a` copies the OUTER `x`, but a
    // Let nested INSIDE the body rebinds `x` again. Splicing `Ref("x")`
    // (verbatim) into `(f a)`'s position — now inside that inner Let's own
    // scope — would silently capture the WRONG (inner, not outer) `x`. Must
    // decline, not merely check `a`'s own immediate siblings.
    const n = assertKind(topFormOf(`(let ((a x)) (let ((x 10)) (f a)))`), "Let");
    expect(propagationDecisionAt(n)).toBeUndefined();
  });

  it("capture-avoidance: a copy's target rebound inside a LATER SIBLING's own init declines too (let*)", () => {
    // (let* ((a x) (b (let ((x 10)) a))) (f b)) — `a` copies the OUTER `x`;
    // `let*` substitutes `a`'s copy into EVERY subsequent sibling's init,
    // including `b`'s, which itself nests a nested Let rebinding `x`.
    // Splicing `a`'s copy there would capture that inner `x`, not the outer
    // one `a` intended.
    const n = assertKind(topFormOf(`(let* ((a x) (b (let ((x 10)) a))) (f b))`), "Let");
    expect(propagationDecisionAt(n)).toBeUndefined();
  });

  it("a nested Let that REBINDS the same name shadows correctly — the inner occurrence is untouched", () => {
    const n = assertKind(topFormOf(`(let ((x 5)) (let ((x 10)) x))`), "Let");
    const folded = propagationDecisionAt(n)!;
    expect(folded.bindings).toHaveLength(0);
    const inner = assertKind(folded.body[0]!, "Let");
    // The inner Let is UNTOUCHED — same reference — because its own `x`
    // binding shadows the outer propagation for its entire body.
    expect(inner).toBe(n.body[0]);
  });
});

describe("propagateTopLevelDefines — literal-only, order-independent, NEVER deletes (finding #2)", () => {
  it("a single literal define propagates into its sibling's use site but the origin define SURVIVES", () => {
    const { forms } = cf(`(define debug #f) (define (f) (if debug 1 2))`);
    const out = propagateTopLevelDefines(forms);
    // Both forms survive — deletion is shakeOf's decision, never this pass's.
    expect(out).toHaveLength(2);
    const defineDebug = assertKind(out[0]!, "Define");
    expect(defineDebug.name).toBe("debug");
    expect(defineDebug).toBe(forms[0]); // untouched — its own value has no self-reference
    const fn = assertKind(out[1]!, "DefineFn");
    const ifNode = assertKind(fn.body[0]!, "If");
    expect(assertKind(ifNode.cond, "Lit").value).toEqual({ kind: "boolean", value: false });
  });

  it("a name defined more than once at top level is never propagated", () => {
    const { forms } = cf(`(define x 1) (define x 2) (f x)`);
    const out = propagateTopLevelDefines(forms);
    expect(out).toBe(forms); // identity fast path — nothing propagated
  });

  it("a bare-Ref copy at top level is deliberately NOT propagated (deferred — see module header)", () => {
    const { forms } = cf(`(define a 5) (define b a) (f b)`);
    const out = propagateTopLevelDefines(forms);
    // `a` (a literal) folds into every reference to it, INCLUDING `b`'s own
    // init — but `a`'s own define survives, same as `debug`'s above. `b`
    // itself is a copy, out of scope for THIS function (module header), so
    // `b`'s define also survives, substituted through with `a`'s literal.
    expect(out).toHaveLength(3); // `define a`, `define b`, `(f b)` — nothing dropped
    const defineA = assertKind(out[0]!, "Define");
    expect(defineA).toBe(forms[0]); // untouched
    const defineB = assertKind(out[1]!, "Define");
    expect(defineB.name).toBe("b");
    expect(assertKind(defineB.value, "Lit").value).toEqual({ kind: "number", text: "5" });
  });

  it("nothing to propagate returns the SAME forms array (identity fast path)", () => {
    const { forms } = cf(`(define (f x) x) (f 1)`);
    expect(propagateTopLevelDefines(forms)).toBe(forms);
  });

  it("a module-shaped call (walk() with NO propagationOf/shakeOf, exactly compileModuleFace's own shape) keeps the exported define's binding", () => {
    // The regression this fix closes: module face never wires `propagationOf`
    // or `shakeOf` into walk() (`../build/scm-module.ts`'s `compileModuleFace`).
    // Every top-level define there becomes a named export — if propagation
    // ever deleted `PI`'s binding while folding its value into `area`, the
    // export would reference a name with no declaration left to back it.
    const unit = walk(cf(`(define PI 3.14) (define (double) (* PI 2))`), {
      registry: EMPTY,
      register: "run",
      // deliberately NO propagationOf, NO shakeOf — compileModuleFace's shape
    });
    const piDecl = unit.decls.find((d) => d.t === "ConstDecl");
    expect(piDecl, "PI's declaration must still exist for the module's named-export list to reference").toBeDefined();
    const out = render(unit);
    expect(out).toContain("const PI = 3.14;"); // the export survives
    expect(out.match(/\bPI\b/g)).toHaveLength(1); // AND its value still folds into double's body — no OTHER use-site reference to PI survives
  });

  it("a plain (let …) inside a module-shaped call still gets sound per-Let propagation with no propagationOf wired", () => {
    // The other half of the same fix: letStmts used to gate its own always-safe
    // per-`Let` fold on the SAME `opts.propagationOf` presence check the unsound
    // top-level pass used — so declining to wire the top-level pass in (module
    // face's own choice) silently lost this fold too. It must apply regardless.
    const out = render(
      walk(cf(`(define (f) (let ((flag #t)) (if flag "A" "B")))`), {
        registry: EMPTY,
        register: "run",
        prevalueOf: prevalueDecisionAt,
        // deliberately NO propagationOf — module face's own shape
      }),
    );
    expect(out).toBe(`function f() {\n    return "A";\n}\n`);
  });
});

describe("sameBranchDecisionAt — (if c A A), A restricted to the trivially-pure floor", () => {
  it("both branches the same literal, cond a pure Ref: drops cond entirely", () => {
    const n = assertKind(topFormOf(`(if c "x" "x")`), "If");
    const folded = sameBranchDecisionAt(n);
    expect(folded).toBe(n.then); // the "x" literal, verbatim
  });

  it("both branches the same Ref, cond a pure Ref: drops cond entirely", () => {
    const n = assertKind(topFormOf(`(if c y y)`), "If");
    expect(sameBranchDecisionAt(n)).toBe(n.then);
  });

  it("different values in each branch: declines", () => {
    const n = assertKind(topFormOf(`(if c "x" "y")`), "If");
    expect(sameBranchDecisionAt(n)).toBeUndefined();
  });

  it("cond is impure (an App): sequences it via Begin rather than dropping it", () => {
    const n = assertKind(topFormOf(`(if (g y) "x" "x")`), "If");
    const folded = sameBranchDecisionAt(n)!;
    expect(folded.kind).toBe("Begin");
    const begin = assertKind(folded, "Begin");
    expect(begin.body).toHaveLength(2);
    expect(begin.body[0]).toBe(n.cond); // c is still evaluated, verbatim
    expect(begin.body[1]).toBe(n.then);
  });

  it("both branches are the same App (e.g. two textually-identical calls): declines — NOT this lane's floor", () => {
    // Deliberately narrow (module header): collapsing two structurally-equal
    // `App`s would need the cacheClass/provenance purity gate CSE reads off
    // the registry — this lane only ever compares trivially-pure branches.
    const n = assertKind(topFormOf(`(if c (g y) (g y))`), "If");
    expect(sameBranchDecisionAt(n)).toBeUndefined();
  });
});

describe("walker consumption — propagation composes with prevalue (the flag example)", () => {
  it("(let ((flag #t)) (if flag \"A\" \"B\")) → propagate flag → (if #t A B) → prevalue folds → A", () => {
    expect(emit(`(define (f) (let ((flag #t)) (if flag "A" "B")))`)).toBe(
      `function f() {\n    return "A";\n}\n`,
    );
  });

  it("copy propagation end to end: (let ((z y)) z) compiles straight to a reference to y — no z binding at all", () => {
    expect(emit(`(define (f y) (let ((z y)) z))`)).toBe(`function f(y) {\n    return y;\n}\n`);
  });

  it("same-branch identity end to end: (if c \"same\" \"same\") with a pure cond drops the branch AND the cond", () => {
    expect(emit(`(define (f c) (if c "same" "same"))`)).toBe(`function f(c) {\n    return "same";\n}\n`);
  });

  it("top-level literal define propagates through a sibling function", () => {
    expect(emit(`(define debug #f) (define (f) (if debug 1 2))`)).toContain("return 2;");
  });
});

describe("soundness invariant (a) — infer is NEVER duplicated (the load-bearing safety test)", () => {
  it("(let ((r (infer \"m\" \"p\"))) r r) stays ONE infer call — r bound once, both uses reference it", () => {
    const out = emit(`(define (f) (let ((r (infer "m" "p"))) r r))`, INFER_REGISTRY);
    // Exactly one call site.
    expect(out.match(/infer\(/g)).toHaveLength(1);
    expect(out).toBe(`function f() {\n    const r = infer("m", "p");\n    r;\n    return r;\n}\n`);
  });

  it("propagationDecisionAt itself declines on an infer-bound binding — the purity gate, isolated", () => {
    const n = assertKind(topFormOf(`(let ((r (infer "m" "p"))) (f r r))`), "Let");
    expect(propagationDecisionAt(n)).toBeUndefined();
  });
});

describe("soundness invariant (b) — effect order preserved: propagation/identity folds never reorder or drop an effect", () => {
  it("(if effectful-cond \"same\" \"same\") still evaluates cond BEFORE returning — unconditionally, not maybe", () => {
    const out = emit(`(define (f) (if (infer "m" "p") "same" "same"))`, INFER_REGISTRY);
    expect(out).toBe(`function f() {\n    infer("m", "p");\n    return "same";\n}\n`);
  });

  it("let* propagation never drops an impure binding's own evaluation — only trivially-pure inits ever vanish", () => {
    // `mid`'s init `(infer "m" "p")` is impure — it must survive as a real
    // binding/statement. `tail`'s copy-init `Ref("mid")` is trivially pure
    // BY SHAPE, but `mid` is one of THIS SAME let*'s own binding names, so
    // the capture-avoidance guard (`propagate/index.ts`'s `propagationDecisionAt`)
    // conservatively declines it too — `tail` survives as its own real
    // binding rather than risk splicing a same-Let*-owned name into the
    // body. Both bindings compile through untouched; the fold contributes
    // nothing here (correctly — there was never a trivially-pure value to
    // propagate in the first place).
    const out = emit(`(define (f) (let* ((mid (infer "m" "p")) (tail mid)) tail))`, INFER_REGISTRY);
    expect(out).toBe(`function f() {\n    const mid = infer("m", "p");\n    const tail = mid;\n    return tail;\n}\n`);
  });
});

describe("soundness invariant (c) — a door on a NON-propagated branch still fires exactly as before", () => {
  it("(let ((n 0)) (if n (set! n 1) n)) — n IS a literal and propagates, but the door still fires unconditionally once n is provably true", () => {
    // n=0 is trivially pure (a literal) and Scheme-truthy (only #f is
    // false), so `flag` propagates to `Lit(0)`, then `prevalue` folds the if
    // to the `then` arm — the `set!` door, now unconditionally reached. This
    // proves propagation composing with prevalue never SILENCES a door that
    // becomes reachable through the fold, mirroring `prevalue.test.ts`'s own
    // soundness invariant (b).
    const out = emit(`(let ((n 0)) (if n (set! n 1) n))`);
    expect(out).toContain('throw new Error("prohibited-dynamics/set!: ');
    expect(out).not.toContain("!== false");
  });
});

describe("compileGreenfield wiring — propagation runs end to end through the REAL harness", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it("(let ((flag #t)) (if flag \"a\" (error \"must-not-run\"))) compiles through the REAL compileGreenfield to the bare surviving value", () => {
    const compiled = compileGreenfield(session, `(let ((flag #t)) (if flag "a" (error "must-not-run")))`);
    expect(compiled).toContain('return "a"');
    expect(compiled).not.toContain("error");
  });

  it("value preservation over the real oracle: propagate-then-fold agrees with the interpreter", async () => {
    const verdict = await runOracle(session, `(let ((flag #t)) (if flag "a" (error "must-not-run")))`);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: "a" });
  });

  it("infer is not duplicated through the real harness either — one call site, two uses", () => {
    const compiled = compileGreenfield(session, `(let ((r (infer "fast" "p"))) (list r r))`);
    expect(compiled.match(/infer\(/g)).toHaveLength(1);
  });
});

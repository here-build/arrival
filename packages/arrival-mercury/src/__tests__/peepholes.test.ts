/**
 * IDIOMS — the opening pair (constitution §3.1/§3.5/§6, Law C), tested at the
 * CoreForm-shape layer, plus:
 *   - byte-level goldens through a LOCAL emit pipeline (classify → walk(registry,
 *     idiomAt)) mirroring rules-phase1.test.ts's own `compile`/`emit` helpers,
 *     with `sm.idiomAt` wired in exactly where the real compile harness wires it.
 *
 * (A former third layer proved the idiom end to end through the real oracle
 * harness; it depended on the oracle package and was removed to keep this a
 * pure compiler unit test.)
 *
 * E2 REWRITE (engine plan §2 E2, second half): the dissolved whole-tree
 * `peephole()` pass (`applyPeepholes`, `programShadowsPeepholeNames` as a
 * driver, the `Peephole`/`PeepholeCtx` table shape) is gone — idioms are now
 * `sm.idiomAt(node)`, a per-`App` decision view (`../model/model.ts`), backed
 * by `../peepholes/index.ts`'s `idiomDecisionAt` + `../peepholes/infer.ts`'s
 * `inferScalarFoldAt`/`cacheKeyElideAt`. Every "BEFORE"/"AFTER" pair below now
 * reads: BEFORE = the node as `sm.coreform` classifies it; AFTER =
 * `sm.idiomAt(before) ?? before` (idiomAt returns `undefined` when no idiom
 * applies — the SAME "declining an optimization" fallback the dissolved
 * pass's `rewriteForm` had, made explicit at the call site instead of
 * folded into a whole-tree traversal). `programShadowsPeepholeNames` itself
 * is UNCHANGED — still the whole-program shadow census, still exported from
 * `../peepholes/index.js` verbatim.
 */
import { describe, expect, it } from "vitest";

import { INFER_PEEPHOLE_LOAD_BEARING_NAMES, programShadowsPeepholeNames } from "../peepholes/index.js";
import {
  type App,
  classify,
  type ClassifyResult,
  type CoreForm,
  desugar,
  type EmitRegistry,
  parseSexprs,
  phase1Rules,
  render,
  SchemeSemanticModel,
  walk,
  withRules,
} from "../index.js";

// ── the front pipeline coreform.test.ts / rules-phase1.test.ts both use ─────────────
const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

// ── the local emit pipeline: classify → walk(registry, sm.idiomAt) → render ─────────
// (rules-phase1.test.ts's own `compile`/`emit` helpers, with `idiomAt` wired in exactly
// where harness.ts's real compile harness wires it — no FRAME/ASYNC-IFY noise, so goldens
// stay the same bare byte-level shape that file already pins.)
const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
// A bare "infer" presence row: `infer`'s own emit rule relocated onto its Contract
// (R2, arrival-mercury constitution §9 — llm-plane-arrival-env/src/infer.ts) and left
// no row in `phase1Rules`, so this file's EMPTY-based stand-in registry (unlike the
// real harvest) can no longer resolve a BARE `(infer …)` call site on its own.
// Byte-identical output either way: with no `emit` at all, "infer" falls to the
// walker's rung-3 RuntimeRef shim (`Call(RuntimeRef("infer"), args)`) — the exact
// same residual the relocated Contract rule builds (same convention
// async-ify.test.ts's own `row("infer")` already relies on) — so this row exists
// SOLELY to make the symbol resolvable, not to stand in for its compiled shape.
const registry = withRules(EMPTY, { ...phase1Rules, infer: {} });
const modelOf = (src: string): SchemeSemanticModel => new SchemeSemanticModel(src, registry);
const emit = (src: string): string => {
  const sm = modelOf(src);
  return render(walk(sm.coreform, { registry, idiomAt: sm.idiomAt, register: "run" }));
};

function assertKind<K extends CoreForm["kind"]>(f: CoreForm, kind: K): Extract<CoreForm, { kind: K }> {
  expect(f.kind).toBe(kind);
  return f as Extract<CoreForm, { kind: K }>;
}

/** Every fixture here is a single `(define (f params…) BODY-APP)` — pull the one
 *  App under test out of the DefineFn's one-form body. */
function bodyAppOf(result: ClassifyResult): App {
  const top = result.forms[0];
  expect(top, "fixture must have a top-level form").toBeDefined();
  const def = assertKind(top!, "DefineFn");
  expect(def.body).toHaveLength(1);
  return assertKind(def.body[0]!, "App");
}

const nameOf = (fn: CoreForm): string => assertKind(fn, "Ref").name;

/** BEFORE/AFTER pair for a single source: the App as classified, and
 *  `sm.idiomAt`'s decision for it (or the UNCHANGED node — idiomAt's own
 *  "declining an optimization is always safe" fallback, made explicit here
 *  instead of folded into a whole-tree traversal the way the dissolved
 *  `peephole()` pass did it). */
function idiomBeforeAfter(src: string): { readonly sm: SchemeSemanticModel; readonly before: App; readonly after: App } {
  const sm = modelOf(src);
  const before = bodyAppOf(sm.coreform);
  const after = sm.idiomAt(before) ?? before;
  return { sm, before, after };
}

describe("infer-scalar-fold — (car (infer …)) folds to the bare scalar call", () => {
  it("BEFORE: classifies as the un-folded App(car, [App(infer, […])]) shape", () => {
    const app = bodyAppOf(cf(`(define (f m p) (car (infer m p)))`));
    expect(nameOf(app.fn)).toBe("car");
    expect(app.positionalArgs).toHaveLength(1);
    const inner = assertKind(app.positionalArgs[0]!, "App");
    expect(nameOf(inner.fn)).toBe("infer");
    expect(inner.positionalArgs).toHaveLength(2);
  });

  it("AFTER: sm.idiomAt fuses outer+inner into ONE App(infer/scalar, [model, prompt])", () => {
    const { before, after } = idiomBeforeAfter(`(define (f m p) (car (infer m p)))`);
    expect(nameOf(after.fn)).toBe("infer/scalar");
    expect(after.positionalArgs).toHaveLength(2);
    expect(after.kwargs).toHaveLength(0);
    // A FUSION, not a trim (peepholes/infer.ts's own doc: "no single original
    // node honestly owns this identity") — fresh ids for both the App and its
    // head Ref, strictly above anything classify() minted for either input node.
    const beforeInner = assertKind(before.positionalArgs[0]!, "App");
    expect(after.id).not.toBe(before.id);
    expect(after.id).not.toBe(beforeInner.id);
  });

  it("infer/chat folds to infer/chat/scalar", () => {
    const { after } = idiomBeforeAfter(`(define (f m msgs) (car (infer/chat m msgs)))`);
    expect(nameOf(after.fn)).toBe("infer/chat/scalar");
    expect(after.positionalArgs).toHaveLength(2);
  });

  it("end-to-end golden: emits the scalar RuntimeRef call, never a car-of-list", () => {
    expect(emit(`(define (f m p) (car (infer m p)))`)).toBe(`function f(m, p) {\n    return infer/scalar(m, p);\n}\n`);
  });

  it("NON-MATCH control: car of an unrelated call is untouched", () => {
    const { after } = idiomBeforeAfter(`(define (f x y) (car (cons x y)))`);
    expect(nameOf(after.fn)).toBe("car");
    const inner = assertKind(after.positionalArgs[0]!, "App");
    expect(nameOf(inner.fn)).toBe("cons");
  });

  it("NON-MATCH control: plain (car xs) — no inner App at all — untouched", () => {
    const { after } = idiomBeforeAfter(`(define (f xs) (car xs))`);
    expect(nameOf(after.fn)).toBe("car");
    expect(after.positionalArgs[0]!.kind).toBe("Ref");
  });

  it("NON-MATCH control: the chat-message constructors are excluded on purpose (different contract shape — peepholes/infer.ts's own note)", () => {
    const { after } = idiomBeforeAfter(`(define (f) (car (infer/chat/system "hi")))`);
    expect(nameOf(after.fn)).toBe("car"); // untouched — "infer/chat/system" is not a key of SCALAR_TARGET_OF
  });
});

describe("cache-key-elide — a literal #f cache-key argument drops", () => {
  it("BEFORE: 4 positional args, #f last", () => {
    const app = bodyAppOf(cf(`(define (f m p s) (infer m p s #f))`));
    expect(app.positionalArgs).toHaveLength(4);
  });

  it("AFTER: trims to 3 args and REUSES the original call's id (a trim, not a fusion)", () => {
    const { before, after } = idiomBeforeAfter(`(define (f m p s) (infer m p s #f))`);
    expect(after.positionalArgs).toHaveLength(3);
    expect(after.id).toBe(before.id);
  });

  it("a REAL cache key is never dropped — stricter than mercury's blanket drop (peepholes/infer.ts's deviation note)", () => {
    const { after } = idiomBeforeAfter(`(define (f m p s k) (infer m p s k))`);
    expect(after.positionalArgs).toHaveLength(4);
  });

  it("NON-MATCH control: wrong arity (3 args, no cache-key slot at all) is untouched", () => {
    const { after } = idiomBeforeAfter(`(define (f m p s) (infer m p s))`);
    expect(after.positionalArgs).toHaveLength(3);
  });

  it("end-to-end golden: the emitted call omits the trailing #f argument", () => {
    expect(emit(`(define (f m p s) (infer m p s #f))`)).toBe(`function f(m, p, s) {\n    return infer(m, p, s);\n}\n`);
  });
});

describe("composition — both idioms fire in ONE recursive query (peepholes/index.ts's own worked example)", () => {
  it("(car (infer m p schema #f)) → infer/scalar(m, p, schema) — the inner trim is visible to the outer fold", () => {
    const { after } = idiomBeforeAfter(`(define (f m p schema) (car (infer m p schema #f)))`);
    expect(nameOf(after.fn)).toBe("infer/scalar");
    expect(after.positionalArgs).toHaveLength(3); // model, prompt, schema — cacheKey already gone
  });

  it("end-to-end golden for the composed fold", () => {
    expect(emit(`(define (f m p schema) (car (infer m p schema #f)))`)).toBe(
      `function f(m, p, schema) {\n    return infer/scalar(m, p, schema);\n}\n`,
    );
  });
});

describe("the whole-program shadowing guard — the soundness net (peepholes/index.ts's own header)", () => {
  it("a local rebind of a load-bearing name anywhere in the program disables BOTH idioms for the WHOLE compile", () => {
    const src = `
      (define (unrelated car) car)
      (define (f m p) (car (infer m p)))
    `;
    const classified = cf(src);
    expect(programShadowsPeepholeNames(classified.forms)).toBe(true);

    const sm = new SchemeSemanticModel(src, registry);
    const fDef = assertKind(sm.coreform.forms[1]!, "DefineFn");
    const fBody = assertKind(fDef.body[0]!, "App");
    expect(sm.idiomAt(fBody)).toBeUndefined(); // untouched — the whole-compile bail fired,
    // even though the shadow lives in `unrelated`, a function that never touches infer.
  });

  it("no shadow anywhere ⇒ false, and the fold proceeds normally", () => {
    const classified = cf(`(define (f m p) (car (infer m p)))`);
    expect(programShadowsPeepholeNames(classified.forms)).toBe(false);
    const { after } = idiomBeforeAfter(`(define (f m p) (car (infer m p)))`);
    expect(nameOf(after.fn)).toBe("infer/scalar");
  });

  it("INFER_PEEPHOLE_LOAD_BEARING_NAMES names exactly the three symbols either idiom keys its decision on", () => {
    expect([...INFER_PEEPHOLE_LOAD_BEARING_NAMES].sort()).toEqual(["car", "infer", "infer/chat"]);
  });
});

// (The real-harness describe lived here; it depended on the oracle package and
// was removed to keep this a pure compiler unit test — the end-to-end idiom
// goldens above already prove the fold surface.)

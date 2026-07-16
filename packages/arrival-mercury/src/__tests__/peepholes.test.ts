/**
 * PEEPHOLES — the opening pair (constitution §3.1/§3.5/§6, Law C), tested at the
 * CoreForm-shape layer peepholes/types.ts's own header calls out as the cheap
 * unit-test seam ("match/rewrite deliberately split... cheap to unit test in
 * isolation"), plus:
 *   - byte-level goldens through a LOCAL emit pipeline (classify → peephole →
 *     walk(phase1Rules) → render) mirroring rules-phase1.test.ts's own
 *     `compile`/`emit` helpers, with `peephole()` spliced in exactly where
 *     oracle/harness.ts's `compileGreenfield` now calls it;
 *   - one proof that the REAL `compileGreenfield` harness (mission item 4's
 *     wiring target) reaches the pass end to end, including the stage-0
 *     runtime-manifest rows (`infer/scalar`/`infer/chat/scalar`) FRAME needs to
 *     resolve the folded call without dooring.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPeepholes, cacheKeyElide, inferScalarFold, peephole, programShadowsPeepholeNames } from "../peepholes/index.js";
import {
  type App,
  classify,
  cleanupOracleScratch,
  type ClassifyResult,
  compileGreenfield,
  type CoreForm,
  desugar,
  type EmitRegistry,
  openOracleSession,
  type OracleSession,
  parseSexprs,
  phase1Rules,
  render,
  walk,
  withRules,
} from "../index.js";

// ── the front pipeline coreform.test.ts / rules-phase1.test.ts both use ─────────────
const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

// ── the local emit pipeline: classify → peephole → walk(phase1Rules) → render ───────
// (rules-phase1.test.ts's own `compile`/`emit` helpers, with `peephole()` spliced in
// exactly where harness.ts's `compileGreenfield` now calls it — no FRAME/ASYNC-IFY
// noise, so goldens stay the same bare byte-level shape that file already pins.)
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
const emit = (src: string): string => render(walk(peephole(cf(src)), { registry, register: "run" }));

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

describe("infer-scalar-fold — (car (infer …)) folds to the bare scalar call", () => {
  it("BEFORE: classifies as the un-folded App(car, [App(infer, […])]) shape", () => {
    const app = bodyAppOf(cf(`(define (f m p) (car (infer m p)))`));
    expect(nameOf(app.fn)).toBe("car");
    expect(app.positionalArgs).toHaveLength(1);
    const inner = assertKind(app.positionalArgs[0]!, "App");
    expect(nameOf(inner.fn)).toBe("infer");
    expect(inner.positionalArgs).toHaveLength(2);
  });

  it("AFTER: peephole() fuses outer+inner into ONE App(infer/scalar, [model, prompt])", () => {
    const before = bodyAppOf(cf(`(define (f m p) (car (infer m p)))`));
    const after = bodyAppOf(peephole(cf(`(define (f m p) (car (infer m p)))`)));
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
    const after = bodyAppOf(peephole(cf(`(define (f m msgs) (car (infer/chat m msgs)))`)));
    expect(nameOf(after.fn)).toBe("infer/chat/scalar");
    expect(after.positionalArgs).toHaveLength(2);
  });

  it("end-to-end golden: emits the scalar RuntimeRef call, never a car-of-list", () => {
    expect(emit(`(define (f m p) (car (infer m p)))`)).toBe(`function f(m, p) {\n    return infer/scalar(m, p);\n}\n`);
  });

  it("NON-MATCH control: car of an unrelated call is untouched", () => {
    const after = bodyAppOf(peephole(cf(`(define (f x y) (car (cons x y)))`)));
    expect(nameOf(after.fn)).toBe("car");
    const inner = assertKind(after.positionalArgs[0]!, "App");
    expect(nameOf(inner.fn)).toBe("cons");
  });

  it("NON-MATCH control: plain (car xs) — no inner App at all — untouched", () => {
    const after = bodyAppOf(peephole(cf(`(define (f xs) (car xs))`)));
    expect(nameOf(after.fn)).toBe("car");
    expect(after.positionalArgs[0]!.kind).toBe("Ref");
  });

  it("NON-MATCH control: the chat-message constructors are excluded on purpose (different contract shape — peepholes/infer.ts's own note)", () => {
    const after = bodyAppOf(peephole(cf(`(define (f) (car (infer/chat/system "hi")))`)));
    expect(nameOf(after.fn)).toBe("car"); // untouched — "infer/chat/system" is not a key of SCALAR_TARGET_OF
  });
});

describe("cache-key-elide — a literal #f cache-key argument drops", () => {
  it("BEFORE: 4 positional args, #f last", () => {
    const app = bodyAppOf(cf(`(define (f m p s) (infer m p s #f))`));
    expect(app.positionalArgs).toHaveLength(4);
  });

  it("AFTER: trims to 3 args and REUSES the original call's id (a trim, not a fusion)", () => {
    const before = bodyAppOf(cf(`(define (f m p s) (infer m p s #f))`));
    const after = bodyAppOf(peephole(cf(`(define (f m p s) (infer m p s #f))`)));
    expect(after.positionalArgs).toHaveLength(3);
    expect(after.id).toBe(before.id);
  });

  it("a REAL cache key is never dropped — stricter than mercury's blanket drop (peepholes/infer.ts's deviation note)", () => {
    const after = bodyAppOf(peephole(cf(`(define (f m p s k) (infer m p s k))`)));
    expect(after.positionalArgs).toHaveLength(4);
  });

  it("NON-MATCH control: wrong arity (3 args, no cache-key slot at all) is untouched", () => {
    const after = bodyAppOf(peephole(cf(`(define (f m p s) (infer m p s))`)));
    expect(after.positionalArgs).toHaveLength(3);
  });

  it("end-to-end golden: the emitted call omits the trailing #f argument", () => {
    expect(emit(`(define (f m p s) (infer m p s #f))`)).toBe(`function f(m, p, s) {\n    return infer(m, p, s);\n}\n`);
  });
});

describe("composition — both peepholes fire in ONE bottom-up pass (peepholes/index.ts's own worked example)", () => {
  it("(car (infer m p schema #f)) → infer/scalar(m, p, schema) — the inner trim is visible to the outer fold", () => {
    const after = bodyAppOf(peephole(cf(`(define (f m p schema) (car (infer m p schema #f)))`)));
    expect(nameOf(after.fn)).toBe("infer/scalar");
    expect(after.positionalArgs).toHaveLength(3); // model, prompt, schema — cacheKey already gone
  });

  it("end-to-end golden for the composed fold", () => {
    expect(emit(`(define (f m p schema) (car (infer m p schema #f)))`)).toBe(
      `function f(m, p, schema) {\n    return infer/scalar(m, p, schema);\n}\n`,
    );
  });
});

describe("single-pass — applyPeepholes with an explicit table matches peephole()'s default", () => {
  it("peephole(classified) === applyPeepholes(classified, [inferScalarFold, cacheKeyElide])", () => {
    const classified = cf(`(define (f m p schema) (car (infer m p schema #f)))`);
    expect(applyPeepholes(classified, [inferScalarFold, cacheKeyElide])).toEqual(peephole(classified));
  });
});

describe("the whole-program shadowing guard — the soundness net (peepholes/index.ts's own header)", () => {
  it("a local rebind of a load-bearing name anywhere in the program disables BOTH peepholes for the WHOLE compile", () => {
    const src = `
      (define (unrelated car) car)
      (define (f m p) (car (infer m p)))
    `;
    const classified = cf(src);
    expect(programShadowsPeepholeNames(classified.forms)).toBe(true);

    const after = peephole(classified);
    const fDef = assertKind(after.forms[1]!, "DefineFn");
    const fBody = assertKind(fDef.body[0]!, "App");
    expect(nameOf(fBody.fn)).toBe("car"); // untouched — the whole-compile bail fired,
    // even though the shadow lives in `unrelated`, a function that never touches infer.
  });

  it("no shadow anywhere ⇒ false, and the fold proceeds normally", () => {
    const classified = cf(`(define (f m p) (car (infer m p)))`);
    expect(programShadowsPeepholeNames(classified.forms)).toBe(false);
    expect(nameOf(bodyAppOf(peephole(classified)).fn)).toBe("infer/scalar");
  });
});

describe("compileGreenfield wiring — PEEPHOLES runs end to end through the REAL harness (mission item 4)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it('(car (infer "gpt-4" "hello")) compiles through the REAL compileGreenfield to the folded call surface', () => {
    const compiled = compileGreenfield(session, `(car (infer "gpt-4" "hello"))`);
    // FRAME resolved the folded name against the stage-0 manifest (no FrameDoorError —
    // proves the runtime/stage0.ts `infer/scalar`→`inferScalar` row this wave added is
    // what makes the wiring actually EXECUTABLE, not merely shape-correct).
    expect(compiled).toContain("inferScalar");
    // No car-of-list residue survives — the fold REPLACED the shape, never wrapped it.
    expect(compiled).not.toContain("[0]");
  });
});

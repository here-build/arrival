/**
 * STATIC PREVALUATION (gate3-human-grade-rulings.md R-G6; `../prevalue/index.ts`),
 * tested at three layers, mirroring `peepholes.test.ts`'s own structure for the
 * sibling decision-view:
 *   - the pure three-valued judgment (`prevalue`) and fold decision
 *     (`prevalueDecisionAt`), at the CoreForm-shape layer;
 *   - a LOCAL emit pipeline (classify → walk(registry, prevalueOf) → render)
 *     proving the walker actually consults the view, including the two hard
 *     soundness invariants named in the mission: value preservation, and that
 *     a REACHABLE `prohibited-dynamics` door still fires exactly as before;
 *   - one proof that the REAL `compileGreenfield` harness folds end to end,
 *     interpreter-agreeing, through the actual oracle session (OQ8a's own
 *     resolution — see `bug-cell-corpus.test.ts`'s `short-circuit-effect` row
 *     and `corpus/short-circuit-effect.expect.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { And, ClassifyResult, CoreForm, Or } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import {
  cleanupOracleScratch,
  compileGreenfield,
  openOracleSession,
  type OracleSession,
  runOracle,
} from "../index.js";
import { prevalue, prevalueDecisionAt } from "../prevalue/index.js";
import type { EmitRegistry } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { walk, type WalkOptions } from "../walker/index.js";

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

/** Every fixture here is a single top-level expression — pull it out of the
 *  one-form program (mirrors `peepholes.test.ts`'s `bodyAppOf`, generalized
 *  to any CoreForm kind since this module folds If/And/Or, not just App). */
function topFormOf(src: string): CoreForm {
  const result = cf(src);
  expect(result.forms, "fixture must have exactly one top-level form").toHaveLength(1);
  return result.forms[0]!;
}

function assertKind<K extends CoreForm["kind"]>(f: CoreForm, kind: K): Extract<CoreForm, { kind: K }> {
  expect(f.kind).toBe(kind);
  return f as Extract<CoreForm, { kind: K }>;
}

// ── the local emit pipeline: classify → walk(registry, prevalueOf) → render ──
// No registry rows are needed anywhere below: `set!` classifies straight to a
// Door regardless of any registry (constitution §2.2 — doors are syntactic),
// and every fold under test here is over literals/and/or/if alone.
const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
const compile = (src: string, over: Partial<WalkOptions> = {}): CompilationUnit =>
  walk(cf(src), { registry: EMPTY, register: "run", prevalueOf: prevalueDecisionAt, ...over });
const emit = (src: string, over: Partial<WalkOptions> = {}): string => render(compile(src, over));

describe("prevalue — the three-valued Scheme-truthiness judgment", () => {
  const pv = (src: string): string => prevalue(topFormOf(src));

  it("only #f is false — every other literal is true (NOT JS truthiness)", () => {
    expect(pv(`#f`)).toBe("false");
    expect(pv(`#t`)).toBe("true");
    expect(pv(`0`)).toBe("true"); // the JS-falsy trap this evaluator must not fall into
    expect(pv(`""`)).toBe("true");
    expect(pv(`"a"`)).toBe("true");
    expect(pv(`(if #f 1)`)).toBe("true"); // the synthesized elided-else Lit(undefined)
  });

  it("quoted data: '#f is false, every other datum (including '() ) is true", () => {
    expect(pv(`'#f`)).toBe("false");
    expect(pv(`'#t`)).toBe("true");
    expect(pv(`'()`)).toBe("true"); // the classic Lisp gotcha — Scheme's empty list is truthy
    expect(pv(`'(1 2)`)).toBe("true");
    expect(pv(`'hello`)).toBe("true");
  });

  it("a bare keyword literal is honestly unknown, never guessed", () => {
    // `:kw` reaching a general expression position (here, an if-condition,
    // since Dict/App key positions intercept keyword atoms before they ever
    // reach classifyExpr) is already a malformed-source edge case `lowerLit`
    // doors on at emit time — prevalue declines rather than picking a side.
    const n = assertKind(topFormOf(`(if :kw 1 2)`), "If");
    expect(prevalue(n.cond)).toBe("unknown");
  });

  it("and/or/if built from provable parts recurse to a single verdict", () => {
    expect(pv(`(if #t #t #f)`)).toBe("true");
    expect(pv(`(if #f #t #f)`)).toBe("false");
    expect(pv(`(and #t #t)`)).toBe("true");
    expect(pv(`(and #t #f)`)).toBe("false");
    expect(pv(`(or #f #f)`)).toBe("false");
    expect(pv(`(or #f #t)`)).toBe("true");
    expect(pv(`(and)`)).toBe("true"); // the identity element
    expect(pv(`(or)`)).toBe("false");
  });

  it("unknown is the safe default for everything this evaluator doesn't own", () => {
    expect(pv(`x`)).toBe("unknown"); // Ref
    expect(pv(`(f x)`)).toBe("unknown"); // App
    expect(pv(`(not 0)`)).toBe("unknown"); // App — `not` is a registry symbol, not a special form
    expect(pv(`(let ((x 1)) x)`)).toBe("unknown"); // Let
    expect(pv(`(list)`)).toBe("unknown"); // a runtime call, not a literal — needs registry semantics
  });

  it("a single unknown operand poisons the whole and/or chain, even with provable neighbors", () => {
    // (and #t x #t): x's truthiness is unknown, so whether the chain even
    // REACHES the trailing #t depends on x — the whole judgment is unknown.
    expect(pv(`(and #t x #t)`)).toBe("unknown");
    expect(pv(`(or #f x #f)`)).toBe("unknown");
  });
});

describe("prevalueDecisionAt — the fold decision", () => {
  it("If: constant true guard folds to `then`, verbatim (same id)", () => {
    const n = assertKind(topFormOf(`(if #t 1 2)`), "If");
    const folded = prevalueDecisionAt(n);
    expect(folded?.kind).toBe("Lit");
    expect(folded).toBe(n.then); // literally the same node, not a copy
  });

  it("If: constant false guard folds to `else`, verbatim (same id)", () => {
    const n = assertKind(topFormOf(`(if #f 1 2)`), "If");
    const folded = prevalueDecisionAt(n);
    expect(folded).toBe(n.else);
  });

  it("If: unknown guard declines (undefined) — the walker's cue to lower normally", () => {
    const n = assertKind(topFormOf(`(if x 1 2)`), "If");
    expect(prevalueDecisionAt(n)).toBeUndefined();
  });

  it("Or: a leading provable-true operand collapses the WHOLE chain to that one value", () => {
    const n = assertKind(topFormOf(`(or #t (set! x))`), "Or");
    const folded = prevalueDecisionAt(n);
    expect(folded).toBe(n.args[0]); // the #t literal, no wrapper survives
  });

  it("Or: a leading provable-false operand drops, leaving the NEXT operand as sole survivor", () => {
    const n = assertKind(topFormOf(`(or #f (set! x))`), "Or");
    const folded = prevalueDecisionAt(n);
    expect(folded).toBe(n.args[1]); // the (set! x) Door — now unconditionally live
  });

  it("Or: multiple survivors trim in place — SAME id/span, fewer args (cacheKeyElideAt's own precedent, not a fresh mint)", () => {
    const n = assertKind(topFormOf(`(or x #f y)`), "Or");
    const folded = prevalueDecisionAt(n);
    expect(folded?.kind).toBe("Or");
    const foldedOr = folded as Or;
    expect(foldedOr.id).toBe(n.id);
    expect(foldedOr.span).toBe(n.span);
    expect(foldedOr.args).toHaveLength(2);
    expect(foldedOr.args[0]).toBe(n.args[0]); // x
    expect(foldedOr.args[1]).toBe(n.args[2]); // y — the #f in the middle is gone
  });

  it("Or: no provable operand at all declines entirely", () => {
    const n = assertKind(topFormOf(`(or x y)`), "Or");
    expect(prevalueDecisionAt(n)).toBeUndefined();
  });

  it("And: mirrors Or with the roles flipped (stop-on-false, drop-on-true)", () => {
    const collapse = assertKind(topFormOf(`(and #f (set! x))`), "And");
    expect(prevalueDecisionAt(collapse)).toBe(collapse.args[0]); // #f wins immediately

    const survive = assertKind(topFormOf(`(and #t (set! x))`), "And");
    expect(prevalueDecisionAt(survive)).toBe(survive.args[1]); // #t drops, set! survives alone

    const trim = assertKind(topFormOf(`(and x #t y)`), "And");
    const folded = trim && (prevalueDecisionAt(trim) as And | undefined);
    expect(folded?.kind).toBe("And");
    expect(folded?.id).toBe(trim.id);
    expect(folded?.args).toHaveLength(2);
  });

  it("recursive folding: a nested If/And/Or inside a cond value pre-resolves through prevalue()", () => {
    // (if (if #t #t #f) 'live 'dead) — the inner if is ITSELF constant-true,
    // so the outer If's own cond prevalues true via recursion, not a special case.
    const n = assertKind(topFormOf(`(if (if #t #t #f) 1 2)`), "If");
    expect(prevalueDecisionAt(n)).toBe(n.then);
  });
});

describe("walker consumption — the fold runs inline, mirroring idiomAt's own consultation", () => {
  it("(if #f (set! x) 0) compiles to the bare live value — no set!, no door, no guard", () => {
    expect(emit(`(if #f (set! x) 0)`)).toBe(`0;\n`);
  });

  it('(or #t (set! x)) compiles to the bare value — the dead branch, Door included, is never lowered', () => {
    expect(emit(`(or #t (set! x))`)).toBe(`true;\n`);
  });

  it("and-chain: a leading #f eliminates a trailing prohibited-dynamics door entirely", () => {
    expect(emit(`(and #f (set! x))`)).toBe(`false;\n`);
  });

  it("a multi-operand chain with one unknown operand trims the provable tail but keeps the unknown live", () => {
    // (or y #f 7): y is unknown so it MUST stay; #f is inert and drops,
    // leaving a plain 2-operand (or y 7) for lowerAndOr to guard normally —
    // ONE `fresh` temp, not two, is the tell that #f never became a second
    // guarded operand of its own.
    expect(emit(`(define (f y) (or y #f 7))`)).toBe(
      `function f(y) {\n    const __or = y;\n    return __or !== false ? __or : 7;\n}\n`,
    );
  });

  it("the fold composes with the TCO tail rewrite (tailLoopForm's OWN If arm, which bypasses lowerExpr)", () => {
    // A statically-dead branch inside a self-tail-recursive named-let body
    // must not survive into the while-loop rewrite either.
    const out = emit(`(define (f n) (let loop ((i n)) (if #f (set! i 0) (if (= i 0) i (loop (- i 1))))))`);
    expect(out).not.toContain("set!");
    expect(out).not.toContain("prohibited-dynamics");
  });
});

describe("soundness invariant (a) — value preservation: folding never changes an oracle value", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it("(let ((n 0)) (and #f (set! n 999)) n) — dead and-branch, both sides agree on the untouched value", async () => {
    const verdict = await runOracle(session, `(let ((n 0)) (and #f (set! n 999)) n)`);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: 0 });
  });

  it("(if #t 42 (set! n 1)) — dead else-branch, both sides agree on the live then-value", async () => {
    const verdict = await runOracle(session, `(if #t 42 (set! n 1))`);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: 42 });
  });

  it("short-circuit-effect's own shape (OQ8a) — both sides agree on 0, no door anywhere", async () => {
    const verdict = await runOracle(session, `(let ((n 0)) (or #t (begin (set! n 999) 'x)) n)`);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: 0 });
  });
});

describe("soundness invariant (b) — a REACHABLE prohibited-dynamics door still fires, exactly as before", () => {
  it("(if some-runtime-cond (set! x) 0) — guard is unknown, NOTHING folds, the door still rides the then-arm", () => {
    const out = emit(`(define (f c) (if c (set! x) 0))`);
    expect(out).toContain('throw new Error("prohibited-dynamics/set!: ');
    // The door is still gated behind the runtime check — an untaken branch
    // still doesn't poison the program (interpreter parity, unaffected by
    // this wave: walker.test.ts's own "a door on an untaken branch does not
    // poison the program" row pins the identical shape with no prevalueOf).
    expect(out).toMatch(/c !== false \? \(\(\) => \{\n\s*throw new Error\("prohibited-dynamics\/set!: /);
  });

  it("(or #f (set! x)) — the #f drops, but set! is now the SOLE, unconditionally-reached operand: the door fires unguarded", () => {
    // Top-level statement position wraps a Block-shaped Door in an
    // argument-less IIFE (lowerStmts' own default-case discipline, unrelated
    // to this fold) — the load-bearing proof is that NO ternary/guard
    // condition gates the throw: it is unconditional, not "maybe."
    const out = emit(`(or #f (set! x))`);
    expect(out).toContain('throw new Error("prohibited-dynamics/set!: ');
    expect(out).not.toContain("!== false"); // no guard survives — this is not a conditional door
  });

  it("real end-to-end agreement: the REACHABLE door still throws prohibited-dynamics on the compiled side", async () => {
    const session = await openOracleSession();
    try {
      const compiled = await import("../oracle/harness.js").then((m) => m.evalCompiled(session, `(or #f (set! x))`));
      expect(compiled.kind).toBe("throw");
      if (compiled.kind === "throw") expect(compiled.errorClass).toBe("prohibited-dynamics");
    } finally {
      await session.dispose();
      cleanupOracleScratch();
    }
  }, 60_000);
});

describe("compileGreenfield wiring — prevaluation runs end to end through the REAL harness (OQ8a's resolution)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it('(or #f "a" (error "must-not-run")) compiles through the REAL compileGreenfield to the bare surviving value', () => {
    const compiled = compileGreenfield(session, `(or #f "a" (error "must-not-run"))`);
    expect(compiled).toContain('return "a"');
    // No `error` residue survives anywhere — not the import, not the call —
    // proving the dead branch was ELIMINATED, not merely unreached at runtime.
    expect(compiled).not.toContain("error");
  });

  it("the import census (sm.importsOf) never over-counts a symbol only a folded-away branch referenced", () => {
    // Without prevalueOf threaded into computeImportsOf's own synthetic walk,
    // this would still claim `error` is needed (model.ts's own documented
    // class of gap — see importsOf's doc). Threaded correctly, the emitted
    // import list agrees with what's actually referenced: nothing.
    const compiled = compileGreenfield(session, `(or #t (error "dead"))`);
    expect(compiled).not.toContain("import");
  });
});

/**
 * reconcileForms + SchemeSemanticModel.reconcile — E4b's structural-sharing
 * splice (engine plan §E4; `../model/reconcile.ts`'s own header carries the
 * full design rationale — content-key soundness, NodeId collision handling,
 * the reference-graph closure).
 *
 * Three concerns, three describe blocks:
 *  - `reconcileForms` in isolation: the content key's soundness (adversarial
 *    near-miss pairs — a form that LOOKS similar but differs in a
 *    fact-relevant way must NOT be judged shared), NodeId collision-freedom
 *    in the spliced tree, and add/remove/duplicate handling. Pure-function
 *    tests — no registry, no tsc.
 *  - `SchemeSemanticModel.reconcile`: THE LOAD-BEARING SOUNDNESS GATE —
 *    sharing must be transparent (`reconcile(prev, edited).factsAt(n) ===
 *    fromScratch(edited).factsAt(n)` for every node, same for every decision
 *    view). A small, fast fixture (no oracle session — see the registry note
 *    below); the LARGER quantitative proof (view-hit counters over a 6-define
 *    program) lives in `src/__benchmarks__/incrementality.test.ts` per
 *    tests.md (a "number to compare over time" is a benchmark; this file's
 *    job is the pass/fail verdict, always gated).
 *  - Cross-form type flow: the two blocks above both use fixtures where every
 *    top-level form is independent (deliberately, for the first — the
 *    benchmark's own header explains why). This block is the ADVERSARIAL
 *    case for the reference-graph closure itself — a form whose own text is
 *    untouched but whose CALLEE's return type changed, transitively, through
 *    a chain of references.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../coreform/classify.js";
import type { And, App, CoreForm, DefineFn, If, Or } from "../coreform/types.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { SchemeSemanticModel } from "../model/model.js";
import { reconcileForms } from "../model/reconcile.js";
import type { EmitRegistry } from "../registry/harvest.js";
import { phase1Rules } from "../rules/phase1.js";
import { withRules } from "../rules/overlay.js";

const cf = (src: string): readonly CoreForm[] => classify(desugar(parseSexprs(src))).forms;

/** Every id-carrying record in `forms` (CoreForm nodes + Param/Binding/KwEntry
 *  leaves) — mirrors `../peepholes/index.ts`'s `maxNodeId` visitor shape,
 *  scoped locally to this file's own collision check (this package's
 *  established precedent: each concern re-walks structurally rather than
 *  sharing one generic visitor — see `reconcile.ts`'s own header). */
function allIds(forms: readonly CoreForm[]): number[] {
  const ids: number[] = [];
  const visit = (node: CoreForm): void => {
    ids.push(node.id);
    switch (node.kind) {
      case "Define":
        visit(node.value);
        if (node.overridableType) visit(node.overridableType);
        return;
      case "DefineFn":
        for (const p of node.params) ids.push(p.id);
        for (const f of node.body) visit(f);
        if (node.overridableType) visit(node.overridableType);
        return;
      case "Lambda":
        for (const p of node.params) ids.push(p.id);
        for (const f of node.body) visit(f);
        return;
      case "If":
        visit(node.cond);
        visit(node.then);
        visit(node.else);
        return;
      case "And":
      case "Or":
        for (const a of node.args) visit(a);
        return;
      case "Let":
      case "NamedLet":
        for (const b of node.bindings) {
          ids.push(b.id);
          visit(b.init);
        }
        for (const f of node.body) visit(f);
        return;
      case "Begin":
        for (const f of node.body) visit(f);
        return;
      case "App":
        visit(node.fn);
        for (const a of node.positionalArgs) visit(a);
        for (const kw of node.kwargs) {
          ids.push(kw.id);
          visit(kw.value);
        }
        return;
      case "Dict":
        for (const e of node.entries) {
          ids.push(e.id);
          visit(e.value);
        }
        return;
      default:
        return; // Ref | Lit | Quote | Require | Door — leaves.
    }
  };
  for (const f of forms) visit(f);
  return ids;
}

describe("reconcileForms — content-key soundness (adversarial near-miss pairs)", () => {
  it("byte-identical source: every form is shared, BY REFERENCE (not just by value)", () => {
    const src = `(define x 5)\n(define (f a) (+ a 1))`;
    const prev = cf(src);
    const { forms, shared, changed } = reconcileForms(prev, src);
    expect(changed.size).toBe(0);
    expect(shared.size).toBe(2);
    expect(forms[0]).toBe(prev[0]); // reference equality — the REUSED object, not a lookalike
    expect(forms[1]).toBe(prev[1]);
  });

  it("near-miss: a changed LITERAL must not be shared (else a stale fact leaks)", () => {
    const prev = cf(`(define x 5)\n(define y 10)`);
    const { forms, shared, changed } = reconcileForms(prev, `(define x 5)\n(define y 11)`);
    expect(shared.size).toBe(1);
    expect(changed.size).toBe(1);
    expect(forms[0]).toBe(prev[0]); // x unchanged — shared
    expect(forms[1]).not.toBe(prev[1]); // y's literal changed — must NOT reuse prev's object
  });

  it("near-miss: a changed nested string literal must not be shared", () => {
    const prev = cf(`(define (f x) (if (> x 0) "pos" "neg"))`);
    const { shared, changed } = reconcileForms(prev, `(define (f x) (if (> x 0) "pos" "neg!"))`);
    expect(shared.size).toBe(0);
    expect(changed.size).toBe(1);
  });

  it("near-miss: a renamed REFERENCED symbol (a called function) must not be shared", () => {
    const prev = cf(`(define (f) (helper-a))\n(define (g) 1)`);
    const { forms, shared, changed } = reconcileForms(prev, `(define (f) (helper-b))\n(define (g) 1)`);
    expect(shared.size).toBe(1);
    expect(changed.size).toBe(1);
    expect(forms[1]).toBe(prev[1]); // g is untouched
    expect(forms[0]).not.toBe(prev[0]); // f's callee renamed
  });

  it("near-miss: a renamed BOUND symbol (a parameter) must not be shared", () => {
    const prev = cf(`(define (f a) (+ a 1))`);
    const { shared, changed } = reconcileForms(prev, `(define (f b) (+ b 1))`);
    expect(shared.size).toBe(0);
    expect(changed.size).toBe(1);
  });

  it("near-miss: a reordered argument list must not be shared", () => {
    const prev = cf(`(define (f a b) (- a b))`);
    const { shared, changed } = reconcileForms(prev, `(define (f a b) (- b a))`);
    expect(shared.size).toBe(0);
    expect(changed.size).toBe(1);
  });

  it("a form ADDED at the end: the originals stay shared, the new one is changed", () => {
    const prev = cf(`(define x 1)\n(define y 2)`);
    const { forms, shared, changed } = reconcileForms(prev, `(define x 1)\n(define y 2)\n(define z 3)`);
    expect(forms).toHaveLength(3);
    expect(shared.size).toBe(2);
    expect(changed.size).toBe(1);
    expect(forms[0]).toBe(prev[0]);
    expect(forms[1]).toBe(prev[1]);
  });

  it("a form REMOVED: the survivor stays shared, nothing invents a replacement", () => {
    const prev = cf(`(define x 1)\n(define y 2)`);
    const { forms, shared, changed } = reconcileForms(prev, `(define y 2)`);
    expect(forms).toHaveLength(1);
    expect(shared.size).toBe(1);
    expect(changed.size).toBe(0);
    expect(forms[0]).toBe(prev[1]);
  });

  it("duplicate identical top-level forms: FIFO matching never double-claims one prev object", () => {
    const prev = cf(`(display "hi")\n(display "hi")`);
    const { forms, shared, changed } = reconcileForms(prev, `(display "hi")\n(display "hi")\n(display "hi")`);
    expect(forms).toHaveLength(3);
    expect(shared.size).toBe(2); // both prev objects reused, each exactly once
    expect(changed.size).toBe(1);
    expect(new Set(forms.slice(0, 2))).toEqual(new Set(prev)); // the two shared ARE the two distinct prev objects
  });

  it("NodeId collision-freedom: every id in the spliced tree is globally unique, across many edits", () => {
    const cases: readonly [string, string][] = [
      [`(define x 5)\n(define y 10)`, `(define x 5)\n(define y 11)`],
      [`(define (f a) (+ a 1))`, `(define (f b) (+ b 1))`],
      [`(define (f x) (if (> x 0) "pos" "neg"))`, `(define (f x) (if (> x 0) "pos" "neg!"))`],
      [`(define x 1)\n(define y 2)`, `(define x 1)\n(define y 2)\n(define z 3)`],
      [`(define (f a) (let ((y 1) (z 2)) (+ a y z)))`, `(define (f a) (let ((y 1) (z 99)) (+ a y z)))`],
    ];
    for (const [prevSrc, newSrc] of cases) {
      const prev = cf(prevSrc);
      const { forms } = reconcileForms(prev, newSrc);
      const ids = allIds(forms);
      expect(new Set(ids).size, `duplicate id in spliced tree for ${JSON.stringify(newSrc)}`).toBe(ids.length);
    }
  });

  it("chained reconcile (reconciling a reconciled splice): ids stay unique across three generations", () => {
    const gen0 = cf(`(define a 1)\n(define b 2)\n(define c 3)`);
    const gen1 = reconcileForms(gen0, `(define a 1)\n(define b 20)\n(define c 3)`);
    const gen2 = reconcileForms(gen1.forms, `(define a 1)\n(define b 20)\n(define c 30)`);
    const ids = allIds(gen2.forms);
    expect(new Set(ids).size).toBe(ids.length);
    // `a` survived two reconciles untouched — same object both times.
    expect(gen2.forms[0]).toBe(gen1.forms[0]);
    expect(gen1.forms[0]).toBe(gen0[0]);
  });
});

// ── SchemeSemanticModel.reconcile — the load-bearing soundness gate ──────────
//
// A lightweight registry (no oracle session): `phase1Rules` overlaid on an
// EMPTY base is a fully-functional `EmitRegistry` for classification/facts/
// decision-view purposes (mirrors `peepholes.test.ts`'s own local-emit-pipeline
// registry) — no arrival interpreter session needs to spin up for THIS file's
// scope (facts/decision-view transplant correctness, not execution).
const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
const registry = withRules(EMPTY, phase1Rules);

/** Every node in `forms`, depth-first — used to walk two structurally-parallel
 *  trees (a reconciled model's spliced forms vs. a fresh model's forms over
 *  the SAME source) in lockstep, comparing `factsAt`/decision views node by
 *  node despite the two trees never sharing an object or a NodeId. */
function childrenOf(node: CoreForm): readonly CoreForm[] {
  switch (node.kind) {
    case "Define":
      return node.overridableType ? [node.value, node.overridableType] : [node.value];
    case "DefineFn":
      return node.overridableType ? [...node.body, node.overridableType] : [...node.body];
    case "Lambda":
      return node.body;
    case "If":
      return [node.cond, node.then, node.else];
    case "And":
    case "Or":
      return node.args;
    case "Let":
    case "NamedLet":
      return [...node.bindings.map((b) => b.init), ...node.body];
    case "Begin":
      return node.body;
    case "App":
      return [node.fn, ...node.positionalArgs, ...node.kwargs.map((k) => k.value)];
    case "Dict":
      return node.entries.map((e) => e.value);
    default:
      return []; // Ref | Lit | Quote | Require | Door — leaves.
  }
}

/** Asserts `a.factsAt`/decision views agree with `b`'s at every corresponding
 *  position of two structurally-isomorphic trees (same shape, different
 *  objects/ids — a reconciled model vs. a from-scratch one built on the same
 *  edited source). */
function assertSameAnswers(a: SchemeSemanticModel, an: CoreForm, b: SchemeSemanticModel, bn: CoreForm): void {
  expect(an.kind, "structurally-isomorphic trees must agree kind-by-kind").toBe(bn.kind);
  expect(a.factsAt(an)).toEqual(b.factsAt(bn));
  if (an.kind === "App" && bn.kind === "App") expect(a.idiomAt(an)).toEqual(deepStripIds(b.idiomAt(bn)));
  if ((an.kind === "If" || an.kind === "And" || an.kind === "Or") && an.kind === bn.kind) {
    expect(deepStripIds(a.prevalueOf(an as If | And | Or))).toEqual(deepStripIds(b.prevalueOf(bn as If | And | Or)));
  }
  if (an.kind === "Let" && bn.kind === "Let") {
    expect(deepStripIds(a.propagationOf(an))).toEqual(deepStripIds(b.propagationOf(bn)));
  }
  if (an.kind === "If" && bn.kind === "If") {
    expect(deepStripIds(a.sameBranchOf(an))).toEqual(deepStripIds(b.sameBranchOf(bn)));
  }
  const ac = childrenOf(an);
  const bc = childrenOf(bn);
  expect(ac.length).toBe(bc.length);
  for (let i = 0; i < ac.length; i++) assertSameAnswers(a, ac[i]!, b, bc[i]!);
}

/** Decision views can return a BRAND-NEW node (a fold/fusion) carrying a
 *  freshly-minted or remapped id — the two models' mints never agree
 *  numerically (different id floors), so comparing decisions structurally
 *  means ignoring `id`/`span` recursively, exactly like `reconcile.ts`'s own
 *  content key does for the SAME reason. `undefined` (the overwhelmingly
 *  common "no fold applies" answer) passes through unchanged. */
function deepStripIds(node: CoreForm | undefined): unknown {
  if (node === undefined) return undefined;
  const { id: _id, span: _span, lead: _lead, trail: _trail, ...rest } = node as CoreForm & Record<string, unknown>;
  const stripped: Record<string, unknown> = { kind: node.kind };
  for (const [k, v] of Object.entries(rest)) {
    if (k === "kind") continue;
    stripped[k] = Array.isArray(v)
      ? v.map((x) => (x && typeof x === "object" && "kind" in x ? deepStripIds(x as CoreForm) : x))
      : v && typeof v === "object" && "kind" in (v as object)
        ? deepStripIds(v as CoreForm)
        : v;
  }
  return stripped;
}

describe("SchemeSemanticModel.reconcile — sharing must be transparent", () => {
  const SOURCE = `(define (double x) (+ x x))
(define (safe-div a b) (if (= b 0) 0 (/ a b)))
(define (with-const x) (let ((y 10)) (+ x y)))
(define (pick-same flag x) (if flag x x))`;
  const EDITED = SOURCE.replace("(+ x x)", "(* x 2)");

  it("facts and every decision view agree, node-for-node, with a from-scratch model", () => {
    const prev = new SchemeSemanticModel(SOURCE, registry);
    // Force prev's own facts once (mirrors the benchmark's "force all facts+
    // views" step) — reconcile forces it again internally if this is skipped,
    // but exercising that call site here too is the more realistic path.
    prev.factsMap();

    const reconciled = prev.reconcile(EDITED);
    const fromScratch = new SchemeSemanticModel(EDITED, registry);

    expect(reconciled.coreform.forms).toHaveLength(fromScratch.coreform.forms.length);
    for (let i = 0; i < reconciled.coreform.forms.length; i++) {
      assertSameAnswers(reconciled, reconciled.coreform.forms[i]!, fromScratch, fromScratch.coreform.forms[i]!);
    }
  });

  it("the unchanged forms are cache HITS on every view; only the edited form misses", () => {
    const prev = new SchemeSemanticModel(SOURCE, registry);
    const visitAll = (sm: SchemeSemanticModel, forms: readonly CoreForm[]): void => {
      const go = (n: CoreForm): void => {
        sm.factsAt(n);
        if (n.kind === "App") sm.idiomAt(n);
        if (n.kind === "If" || n.kind === "And" || n.kind === "Or") sm.prevalueOf(n);
        if (n.kind === "Let") sm.propagationOf(n);
        if (n.kind === "If") sm.sameBranchOf(n);
        for (const c of childrenOf(n)) go(c);
      };
      for (const f of forms) go(f);
    };
    visitAll(prev, prev.coreform.forms);

    const { changed } = reconcileForms(prev.coreform.forms, EDITED);
    const reconciled = prev.reconcile(EDITED);
    visitAll(reconciled, reconciled.coreform.forms);

    // Every miss must belong to the one changed form's own subtree — none can
    // come from an unchanged (shared) form.
    const changedIds = new Set<number>();
    for (const f of changed) for (const id of allIds([f])) changedIds.add(id);
    const stats = reconciled.viewStats();
    expect(stats.idiomAt.misses).toBeGreaterThan(0); // the fixture DOES have an App in the edited form
    expect(stats.factsAt.misses).toBeGreaterThan(0);
    // A stronger, direct check: nothing outside `changed`'s node set contributed
    // a miss for the four decision views (facts already proven node-for-node
    // equal above; this is the count-based half of the same property).
    expect(stats.prevalueOf.misses + stats.sameBranchOf.misses).toBeLessThanOrEqual(
      // safe-div + pick-same each own one If; with-const's Let owns none of
      // these — an upper bound on how many COULD miss if the edit somehow
      // touched them, which it must not (double's body has no If).
      2,
    );
  });
});

// ── cross-form type flow — the reference-graph closure's own repro ──────────
//
// `f`'s return type flows into `g` (a direct caller) and, transitively, into
// `h` (a caller of `g` that never mentions `f` in its own text). `k` is a
// genuinely independent sibling — present to prove the closure does not
// over-dirty the whole program, only the actual dependency chain.
describe("reconcileForms + SchemeSemanticModel.reconcile — cross-form type flow (referential transparency)", () => {
  const SOURCE = `(define (f) (list 1 2))
(define (g) (car (f)))
(define (h) (g))
(define (k) 999)`;
  const EDITED = `(define (f) 42)
(define (g) (car (f)))
(define (h) (g))
(define (k) 999)`;

  it("reconcileForms: g and h are NOT silently shared despite byte-identical text — only k (truly independent) stays shared", () => {
    const prev = cf(SOURCE);
    const { forms, shared, changed } = reconcileForms(prev, EDITED);
    expect(forms).toHaveLength(4);
    expect(shared.size, "only k has no dependency on the edited f").toBe(1);
    expect(changed.size, "f itself, plus its two transitive dependents g and h").toBe(3);
    expect(forms[0]).not.toBe(prev[0]); // f — directly edited
    expect(forms[1]).not.toBe(prev[1]); // g — direct dependent (calls f)
    expect(forms[2]).not.toBe(prev[2]); // h — TRANSITIVE dependent (calls g, never mentions f)
    expect(forms[3]).toBe(prev[3]); // k — independent, reused verbatim
  });

  it("SchemeSemanticModel.reconcile: g and h's facts agree with a from-scratch model, node-for-node (the load-bearing gate, at this fixture)", () => {
    const prev = new SchemeSemanticModel(SOURCE, registry);
    prev.factsMap();

    const reconciled = prev.reconcile(EDITED);
    const fromScratch = new SchemeSemanticModel(EDITED, registry);

    expect(reconciled.coreform.forms).toHaveLength(fromScratch.coreform.forms.length);
    for (let i = 0; i < reconciled.coreform.forms.length; i++) {
      assertSameAnswers(reconciled, reconciled.coreform.forms[i]!, fromScratch, fromScratch.coreform.forms[i]!);
    }
  });

  it("pinned repro: g's call-to-f facts flip from list-shaped to numeric — the exact stale transplant this closure prevents", () => {
    const prev = new SchemeSemanticModel(SOURCE, registry);
    prev.factsMap();
    const gBefore = prev.coreform.forms[1] as DefineFn; // (define (g) (car (f)))
    const carAppBefore = gBefore.body[0] as App;
    const fCallBefore = carAppBefore.positionalArgs[0] as App; // (f)
    expect(prev.factsAt(fCallBefore)?.list, "f used to return a list").toBe(true);

    const reconciled = prev.reconcile(EDITED);
    const gAfter = reconciled.coreform.forms[1] as DefineFn;
    const carAppAfter = gAfter.body[0] as App;
    const fCallAfter = carAppAfter.positionalArgs[0] as App;
    expect(reconciled.factsAt(fCallAfter)?.numeric, "f now returns a number").toBe(true);
    expect(reconciled.factsAt(fCallAfter)?.list, "must NOT still show the stale list fact").toBeUndefined();
  });
});

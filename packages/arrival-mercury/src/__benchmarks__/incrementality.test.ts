/**
 * E4b's incrementality benchmark (engine plan §E4: "edit → new root with
 * structural sharing → surviving nodes keep cached facts → recompile touches
 * only the changed artifact. Measured, not claimed: a benchmark fixture (edit
 * one define in gepa, assert sub-linear recompute via view-hit counters)").
 *
 * A SYNTHETIC 6-define program stands in for "a trimmed gepa" (the plan names
 * both as acceptable) — deliberately built so every define is INDEPENDENT (no
 * define calls another): editing one define's body can then never ripple a
 * type-inference change into an unrelated define, which is exactly the
 * assumption `SchemeSemanticModel.reconcile`'s v1 transplant makes (facts
 * extraction is still whole-program tsc underneath — see `reconcile`'s own
 * doc in `../model/model.ts` for the "v1 boundary" this fixture is chosen to
 * stay inside of). A real gepa-scale fixture with cross-references would risk
 * the OPPOSITE demonstration — a define's inferred signature drifting because
 * SOME OTHER define changed — which is a real, documented, and DEFERRED risk
 * of blind whole-program transplant, not something this phase claims to
 * solve (a later phase's per-artifact TS catalog is where that gets closed).
 *
 * Two properties, "measured, not claimed":
 *  1. Zero recompute for unchanged forms — querying every view on the 5
 *     untouched defines produces ZERO misses (proven by query ORDER: shared
 *     forms are queried FIRST and checked before the changed form is ever
 *     touched, so a nonzero miss at that point could only come from a
 *     shared node — never inferred, always directly observed).
 *  2. Fresh-equivalence — sharing must never change an answer. The reconciled
 *     model and a from-scratch model built on the same edited source agree,
 *     node-for-node, on every view (the same soundness gate
 *     `../__tests__/reconcile.test.ts` pins on a smaller fixture; here it's
 *     re-run at this fixture's scale as this benchmark's own gate, per the
 *     phase's "the benchmark asserts... AND the fresh-equivalence property").
 */
import { describe, expect, it } from "vitest";

import type { And, CoreForm, If, Or } from "../coreform/types.js";
import { SchemeSemanticModel } from "../model/model.js";
import type { EmitRegistry } from "../registry/harvest.js";
import { phase1Rules } from "../rules/phase1.js";
import { withRules } from "../rules/overlay.js";

// No oracle session needed (mirrors `../__tests__/peepholes.test.ts`'s own
// local-emit-pipeline registry) — this benchmark measures view-hit/miss
// counts over classification+facts+decision-views, none of which need a live
// arrival interpreter.
const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
const registry = withRules(EMPTY, phase1Rules);

// Six independent top-level defines — see module header for why independence
// is load-bearing here. Each exercises a different view meaningfully:
//   double     → App only (idiomAt, factsAt) — THIS ONE gets edited.
//   safe-div   → If (prevalueOf, sameBranchOf — cond not foldable, branches differ)
//   with-const → Let (propagationOf — `y` is a literal binding, folds)
//   pick-same  → If (prevalueOf declines; sameBranchOf FOLDS — both branches are `x`)
//   square     → App only
//   negate     → App only
const SOURCE = `(define (double x) (+ x x))
(define (safe-div a b) (if (= b 0) 0 (/ a b)))
(define (with-const x) (let ((y 10)) (+ x y)))
(define (pick-same flag x) (if flag x x))
(define (square x) (* x x))
(define (negate x) (- 0 x))`;

// The edit: `double`'s body changes shape (still arithmetic, still returns a
// number) — nothing else references `double`, so nothing else's facts can be
// affected regardless of how tsc's whole-program check happens to work.
const EDITED = SOURCE.replace("(+ x x)", "(* x 2)");

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

/** Kinds `queryFacts` (`../typefacts/extract.ts`) ever attaches a fact OR a
 *  hole to — `Lit`/`Quote` derive structurally, `Ref`/`App`/`And`/`Or`/`If`
 *  are the QUERIED set; every OTHER kind (`Define`/`DefineFn`/`Lambda`/`Let`/
 *  `NamedLet`/`Begin`/`Dict`/`Require`/`Door`) is permanently absent from both
 *  maps — calling `factsAt` on one of those is not "querying facts" in any
 *  meaningful sense and would always read as a miss REGARDLESS of shared vs.
 *  changed (there is nothing to seed, ever), polluting the hit/miss signal
 *  this benchmark measures. `queryAll` below scopes `factsAt` calls to
 *  exactly this set — and additionally skips an App's OPERATOR-position `Ref`
 *  (`queryFacts`'s own `inAppFn` skip: "builtin heads lower to `__arr`
 *  members with no own atom emission") so the fixture's `+`/`*`/`-`/`/`/`=`
 *  call heads don't register as always-miss noise either. */
const FACT_QUERYABLE = new Set(["Ref", "App", "And", "Or", "If", "Lit", "Quote"]);

/** Query every applicable view on every node of `forms`, depth-first. The
 *  same "each concern re-walks structurally" precedent `../model/
 *  reconcile.ts`'s own header names (no shared generic visitor across
 *  production/test/benchmark code). `inAppFn` mirrors `typefacts/extract.ts`'s
 *  `walkProgram` — an App's own `fn` slot is skipped for `factsAt`. */
function queryAll(sm: SchemeSemanticModel, forms: readonly CoreForm[]): void {
  const go = (n: CoreForm, inAppFn: boolean): void => {
    if (FACT_QUERYABLE.has(n.kind) && !(n.kind === "Ref" && inAppFn)) sm.factsAt(n);
    if (n.kind === "App") sm.idiomAt(n);
    if (n.kind === "If" || n.kind === "And" || n.kind === "Or") sm.prevalueOf(n);
    if (n.kind === "Let") sm.propagationOf(n);
    if (n.kind === "If") sm.sameBranchOf(n);
    if (n.kind === "App") {
      go(n.fn, true);
      for (const a of n.positionalArgs) go(a, false);
      for (const kw of n.kwargs) go(kw.value, false);
      return;
    }
    for (const c of childrenOf(n)) go(c, false);
  };
  for (const f of forms) go(f, false);
}

const VIEWS = ["idiomAt", "prevalueOf", "propagationOf", "sameBranchOf", "factsAt"] as const;

describe("E4b incrementality benchmark — 6-define fixture, one edit", () => {
  it("property 1: querying every UNCHANGED define first produces zero misses on every view", () => {
    const sm1 = new SchemeSemanticModel(SOURCE, registry);
    queryAll(sm1, sm1.coreform.forms); // force every fact/decision — the pre-edit baseline

    const sm2 = sm1.reconcile(EDITED);

    // Derive shared/changed from `sm2`'s OWN actual splice (never a second,
    // independent `reconcileForms` call) — a shared form IS one of `sm1`'s
    // own form objects, by reference; anything else is `reconcile`'s fresh,
    // remapped replacement. Sourcing this from `sm2.coreform.forms` itself
    // (rather than re-deriving via `reconcileForms` a second time) guarantees
    // `queryAll` below touches the EXACT node objects `sm2`'s caches were
    // seeded against, not merely structurally-similar stand-ins.
    const prevFormSet = new Set(sm1.coreform.forms);
    const sharedForms = sm2.coreform.forms.filter((f) => prevFormSet.has(f));
    const changedForms = sm2.coreform.forms.filter((f) => !prevFormSet.has(f));
    expect(sharedForms, "5 of 6 defines are untouched by the edit").toHaveLength(5);
    expect(changedForms, "exactly `double` changed").toHaveLength(1);

    // Query ONLY the 5 unchanged forms — BEFORE the changed form is ever
    // touched. Any miss recorded here can only be attributed to a shared
    // node (query order makes this a direct observation, not an inference).
    queryAll(sm2, sharedForms);
    const afterSharedOnly = sm2.viewStats();
    for (const view of VIEWS) {
      expect(afterSharedOnly[view].misses, `${view}: unchanged defines must be ALL hits`).toBe(0);
      expect(afterSharedOnly[view].hits, `${view}: unchanged defines must have been queried at all`).toBeGreaterThan(0);
    }

    // NOW query the changed form — this is where recompute is EXPECTED.
    queryAll(sm2, changedForms);
    const afterChangedToo = sm2.viewStats();
    expect(afterChangedToo.idiomAt.misses, "the edited App itself must miss").toBeGreaterThan(0);
    expect(afterChangedToo.factsAt.misses, "the edited form's facts must miss").toBeGreaterThan(0);
    // The changed form (a lone App, no If/Let) contributes nothing to the
    // other three views — misses stay exactly what they were before it was
    // touched (zero), the sub-linear claim's sharpest form: recompute is
    // proportional to what the changed form ACTUALLY contains, not merely
    // "small".
    expect(afterChangedToo.prevalueOf.misses).toBe(afterSharedOnly.prevalueOf.misses);
    expect(afterChangedToo.propagationOf.misses).toBe(afterSharedOnly.propagationOf.misses);
    expect(afterChangedToo.sameBranchOf.misses).toBe(afterSharedOnly.sameBranchOf.misses);
  });

  it("property 2: fresh-equivalence — the reconciled model agrees with a from-scratch build, node-for-node", () => {
    const sm1 = new SchemeSemanticModel(SOURCE, registry);
    queryAll(sm1, sm1.coreform.forms);
    const sm2 = sm1.reconcile(EDITED);
    const fresh = new SchemeSemanticModel(EDITED, registry);

    expect(sm2.coreform.forms).toHaveLength(fresh.coreform.forms.length);
    for (let i = 0; i < sm2.coreform.forms.length; i++) {
      assertSameAnswers(sm2, sm2.coreform.forms[i]!, fresh, fresh.coreform.forms[i]!);
    }
  });
});

function assertSameAnswers(a: SchemeSemanticModel, an: CoreForm, b: SchemeSemanticModel, bn: CoreForm): void {
  expect(an.kind).toBe(bn.kind);
  expect(a.factsAt(an)).toEqual(b.factsAt(bn));
  if (an.kind === "App" && bn.kind === "App") expect(deepStripIds(a.idiomAt(an))).toEqual(deepStripIds(b.idiomAt(bn)));
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

/** Strip id/span/lead/trail recursively before comparing two decision-view
 *  answers — a fold/fusion may carry a freshly-minted or remapped id, and the
 *  two models here never share a mint floor, so raw `toEqual` would fail on
 *  numbers that were never meant to compare (mirrors `../model/reconcile.ts`'s
 *  content key excluding the same fields for the same reason). */
function deepStripIds(node: CoreForm | undefined): unknown {
  if (node === undefined) return undefined;
  const { id: _id, span: _span, lead: _lead, trail: _trail, ...rest } = node as CoreForm & Record<string, unknown>;
  const stripped: Record<string, unknown> = { kind: node.kind };
  for (const [k, v] of Object.entries(rest)) {
    stripped[k] = Array.isArray(v)
      ? v.map((x) => (x && typeof x === "object" && "kind" in x ? deepStripIds(x as CoreForm) : x))
      : v && typeof v === "object" && "kind" in (v as object)
        ? deepStripIds(v as CoreForm)
        : v;
  }
  return stripped;
}

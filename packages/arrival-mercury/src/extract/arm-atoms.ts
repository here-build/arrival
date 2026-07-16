/**
 * ARM-A — atoms / bindings / structure (IMPLEMENTED; all 8 atom forms).
 *
 * Owns: Lit, Ref, Quote, Define, Let, Begin, Require, Door.
 *
 * Contracts (I1 throughout — lift or opaque, never mislabel):
 *  - Lit          → ConstProv (program-text constant, THE fabrication mark).
 *                   A keyword Lit in App-head position never reaches here (ARM-B).
 *  - Quote        → ConstProv. Quoted data is inert program text — a quoted list
 *                   is ONE const, not a build (it cannot carry evidence).
 *  - Ref          → SCOPE FIRST (lexical shadowing is real — the
 *                   shadowed-input forge fix): in-scope ⇒ a synthetic `prov`
 *                   directly, or extract the bound expr IN ITS BINDING SCOPE
 *                   (Bound.scope, hardening #2) with the cycle guard;
 *                   UNBOUND ⇒ InputProv — the wire-model convention (derive.ts's
 *                   PVertice): the evidence handle arrives as a free name (`e`),
 *                   bound by the run harness, not the source. Sound under
 *                   adversarial authorship because the seal is static ∧ probe:
 *                   a name unbound at RUN time crashes the run, and no run ⇒ no
 *                   probe leg ⇒ nothing attests. define/overridable inputs are
 *                   bound by extractProgram as Bound{prov: InputProv} in the
 *                   ORDINARY top scope, so an inner shadow wins lexically.
 *  - Define       → attribution of its value (top-level registration is
 *                   extractProgram's job; nested defines extend scope).
 *  - Let (4 kinds)→ letKind-honoring scope extension (let: all inits in OUTER;
 *                   let*: each sees previous; letrec/letrec*: all see the new
 *                   frame — recursion through it hits the cycle guard), then
 *                   body: attribution of LAST body form (Begin semantics).
 *  - Begin        → attribution of the LAST form (earlier forms are effect
 *                   positions; their mints still exist as crossing sites but do
 *                   not flow into the value). A Define/DefineFn pools into ONE
 *                   body-local frame regardless of its position relative to the
 *                   selected last form (mirrors extractProgram's own top-level
 *                   treatment — bodies are the R7RS idiom of defines-then-
 *                   expressions; a define textually AFTER the selected last form
 *                   is not distinguished from one before it).
 *  - Require      → MintProv (a crossing: module loading penetrates the
 *                   membrane), integrity "evidence", head "require".
 *  - Door         → opaque(door.code) — the classifier already refused; extract
 *                   NEVER upgrades a Door.
 */
import type { Begin, Binding, CoreForm, Define, Door, Let, LetKind, Lit, NodeId, Quote, Ref, Require } from "../coreform/types.js";
import type { StaticProv } from "../model/static-prov.js";
// Circular with ./index.js by construction: index.ts imports extractAtom to dispatch INTO
// this module; this module imports extract to recurse back OUT for sub-forms. Sound because
// both sides only reach across the cycle from inside function bodies, never at module-eval
// time (the arm-group cut's own note — calls happen at runtime).
import { type Bound, type ExtractCtx, type RiskProbe, type Scope, extract, lookup, markRead, opaque, readSetMatches } from "./index.js";

type AtomForm = Lit | Ref | Quote | Define | Let | Begin | Require | Door;

export function extractAtom(form: AtomForm, ctx: ExtractCtx): StaticProv {
  switch (form.kind) {
    case "Lit":
      return { kind: "const", site: form.id };
    case "Quote":
      return { kind: "const", site: form.id };
    case "Ref":
      return extractRef(form, ctx);
    case "Define":
      return extract(form.value, ctx);
    case "Let": {
      const scope = extendForLet(form.letKind, form.bindings, ctx.scope);
      return extractBody(form.body, { ...ctx, scope }, form.id);
    }
    case "Begin":
      return extractBody(form.body, ctx, form.id);
    case "Require":
      return { kind: "mint", site: form.id, head: "require", integrity: "evidence", closed: [] };
    case "Door":
      return opaque(form.id, form.code);
  }
}

/** Ref's contract (SCOPE FIRST — the shadowed-input forge fix, corpus row 6):
 *  a scope hit wins unconditionally, honoring lexical shadowing — it is either
 *  a direct `prov` (a synthetic binding: a fan-body element, or a
 *  define/overridable input bound as InputProv by extractProgram) or a deferred
 *  `{expr, scope}` pair extracted IN ITS OWN BINDING SCOPE (never the
 *  reference site — derive.ts hardening #2) behind the cycle guard, MEMOIZED
 *  on the Bound object (the shared-DAG fix, G2, upgraded to read-set
 *  memoization #74 — see `ExtractCtx.memo`/`riskProbes`'s doc in index.ts for
 *  the cache's full soundness argument: it is keyed by Bound IDENTITY, so
 *  betaReduce's per-call-site fresh param Bounds never collide, and every
 *  completed extraction is written to `memo` alongside the read-set its own
 *  probe accumulated — a cached entry is only ever SERVED, though, when
 *  `readSetMatches` confirms this reference point's `ctx.reducing` agrees
 *  with that read-set; a mismatch falls through to a fresh, uncached-here
 *  extraction rather than laundering a context-dependent answer across
 *  reference points it was never computed for). Only a scope MISS is the
 *  evidence-handle convention: a free name is the input the harness binds
 *  (InputProv). ctx.inputs never bypasses scope — an inputs-first check let
 *  `(let ((e "FAB")) e)` attribute the shadow's const as evidence, which the
 *  static leg must never do. */
function extractRef(form: Ref, ctx: ExtractCtx): StaticProv {
  const bound = lookup(ctx.scope, form.name);
  if (bound === undefined) {
    // F23 (architecture review, 2026-07-15): a free name that the registry
    // KNOWS is a builtin head is a fn-as-value, not evidence — `(car (list +))`
    // must not launder `+` into an evidence-class input. Only registry-unknown
    // free names are the evidence-handle convention.
    if (ctx.registry.classifyHead(form.name).role !== "opaque") return opaque(form.id, "builtin-as-value");
    return { kind: "input", site: form.id, name: form.name };
  }
  // A synthetic InputProv re-stamps to the USE site: the binding is a
  // declaration-synthetic (extractProgram binds define/overridable once, at the
  // define's id), but every consumer of the attribution — scope-id addressing,
  // the render, where-provenance — wants the reference location. Other
  // synthetic kinds (fan elements) keep their binder's site deliberately: the
  // element IS the axis's projection, not a per-use value.
  if (bound.tag === "prov") return bound.prov.kind === "input" ? { ...bound.prov, site: form.id } : bound.prov;
  const reducingHit = ctx.reducing.has(bound.expr);
  markRead(ctx, bound.expr, reducingHit); // consulting `reducing`'s content — see ExtractCtx.riskProbes
  if (reducingHit) return opaque(form.id, "cyclic-binding");
  const cached = ctx.memo.get(bound);
  if (cached !== undefined && readSetMatches(cached.reads, ctx.reducing)) return cached.result;
  const probe: RiskProbe = { reads: new Map() };
  const result = extract(bound.expr, {
    ...ctx,
    scope: bound.scope,
    reducing: new Set([...ctx.reducing, bound.expr]),
    riskProbes: [...ctx.riskProbes, probe],
  });
  ctx.memo.set(bound, { reads: probe.reads, result });
  return result;
}

/** Build the scope a Let's BODY sees, honoring letKind (derive.ts's
 *  `extendForLet`, ported onto index.ts's Scope/Bound shapes — same three-way
 *  split, same reasoning): `let*` chains one frame per binding (init i sees
 *  bindings 0..i-1 only, never itself or later ones — each new frame carries
 *  just that one name, parented to the accumulator-so-far); `let` and
 *  `letrec`/`letrec*` build ONE frame, differing only in which scope the
 *  inits themselves resolve against (outer vs the frame itself,
 *  self-referential — a letrec cycle is caught later, by Ref's cycle guard,
 *  not here). */
function extendForLet(letKind: LetKind, bindings: readonly Binding[], outer: Scope): Scope {
  if (letKind === "let*") {
    let acc: Scope = outer;
    for (const b of bindings) {
      acc = { names: new Map([[b.name, { tag: "expr", expr: b.init, scope: acc }]]), parent: acc };
    }
    return acc;
  }
  const names = new Map<string, Bound>();
  const frame: Scope = { names, parent: outer };
  const initScope: Scope = letKind === "let" ? outer : frame; // letrec/letrec* — self-referential
  for (const b of bindings) names.set(b.name, { tag: "expr", expr: b.init, scope: initScope });
  return frame;
}

/** Shared Begin/Let-body walk: a Define/DefineFn extends one body-local frame
 *  (visible to the rest of the body — the R7RS internal-define idiom; for a
 *  DefineFn the bound expr is the DefineFn form itself, matching
 *  extractProgram's top-level treatment); every other form is a candidate
 *  value, and the LAST one seen is the one actually extracted — earlier
 *  candidates are effect positions and are never walked (I1 needs their
 *  crossing sites to exist in the SOURCE, not in this return value — walking
 *  them here would be pure waste, and extractProgram's own top-level pass
 *  already sets this precedent). All-defines body: fall back to the body's
 *  own last element (a bare Define there attributes its value via the Define
 *  case above). Empty body: opaque, fail-closed — CoreForm's grammar does not
 *  guarantee non-emptiness for Let/Begin bodies the way it does for
 *  DefineFn/Lambda. */
function extractBody(body: readonly CoreForm[], ctx: ExtractCtx, siteId: NodeId): StaticProv {
  const names = new Map<string, Bound>();
  const frame: Scope = { names, parent: ctx.scope };
  let scope: Scope = ctx.scope;
  let last: CoreForm | undefined;
  for (const f of body) {
    if (f.kind === "Define") {
      names.set(f.name, { tag: "expr", expr: f.value, scope: frame });
      scope = frame;
      continue;
    }
    if (f.kind === "DefineFn") {
      names.set(f.name, { tag: "expr", expr: f, scope: frame });
      scope = frame;
      continue;
    }
    last = f;
  }
  const target = last ?? body.at(-1);
  if (target === undefined) return opaque(siteId, "empty-body");
  return extract(target, { ...ctx, scope });
}

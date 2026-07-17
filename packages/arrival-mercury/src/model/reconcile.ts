/**
 * reconcileForms — E4b's structural-sharing splice (engine plan §E4: "edit → new
 * root with structural sharing → surviving nodes keep cached facts → recompile
 * touches only the changed artifact"). Given the PREVIOUS model's top-level forms
 * and a NEW source string, produces the new program's forms with every top-level
 * form PROVEN CLEAN — content-key identical to a prev form AND untainted by the
 * reference graph (see "The reference-graph closure", below) — spliced in AS THE
 * SAME OBJECT the prev model used, so `SchemeSemanticModel.reconcile` (model.ts)
 * can transplant the WeakMap decision-caches and the NodeId-keyed fact table for
 * free (identity equality IS the cache key for the former; the latter survives
 * because a reused form's ids are literally unchanged). Everything else —
 * content-changed, freshly added, or a referential DEPENDENT of either — is
 * freshly classified and id-remapped (`changed`).
 *
 * ── The content key (necessary, not sufficient) ──────────────────────────────
 * Two top-level forms with an identical content key extract IDENTICAL facts IN
 * ISOLATION — so the key must capture everything facts extraction reads: node
 * KIND, every literal value, every symbol name (Ref/Param/Binding/loop names,
 * Dict/kwarg keys, Require paths, Door identity), structurally, at every depth.
 * It must NOT capture NodeId or Span (those are re-minted per parse, never
 * semantic) or `lead`/`trail` comments (scheme comments carry no type-checker
 * weight — a comment-only edit should still share). `structKey` below is exactly
 * this: a nested-array fingerprint over every CoreForm field except
 * id/span/lead/trail, JSON-stringified into one comparable string. Because it is
 * literally the program's OWN meaning (not a text diff or a partial hash), a
 * changed literal, a renamed symbol, or a reordered argument all produce a
 * different key BY CONSTRUCTION — there is no near-miss the key can conflate
 * (pinned adversarially in `__tests__/reconcile.test.ts`).
 *
 * A matching key is NOT, by itself, sufficient to share: facts extraction is
 * WHOLE-PROGRAM (`typefacts/extract.ts`'s `QUERIED` walk reads
 * `checker.getTypeAtLocation` off the E4a whole-program `program` layer), so an
 * `App`'s facts include the CALLEE's return type — defined in a SIBLING form,
 * outside this node's own content key entirely. A form can be byte-identical to
 * its prev twin and still owe a DIFFERENT fact, if something it calls changed.
 * "The reference-graph closure", below, is the second, orthogonal test a form
 * must ALSO pass before it is safe to reuse.
 *
 * A source-text span slice was the other candidate for the content key (simpler,
 * no tree walk) — rejected because it needs the PREVIOUS source string to slice
 * against, and this function's contract is deliberately `(prevForms, newSource)`:
 * the caller (`SchemeSemanticModel.reconcile`) has already thrown its own source
 * away by the time a future model reconciles a THIRD time from a SECOND
 * reconciled model, whereas `prevForms` (the classified tree) is always at hand.
 * A structural key needs only the trees.
 *
 * ── The reference-graph closure (soundness — referential transparency) ───────
 * The language this package compiles is immutable, pure, homoiconic, and
 * referentially transparent: a form's facts flow from what it REFERENCES, not
 * merely from its own text. "Unchanged text" is therefore not "clean" — a form
 * is safe to reuse only if NOTHING it transitively references was itself
 * touched. `dirty = changed ∪ transitive-dependents`, where a dependent is a
 * form whose free refs intersect the DEFINED NAME of a dirty form — closed to a
 * fixpoint (`closeDirtySet`, below): `h` calls `g` calls `f`; editing `f` dirties
 * `f`, which dirties `g` via the `f`→`g` reference, which then dirties `h` via
 * the `g`→`h` reference, even though `h`'s own text never mentions `f`. Derived
 * on the spot from `fresh.forms`' own shape every call — no side-table, no
 * cache, matching the immutable/no-dynamics discipline this package itself
 * compiles under.
 *
 * A dependent that turns out dirty takes its FRESH twin (freshly classified,
 * id-remapped) — never the prev object, even though the content key matched —
 * for two reasons: (1) its facts must be RE-DERIVED against the new program's
 * whole-program check, and `SchemeSemanticModel.reconcile`'s facts-transplant
 * decides what to re-query by which OBJECTS are `changed`, not by why they are,
 * so reusing the prev object here would route right back to the stale fact this
 * closure exists to prevent; (2) its byte span may have SHIFTED in `newSource`
 * even though its own text didn't (an earlier sibling's edit can change length)
 * — a fresh twin carries the correct span, defusing that staleness for exactly
 * this subset (span drift under sharing for a genuinely INDEPENDENT form is a
 * separate, not-yet-addressed concern this fix does not claim to close).
 *
 * Free-ref collection (`freeRefsIn`) is deliberately UNSCOPED — no
 * lexical-shadowing awareness, the same safe over-approximation
 * `../shake/index.ts`'s own `freeNamesIn` makes for the identical reason (that
 * module's header: porting the walker's real scope stack just to answer "is
 * this name free at this depth" would cost as much machinery as `walk()`
 * itself). A locally-bound name that happens to share text with a dirtied
 * top-level define costs a missed sharing opportunity, never a missed real
 * dependency — Law F's safe direction.
 *
 * ── NodeId collision (the subtlety the plan calls out) ───────────────────────
 * `classify()` mints ids from ONE counter, per call, starting at 0 (coreform/
 * classify.ts). Re-parsing `newSource` therefore mints a FRESH id space that
 * starts at 0 again — numerically overlapping `prevForms`' id space. Splicing a
 * reused prev form (old ids) next to a freshly-classified changed form (new,
 * COLLIDING ids) would corrupt every NodeId-keyed table built over the spliced
 * tree (two different nodes claiming the same id). Fix: every CHANGED form's
 * subtree is re-minted, by `remapIds`, to start strictly above
 * `maxNodeId(prevForms)` — the same floor-above-every-existing-id technique
 * `model.ts`'s own `mintIdiomId` already uses for its fusion ids (`../peepholes/
 * index.ts`'s `maxNodeId`). Shared forms keep their prev ids verbatim (they are
 * the prev objects) — the two ranges are then disjoint by construction,
 * regardless of which forms end up shared vs. changed, or how the program
 * grows/shrinks. Verified by `__tests__/reconcile.test.ts`'s uniqueness check.
 */
import type { Binding, CoreForm, KwEntry, LitValue, NodeId, Param, QuoteDatum, ScalarLit } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { maxNodeId } from "../peepholes/index.js";

export interface ReconcileResult {
  /** The new program's top-level forms — a splice of REUSED prev objects
   *  (`shared`) and freshly-classified, id-remapped objects (`changed`), in
   *  the new source's own top-level order. */
  readonly forms: readonly CoreForm[];
  /** The subset of `forms` that ARE the prev model's own form objects (same
   *  identity, same NodeIds) — a structurally-identical prev form was found
   *  AND it is untainted by the reference-graph closure (module header). */
  readonly shared: ReadonlySet<CoreForm>;
  /** The subset of `forms` that are freshly classified from `newSource` (ids
   *  remapped above every prev id) — no structurally-identical prev form, OR
   *  one was found but this form is a transitive dependent of something that
   *  changed (module header's "reference-graph closure"). */
  readonly changed: ReadonlySet<CoreForm>;
}

/** Fingerprint alphabet: nested arrays only (never bare objects) so
 *  `JSON.stringify` has no key-ordering to worry about — array order IS the
 *  field order this module chooses, fixed below. */
type KeyAtom = string | number | boolean | null;
type Key = KeyAtom | readonly Key[];

const scalarLitKey = (v: ScalarLit): Key => {
  switch (v.kind) {
    case "number":
      return ["num", v.text];
    case "string":
      return ["str", v.value];
    case "boolean":
      return ["bool", v.value];
  }
};

const quoteDatumKey = (d: QuoteDatum): Key =>
  d.kind === "symbol" ? ["sym", d.name] : d.kind === "list" ? ["list", d.items.map(quoteDatumKey)] : scalarLitKey(d);

const litValueKey = (v: LitValue): Key => {
  switch (v.kind) {
    case "keyword":
      return ["kw", v.name];
    case "undefined":
      return ["undef"];
    default:
      return scalarLitKey(v);
  }
};

const paramKey = (p: Param): Key => ["param", p.name, p.rest];
const bindingKey = (b: Binding): Key => ["binding", b.name, structKey(b.init)];
const kwEntryKey = (e: KwEntry): Key => ["kwentry", e.key, structKey(e.value)];

/** Every CoreForm field EXCEPT `id`/`span`/`lead`/`trail` — see this module's
 *  header for why exactly this cut is the sound one. Exhaustive over the
 *  16-member union; a future member trips the `never` check at compile time. */
function structKey(node: CoreForm): Key {
  switch (node.kind) {
    case "Define":
      return ["Define", node.name, structKey(node.value), node.overridableType ? structKey(node.overridableType) : null];
    case "DefineFn":
      return [
        "DefineFn",
        node.name,
        node.params.map(paramKey),
        node.body.map(structKey),
        node.overridableType ? structKey(node.overridableType) : null,
      ];
    case "Lambda":
      return ["Lambda", node.params.map(paramKey), node.body.map(structKey)];
    case "If":
      return ["If", structKey(node.cond), structKey(node.then), structKey(node.else)];
    case "And":
      return ["And", node.args.map(structKey)];
    case "Or":
      return ["Or", node.args.map(structKey)];
    case "Let":
      return ["Let", node.letKind, node.bindings.map(bindingKey), node.body.map(structKey)];
    case "NamedLet":
      return ["NamedLet", node.loopName, node.bindings.map(bindingKey), node.body.map(structKey)];
    case "Begin":
      return ["Begin", node.body.map(structKey)];
    case "Quote":
      return ["Quote", quoteDatumKey(node.datum)];
    case "App":
      return ["App", structKey(node.fn), node.positionalArgs.map(structKey), node.kwargs.map(kwEntryKey)];
    case "Ref":
      return ["Ref", node.name];
    case "Lit":
      return ["Lit", litValueKey(node.value)];
    case "Dict":
      return ["Dict", node.entries.map(kwEntryKey)];
    case "Require":
      return ["Require", node.path];
    case "Door":
      return ["Door", node.category, node.code, node.message];
    default: {
      const exhaustive: never = node;
      throw new Error(`reconcile/structKey: unhandled CoreForm kind ${(exhaustive as CoreForm).kind}`);
    }
  }
}

/** The comparable string two top-level forms match on (see module header). */
const contentKeyOf = (form: CoreForm): string => JSON.stringify(structKey(form));

// ── id remap — every CHANGED form's subtree, shifted above `maxNodeId(prevForms)` ──

const shiftId = (id: NodeId, offset: number): NodeId => (id + offset) as NodeId;
const remapParam = (p: Param, offset: number): Param => ({ ...p, id: shiftId(p.id, offset) });
const remapBinding = (b: Binding, offset: number): Binding => ({
  ...b,
  id: shiftId(b.id, offset),
  init: remapIds(b.init, offset),
});
const remapKwEntry = (e: KwEntry, offset: number): KwEntry => ({
  ...e,
  id: shiftId(e.id, offset),
  value: remapIds(e.value, offset),
});

/** Clone `node`'s whole subtree with every id shifted by `offset` — CoreForm is
 *  immutable (coreform/types.ts's own law: "Nothing here is ever mutated"), so
 *  this is a rebuild, never an in-place edit. Exhaustive over the 16-member
 *  union (mirrors `../peepholes/index.ts`'s `maxNodeId` visitor and typefacts/
 *  extract.ts's `walkProgram` — the same child-shape enumeration a third time,
 *  each module's own scoped walk, per this codebase's established precedent of
 *  not sharing one generic visitor across unrelated concerns). */
function remapIds(node: CoreForm, offset: number): CoreForm {
  const id = shiftId(node.id, offset);
  switch (node.kind) {
    case "Define":
      return node.overridableType !== undefined
        ? { ...node, id, value: remapIds(node.value, offset), overridableType: remapIds(node.overridableType, offset) }
        : { ...node, id, value: remapIds(node.value, offset) };
    case "DefineFn":
      return node.overridableType !== undefined
        ? {
            ...node,
            id,
            params: node.params.map((p) => remapParam(p, offset)),
            body: node.body.map((f) => remapIds(f, offset)),
            overridableType: remapIds(node.overridableType, offset),
          }
        : {
            ...node,
            id,
            params: node.params.map((p) => remapParam(p, offset)),
            body: node.body.map((f) => remapIds(f, offset)),
          };
    case "Lambda":
      return { ...node, id, params: node.params.map((p) => remapParam(p, offset)), body: node.body.map((f) => remapIds(f, offset)) };
    case "If":
      return { ...node, id, cond: remapIds(node.cond, offset), then: remapIds(node.then, offset), else: remapIds(node.else, offset) };
    case "And":
      return { ...node, id, args: node.args.map((a) => remapIds(a, offset)) };
    case "Or":
      return { ...node, id, args: node.args.map((a) => remapIds(a, offset)) };
    case "Let":
      return { ...node, id, bindings: node.bindings.map((b) => remapBinding(b, offset)), body: node.body.map((f) => remapIds(f, offset)) };
    case "NamedLet":
      return { ...node, id, bindings: node.bindings.map((b) => remapBinding(b, offset)), body: node.body.map((f) => remapIds(f, offset)) };
    case "Begin":
      return { ...node, id, body: node.body.map((f) => remapIds(f, offset)) };
    case "Quote":
      return { ...node, id };
    case "App":
      return {
        ...node,
        id,
        fn: remapIds(node.fn, offset),
        positionalArgs: node.positionalArgs.map((a) => remapIds(a, offset)),
        kwargs: node.kwargs.map((kw) => remapKwEntry(kw, offset)),
      };
    case "Ref":
      return { ...node, id };
    case "Lit":
      return { ...node, id };
    case "Dict":
      return { ...node, id, entries: node.entries.map((e) => remapKwEntry(e, offset)) };
    case "Require":
      return { ...node, id };
    case "Door":
      return { ...node, id };
    default: {
      const exhaustive: never = node;
      throw new Error(`reconcile/remapIds: unhandled CoreForm kind ${(exhaustive as CoreForm).kind}`);
    }
  }
}

// ── the reference graph (soundness continued — referential transparency) ────
// See the module header's "reference-graph closure" section for the full
// rationale. Everything below is derived FRESH from `fresh.forms` on every
// `reconcileForms` call — no side-table, no cache.

/** Every free-referenced name anywhere in `node`'s subtree, unscoped (no
 *  lexical-shadowing awareness — see the module header for why this
 *  over-approximation is the sound direction). Re-walked locally rather than
 *  imported from `../shake/index.ts` (its own `freeNamesIn` is not exported,
 *  and this module already commits to "each concern re-walks structurally" —
 *  `remapIds`'s own doc makes the identical call against `maxNodeId`'s
 *  visitor). Exhaustive over the 16-member union, mirroring `structKey`/
 *  `remapIds` above. */
function freeRefsIn(node: CoreForm, out: Set<string>): void {
  switch (node.kind) {
    case "Ref":
      out.add(node.name);
      return;
    case "Define":
      freeRefsIn(node.value, out);
      if (node.overridableType !== undefined) freeRefsIn(node.overridableType, out);
      return;
    case "DefineFn":
      for (const f of node.body) freeRefsIn(f, out);
      if (node.overridableType !== undefined) freeRefsIn(node.overridableType, out);
      return;
    case "Lambda":
      for (const f of node.body) freeRefsIn(f, out);
      return;
    case "If":
      freeRefsIn(node.cond, out);
      freeRefsIn(node.then, out);
      freeRefsIn(node.else, out);
      return;
    case "And":
    case "Or":
      for (const a of node.args) freeRefsIn(a, out);
      return;
    case "Let":
    case "NamedLet":
      for (const b of node.bindings) freeRefsIn(b.init, out);
      for (const f of node.body) freeRefsIn(f, out);
      return;
    case "Begin":
      for (const f of node.body) freeRefsIn(f, out);
      return;
    case "App":
      freeRefsIn(node.fn, out);
      for (const a of node.positionalArgs) freeRefsIn(a, out);
      for (const kw of node.kwargs) freeRefsIn(kw.value, out);
      return;
    case "Dict":
      for (const e of node.entries) freeRefsIn(e.value, out);
      return;
    case "Quote":
    case "Lit":
    case "Require":
    case "Door":
      return;
    default: {
      const exhaustive: never = node;
      throw new Error(`reconcile/freeRefsIn: unhandled CoreForm kind ${(exhaustive as CoreForm).kind}`);
    }
  }
}

/** The name a top-level form itself DEFINES, or `undefined` — TOP-LEVEL only,
 *  deliberately (mirrors `../shake/index.ts`'s own `isNamedDefine` filter): an
 *  internal define nested inside a DefineFn/Lambda/Let body is lexically
 *  scoped to that form's OWN subtree and can never be referenced by name from
 *  a *different* top-level form, so it needs no entry in the reference graph
 *  built below (which relates SIBLINGS in `fresh.forms`, one level only). */
const topLevelNameOf = (form: CoreForm): string | undefined =>
  form.kind === "Define" || form.kind === "DefineFn" ? form.name : undefined;

/**
 * `dirty = changed ∪ transitive-dependents` (module header). `matched[i]` is
 * `freshForms[i]`'s content-key twin from Pass 1, or `undefined` — an index
 * with no twin is dirty from the start. `prevForms` contributes exactly one
 * seeding fact of its own: names whose top-level definition sequence changed
 * (deleted/renamed-away/redefinition-reordered defines have NO fresh form to
 * be unmatched, yet dirty every surviving referrer — see below). From there,
 * a fixpoint over `freshForms`' OWN free-ref/defines shape closes over every
 * sibling that refers to a dirty name, transitively (a content-key match
 * proves two trees agree at a node — never that the node's ENVIRONMENT
 * agrees, which is precisely what the name seeds carry).
 *
 * Graph direction is the TRANSPOSE of `../shake/index.ts`'s own `closureOf`:
 * shake starts at ROOTS and follows "what does this reference" FORWARD to
 * find everything reachable; this starts at EDITS and follows "what
 * references this" BACKWARD to find everything that owes a recompute — a
 * dependents-closure, not a reachability-closure. Implemented as a
 * name-keyed worklist for the same reason shake's is: a form can be reached
 * by more than one path, and the `dirty[i]` guard below makes each index
 * settle exactly once regardless of cycles (mutual recursion) or
 * self-reference.
 */
function closeDirtySet(
  prevForms: readonly CoreForm[],
  freshForms: readonly CoreForm[],
  matched: readonly (CoreForm | undefined)[],
): boolean[] {
  const freeRefs = freshForms.map((f) => {
    const out = new Set<string>();
    freeRefsIn(f, out);
    return out;
  });
  const definedName = freshForms.map(topLevelNameOf);

  // name -> every index whose free refs mention it — the reference graph,
  // TRANSPOSED (dependents, not dependencies), built once, read by the
  // worklist below.
  const dependentsOf = new Map<string, number[]>();
  freeRefs.forEach((refs, i) => {
    for (const name of refs) {
      const bucket = dependentsOf.get(name);
      if (bucket) bucket.push(i);
      else dependentsOf.set(name, [i]);
    }
  });

  const dirty = freshForms.map((_, i) => matched[i] === undefined);
  const dirtyNames = new Set<string>();
  const worklist: string[] = [];
  const markName = (name: string): void => {
    if (!dirtyNames.has(name)) {
      dirtyNames.add(name);
      worklist.push(name);
    }
  };
  const seedName = (i: number): void => {
    const name = definedName[i];
    if (name !== undefined) markName(name);
  };
  dirty.forEach((isDirty, i) => {
    if (isDirty) seedName(i);
  });

  // A name whose top-level DEFINITION SEQUENCE changed between prev and fresh
  // is dirty even when NO fresh form is — the deleted/renamed-away define has
  // no fresh form to be unmatched, yet every surviving referrer's facts were
  // computed against it (the stale-transplant hole: reconciled ≢ fresh on a
  // plain deletion). The per-name sequence of content keys — not a bare name
  // set — also covers a REDEFINED name losing/reordering one of its
  // definitions, where the surviving define is content-identical but the
  // winner changed. (An ADDED name needs no entry here: its defining form is
  // unmatched ⇒ already seeded above.)
  const defSequenceOf = (forms: readonly CoreForm[]): Map<string, string> => {
    const seq = new Map<string, string>();
    for (const f of forms) {
      const name = topLevelNameOf(f);
      if (name !== undefined) seq.set(name, `${seq.get(name) ?? ""} ${contentKeyOf(f)}`);
    }
    return seq;
  };
  const freshDefs = defSequenceOf(freshForms);
  for (const [name, seq] of defSequenceOf(prevForms)) {
    if (freshDefs.get(name) !== seq) markName(name);
  }

  while (worklist.length > 0) {
    const name = worklist.pop()!;
    for (const i of dependentsOf.get(name) ?? []) {
      if (!dirty[i]) {
        dirty[i] = true;
        seedName(i); // this dependent may itself define a name others rely on
      }
    }
  }
  return dirty;
}

/**
 * The E4b splice. Parses+classifies `newSource` fresh, then:
 *
 *  1. Content-key match each fresh top-level form against an unconsumed
 *     `prevForms` entry (FIFO — two textually-duplicate top-level forms never
 *     both claim the same prev object). Forms added/removed/reordered are
 *     handled for free: an unmatched fresh form simply has no prev twin, an
 *     unconsumed prev form is simply never referenced by the output.
 *  2. Close the DIRTY set over the reference graph (`closeDirtySet`, above) —
 *     every form with no content-key match, PLUS every transitive dependent
 *     of one (a sibling whose free refs mention a dirty form's defined name).
 *  3. Splice: a form that matched AND is not dirty is REUSED verbatim (same
 *     object, same NodeIds, same `lead`/`trail`); everything else — no match,
 *     or matched-but-dirty — is the freshly classified form with its
 *     subtree's ids remapped above `maxNodeId(prevForms)` (see header).
 */
export function reconcileForms(prevForms: readonly CoreForm[], newSource: string): ReconcileResult {
  const fresh = classify(desugar(parseSexprs(newSource)));
  const offset = maxNodeId(prevForms) + 1;

  const byKey = new Map<string, CoreForm[]>();
  for (const f of prevForms) {
    const k = contentKeyOf(f);
    const bucket = byKey.get(k);
    if (bucket) bucket.push(f);
    else byKey.set(k, [f]);
  }

  const matched: (CoreForm | undefined)[] = fresh.forms.map((freshForm) => {
    const bucket = byKey.get(contentKeyOf(freshForm));
    return bucket?.shift(); // FIFO — never double-claim one prev object
  });
  const dirty = closeDirtySet(prevForms, fresh.forms, matched);

  const forms: CoreForm[] = [];
  const shared = new Set<CoreForm>();
  const changed = new Set<CoreForm>();
  fresh.forms.forEach((freshForm, i) => {
    const reused = dirty[i] ? undefined : matched[i];
    if (reused !== undefined) {
      forms.push(reused);
      shared.add(reused);
    } else {
      const remapped = remapIds(freshForm, offset);
      forms.push(remapped);
      changed.add(remapped);
    }
  });
  return { forms, shared, changed };
}

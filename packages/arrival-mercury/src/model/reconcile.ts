/**
 * reconcileForms — E4b's structural-sharing splice (engine plan §E4: "edit → new
 * root with structural sharing → surviving nodes keep cached facts → recompile
 * touches only the changed artifact"). Given the PREVIOUS model's top-level forms
 * and a NEW source string, produces the new program's forms with every
 * structurally-unchanged top-level form spliced in AS THE SAME OBJECT the prev
 * model used — so `SchemeSemanticModel.reconcile` (model.ts) can transplant the
 * WeakMap decision-caches and the NodeId-keyed fact table for free (identity
 * equality IS the cache key for the former; the latter survives because a
 * reused form's ids are literally unchanged).
 *
 * ── The content key (soundness) ──────────────────────────────────────────────
 * Two top-level forms are "the same" iff they would extract IDENTICAL facts —
 * so the key must capture everything facts extraction reads: node KIND, every
 * literal value, every symbol name (Ref/Param/Binding/loop names, Dict/kwarg
 * keys, Require paths, Door identity), structurally, at every depth. It must
 * NOT capture NodeId or Span (those are re-minted per parse, never semantic) or
 * `lead`/`trail` comments (scheme comments carry no type-checker weight — a
 * comment-only edit should still share). `structKey` below is exactly this: a
 * nested-array fingerprint over every CoreForm field except id/span/lead/trail,
 * JSON-stringified into one comparable string. Because it is literally the
 * program's meaning (not a text diff or a partial hash), a changed literal, a
 * renamed symbol, or a reordered argument all produce a different key BY
 * CONSTRUCTION — there is no near-miss the key can conflate (pinned
 * adversarially in `__tests__/reconcile.test.ts`).
 *
 * A source-text span slice was the other candidate (simpler, no tree walk) —
 * rejected because it needs the PREVIOUS source string to slice against, and
 * this function's contract is deliberately `(prevForms, newSource)`: the caller
 * (`SchemeSemanticModel.reconcile`) has already thrown its own source away by
 * the time a future model reconciles a THIRD time from a SECOND reconciled
 * model, whereas `prevForms` (the classified tree) is always at hand. A
 * structural key needs only the trees.
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
   *  identity, same NodeIds) — a structurally-identical form was found. */
  readonly shared: ReadonlySet<CoreForm>;
  /** The subset of `forms` that are freshly classified from `newSource` (ids
   *  remapped above every prev id) — no structurally-identical prev form. */
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

/**
 * The E4b splice. Parses+classifies `newSource` fresh, then walks its top-level
 * forms in order: a structurally-identical (by content key) `prevForms` entry
 * — not yet consumed by an earlier match, so two textually-duplicate top-level
 * forms never both claim the same prev object — is REUSED verbatim (same
 * object, same NodeIds, same `lead`/`trail`); everything else is the freshly
 * classified form with its subtree's ids remapped above
 * `maxNodeId(prevForms)` (see header). Forms added/removed/reordered are
 * handled for free: unmatched fresh forms fall to `changed`, unconsumed prev
 * forms are simply never referenced by the output.
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

  const forms: CoreForm[] = [];
  const shared = new Set<CoreForm>();
  const changed = new Set<CoreForm>();
  for (const freshForm of fresh.forms) {
    const bucket = byKey.get(contentKeyOf(freshForm));
    const reused = bucket?.shift(); // FIFO — never double-claim one prev object
    if (reused !== undefined) {
      forms.push(reused);
      shared.add(reused);
    } else {
      const remapped = remapIds(freshForm, offset);
      forms.push(remapped);
      changed.add(remapped);
    }
  }
  return { forms, shared, changed };
}

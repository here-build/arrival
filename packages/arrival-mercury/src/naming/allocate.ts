/**
 * ALLOCATION — E1a's one naming-policy commit (engine plan §2 E1a item 2):
 * feeds the census to `@here.build/lexical-namer` (the SAME adapter shape
 * front/scheme-scope.ts already proves for the read register's namer —
 * candidate ladders, collision resolution over a lexical scope tree), and
 * decides EVERY binding's final name plus every destructure shape's slot
 * names, in one global pass.
 *
 * ── Priority scheme (why a plain 1-2-rung ladder isn't enough) ─────────────
 * `resolveLexicalNames` resolves same-priority collisions SYMMETRICALLY (both
 * tied entities get postfixed — see its own doc on `onTie`). That is wrong for
 * this package's declaration-order convention: `(define (f x) (let ((x 2)) x))`
 * must keep the PARAM's bare "x" and suffix the LET's "x" to "x_2" — an
 * asymmetric, first-come-first-served outcome (walker/walk.ts's original
 * `declareJs` ladder, incremental at mint time). Fix: every SIMPLE-form site
 * gets a strictly-decreasing priority per (rung, declaration index) — see
 * `RUNG_BAND`/`TOP_PRIORITY` below — so two sites competing for the same bare
 * name are NEVER a same-priority tie; whichever was declared first always
 * wins outright, and the later one falls through to the generic numeric
 * fallback. `onTie`/`resolveTie` stay set (matching scheme-scope.ts's own
 * choice) as a defensive backstop only — the priority scheme is built to make
 * them dead code in practice. Destructure-eligible sites (below) don't carry a
 * `declIndex` at all — the library resolves rich (Shape-form) entities in a
 * SEPARATE phase, after every simple entity in the same scope, by design (see
 * `@here.build/lexical-namer`'s own `resolveScope`); the declaration-order
 * scheme only needs to stay internally consistent among simple entities.
 *
 * ── Two fallback-suffix conventions, reconciled ─────────────────────────────
 * The walker's ORIGINAL two mint paths used two different collision-suffix
 * spellings: `declareJs` → `${name}_${n}` ("x_2"), `fresh` → `${name}${n}`
 * ("__or2", no separating underscore — the mint hint is already
 * double-underscore-prefixed). `resolveLexicalNames`'s `fallbackSuffix` is
 * ONE function for the whole resolution, so both conventions can't ride it
 * simultaneously. Resolution: "declared" sites rely on the library's generic
 * fallback (set to the `_${n}` convention below); "fresh" sites instead get a
 * PRE-EXPANDED ladder of `${base}${n}` candidates (2..50) so the library's
 * generic fallback is never actually reached for them in practice — 50 nested
 * same-hint collisions is far beyond anything a real corpus program
 * approaches. The library's generic `fallbackSuffix` only ever fires for
 * SIMPLE-form entities (`resolveScope`'s own dedicated fallback loop walks
 * `sortedEntities`, never rich ones) — every Shape binding built below
 * (`shapeLadder`) carries its OWN pre-expanded `_2`..`_50` tail for the same
 * reason `freshCandidates` does, so a rich entity's resolution can never
 * throw the library's "no shape fits" invariant in practice either.
 *
 * ── Destructure dissolves into the Shape API (naming lane item 1) ──────────
 * A destructure-eligible site (`BindingSite.destructure`/`.fieldDestructure`
 * — census.ts's positional car/cdr analysis or its dict-field twin) is fed as
 * a RICH entity: a T100 "destructure" shape (bindings = the destructured
 * slots/fields; facets = their accesses) alongside a T80 "bare" shape (the
 * site's ORDINARY, non-destructured candidate ladder) — exactly the shape
 * `@here.build/lexical-namer`'s own state/query examples use
 * (`examples-destructure.test.ts`'s D1/D7). The resolver picks T100 whenever
 * every one of its bindings allocates; genuine exhaustion (every candidate,
 * including the 50-deep fallback tail, blocked) falls to T80 — a real
 * behavioral gain over the old design (which always committed to destructure
 * once census decided it, with no allocation-time escape hatch) that is
 * vanishingly unlikely to ever fire in practice, since slot/field names are
 * fresh, small, and rarely collide.
 */
import { resolveLexicalNames, type FacetExpr, type Shape, type ShapeBinding, type ScopeSpec, type ScopedEntity } from "@here.build/lexical-namer";

import { Binding as mkBinding } from "../residual/types.js";
import type { Binding, R } from "../residual/types.js";
import { cleanName, nameCandidates, RESERVED as JS_RESERVED } from "../walker/names.js";
import type { BindingCensus, BindingSite, NameAllocation, ScopeCensus } from "./types.js";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinalName = (k: number): string => ORDINALS[k] ?? `item${k + 1}`;

/** Width of one entity's own rung band, and the absolute top of the priority
 *  space — see the module header. `RUNG_BAND` (1e6) vastly exceeds the
 *  per-scope declaration-index stagger (below), so an entity's rung N always
 *  outranks any OTHER entity's rung N+1 regardless of declaration order, for
 *  any realistic program size (safe up to ~1e6 total bindings). Only SIMPLE-
 *  form (non-destructure-eligible) sites use this scheme — see module header. */
const RUNG_BAND = 1_000_000;
const TOP_PRIORITY = 1_000_000_000;
/** How many `${base}${n}` fallback rungs a "fresh" entity's ladder pre-expands
 *  — see the module header's fallback-suffix note. */
const FRESH_FALLBACK_DEPTH = 50;
/** How many `${base}_${n}` fallback rungs a Shape binding's OWN candidate
 *  ladder pre-expands (module header: Shape resolution has no access to the
 *  library's generic simple-form fallback). Same depth as `FRESH_FALLBACK_DEPTH`
 *  — "far beyond anything a real corpus program approaches" applies equally. */
const SHAPE_FALLBACK_DEPTH = 50;

/**
 * A destructure-eligible site's own sub-binding key — one per positional slot
 * (`slot: number`, from `DestructureShape`) or field (`slot: string`, from
 * `FieldDestructureShape`), or the T80 bare shape's single sub-binding
 * (sentinel `slot: "bare"`). Identity-keyed: the SAME object instance is kept
 * in `slotsByParam` (below) and handed to the Shape as `ShapeBinding.subKey`,
 * so the result read-back can look up the exact key the library resolved a
 * name for (Maps here key by reference, not structural shape).
 */
interface SlotKey {
  readonly param: Binding;
  readonly slot: number | string;
}
type NameKey = Binding | SlotKey;

/**
 * The bare names every "declared", non-predicate, non-destructured site
 * wants — used to decide whether a PREDICATE's ladder should yield the bare
 * name to a plain binding (ported from front/scheme-scope.ts's `ladder()`;
 * same trick, same reason: `picked?` yields "picked" to a co-scoped `picked`
 * loop var by offering `isPicked` first).
 */
function computePlainPrimaries(census: BindingCensus): ReadonlySet<string> {
  const out = new Set<string>();
  for (const site of census.bySite.values()) {
    if (
      site.origin.mint === "declared" &&
      site.destructure === undefined &&
      site.fieldDestructure === undefined &&
      !site.origin.text.endsWith("?")
    ) {
      out.add(nameCandidates(site.origin.text)[0]!);
    }
  }
  return out;
}

/** Content-aware candidate ordering for a "declared" site — verbatim policy
 *  port of front/scheme-scope.ts's `ladder()` (adapted: that module builds a
 *  `Record<number,Candidate>` directly; this one returns the ordered name
 *  list, priorities assigned uniformly by `toCandidateRecord` below). */
function declaredCandidates(schemeName: string, plainPrimaries: ReadonlySet<string>): string[] {
  const isPred = schemeName.endsWith("?");
  let cands = nameCandidates(schemeName);
  if (isPred && cands.length > 1 && plainPrimaries.has(cands[0]!)) {
    cands = [cands[1]!, cands[0]!, ...cands.slice(2)]; // yield the contested bare name; isFoo on top
  }
  return cands;
}

/** Candidate ladder for a "fresh" (engine-glue) site: the singular collection
 *  name first when the census derived one (the singularize/fold-role win),
 *  else the `__`-prefixed hint — then a pre-expanded numeric-fallback tail
 *  (see the module header). */
function freshCandidates(site: BindingSite): string[] {
  const base = `__${cleanName(site.origin.text)}`;
  const list = site.singularName !== undefined ? [site.singularName, base] : [base];
  for (let n = 2; n <= FRESH_FALLBACK_DEPTH; n++) list.push(`${base}${n}`);
  return list;
}

function candidatesFor(site: BindingSite, plainPrimaries: ReadonlySet<string>): string[] {
  return site.origin.mint === "fresh" ? freshCandidates(site) : declaredCandidates(site.origin.text, plainPrimaries);
}

function toCandidateRecord(names: readonly string[], declIndex: number): Record<number, string> {
  const rec: Record<number, string> = {};
  names.forEach((name, rungIndex) => {
    rec[TOP_PRIORITY - rungIndex * RUNG_BAND - declIndex] = name;
  });
  return rec;
}

/** `[names[0], names[1], …, tail_2, tail_3, …]` as a priority-descending
 *  Record — a Shape binding's own guaranteed-fit ladder (module header: no
 *  access to the library's generic simple-form fallback, so every rich
 *  binding pre-expands its own numeric tail exactly like `freshCandidates`
 *  does for "fresh" simple-form sites). `_`-suffixed (the "declared"-style
 *  convention) — every name offered here reads like a real identifier (an
 *  ordinal, a field key, a fold role), never `__`-prefixed engine glue. */
function shapeLadder(names: readonly string[]): Record<number, string> {
  const last = names[names.length - 1]!;
  const withTail = [...names];
  for (let n = 2; n <= SHAPE_FALLBACK_DEPTH; n++) withTail.push(`${last}_${n}`);
  const rec: Record<number, string> = {};
  withTail.forEach((name, i) => {
    rec[withTail.length - i] = name;
  });
  return rec;
}

/** The bare candidate ladder a destructure-eligible site's T80 shape falls
 *  back to — identical to what the site would get had it never been
 *  destructure-eligible at all (`candidatesFor`), wrapped for Shape-binding
 *  use. "fresh" sites already self-guarantee (50-deep tail baked into
 *  `freshCandidates`) — wrapping again would just waste ladder rungs on a
 *  redundant tail, so only "declared" sites route through `shapeLadder`'s
 *  OWN tail-append. */
function bareLadder(site: BindingSite, plainPrimaries: ReadonlySet<string>): Record<number, string> {
  const names = candidatesFor(site, plainPrimaries);
  if (site.origin.mint === "fresh") {
    const rec: Record<number, string> = {};
    names.forEach((name, i) => {
      rec[names.length - i] = name;
    });
    return rec;
  }
  return shapeLadder(names);
}

/**
 * Build the [T100 destructure, T80 bare] shape ladder for a destructure-
 * eligible site (positional OR field — census guarantees at most one of
 * `site.destructure`/`site.fieldDestructure`, never both). Records every
 * SlotKey it mints into `slotsByParam` so `readAllocation` (below) can look
 * the exact same objects back up in the resolved per-entity result.
 */
function destructureShapes(
  site: BindingSite,
  plainPrimaries: ReadonlySet<string>,
  slotsByParam: Map<Binding, Map<number | string, SlotKey>>,
): readonly Shape<NameKey>[] {
  const param = site.binding;
  const slotMap = new Map<number | string, SlotKey>();
  slotsByParam.set(param, slotMap);

  const bareKey: SlotKey = { param, slot: "bare" };
  slotMap.set("bare", bareKey);
  const bareShape: Shape<NameKey> = {
    priority: 80,
    bindings: [{ subKey: bareKey, candidates: bareLadder(site, plainPrimaries) }],
    facets: { default: { kind: "binding", ref: bareKey, access: "" } },
  };

  if (site.destructure !== undefined) {
    const bindings: ShapeBinding<NameKey>[] = [];
    const facets: Record<string, FacetExpr<NameKey>> = {};
    for (let i = 0; i <= site.destructure.maxIndex; i++) {
      const key: SlotKey = { param, slot: i };
      slotMap.set(i, key);
      const name = site.destructure.maxIndex === 0 ? "head" : ordinalName(i);
      bindings.push({ subKey: key, candidates: shapeLadder([name]) });
      facets[String(i)] = { kind: "binding", ref: key, access: "" };
    }
    return [{ priority: 100, bindings, facets }, bareShape];
  }

  // fieldDestructure — the dict-field twin (item 2). One binding per distinct
  // field key, candidate-laddered through `nameCandidates` (the SAME
  // kebab→camel/reserved-word convention a "declared" site's own ladder uses
  // — a field name is real identifier text, not engine glue).
  const fd = site.fieldDestructure!;
  const bindings: ShapeBinding<NameKey>[] = [];
  const facets: Record<string, FacetExpr<NameKey>> = {};
  for (const field of fd.fields) {
    const key: SlotKey = { param, slot: field };
    slotMap.set(field, key);
    bindings.push({ subKey: key, candidates: shapeLadder(nameCandidates(field)) });
    facets[field] = { kind: "binding", ref: key, access: "" };
  }
  return [{ priority: 100, bindings, facets }, bareShape];
}

/** Mutable declaration-order counter, threaded through the whole scope-tree
 *  build in visitation order (pre-order, matching census.ts's own traversal —
 *  params/names before body statements, matching the walker's original
 *  declare-then-descend order). Consumed TWO ways: SIMPLE-form sites bake it
 *  directly into their candidates' priority (`toCandidateRecord` — dead-code
 *  tie-break backstop, module header); EVERY site (simple or rich) also
 *  records it into `declOrderOf` for `compareEntities` below — the ONLY
 *  ordering lever rich (Shape-form) entities have, since the library
 *  resolves them in a separate phase, greedily, in `compareEntities` order
 *  (`@here.build/lexical-namer`'s own `resolveScope`: "Phase 2: rich-shape
 *  entities... greedy per-entity in stable order"). Without this, two
 *  sibling destructure-eligible params contesting the same field/slot name
 *  (e.g. two params each used only via their own `["via"]`) would resolve in
 *  the library's DEFAULT order (lexical compare of `postfixFor`'s stringified
 *  counter — NOT declaration order, since postfixes are assigned on first
 *  probe by `Array.prototype.sort`, not by source position) instead of the
 *  package's own "first declared wins the bare name" convention every OTHER
 *  binding in this module honors. */
interface DeclCounter {
  n: number;
}

function buildScopeSpec(
  scope: ScopeCensus,
  plainPrimaries: ReadonlySet<string>,
  counter: DeclCounter,
  slotsByParam: Map<Binding, Map<number | string, SlotKey>>,
  declOrderOf: Map<NameKey, number>,
): ScopeSpec<NameKey> {
  const entities: ScopedEntity<NameKey>[] = [];
  for (const site of scope.sites) {
    declOrderOf.set(site.binding, counter.n);
    if (site.destructure !== undefined || site.fieldDestructure !== undefined) {
      entities.push({ key: site.binding, shapes: destructureShapes(site, plainPrimaries, slotsByParam) });
      counter.n++;
      continue;
    }
    const names = candidatesFor(site, plainPrimaries);
    entities.push({ key: site.binding, candidates: toCandidateRecord(names, counter.n) });
    counter.n++;
  }
  const children = scope.children.map((c) => buildScopeSpec(c, plainPrimaries, counter, slotsByParam, declOrderOf));
  return { entities, children };
}

/**
 * Allocate final names for every site in `census`, plus destructure slot
 * names. `reservations` (stage-0 manifest exports + the "Error"/"Math"/
 * "Promise" globals other passes reference verbatim) are FIXED, propagate to
 * every scope (root-level, per `ScopeSpec.reservations`'s down-propagation),
 * and are unioned with the platform's own JS reserved words (`walker/names.ts`'s
 * `RESERVED` — the SAME set `cleanName` escapes against, so a reservation here
 * can never fight a candidate ladder that already avoided it).
 */
export function allocateNames(census: BindingCensus, reservations: readonly string[]): NameAllocation {
  const plainPrimaries = computePlainPrimaries(census);
  const slotsByParam = new Map<Binding, Map<number | string, SlotKey>>();
  const counter: DeclCounter = { n: 0 };
  const declOrderOf = new Map<NameKey, number>();
  const root = buildScopeSpec(census.root, plainPrimaries, counter, slotsByParam, declOrderOf);
  const rooted: ScopeSpec<NameKey> = { ...root, reservations: [...JS_RESERVED, ...reservations] };

  const postfixOf = new Map<NameKey, string>();
  let postfixCounter = 0;
  const postfixFor = (key: NameKey): string => {
    let p = postfixOf.get(key);
    if (p === undefined) {
      p = String(postfixCounter++);
      postfixOf.set(key, p);
    }
    return p;
  };

  const { assignments, resolutions } = resolveLexicalNames(rooted, {
    postfixFor,
    // Declaration-order comparator — see `DeclCounter`'s doc. Falls back to 0
    // for a key `declOrderOf` never saw (a slot/field sub-key never reaches
    // `compareEntities`, which only ever receives top-level entity keys, but
    // the fallback keeps this total in case the library ever compares one).
    compareEntities: (a, b) => (declOrderOf.get(a) ?? 0) - (declOrderOf.get(b) ?? 0),
    resolveTie: (name, p) => `${name}_${p}`,
    fallbackSuffix: (name, n) => `${name}_${n}`,
    onTie: "free",
  });

  const nameOf = new Map<Binding, string>();
  const destructureOf = new Map<Binding, { slots: readonly Binding[]; positions: ReadonlyMap<R, number> }>();
  const fieldDestructureOf = new Map<
    Binding,
    { properties: readonly { key: string; binding: Binding }[]; accesses: ReadonlyMap<R, Binding> }
  >();

  for (const site of census.bySite.values()) {
    const slotMap = slotsByParam.get(site.binding);
    if (slotMap === undefined) {
      // Ordinary simple-form site — unaffected by the Shape dissolution.
      nameOf.set(site.binding, assignments.get(site.binding) ?? site.binding.text);
      continue;
    }
    const resolution = resolutions.get(site.binding)!;
    if (resolution.selectedShapePriority === 80) {
      // T80 bare shape won (destructure was offered but declined to allocate,
      // or — the overwhelmingly common case — this IS just how the site
      // resolves; either way it's an ordinary single name now).
      const bareKey = slotMap.get("bare")!;
      nameOf.set(site.binding, resolution.bindingNames.get(bareKey) ?? site.binding.text);
      continue;
    }
    // T100 destructure shape won — positional or field, whichever analysis fired.
    if (site.destructure !== undefined) {
      const slots: Binding[] = [];
      for (let i = 0; i <= site.destructure.maxIndex; i++) {
        slots.push(mkBinding(resolution.bindingNames.get(slotMap.get(i)!) ?? "_"));
      }
      destructureOf.set(site.binding, { slots, positions: site.destructure.positions });
    } else if (site.fieldDestructure !== undefined) {
      const properties = site.fieldDestructure.fields.map((field) => ({
        key: field,
        binding: mkBinding(resolution.bindingNames.get(slotMap.get(field)!) ?? "_"),
      }));
      const byField = new Map(properties.map((p) => [p.key, p.binding]));
      const accesses = new Map<R, Binding>();
      for (const [node, field] of site.fieldDestructure.accesses) accesses.set(node, byField.get(field)!);
      fieldDestructureOf.set(site.binding, { properties, accesses });
    }
  }
  return { nameOf, destructureOf, fieldDestructureOf };
}

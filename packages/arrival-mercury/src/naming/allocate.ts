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
 * `declareJs` ladder, incremental at mint time). Fix: every site gets a
 * strictly-decreasing priority per (rung, declaration index) — see
 * `RUNG_BAND`/`TOP_PRIORITY` below — so two sites competing for the same bare
 * name are NEVER a same-priority tie; whichever was declared first always
 * wins outright, and the later one falls through to the generic numeric
 * fallback. `onTie`/`resolveTie` stay set (matching scheme-scope.ts's own
 * choice) as a defensive backstop only — the priority scheme is built to make
 * them dead code in practice.
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
 * approaches.
 */
import { resolveLexicalNames, type ScopeSpec, type ScopedEntity } from "@here.build/lexical-namer";

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
 *  any realistic program size (safe up to ~1e6 total bindings). */
const RUNG_BAND = 1_000_000;
const TOP_PRIORITY = 1_000_000_000;
/** How many `${base}${n}` fallback rungs a "fresh" entity's ladder pre-expands
 *  — see the module header's fallback-suffix note. */
const FRESH_FALLBACK_DEPTH = 50;

/** A destructured param's slot is a SYNTHETIC key — it names no Binding until
 *  allocation itself decides its text (unlike every other entity, which keys
 *  directly off the ALREADY-MINTED Binding it renames). */
interface SlotKey {
  readonly param: Binding;
  readonly index: number;
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
    if (site.origin.mint === "declared" && site.destructure === undefined && !site.origin.text.endsWith("?")) {
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
 *  name first when the census derived one (the singularize win), else the
 *  `__`-prefixed hint — then a pre-expanded numeric-fallback tail (see the
 *  module header). */
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

/** Mutable declaration-order counter, threaded through the whole scope-tree
 *  build in visitation order (pre-order, matching census.ts's own traversal —
 *  params/names before body statements, matching the walker's original
 *  declare-then-descend order). */
interface DeclCounter {
  n: number;
}

function buildScopeSpec(
  scope: ScopeCensus,
  plainPrimaries: ReadonlySet<string>,
  counter: DeclCounter,
  slotsByParam: Map<Binding, SlotKey[]>,
): ScopeSpec<NameKey> {
  const entities: ScopedEntity<NameKey>[] = [];
  for (const site of scope.sites) {
    if (site.destructure !== undefined) {
      const slots: SlotKey[] = [];
      for (let i = 0; i <= site.destructure.maxIndex; i++) {
        const key: SlotKey = { param: site.binding, index: i };
        slots.push(key);
        const name = site.destructure.maxIndex === 0 ? "head" : ordinalName(i);
        entities.push({ key, candidates: toCandidateRecord([name], counter.n++) });
      }
      slotsByParam.set(site.binding, slots);
      continue;
    }
    const names = candidatesFor(site, plainPrimaries);
    entities.push({ key: site.binding, candidates: toCandidateRecord(names, counter.n++) });
  }
  const children = scope.children.map((c) => buildScopeSpec(c, plainPrimaries, counter, slotsByParam));
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
  const slotsByParam = new Map<Binding, SlotKey[]>();
  const counter: DeclCounter = { n: 0 };
  const root = buildScopeSpec(census.root, plainPrimaries, counter, slotsByParam);
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

  const { assignments } = resolveLexicalNames(rooted, {
    postfixFor,
    resolveTie: (name, p) => `${name}_${p}`,
    fallbackSuffix: (name, n) => `${name}_${n}`,
    onTie: "free",
  });

  const nameOf = new Map<Binding, string>();
  const destructureOf = new Map<
    Binding,
    { slots: readonly Binding[]; positions: ReadonlyMap<R, number> }
  >();
  for (const site of census.bySite.values()) {
    if (site.destructure !== undefined) {
      const slotKeys = slotsByParam.get(site.binding) ?? [];
      const slots = slotKeys.map((k) => mkBinding(assignments.get(k) ?? "_"));
      destructureOf.set(site.binding, { slots, positions: site.destructure.positions });
    } else {
      nameOf.set(site.binding, assignments.get(site.binding) ?? site.binding.text);
    }
  }
  return { nameOf, destructureOf };
}

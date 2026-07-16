/**
 * SHARED BINDINGS — E2's sharing decision-view + materializer (engine plan §2
 * E2, second half: "CSE… become… sharing… decision views
 * (`sm.sharedBindingsOf(unit)`)… decided pre-census so shared bindings get
 * named like everything else"). The dissolved `legibility/cse.ts`'s
 * pure-region CSE (constitution §3.5's third invention, leg 3) splits into:
 *
 *  - `sharedBindingsOf(unit, registry)` — THE VIEW: which structurally-
 *    identical, eligible `Call` groups (≥2 occurrences, scope-respecting)
 *    exist over an already-walked, already-NAMED `CompilationUnit`. Pure;
 *    never mutates `unit`. `model.ts`'s `sm.sharedBindingsOf` is a thin wrap.
 *  - `materializeSharedBindings(view)` — the mechanical commit: splice a
 *    `Const` before each group's earliest use (within ITS OWN scope),
 *    substitute every occurrence with a `Ref`, THEN route every hoisted
 *    binding's FINAL TEXT through the SAME `bindingCensusOf`/`allocateNames`
 *    machinery `walker/walk.ts`'s own naming phase uses (`census.ts`,
 *    `allocate.ts`) — "real allocated names", not the dissolved pass's own
 *    bespoke `mintFresh` + independent `taken`-set collision loop
 *    (`legibility/tree.ts`'s `mintFresh`, never called from here).
 *
 * ── Why the eligibility gate still needs the FINISHED, already-NAMED tree ───
 * Unchanged from the dissolved pass's own reasoning: CSE's eligibility (a
 * REGISTRY read — `cacheClass`/`provenance`, constitution §2.3) and its
 * structural-equality grouping both need the FINISHED, already-NAMED
 * Residual tree — hoisting is a cross-occurrence dedup decision the naming
 * phase's per-site census was never structured to make (it censuses binding
 * SITES, not multi-occurrence EXPRESSION sharing), and structural equality
 * BY TEXT (two `Ref`s to "the same" variable must print the SAME name) is
 * only sound once names are collision-resolved and final — a PROVISIONAL
 * (pre-allocation) tree can have two DIFFERENT bindings sharing the same
 * placeholder text. "Decided pre-census" (this module's header quote) means
 * pre the SECOND census — the one THIS module's own hoisted temps go
 * through — not pre `walk()`'s own (first) census/allocate cycle, which must
 * still run first to produce the FINAL, name-stable tree this view reads.
 *
 * ── Eligibility (the purity gate) — ported verbatim ──────────────────────────
 * A `Call` is CSE-eligible iff its callee is a `RuntimeRef` whose REGISTRY row has
 * `cacheClass` "pure" or "view" AND `provenance` is neither "sink" nor "opaque"
 * (sinks NEVER dedup — checked explicitly, even though a sink row would not
 * ordinarily also carry a pure/view cacheClass), and every argument is itself
 * eligible: `Lit`/`Ref` (pure by construction) or `Index`/`Member` over an
 * eligible receiver. A REGISTRY READ, not an inferred effect analysis
 * (constitution §2.3: "no effect-analysis pass exists or is needed").
 *
 * ── Scope discipline — ported verbatim ───────────────────────────────────────
 * ONE flat statement list at a time — `FnDecl.body`, an Arrow's body
 * (normalized to a one-statement list when it is a bare expression), the
 * top-level module body, and — independently — EVERY nested `Block`
 * (`If.then`/`If.else`, `While.body`, `ForOf.body`, or a `Block` reached as a
 * bare expression value). Occurrence collection never crosses a scope
 * boundary in EITHER direction — the hazard this sidesteps (hoisting a
 * subtree OUT of a conditionally-executed block could make a "pure" call
 * that can still throw on some input start throwing on a path that
 * previously never reached it) is unchanged. A bare `ConstDecl.init` is NOT
 * itself a scope (mirrors the dissolved pass's own documented limit — module
 * top level is treated as its own scope, but each top-level `define`'s own
 * init expression is not; only nested Block/Arrow WITHIN it are).
 *
 * ── Naming — what E2 actually changes ────────────────────────────────────────
 * The dissolved pass minted each hoisted temp's name via `mintFresh` — a
 * `__`-prefixed candidate ladder plus an independent `taken`-set collision
 * loop (`legibility/tree.ts`), its OWN small naming system, never integrated
 * with E1a's `bindingCensusOf`/`allocateNames`. This module mints the SAME
 * PROVISIONAL shape (`fresh`-mint, origin-recorded — the IDENTICAL
 * discipline `walker/walk.ts`'s own `fresh()` uses) but defers the FINAL,
 * collision-free TEXT to one combined `allocateNames` call over every
 * hoisted site (in MINT order — outer-scope-first, matching the dissolved
 * pass's own sequential naming order), reserving every name already spoken
 * for anywhere in `unit` (`collectBoundNames`) exactly like the dissolved
 * pass's `taken` seed did. Because a "fresh"-mint site's candidate ladder IS
 * the SAME `__hint`/`__hint2`/… sequence `mintFresh` produced
 * (`allocate.ts`'s `freshCandidates`), this is a MECHANISM swap, not a
 * naming-convention change — byte-identical for every corpus program
 * (verified: `legibility.test.ts`'s CSE goldens, unchanged bytes).
 */
import { childrenOf, collectBoundNames, mapChildren, substituteBy } from "../legibility/tree.js";
import type { EmitRegistry } from "../registry/index.js";
import type { Binding, CompilationUnit, Decl, R } from "../residual/types.js";
import { Binding as mkBinding, Const, Return } from "../residual/types.js";
import { cleanName } from "../walker/names.js";
import { allocateNames } from "./allocate.js";
import { materializeNames } from "./materialize.js";
import { originOf, recordOrigin } from "./origin.js";
import type { BindingCensus, BindingSite } from "./types.js";

// ── eligibility (the purity gate) — ported verbatim from the dissolved legibility/cse.ts ──

function isEligible(n: R, registry: EmitRegistry): boolean {
  switch (n.t) {
    case "Lit":
    case "Ref":
      return true;
    case "Index":
      return isEligible(n.recv, registry) && isEligible(n.index, registry);
    case "Member":
      return isEligible(n.recv, registry);
    case "Call": {
      if (n.callee.t !== "RuntimeRef") return false;
      const row = registry.lookup(n.callee.symbol);
      if (row === undefined) return false;
      if (row.provenance === "sink" || row.provenance === "opaque") return false;
      if (row.cacheClass !== "pure" && row.cacheClass !== "view") return false;
      return n.args.every((a) => isEligible(a, registry));
    }
    default:
      return false;
  }
}

/** Naming hint for a hoisted temp: the callee's own registry symbol when
 *  known, else a generic fallback — ported verbatim. */
function hintFor(n: R): string {
  return n.t === "Call" && n.callee.t === "RuntimeRef" ? n.callee.symbol : "shared";
}

/** Structural-equality key, `.origin` stripped and object keys sorted —
 *  ported verbatim. */
function structuralKey(n: R): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)
        .filter((key) => key !== "origin")
        .sort()) {
        out[k] = strip((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(n));
}

// ── the decision ──────────────────────────────────────────────────────────────────

export interface SharedBindingGroup {
  /** The representative eligible shape — also `sites[0]`. */
  readonly canonical: R;
  /** Every occurrence, ≥2, in first-encountered (pre-order) order. */
  readonly sites: readonly R[];
  readonly hint: string;
}

export interface SharedBindingsView {
  /** The tree these groups were computed over — `materializeSharedBindings`
   *  reads this rather than take a second, independently-suppliable `unit`
   *  parameter (mirrors `AsyncnessFacts.unit`'s own discipline: every site
   *  here is keyed by NODE IDENTITY from this exact tree). */
  readonly unit: CompilationUnit;
  readonly groups: readonly SharedBindingGroup[];
}

interface Group {
  readonly canonical: R;
  readonly sites: R[];
}

/** ONE scope's own eligible groups (never crossing into a nested Block/Arrow
 *  — see the module header's scope discipline), then every nested Block/Arrow
 *  reachable from these statements gets its OWN independent call. Merges the
 *  dissolved pass's `collectGroups`+`cseRewriteNested` pairing into one walk
 *  — a pure decision has no reconstruction step to interleave with, so one
 *  pass over each scope suffices where the pass needed two. */
function collectScope(stmts: readonly R[], registry: EmitRegistry, out: SharedBindingGroup[]): void {
  const groups = new Map<string, Group>();
  const visit = (n: R): void => {
    if (n.t === "Block") {
      collectScope(n.stmts, registry, out);
      return;
    }
    if (n.t === "Arrow") {
      collectScope(n.body.t === "Block" ? n.body.stmts : [n.body], registry, out);
      return;
    }
    if (n.t === "Call" && isEligible(n, registry)) {
      const key = structuralKey(n);
      const g = groups.get(key);
      if (g === undefined) groups.set(key, { canonical: n, sites: [n] });
      else g.sites.push(n);
    }
    for (const c of childrenOf(n)) visit(c);
  };
  for (const s of stmts) visit(s);
  for (const g of groups.values()) {
    if (g.sites.length >= 2) out.push({ canonical: g.canonical, sites: g.sites, hint: hintFor(g.canonical) });
  }
}

/** Recurse through `n` looking for a nested Block/Arrow (its own independent
 *  `collectScope` call) WITHOUT giving `n` itself scope-level treatment — the
 *  `ConstDecl.init` case (module header: a bare top-level init is not itself
 *  a scope). Mirrors the dissolved pass's `cseRewriteNested`'s default arm. */
function collectWithin(n: R, registry: EmitRegistry, out: SharedBindingGroup[]): void {
  if (n.t === "Block") {
    collectScope(n.stmts, registry, out);
    return;
  }
  if (n.t === "Arrow") {
    collectScope(n.body.t === "Block" ? n.body.stmts : [n.body], registry, out);
    return;
  }
  for (const c of childrenOf(n)) collectWithin(c, registry, out);
}

/**
 * The whole-unit decision (`sm.sharedBindingsOf`'s underlying machinery).
 * Top-level `unit.body` is its OWN scope (mirrors the dissolved pass); each
 * `FnDecl.body` is its OWN scope; a `ConstDecl.init` is NOT itself scoped —
 * only nested Block/Arrow within it are. Pure: never mutates `unit`.
 */
export function sharedBindingsOf(unit: CompilationUnit, registry: EmitRegistry): SharedBindingsView {
  const groups: SharedBindingGroup[] = [];
  const visitDecl = (d: Decl): void => {
    switch (d.t) {
      case "FnDecl":
        collectScope(d.body.stmts, registry, groups);
        return;
      case "ConstDecl":
        collectWithin(d.init, registry, groups);
        return;
      case "DeclComment":
        visitDecl(d.decl);
        return;
      case "Import":
      case "ImportType":
      case "Export":
        return;
    }
  };
  for (const d of unit.decls) visitDecl(d);
  collectScope(unit.body, registry, groups);
  return { unit, groups };
}

// ── the materializer ──────────────────────────────────────────────────────────────

/** Mint a PROVISIONAL hoisted-temp Binding — the IDENTICAL discipline
 *  `walker/walk.ts`'s own `fresh(hint)` uses (same `__`-prefixed placeholder
 *  text, same origin shape); the FINAL text is decided later, by the one
 *  combined `allocateNames` call at the bottom of `materializeSharedBindings`. */
function mintProvisional(hint: string): Binding {
  return recordOrigin(mkBinding(`__${cleanName(hint)}`), { mint: "fresh", text: hint });
}

/** ONE scope's splice+substitute, driven by the PRECOMPUTED decision
 *  (`siteToGroup`) instead of re-deriving eligibility/structural-equality —
 *  mirrors the dissolved pass's `cseScope` exactly, mint order (outer scope
 *  first) preserved via `pending`. */
function materializeScope(
  stmts: readonly R[],
  siteToGroup: ReadonlyMap<R, SharedBindingGroup>,
  pending: Binding[],
): R[] {
  const seen = new Set<SharedBindingGroup>();
  const rooted: { readonly group: SharedBindingGroup; readonly firstIndex: number }[] = [];
  const visit = (n: R, stmtIndex: number): void => {
    if (n.t === "Block" || n.t === "Arrow") return; // independent nested scope — handled below
    const group = siteToGroup.get(n);
    if (group !== undefined && !seen.has(group)) {
      seen.add(group);
      rooted.push({ group, firstIndex: stmtIndex });
    }
    for (const c of childrenOf(n)) visit(c, stmtIndex);
  };
  stmts.forEach((s, i) => visit(s, i));

  const replacements = new Map<R, R>();
  const insertsByIndex = new Map<number, R[]>();
  for (const { group, firstIndex } of rooted) {
    const binding = mintProvisional(group.hint);
    pending.push(binding);
    for (const site of group.sites) replacements.set(site, { t: "Ref" as const, binding });
    const list = insertsByIndex.get(firstIndex) ?? [];
    list.push(Const(binding, group.canonical));
    insertsByIndex.set(firstIndex, list);
  }

  const out: R[] = [];
  stmts.forEach((s, i) => {
    const inserts = insertsByIndex.get(i);
    if (inserts !== undefined) out.push(...inserts);
    const replaced = replacements.size === 0 ? s : substituteBy(s, (n) => replacements.get(n));
    out.push(materializeWithin(replaced, siteToGroup, pending));
  });
  return out;
}

/** Recurse into every nested Block/Arrow reached within an (already scoped
 *  and substituted) statement, giving each its own independent
 *  `materializeScope` call — mirrors the dissolved pass's `cseRewriteNested`. */
function materializeWithin(n: R, siteToGroup: ReadonlyMap<R, SharedBindingGroup>, pending: Binding[]): R {
  if (n.t === "Block") {
    return { ...n, stmts: materializeScope(n.stmts, siteToGroup, pending) };
  }
  if (n.t === "Arrow") {
    if (n.body.t === "Block") {
      return { ...n, body: { ...n.body, stmts: materializeScope(n.body.stmts, siteToGroup, pending) } };
    }
    const processed = materializeScope([Return(n.body)], siteToGroup, pending);
    const newBody =
      processed.length === 1 && processed[0]!.t === "Return" && processed[0]!.value !== undefined
        ? processed[0]!.value
        : { t: "Block" as const, stmts: processed };
    return { ...n, body: newBody };
  }
  return mapChildren(n, (child) => materializeWithin(child, siteToGroup, pending));
}

function materializeDecl(d: Decl, siteToGroup: ReadonlyMap<R, SharedBindingGroup>, pending: Binding[]): Decl {
  switch (d.t) {
    case "FnDecl":
      return { ...d, body: { ...d.body, stmts: materializeScope(d.body.stmts, siteToGroup, pending) } };
    case "ConstDecl":
      return { ...d, init: materializeWithin(d.init, siteToGroup, pending) };
    case "DeclComment":
      return { ...d, decl: materializeDecl(d.decl, siteToGroup, pending) };
    case "Import":
    case "ImportType":
    case "Export":
      return d;
  }
}

/**
 * The mechanical commit (`view.groups` → a rewritten `CompilationUnit`,
 * real names included). Identity fast-path: no groups ⇒ `view.unit`
 * unchanged (same reference — mirrors `materializeAsyncness`/
 * `materializeImports`'s own convention).
 */
export function materializeSharedBindings(view: SharedBindingsView): CompilationUnit {
  if (view.groups.length === 0) return view.unit;

  const siteToGroup = new Map<R, SharedBindingGroup>();
  for (const g of view.groups) for (const s of g.sites) siteToGroup.set(s, g);

  const pending: Binding[] = [];
  const decls = view.unit.decls.map((d) => materializeDecl(d, siteToGroup, pending));
  const body = materializeScope(view.unit.body, siteToGroup, pending);
  const spliced: CompilationUnit = { decls, body };

  // ── the naming commit: route every hoisted temp's FINAL text through the
  // SAME census→allocate machinery E1a's naming phase uses (module header) ──
  // Reservations mirror the dissolved pass's own `taken` seed exactly: every
  // name already spoken for ANYWHERE in the (pre-splice) unit. A fresh-mint
  // candidate is always `__`-prefixed (`allocate.ts`'s `freshCandidates`), so
  // it can never collide with a bare STAGE0 import name regardless — the
  // whole-unit reservation exists to avoid colliding with another already-
  // materialized "fresh" or "declared" binding, exactly as `mintFresh`'s own
  // `taken` set did.
  const reservations = [...collectBoundNames(view.unit)];
  const sites: BindingSite[] = pending.map((binding) => ({
    binding,
    origin: originOf(binding)!, // always defined — recorded by mintProvisional, just above
    kind: "value",
  }));
  const census: BindingCensus = { root: { sites, children: [] }, bySite: new Map(sites.map((s) => [s.binding, s])) };
  const allocation = allocateNames(census, reservations);
  return materializeNames(spliced, allocation);
}

/**
 * LEGIBILITY leg 3 — pure-region common-subexpression elimination (constitution
 * §3.5/§2.3). Two or more STRUCTURALLY IDENTICAL, CSE-ELIGIBLE `Call` subtrees
 * within ONE flat scope hoist to a single shared `Const`, declared immediately
 * before the earliest statement (of that scope) using it; every occurrence
 * becomes a `Ref` to that Const.
 *
 * ── Eligibility (the purity gate) ────────────────────────────────────────────────
 * A `Call` is CSE-eligible iff its callee is a `RuntimeRef` whose REGISTRY row has
 * `cacheClass` "pure" or "view" AND `provenance` is neither "sink" nor "opaque"
 * (sinks NEVER dedup — checked explicitly, even though a sink row would not
 * ordinarily also carry a pure/view cacheClass), and every argument is itself
 * eligible: `Lit`/`Ref` (pure by construction — reading an already-bound value or
 * a literal has no effect) or `Index`/`Member` over an eligible receiver. This is
 * a REGISTRY READ, not an inferred effect analysis (constitution §2.3: "no
 * effect-analysis pass exists or is needed" — every optimization gate reads
 * `Contract.provenance`+`cacheClass`). Identical `infer` calls ARE eligible —
 * `infer`'s Contract declares `cacheClass: "pure"` (llm-plane-arrival-env's
 * `infer.ts`).
 *
 * ── Scope discipline ──────────────────────────────────────────────────────────────
 * ONE flat statement list at a time — `FnDecl.body`, an Arrow's body (normalized
 * to a one-statement list when it is a bare expression), the top-level module
 * body, and — independently — EVERY nested `Block` (`If.then`/`If.else`,
 * `While.body`, `ForOf.body`, or a `Block` reached as a bare expression value,
 * e.g. the guarded and/or cascade). Occurrence collection never crosses a scope
 * boundary in EITHER direction: a candidate found inside a nested Block/Arrow is
 * invisible to the enclosing scope's grouping, and vice versa.
 *
 * This is what makes hoisting always safe without a separate throwing/effect
 * analysis: many "pure" operations can still throw on some inputs (§7's overflow
 * guarantee is exactly this) — hoisting a subtree OUT of a conditionally-executed
 * block (an `If` branch, a loop body, the guarded cascade's Block) to an
 * ENCLOSING, unconditionally-executed scope could make it start throwing on a
 * path that previously never reached it. Never letting a group span a scope
 * boundary sidesteps the whole hazard class: every hoist lands in the SAME block
 * that already unconditionally executed both original occurrences, so whether
 * that block itself runs is completely unchanged. (A future widen — skip this
 * restriction when the subtree is provably non-throwing — is a widen, not a
 * correctness fix; this scoping is conservative-safe today, matching the
 * mission's "minimum viable" framing.)
 *
 * ── Ordering (constitution deviation, documented in ../legibility.ts) ────────────
 * This leg runs BEFORE ASYNC-IFY. Concretely: CSE hoists a plain sync-shaped
 * `Call(RuntimeRef(...), args)` into an ordinary `Const`; ASYNC-IFY then treats
 * that Const exactly like any other (`typeOf` awaits its init iff the callee is a
 * seed, and every `Ref` read of it is unconditionally sync — "by the time a value
 * is bound... it has already resolved"). CSE never has to know `Await` exists.
 */
import { childrenOf, collectBoundNames, mapChildren, mintFresh, substituteBy } from "./tree.js";
import type { EmitRegistry } from "../registry/index.js";
import type { Binding, CompilationUnit, Decl, R } from "../residual/types.js";
import { Const, Return } from "../residual/types.js";
import { cleanName } from "../walker/index.js";

/** Recursive purity check over a candidate `Call`'s own shape and its arguments.
 *  See the module header — this is the registry read, not an effect inference. */
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

/** Naming hint for a hoisted temp: the callee's own registry symbol when known,
 *  else a generic fallback. */
function hintFor(n: R): string {
  return n.t === "Call" && n.callee.t === "RuntimeRef" ? n.callee.symbol : "shared";
}

/** Structural-equality key, `.origin` stripped (two occurrences at different
 *  source spans must still group) and object keys sorted (robust regardless of
 *  the incidental construction order of any particular `{ ...n, field }` spread
 *  upstream — insertion order is otherwise not a semantic property of these
 *  plain-data nodes). */
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

interface Group {
  readonly canonical: R;
  readonly sites: R[];
  readonly firstIndex: number;
}

/** Collect eligible `Call` occurrences within ONE flat scope, never crossing into
 *  a nested `Block`/`Arrow` (those get their own independent `cseScope` call —
 *  see `cseRewriteNested` below). `stmtIndex` is threaded so every occurrence
 *  knows which top-level statement (of THIS scope) contains it — the "first use"
 *  the hoisted Const is inserted before. */
function collectGroups(stmts: readonly R[], registry: EmitRegistry): Map<string, Group> {
  const groups = new Map<string, Group>();
  const visit = (n: R, stmtIndex: number): void => {
    if (n.t === "Block" || n.t === "Arrow") return; // independent nested scope
    if (n.t === "Call" && isEligible(n, registry)) {
      const key = structuralKey(n);
      const g = groups.get(key);
      if (g === undefined) groups.set(key, { canonical: n, sites: [n], firstIndex: stmtIndex });
      else g.sites.push(n);
      // still descend — a DIFFERENT duplicate may nest inside this call's own args
    }
    for (const c of childrenOf(n)) visit(c, stmtIndex);
  };
  stmts.forEach((s, i) => visit(s, i));
  return groups;
}

/** Recurse into every nested `Block`/`Arrow` reached within an (already scoped
 *  and substituted) statement, giving each its own independent `cseScope` call. */
function cseRewriteNested(n: R, registry: EmitRegistry, taken: Set<string>): R {
  if (n.t === "Block") {
    return { ...n, stmts: cseScope(n.stmts, registry, taken) };
  }
  if (n.t === "Arrow") {
    if (n.body.t === "Block") {
      return { ...n, body: { ...n.body, stmts: cseScope(n.body.stmts, registry, taken) } };
    }
    const processed = cseScope([Return(n.body)], registry, taken);
    const newBody =
      processed.length === 1 && processed[0]!.t === "Return" && processed[0]!.value !== undefined
        ? processed[0]!.value
        : { t: "Block" as const, stmts: processed };
    return { ...n, body: newBody };
  }
  return mapChildren(n, (child) => cseRewriteNested(child, registry, taken));
}

/** The per-scope hoist: collect groups, mint one Const per group with ≥2 sites,
 *  splice the Const in before the earliest using statement, substitute every
 *  site with a `Ref`, then recurse into nested scopes. */
function cseScope(stmts: readonly R[], registry: EmitRegistry, taken: Set<string>): R[] {
  const groups = collectGroups(stmts, registry);
  const eligible = [...groups.values()].filter((g) => g.sites.length >= 2);

  const replacements = new Map<R, R>();
  const insertsByIndex = new Map<number, R[]>();
  for (const g of eligible) {
    const binding: Binding = mintFresh(hintFor(g.canonical), taken, cleanName);
    for (const site of g.sites) replacements.set(site, { t: "Ref" as const, binding });
    const list = insertsByIndex.get(g.firstIndex) ?? [];
    list.push(Const(binding, g.canonical));
    insertsByIndex.set(g.firstIndex, list);
  }

  const out: R[] = [];
  stmts.forEach((s, i) => {
    const inserts = insertsByIndex.get(i);
    if (inserts !== undefined) out.push(...inserts);
    const replaced = replacements.size === 0 ? s : substituteBy(s, (n) => replacements.get(n));
    out.push(cseRewriteNested(replaced, registry, taken));
  });
  return out;
}

function rewriteDecl(d: Decl, registry: EmitRegistry, taken: Set<string>): Decl {
  switch (d.t) {
    case "FnDecl":
      return { ...d, body: { ...d.body, stmts: cseScope(d.body.stmts, registry, taken) } };
    case "ConstDecl":
      return { ...d, init: cseRewriteNested(d.init, registry, taken) };
    case "DeclComment":
      return { ...d, decl: rewriteDecl(d.decl, registry, taken) };
    case "Import":
    case "ImportType":
    case "Export":
      return d;
  }
}

/** The whole-unit entry point. `registry` is the SAME one `walk()` was given —
 *  the purity gate reads `cacheClass`/`provenance` off it. Pure: never mutates
 *  `unit`. Top-level `unit.body` is treated as its own scope (the module's own
 *  "function body"); duplicate calls split across SEPARATE top-level `ConstDecl`s
 *  are NOT unified — a documented, deliberate scope limit (the mission's own
 *  framing is "within one function body"; oracle-wrapped programs put all real
 *  logic inside one `__oracle-main` FnDecl anyway, so this does not affect the
 *  gate-authoritative pipeline). */
export function pureRegionCse(unit: CompilationUnit, registry: EmitRegistry): CompilationUnit {
  const taken = collectBoundNames(unit);
  return {
    decls: unit.decls.map((d) => rewriteDecl(d, registry, taken)),
    body: cseScope(unit.body, registry, taken),
  };
}

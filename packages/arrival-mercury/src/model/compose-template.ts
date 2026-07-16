/**
 * compose-template — StaticProv → ComposeTemplate (T-compose), the FOURTH
 * pure projection beside circuit-sexpr / circuit-mermaid / to-wireframe
 * (docs/working-proposals/provenance-beautiful-child/compose-phase.md §4;
 * consolidation README §2/§7 Wave 1). Same source (`StaticProv`), same
 * totality discipline (exhaustive 10-arm switch, no default — tsc's
 * return-type check is the totality proof, I1), same identity-keyed dedup
 * (the C2 census), derived-never-stored, and the seal never reads it.
 *
 * ── the boundary is the verdict's own (spec §3) ─────────────────────────────
 *
 * A node INLINES into a formula iff `channels()` treats it as the pointwise
 * identity fold (channel-transparent: `fused` `mux` `build` `string`); it is
 * a HOLE iff the fold does something with it (channel-active: `input` `mint`
 * `choice` `fan` `opaque`). `const` is the third class: a channel TERMINAL
 * with no interior — it inlines as the MARKED token (`lit`), never a hole,
 * never unmarked. R1 (hole by kind, never by depth) is therefore not a
 * styling rule but the channel-purity theorem: every path from a formula's
 * root to any of its tokens stays in the root's channel, because every
 * channel-moving kind is a hole. NOTE: a `combine`-collapse fan is still a
 * hole HERE (a variable-arity axis can never inline into a fixed-arity
 * formula) even though `planeOf` classifies it data-plane for the machine
 * view's contraction — see `planeOf`'s own doc for the split.
 *
 * ── no unmarked literal exists, by construction (spec §6) ───────────────────
 *
 * `lit` is the ONLY literal kind in `ComposeExpr` and it IS the mark — a
 * renderer physically cannot draw an unmarked literal (contrast
 * to-wireframe's `fabrication` side map, where the guard is a convention
 * every consumer must remember). `lit ⟺ ConstProv` is pinned by test
 * (INV-2's compose half).
 *
 * ── sharing (R2): where-clauses exactly where the DAG branches ──────────────
 *
 * Object-identity sharing (the G2 memo's product, numbered by the C2 census)
 * lifts to a named sub-formula iff the shared node is N-ARY
 * (`fused`/`string`/`build`); unary/leaf shared nodes (`mux`, `const`) copy
 * freely — chains cannot branch, so copying costs one token run per use,
 * already linear in the DAG's edge count, while re-expanding a shared n-ary
 * node in text would undo G2 (the pre-G2 catastrophe: `examples` re-walked
 * per reference). Identity of copied leaves survives as SITE-equality (a
 * shared const copied three times renders the same `site` thrice — the
 * machine's `(ref N)` fact is recoverable).
 *
 * A shared hole's `♯k` label uses the census id — the SAME number
 * `circuit-sexpr` prints as `:id k`/`(ref k)` for the same object (C2's
 * cross-readability: one census, two projections, drift impossible).
 *
 * WHERE-CLAUSES ARE REGISTERED FOR THE WHOLE CENSUS, walk-encountered or
 * not: a census-shared n-ary node living BEHIND a channel-active hole (the
 * canonical case: a fan's collection, referenced by both `FanProv.collection`
 * and the element mux's `source` — GEPA's `♯examples`) is exactly the named
 * sub-formula the hole's card will reference when a caller descends into it
 * (per-card `toComposeTemplate` calls see a smaller census in which the
 * sharing is no longer visible — the ROOT call is the one place the full
 * sharing structure exists, so the root template carries the program's
 * where-clause vocabulary). Registration order: walk-encountered shared
 * nodes first (first-occurrence order, like every other hole), then the
 * remaining census-shared n-ary nodes in census-id order — deterministic.
 *
 * ── the fan element is a binder token, not an access chain (R3) ─────────────
 *
 * `buildFan` mints ONE distinguished `MuxProv{key:null, source:collection}`
 * and binds every "current element" param to that same object
 * (arm-containers.ts). A caller rendering a fan hole's interior supplies
 * `binders: {thatObject → "ex"}` — IDENTITY-keyed, the only honest key
 * (`max-by`'s look-alike `key:null` mux is a different object and correctly
 * renders as `⟨…⟩[?]`). The binder check runs FIRST, before kind dispatch —
 * the element IS the fan's parameter in the model's own construction;
 * spelling it as `collection[?]` at every use would render the binder's
 * definition once per read.
 *
 * ── no depth/size escalation, ever (R4) ─────────────────────────────────────
 *
 * A transparent composite of transparent parts is transparent (union of
 * unions); there is no depth at which the fold changes character, so no
 * depth cutoff exists anywhere in this file. Renderers may FOLD long structs
 * (progressive disclosure is presentation); the projection is total and
 * never falls back to graph on size.
 *
 * ── two fidelity tiers; the op name is NOT a model field ────────────────────
 *
 * `StaticProv` is transformation-blind by law (`+`/`-` extract identically)
 * and the model-design rule forbids storing what is derivable — the head IS
 * derivable: `site` keys back into the CoreForm walk (the Roslyn side-table
 * rule). So `renderComposeText` takes an optional `SourceLens` (precedent:
 * `MermaidOptions.dataFor`). Tier-1 (no lens) is honest to the circuit
 * alone: generic operators (`⊗(…)`, `str(…)`), bare `⚠` lit marks, sites as
 * token identity. Tier-2 (lens present) recovers the author's spelling:
 * `1⚠ + ⟨e⟩.v`, `"prefix"⚠ ⧺ ⟨e⟩.name ⧺ "suffix"⚠`. Lens output is display
 * metadata in the exact sense `ChannelAnchor.site` already is — the verdict
 * never reads it; a wrong lens can mislabel a `+` as `-` but can never move
 * a mark, an anchor, or a channel.
 *
 * ── what this module does NOT do ────────────────────────────────────────────
 *
 * No per-formula verdict BADGES (a render-layer concern, later wave) — but
 * the structure makes them derivable: a formula's channel is a property of
 * its ROOT POSITION (the purity theorem), and `ComposeHole.prov` is the
 * verdict handle (`channels(prov)` / `circuitVerdict(prov, role)`) for every
 * hole. The `dead` mark on `access` is NOT a verdict anticipation — it is
 * `narrowMux`'s own 0-hit fail-closed partition, the one shared helper
 * (`verdict/circuit-verdict.ts`), so the mark and the verdict can never
 * disagree. `seal()` consumes `CircuitVerdict` + probe only; this is a lens.
 */
import type { NodeId } from "../coreform/types.js";
import { narrowMux } from "../verdict/circuit-verdict.js";
import { census } from "./census.js";
import type { StaticProv } from "./static-prov.js";

/** Per-template hole number, minted in first-occurrence order (1-based —
 *  matching the spec legend's `№1`, `№2`, …), stable per render: the same
 *  root always numbers the same way (census + walk order are both pure
 *  functions of the DAG's own structure). */
export type HoleId = number;

/** Formula interior — exactly the channel-transparent kinds + the const
 *  token. Every node carries `site` (the Roslyn side-table key; identity of
 *  shared leaves survives as site-equality even where copies are
 *  permitted). */
export type ComposeExpr =
  | { readonly kind: "lit"; readonly site: NodeId } // ConstProv — THE marked token; no unmarked literal kind exists
  | { readonly kind: "hole"; readonly hole: HoleId } // channel-active subcircuit, or a lifted shared interior (where-clause)
  | { readonly kind: "binder"; readonly name: string } // fan-element projection, resolved by identity (R3)
  | {
      readonly kind: "access";
      readonly site: NodeId;
      readonly key: string | number | null;
      readonly base: ComposeExpr;
      /** `narrowMux`'s 0-hit fail-closed sub-case — the verdict's own
       *  "provably absent" reading, shared verbatim, never re-derived. */
      readonly dead: boolean;
    } // MuxProv
  | { readonly kind: "op"; readonly site: NodeId; readonly args: readonly ComposeExpr[] } // FusedProv (op identity erased)
  | { readonly kind: "runs"; readonly site: NodeId; readonly runs: readonly ComposeExpr[] } // StringProv (ordered)
  | {
      readonly kind: "struct";
      readonly site: NodeId;
      readonly ctor: "pair" | "vector" | "dict";
      readonly fields: readonly { readonly key: string | number; readonly value: ComposeExpr }[];
    }; // BuildProv

export type HoleReason = "input" | "mint" | "choice" | "fan" | "opaque" | "shared";

export interface ComposeHole {
  readonly id: HoleId;
  readonly reason: HoleReason;
  /** The subcircuit — the recursion handle (render its card / its own
   *  template) AND the verdict handle (`channels(prov)` — the lens-3 seam). */
  readonly prov: StaticProv;
  /** input: the evidence name; mint: the head; choice: `"choice"`; fan: its
   *  collapse kind; opaque: the reason; shared: `♯k` where k is the C2
   *  census id — the SAME number circuit-sexpr prints as `:id k` for this
   *  object (a lens may upgrade the display to the author's own binding
   *  name, `♯examples`, via `bindingNameAt` — display only, never stored). */
  readonly label: string;
  /** Present iff reason === "shared": the lifted interior's own formula (the
   *  where-clause body). Channel-active holes recurse via `prov` instead. */
  readonly formula?: ComposeExpr;
}

export interface ComposeTemplate {
  readonly root: ComposeExpr;
  readonly holes: ReadonlyMap<HoleId, ComposeHole>; // insertion-ordered (first-occurrence)
}

/** The tier-2 fidelity seam — a caller that holds BOTH the circuit and the
 *  CoreForm forest it was extracted from resolves sites to source spellings
 *  (the exact limitation circuit-sexpr.ts documents, answered as an optional
 *  lens instead of a fabricated `head@line:col`). Every method may return
 *  `undefined`; the renderer then stays at its tier-1 generic form for that
 *  token. No CoreForm-side plumbing exists in this wave — tests stub it. */
export interface SourceLens {
  /** the literal's own source spelling at a Lit/Quote site — `"prefix"`, `1` */
  literalTextAt(site: NodeId): string | undefined;
  /** the App head at an op/runs/access site — `+`, `string-append`, `substring`, `car` */
  headAt(site: NodeId): string | undefined;
  /** a Define/binding name at a site — labels shared holes `♯examples` */
  bindingNameAt(site: NodeId): string | undefined;
}

/** Is this a kind the where-clause lift applies to — n-ary transparent
 *  (R2's rule: exactly the transparent kinds where copy-expansion compounds;
 *  `mux`/`const` chains cannot branch and copy freely)? */
const isNaryTransparent = (p: StaticProv): p is Extract<StaticProv, { kind: "fused" | "string" | "build" }> =>
  p.kind === "fused" || p.kind === "string" || p.kind === "build";

interface BuildCtx {
  readonly binders: ReadonlyMap<StaticProv, string> | undefined;
  readonly sharedIdOf: ReadonlyMap<StaticProv, number>; // the C2 census's idOf
  readonly holes: Map<HoleId, ComposeHole>;
  readonly holeIdByProv: Map<StaticProv, HoleId>;
  nextHole: HoleId;
}

/** Mint (or reuse) the hole for `p`. Holes dedup by OBJECT IDENTITY — a
 *  shared mint referenced twice is ONE hole with two `{kind:"hole"}` tokens
 *  pointing at it (multiplicity survives as token count where the objects
 *  are genuinely distinct: two `(:v e)` reads are two `InputProv` objects,
 *  hence two holes — the probe's cancellation counting needs exactly that). */
function holeRef(ctx: BuildCtx, p: StaticProv, reason: HoleReason, label: string): ComposeExpr {
  const existing = ctx.holeIdByProv.get(p);
  if (existing !== undefined) return { kind: "hole", hole: existing };
  const id = ctx.nextHole++;
  ctx.holeIdByProv.set(p, id);
  ctx.holes.set(id, { id, reason, prov: p, label });
  return { kind: "hole", hole: id };
}

/** Register the where-clause hole for a census-shared n-ary node and build
 *  its interior formula. The id/placeholder is set BEFORE the interior walk
 *  so hole numbering stays first-occurrence order (interior holes number
 *  after their lifting parent) and so a later reference DURING the interior
 *  walk (impossible for the node itself — the DAG is acyclic — but routine
 *  for sibling shared nodes) resolves through the ordinary dedup. */
function sharedHoleRef(ctx: BuildCtx, p: StaticProv, sharedId: number): ComposeExpr {
  const existing = ctx.holeIdByProv.get(p);
  if (existing !== undefined) return { kind: "hole", hole: existing };
  const id = ctx.nextHole++;
  const label = `♯${sharedId}`;
  ctx.holeIdByProv.set(p, id);
  ctx.holes.set(id, { id, reason: "shared", prov: p, label });
  const formula = walkFresh(ctx, p);
  ctx.holes.set(id, { id, reason: "shared", prov: p, label, formula });
  return { kind: "hole", hole: id };
}

/** The dispatch wrapper every recursion goes through: binder identity first
 *  (R3 — the element token wins over every other reading of that object),
 *  then the where-clause lift (R2), then the per-kind arm. */
function walk(ctx: BuildCtx, p: StaticProv): ComposeExpr {
  const binderName = ctx.binders?.get(p);
  if (binderName !== undefined) return { kind: "binder", name: binderName };
  const sharedId = ctx.sharedIdOf.get(p);
  if (sharedId !== undefined && isNaryTransparent(p)) return sharedHoleRef(ctx, p, sharedId);
  return walkFresh(ctx, p);
}

/** The exhaustive per-kind arm for a node rendering IN PLACE (not lifted,
 *  not bindered). Exhaustive over `StaticProv`'s ten members WITHOUT a
 *  default arm — tsc's return-type check is the totality proof, mirroring
 *  every other projection in this package (I1). */
function walkFresh(ctx: BuildCtx, p: StaticProv): ComposeExpr {
  switch (p.kind) {
    case "const":
      return { kind: "lit", site: p.site };
    case "input":
      return holeRef(ctx, p, "input", p.name);
    case "mint":
      return holeRef(ctx, p, "mint", p.head);
    case "choice":
      return holeRef(ctx, p, "choice", "choice");
    case "fan":
      return holeRef(ctx, p, "fan", p.collapse);
    case "opaque":
      return holeRef(ctx, p, "opaque", p.reason);
    case "fused":
      return { kind: "op", site: p.site, args: p.sources.map((c) => walk(ctx, c)) };
    case "string":
      return { kind: "runs", site: p.site, runs: p.runs.map((c) => walk(ctx, c)) };
    case "build":
      return {
        kind: "struct",
        site: p.site,
        ctor: p.ctor,
        fields: p.parts.map((part) => ({ key: part.key, value: walk(ctx, part.prov) })),
      };
    case "mux":
      return {
        kind: "access",
        site: p.site,
        key: p.key,
        base: walk(ctx, p.source),
        dead: narrowMux(p).kind === "dead",
      };
  }
}

/**
 * `StaticProv` → `ComposeTemplate`. Pure, total, deterministic — the
 * discipline of the other three projections, verbatim. `opts.binders` is the
 * R3 seam: identity-keyed binder names for fan-body element projections,
 * supplied by the caller rendering a fan hole's interior (the element object
 * is `FanProv`-reachable: the distinguished `mux{key:null, source ===
 * fan.collection}` inside the body — `buildFan`'s own construction).
 */
export function toComposeTemplate(
  prov: StaticProv,
  opts?: {
    readonly binders?: ReadonlyMap<StaticProv, string>;
  },
): ComposeTemplate {
  const c = census(prov);
  const ctx: BuildCtx = {
    binders: opts?.binders,
    sharedIdOf: c.idOf,
    holes: new Map(),
    holeIdByProv: new Map(),
    nextHole: 1,
  };
  const root = walk(ctx, prov);
  // The where-clause completion pass (see header, "sharing"): census-shared
  // n-ary nodes the root walk never reached (they live behind channel-active
  // holes) still get their named sub-formula registered, in census-id order.
  // A binder-covered object never lifts (the binder token IS its rendering),
  // and non-n-ary shared nodes copy (R2) — both skipped here exactly as in
  // the walk.
  for (const [node, sharedId] of c.idOf) {
    if (!isNaryTransparent(node)) continue;
    if (ctx.binders?.has(node)) continue;
    if (ctx.holeIdByProv.has(node)) continue;
    sharedHoleRef(ctx, node, sharedId);
  }
  return { root, holes: ctx.holes };
}

// ── renderComposeText — the deterministic text rendering ─────────────────────

const holeToken = (h: ComposeHole, lens?: SourceLens): string => {
  switch (h.reason) {
    case "input":
      return `⟨${h.label}⟩`;
    case "mint":
      return `⟦${h.label} №${h.id}⟧`;
    case "choice":
      return `♦№${h.id}`;
    case "fan":
      return `⟳№${h.id}`;
    case "opaque":
      return `⟨opaque: ${h.label}⟩`;
    case "shared": {
      const name = lens?.bindingNameAt(h.prov.site);
      return name !== undefined ? `♯${name}` : h.label;
    }
  }
};

/**
 * Pure text rendering (mermaid-legend sibling). Deterministic: the same
 * template (and same lens answers) always produces the exact same string.
 * Tier-1 (no lens): `⊗(…)`/`str(…)`/bare `⚠` marks — honest to the circuit
 * alone. Tier-2 (lens): author spellings — infix heads, `⧺` for
 * string-append (ONLY string-append: `substring`/`format` keep call shape,
 * spec §3's overclaim note), literal texts on `⚠` marks, binding names on
 * `♯` where-clauses. Where-clauses render as trailing `where ♯k = …` lines.
 */
export function renderComposeText(t: ComposeTemplate, lens?: SourceLens): string {
  const expr = (e: ComposeExpr): string => {
    switch (e.kind) {
      case "lit": {
        const text = lens?.literalTextAt(e.site);
        return text !== undefined ? `${text}⚠` : "⚠";
      }
      case "hole": {
        const h = t.holes.get(e.hole);
        // A dangling hole id is unrepresentable by construction (every
        // `{kind:"hole"}` token is minted alongside its map entry); guard
        // anyway rather than render a lie.
        return h === undefined ? `⟨hole №${e.hole}?⟩` : holeToken(h, lens);
      }
      case "binder":
        return e.name;
      case "access": {
        const base = expr(e.base);
        const step = e.key === null ? "[?]" : typeof e.key === "number" ? `[${e.key}]` : `.${e.key}`;
        return `${base}${step}${e.dead ? "⊘" : ""}`;
      }
      case "op": {
        const args = e.args.map(expr);
        const head = lens?.headAt(e.site);
        if (head === undefined) return `⊗(${args.join(", ")})`;
        return args.length >= 2 ? args.join(` ${head} `) : `${head}(${args.join(", ")})`;
      }
      case "runs": {
        const runs = e.runs.map(expr);
        const head = lens?.headAt(e.site);
        if (head === "string-append") return runs.join(" ⧺ ");
        if (head !== undefined) return `${head}(${runs.join(", ")})`;
        return `str(${runs.join(", ")})`;
      }
      case "struct": {
        if (e.ctor === "dict") return `{${e.fields.map((f) => `${f.key}: ${expr(f.value)}`).join(", ")}}`;
        if (e.ctor === "vector") return `[${e.fields.map((f) => expr(f.value)).join(", ")}]`;
        return `(${e.fields.map((f) => expr(f.value)).join(" ∙ ")})`;
      }
    }
  };

  const lines = [expr(t.root)];
  for (const h of t.holes.values()) {
    if (h.reason !== "shared" || h.formula === undefined) continue;
    lines.push(`where ${holeToken(h, lens)} = ${expr(h.formula)}`);
  }
  return lines.join("\n");
}

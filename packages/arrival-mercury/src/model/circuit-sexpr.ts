/**
 * circuitToSexpr — StaticProv → homoiconic sexpr, `dag`'s STATIC sibling.
 *
 * `@inhuman.tools/arrival-provenance/reflect`'s `(dag h)` renders the RUNTIME computation DAG (one run's
 * traced dataflow). This renders the COMPILE-TIME attribution CIRCUIT `extract`
 * produces over a program's CoreForm — the same value `circuit-verdict.ts`'s
 * `channels()` folds, here rendered instead of folded. Pure and total: every
 * `StaticProv` kind (model/static-prov.ts's 10-member union) has an arm; there
 * is no default case, so tsc's exhaustiveness check is the totality proof, same
 * discipline as `extract`'s own dispatcher (I1).
 *
 * ── `:site` is a bare NodeId, not `head@line:col` ───────────────────────────
 *
 * `/reflect`'s `dagOf`/`whereOf` address nodes as `head@line:col`
 * strings, resolved from a runtime trace that carries span + source text
 * alongside every point. A `StaticProv` carries only the NodeId (`site` —
 * "mint-order, unknowable by hand," fixture-corpus.ts's own description of it)
 * with NO accompanying span or source: the type is deliberately narrow (see
 * static-prov.ts's header), and this function's signature — `(prov:
 * StaticProv): string`, nothing else — has no forest/source to resolve one
 * against either. Fabricating a `head@line:col`-shaped string from a bare
 * integer would be exactly the kind of invented structure I1 forbids
 * elsewhere; rendering `:site N` honestly is the sound choice. Full
 * `head@line:col` interop with `(blast h)`/`(where h)` needs a caller that
 * holds BOTH the circuit and the CoreForm forest it was extracted from —
 * see handle-provenance.ts's `circuitOf` doc for exactly why that caller
 * doesn't exist yet.
 *
 * ── gray, never taken/gray ───────────────────────────────────────────────────
 *
 * `ChoiceProv` has no valuation field (static-prov.ts: "the run's recorded
 * valuation... lights one solid" — a RUNTIME overlay). This function only ever
 * sees the static circuit, so every alt renders gray, uniformly — there is no
 * "taken" to distinguish without a trace to overlay, and inventing one would
 * misrepresent an unexercised branch as chosen.
 *
 * ── shared-DAG dedup (G2) ────────────────────────────────────────────────────
 *
 * A circuit IS a shared DAG (Deutch-Milo-Roy-Tannen, ICDT 2014), and since the
 * extract-side memo (`ExtractCtx.memo`, src/extract/index.ts) makes two Refs
 * to one binding return the IDENTICAL `StaticProv` object, this renderer
 * recognizes that identity instead of re-rendering the shared subtree once
 * per reference: a node reachable ≥2 times by object identity renders its
 * FIRST occurrence tagged `:id N` and every later occurrence as the compact
 * `(ref N)` — see `renderNode`'s doc for the mechanism. This is a
 * pure REPRESENTATION change, never semantics — the referenced subtree's own
 * rendering is byte-identical to what `(ref N)` stands in for, and a circuit
 * with no aliasing anywhere (object identity never repeats) renders exactly
 * as it did before this dedup existed, with no `:id`/`:ref` anywhere.
 *
 * SHARED CENSUS (C2): the occurrence-count + id-assignment walk that used
 * to live privately here (`countOccurrences` + the render-time `nextId`
 * mint) is extracted to
 * `census.ts` so the compose projection's where-clause `♯k` labels and this
 * file's `:id k` tags come from ONE pass and can never drift — a human
 * cross-reads `♯1` in a formula straight to `(build :id 1 …)`/`(ref 1)` in
 * the sexpr dump of the same circuit. `census.assignIds` reproduces the old
 * render-time mint order exactly (post-order along the identical per-kind
 * child walk — census.ts's header carries the argument), so this file's
 * output is BYTE-IDENTICAL to the pre-extraction rendering; its tests pin it.
 */
import { census } from "./census.js";
import type {
  BuildProv,
  ChoiceProv,
  ConstProv,
  FanProv,
  FusedProv,
  InputProv,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "./static-prov.js";

const s = (x: string): string => JSON.stringify(x);
const key = (k: string | number): string => (typeof k === "number" ? String(k) : s(k));

/** Shared-DAG dedup (G2; census extracted per C2 — see this
 *  file's header and census.ts). `idOf` is the shared census's numbering: a
 *  node reachable ≥2 times by object identity has an id, everything else is
 *  absent — so an UNSHARED circuit renders byte-identical to before dedup
 *  existed (the golden tests' own invariant — none of their hand-built
 *  fixtures alias, so none of them ever see an `:id`). `rendered` tracks
 *  which shared nodes THIS render already emitted in full: the first
 *  rendering of a shared node is tagged `:id N`, every LATER visit to that
 *  SAME reference emits the compact `(ref N)` — the homoiconic-sexpr sibling
 *  of circuit-mermaid.ts's "one box, two in-edges." */
interface Ctx {
  readonly idOf: ReadonlyMap<StaticProv, number>;
  readonly rendered: Map<StaticProv, number>;
}

const renderInput = (p: InputProv): string => `(input :site ${p.site} :name ${s(p.name)})`;

const renderMint = (p: MintProv, ctx: Ctx): string =>
  `(mint :site ${p.site} :head ${s(p.head)} :integrity ${p.integrity}` +
  (p.closed.length > 0 ? ` :closed (${p.closed.map((c) => renderNode(c, ctx)).join(" ")})` : "") +
  `)`;

const renderConst = (p: ConstProv): string => `(const :site ${p.site})`;

const renderFused = (p: FusedProv, ctx: Ctx): string =>
  `(fused :site ${p.site} :sources (${p.sources.map((c) => renderNode(c, ctx)).join(" ")}))`;

const renderMux = (p: MuxProv, ctx: Ctx): string =>
  `(mux :site ${p.site} :key ${p.key === null ? "nil" : key(p.key)} :source ${renderNode(p.source, ctx)})`;

const renderBuild = (p: BuildProv, ctx: Ctx): string =>
  `(build :site ${p.site} :ctor ${p.ctor} :parts (${p.parts
    .map((part) => `(:key ${key(part.key)} :prov ${renderNode(part.prov, ctx)})`)
    .join(" ")}))`;

const renderString = (p: StringProv, ctx: Ctx): string =>
  `(string :site ${p.site} :runs (${p.runs.map((c) => renderNode(c, ctx)).join(" ")}))`;

/** Every alt renders GRAY — no valuation is available at this pure, trace-free
 *  layer (see this file's header). */
const renderChoice = (p: ChoiceProv, ctx: Ctx): string =>
  `(choice :site ${p.site} :guards (${p.guards.map((c) => renderNode(c, ctx)).join(" ")}) :alts (${p.alts
    .map((alt) => `(gray ${renderNode(alt, ctx)})`)
    .join(" ")}))`;

const renderFan = (p: FanProv, ctx: Ctx): string =>
  `(fan :site ${p.site} :collapse ${p.collapse} :collection ${renderNode(p.collection, ctx)} :body ${renderNode(p.body, ctx)})`;

const renderOpaque = (p: OpaqueProv): string => `(opaque :site ${p.site} :reason ${s(p.reason)})`;

/** `StaticProv` → sexpr for a NOT-YET-tagged `prov` — the exhaustive per-kind
 *  switch. Exhaustive by tsc (no default arm) — adding an 11th `StaticProv`
 *  kind breaks this file at compile time, mirroring `extract`'s own totality
 *  proof (I1). Called only from `renderNode`, below. */
function renderNodeFresh(prov: StaticProv, ctx: Ctx): string {
  switch (prov.kind) {
    case "input":
      return renderInput(prov);
    case "mint":
      return renderMint(prov, ctx);
    case "const":
      return renderConst(prov);
    case "fused":
      return renderFused(prov, ctx);
    case "mux":
      return renderMux(prov, ctx);
    case "build":
      return renderBuild(prov, ctx);
    case "string":
      return renderString(prov, ctx);
    case "choice":
      return renderChoice(prov, ctx);
    case "fan":
      return renderFan(prov, ctx);
    case "opaque":
      return renderOpaque(prov);
  }
}

/** Splice `:id N` in right after the kind symbol of an already-rendered form
 *  — `(fused :site 0 ...)` → `(fused :id 3 :site 0 ...)`. Every current
 *  kind's render is `(kindname :field ...)`, so the first space in the
 *  string is always exactly the boundary after the (space-free) kind symbol,
 *  regardless of what field content follows (even a quoted string value that
 *  itself contains a space, e.g. a mint `:head` — `.indexOf` finds the
 *  FIRST occurrence only). Only ever called for a node `ctx.idOf` says is
 *  shared; an unshared node's rendering never reaches here. */
function withId(rendered: string, id: number): string {
  const spaceIdx = rendered.indexOf(" ");
  if (spaceIdx === -1) return rendered; // defensive; no current kind renders with zero fields
  return `${rendered.slice(0, spaceIdx)} :id ${id}${rendered.slice(spaceIdx)}`;
}

/** `StaticProv` → sexpr, returning the string for `prov` itself —
 *  SHARED-DAG AWARE (G2): a `prov` object identity already
 *  rendered earlier in this SAME `circuitToSexpr` call emits the compact
 *  `(ref N)` form instead of re-rendering the whole subtree; a node reachable
 *  only once never gets tagged at all (see `withId`'s doc and this file's
 *  header for the byte-identical-when-unshared guarantee). Dedup is by
 *  OBJECT IDENTITY — two structurally-equal but distinct object instances
 *  (e.g. two independent call sites' attributions that happen to look the
 *  same) are never merged, only genuine representation sharing is. */
function renderNode(prov: StaticProv, ctx: Ctx): string {
  const already = ctx.rendered.get(prov);
  if (already !== undefined) return `(ref ${already})`;
  const fresh = renderNodeFresh(prov, ctx);
  const id = ctx.idOf.get(prov);
  if (id === undefined) return fresh;
  ctx.rendered.set(prov, id);
  return withId(fresh, id);
}

/** `StaticProv` → homoiconic sexpr. Exhaustive over StaticProv's ten members
 *  (see `renderNodeFresh`'s own totality proof). Deterministic: the same
 *  `prov` always produces the exact same string (object identity is fixed
 *  once `prov` is constructed, so the census pre-pass and the render walk
 *  both proceed in the same stable order every call). The census's id
 *  assignment reproduces this file's original render-time mint order exactly
 *  (census.ts's header carries the argument), so output is byte-identical
 *  to the pre-C2 private implementation. */
export function circuitToSexpr(prov: StaticProv): string {
  return renderNode(prov, { idOf: census(prov).idOf, rendered: new Map() });
}

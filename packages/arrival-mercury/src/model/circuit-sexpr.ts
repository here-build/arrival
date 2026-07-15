/**
 * circuitToSexpr — StaticProv → homoiconic sexpr, `dag`'s STATIC sibling
 * (T6b, docs/working-proposals/scheme-semantic-model-synthesis.md §2g).
 *
 * `arrival-reflect`'s `(dag h)` renders the RUNTIME computation DAG (one run's
 * traced dataflow). This renders the COMPILE-TIME attribution CIRCUIT `extract`
 * produces over a program's CoreForm — the same value `circuit-verdict.ts`'s
 * `channels()` folds, here rendered instead of folded. Pure and total: every
 * `StaticProv` kind (model/static-prov.ts's 10-member union) has an arm; there
 * is no default case, so tsc's exhaustiveness check is the totality proof, same
 * discipline as `extract`'s own dispatcher (I1).
 *
 * ── `:site` is a bare NodeId, not `head@line:col` ───────────────────────────
 *
 * `arrival-reflect`'s `dagOf`/`whereOf` address nodes as `head@line:col`
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
 * holds BOTH the circuit and the CoreForm forest it was extracted from (a
 * later wave's concern — see handle-provenance.ts's `circuitOf` doc for
 * exactly why that caller doesn't exist yet).
 *
 * ── gray, never taken/gray ───────────────────────────────────────────────────
 *
 * `ChoiceProv` has no valuation field (static-prov.ts: "the run's recorded
 * valuation... lights one solid" — a RUNTIME overlay). This function only ever
 * sees the static circuit, so every alt renders gray, uniformly — there is no
 * "taken" to distinguish without a trace to overlay, and inventing one would
 * misrepresent an unexercised branch as chosen.
 */
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

const renderInput = (p: InputProv): string => `(input :site ${p.site} :name ${s(p.name)})`;

const renderMint = (p: MintProv): string =>
  `(mint :site ${p.site} :head ${s(p.head)} :integrity ${p.integrity}` +
  (p.closed.length > 0 ? ` :closed (${p.closed.map(circuitToSexpr).join(" ")})` : "") +
  `)`;

const renderConst = (p: ConstProv): string => `(const :site ${p.site})`;

const renderFused = (p: FusedProv): string => `(fused :site ${p.site} :sources (${p.sources.map(circuitToSexpr).join(" ")}))`;

const renderMux = (p: MuxProv): string =>
  `(mux :site ${p.site} :key ${p.key === null ? "nil" : key(p.key)} :source ${circuitToSexpr(p.source)})`;

const renderBuild = (p: BuildProv): string =>
  `(build :site ${p.site} :ctor ${p.ctor} :parts (${p.parts
    .map((part) => `(:key ${key(part.key)} :prov ${circuitToSexpr(part.prov)})`)
    .join(" ")}))`;

const renderString = (p: StringProv): string => `(string :site ${p.site} :runs (${p.runs.map(circuitToSexpr).join(" ")}))`;

/** Every alt renders GRAY — no valuation is available at this pure, trace-free
 *  layer (see this file's header). */
const renderChoice = (p: ChoiceProv): string =>
  `(choice :site ${p.site} :guards (${p.guards.map(circuitToSexpr).join(" ")}) :alts (${p.alts
    .map((alt) => `(gray ${circuitToSexpr(alt)})`)
    .join(" ")}))`;

const renderFan = (p: FanProv): string =>
  `(fan :site ${p.site} :collapse ${p.collapse} :collection ${circuitToSexpr(p.collection)} :body ${circuitToSexpr(p.body)})`;

const renderOpaque = (p: OpaqueProv): string => `(opaque :site ${p.site} :reason ${s(p.reason)})`;

/** `StaticProv` → homoiconic sexpr. Exhaustive by tsc (no default arm) — adding
 *  an 11th `StaticProv` kind breaks this file at compile time, mirroring
 *  `extract`'s own totality proof (I1). */
export function circuitToSexpr(prov: StaticProv): string {
  switch (prov.kind) {
    case "input":
      return renderInput(prov);
    case "mint":
      return renderMint(prov);
    case "const":
      return renderConst(prov);
    case "fused":
      return renderFused(prov);
    case "mux":
      return renderMux(prov);
    case "build":
      return renderBuild(prov);
    case "string":
      return renderString(prov);
    case "choice":
      return renderChoice(prov);
    case "fan":
      return renderFan(prov);
    case "opaque":
      return renderOpaque(prov);
  }
}

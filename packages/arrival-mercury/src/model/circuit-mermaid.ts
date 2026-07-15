/**
 * circuitToMermaid — StaticProv → a mermaid `flowchart` definition, the THIRD
 * pure projection beside `circuit-sexpr.ts` (homoiconic sexpr) and
 * `to-wireframe.ts` (studio ELK pane target). Same source, same 10-member
 * union (model/static-prov.ts), same discipline — a different consumer: a
 * mermaid flowchart renders inline in GitHub (PRs, this file's own tests) and
 * in any markdown-hosted artifact, so a reviewer EYEBALLS a circuit instead of
 * decoding nested `StaticProv` JSON by hand. Pure and total: every kind has an
 * arm, no default case — tsc's exhaustiveness check is the totality proof,
 * the same discipline `circuit-sexpr.ts` and `extract` itself hold (I1).
 *
 * ── direction: `flowchart TD` (top-down) ────────────────────────────────────
 *
 * A circuit reads like a dependency tree: the value under attribution sits at
 * the root, evidence/const leaves sit at the bottom. TD lays that out the way
 * a reviewer already reads a stack trace or an AST dump — root on top,
 * grounding at the bottom — and GitHub's renderer keeps TD diagrams narrow
 * for this shape (LR spreads wide fast once `fused`/`build` fan out).
 * `opts.direction` overrides to `"LR"` for a circuit that is wide-and-shallow
 * rather than deep.
 *
 * ── shape legend (kind → mermaid shape) ─────────────────────────────────────
 *
 *   input   stadium        `([evidence: name (site N)])`   — the evidence source
 *   mint    subroutine     `[[head (site N)]]`              — evidence-class crossing
 *           hexagon        `{{head (site N)}}`              — ambient-class crossing (ungrounded)
 *   const   flag           `>⚠ const (site N)]`             — THE fabrication mark, unmistakable
 *   fused   rectangle      `[⊗ fuse (site N)]`
 *   mux     parallelogram  `[/mux: key (site N)/]`          — a projection/lens
 *   build   rectangle      `[ctor (site N)]`                — parts arrive as KEYED content edges
 *   string  rectangle      `[str (site N)]`                 — runs arrive in declared order
 *   choice  rhombus        `{choice (site N)}`               — a decision: guards vs alts below
 *   fan     subroutine     `[[fan: collapse (site N)]]`     — the aggregation boundary
 *   opaque  cylinder       `[(opaque: reason (site N))]`    — fail-closed, I1's lift target
 *
 * `const`'s flag shape (asymmetric — the one shape no other kind uses) PLUS
 * the "⚠ const" label is deliberately impossible to mistake for anything else
 * scrolling past: it is the fabrication mark a reviewer hunts for, per
 * static-prov.ts's own header ("THE fabrication mark").
 *
 * ── edges carry the CHANNEL, not just the shape ─────────────────────────────
 *
 * Solid (`-->`) = the CONTENT channel (what value flowed: `fused` sources,
 * `mux`/`build`/`string`/`fan` children, `choice` alts). Dotted (`-.->`) = the
 * SELECTION channel (why this world, never what flowed: `choice` guards, and
 * `mint`'s `closed` — static-prov.ts is explicit that a mint's own inputs
 * "ground the SELECTION story, never the content"). A reviewer sees the two
 * provenance channels (Green-Karvounarakis-Tannen content vs
 * Imieliński-Lipski selection) at a glance, without reading a legend.
 *
 * ── gray, never taken/gray (same as circuit-sexpr.ts) ───────────────────────
 *
 * `ChoiceProv` carries no valuation (that is a runtime overlay this pure,
 * trace-free layer never sees) — every alt renders identically; there is no
 * "taken" branch to highlight without a trace, and inventing one would
 * misrepresent an unexercised branch as chosen.
 *
 * ── `site` renders as the bare NodeId (same honesty as circuit-sexpr.ts) ────
 *
 * Every node label ends in `(site N)` where N is the raw `NodeId` — never a
 * fabricated `head@line:col` (this function has no source span to resolve
 * one against; see circuit-sexpr.ts's header for the full argument, which
 * applies here unchanged).
 *
 * ── determinism ──────────────────────────────────────────────────────────────
 *
 * Node ids (`n0`, `n1`, …) are assigned in a stable PRE-ORDER walk (own id
 * first, then children left-to-right in field-declaration order) with no
 * structural-sharing dedup — same input StaticProv always produces the exact
 * same string, so a test can assert against a golden string, and two runs of
 * this function diff cleanly.
 *
 * ── escaping ─────────────────────────────────────────────────────────────────
 *
 * Every label is emitted double-quoted; the mermaid parser then treats the
 * contents literally except the quote character itself, so brackets, pipes,
 * and parens embedded in an `input` name, a `mint` head, an `opaque` reason,
 * or a `build`/`mux` key never break node or edge parsing. A literal `"` is
 * replaced with mermaid's own `#quot;` entity (never a bare backslash-escape,
 * which mermaid does not treat as an escape inside a quoted label).
 */
import type { NodeId } from "../coreform/types.js";
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

export interface MermaidOptions {
  /** Layout direction — see this file's header for the TD default's rationale. */
  readonly direction?: "TD" | "LR";
}

interface Ctx {
  readonly lines: string[];
  next: number;
}

const freshId = (ctx: Ctx): string => `n${ctx.next++}`;

/** Every label is quoted; `"` becomes mermaid's `#quot;` entity so a value
 *  carrying brackets/pipes/quotes (an evidence name, a mint head, an opaque
 *  reason, a build/mux key) can never break node or edge syntax. */
const escapeLabel = (text: string): string => `"${text.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ")}"`;

const withSite = (text: string, site: NodeId): string => `${text} (site ${site})`;

const keyText = (k: string | number): string => (typeof k === "number" ? String(k) : k);

// ── shapes ───────────────────────────────────────────────────────────────────

const nodeStadium = (id: string, label: string): string => `${id}([${escapeLabel(label)}])`;
const nodeSubroutine = (id: string, label: string): string => `${id}[[${escapeLabel(label)}]]`;
const nodeHexagon = (id: string, label: string): string => `${id}{{${escapeLabel(label)}}}`;
const nodeFlag = (id: string, label: string): string => `${id}>${escapeLabel(label)}]`;
const nodeRect = (id: string, label: string): string => `${id}[${escapeLabel(label)}]`;
const nodeRhombus = (id: string, label: string): string => `${id}{${escapeLabel(label)}}`;
const nodeParallelogram = (id: string, label: string): string => `${id}[/${escapeLabel(label)}/]`;
const nodeCylinder = (id: string, label: string): string => `${id}[(${escapeLabel(label)})]`;

// ── edges: solid = content channel, dotted = selection channel ─────────────

const contentEdge = (from: string, to: string, label?: string): string =>
  label === undefined ? `${from} --> ${to}` : `${from} -->|${escapeLabel(label)}| ${to}`;

const selectionEdge = (from: string, to: string, label?: string): string =>
  label === undefined ? `${from} -.-> ${to}` : `${from} -.->|${escapeLabel(label)}| ${to}`;

// ── per-kind renderers ───────────────────────────────────────────────────────

const renderInput = (p: InputProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeStadium(id, withSite(`evidence: ${p.name}`, p.site)));
  return id;
};

/** Evidence-class crossing → subroutine (a known, recorded call). Ambient
 *  crossing → hexagon (visually distinct — the ungrounded class, `(now)`/
 *  `(uuid)`, per static-prov.ts's own `Integrity` doc). `closed` is the
 *  crossing's own inputs — SELECTION channel (dotted), never content. */
const renderMint = (p: MintProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  const label = withSite(p.head, p.site);
  ctx.lines.push(p.integrity === "ambient" ? nodeHexagon(id, label) : nodeSubroutine(id, label));
  for (const c of p.closed) {
    const childId = renderNode(c, ctx);
    ctx.lines.push(selectionEdge(id, childId, "closed"));
  }
  return id;
};

/** THE fabrication mark — see this file's header for why the flag shape +
 *  "⚠" text is deliberately unmistakable. */
const renderConst = (p: ConstProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeFlag(id, withSite("⚠ const", p.site)));
  return id;
};

const renderFused = (p: FusedProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeRect(id, withSite("⊗ fuse", p.site)));
  for (const s of p.sources) {
    const childId = renderNode(s, ctx);
    ctx.lines.push(contentEdge(id, childId));
  }
  return id;
};

const renderMux = (p: MuxProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeParallelogram(id, withSite(`mux: ${p.key === null ? "nil" : keyText(p.key)}`, p.site)));
  const childId = renderNode(p.source, ctx);
  ctx.lines.push(contentEdge(id, childId));
  return id;
};

/** Parts carry the container's structure — each edge is labeled with its
 *  KEY (the field/index name), the one thing a `fused`-style unlabeled fold
 *  would lose. */
const renderBuild = (p: BuildProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeRect(id, withSite(p.ctor, p.site)));
  for (const part of p.parts) {
    const childId = renderNode(part.prov, ctx);
    ctx.lines.push(contentEdge(id, childId, keyText(part.key)));
  }
  return id;
};

const renderString = (p: StringProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeRect(id, withSite("str", p.site)));
  for (const r of p.runs) {
    const childId = renderNode(r, ctx);
    ctx.lines.push(contentEdge(id, childId));
  }
  return id;
};

/** Every alt renders identically (no valuation at this pure, trace-free
 *  layer — see this file's header). Guards are the SELECTION channel
 *  (dotted, "why this world"); alts are the CONTENT channel (solid, "what
 *  flowed"). */
const renderChoice = (p: ChoiceProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeRhombus(id, withSite("choice", p.site)));
  for (const g of p.guards) {
    const childId = renderNode(g, ctx);
    ctx.lines.push(selectionEdge(id, childId, "guard"));
  }
  for (const a of p.alts) {
    const childId = renderNode(a, ctx);
    ctx.lines.push(contentEdge(id, childId, "alt"));
  }
  return id;
};

/** Both `collection` and `body` are content: the collection is the data
 *  under iteration, `body` is the per-element attribution template. The
 *  node's own label carries `collapse` — the only fan-specific metadata a
 *  static (unexecuted) circuit has to show. */
const renderFan = (p: FanProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeSubroutine(id, withSite(`fan: ${p.collapse}`, p.site)));
  const collectionId = renderNode(p.collection, ctx);
  ctx.lines.push(contentEdge(id, collectionId, "collection"));
  const bodyId = renderNode(p.body, ctx);
  ctx.lines.push(contentEdge(id, bodyId, "body"));
  return id;
};

const renderOpaque = (p: OpaqueProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeCylinder(id, withSite(`opaque: ${p.reason}`, p.site)));
  return id;
};

/** `StaticProv` → mermaid node(s)/edge(s), returning the id assigned to
 *  `prov` itself. Exhaustive by tsc (no default arm) — adding an 11th
 *  `StaticProv` kind breaks this file at compile time, mirroring
 *  `circuit-sexpr.ts`'s and `extract`'s own totality proof (I1). */
function renderNode(prov: StaticProv, ctx: Ctx): string {
  switch (prov.kind) {
    case "input":
      return renderInput(prov, ctx);
    case "mint":
      return renderMint(prov, ctx);
    case "const":
      return renderConst(prov, ctx);
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
      return renderOpaque(prov, ctx);
  }
}

/** `StaticProv` → a mermaid `flowchart` definition — see this file's header
 *  for the shape/edge/direction legend. Deterministic: the same `prov`
 *  always produces the exact same string. */
export function circuitToMermaid(prov: StaticProv, opts: MermaidOptions = {}): string {
  const direction = opts.direction ?? "TD";
  const ctx: Ctx = { lines: [], next: 0 };
  renderNode(prov, ctx);
  return [`flowchart ${direction}`, ...ctx.lines].join("\n");
}

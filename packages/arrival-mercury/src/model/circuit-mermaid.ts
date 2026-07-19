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
 * ── edges carry the CHANNEL, not just the shape — plus one deliberate borrow ─
 *
 * Solid (`-->`) = the CONTENT channel (what value flowed: `fused` sources,
 * `mux`/`build`/`string`/`fan` children). Dotted (`-.->`) = the SELECTION
 * channel (why this world, never what flowed: `choice` guards, and `mint`'s
 * `closed` — static-prov.ts is explicit that a mint's own inputs "ground the
 * SELECTION story, never the content"). A reviewer sees the two provenance
 * channels (Green-Karvounarakis-Tannen content vs Imieliński-Lipski
 * selection) at a glance, without reading a legend.
 *
 * `choice` ALTS are dashed too — a deliberate borrow of the selection
 * styling, not a `channels()` reclassification: an alt's own content still
 * folds into the CONTENT channel (circuit-verdict.ts's `channels()`), never
 * selection. What earns it the dashed treatment is a DIFFERENT, related
 * fact: unlike a `fused`/`build`/`string`/`fan` child (every one of which
 * unconditionally contributes), only ONE of a `choice`'s kept alts is
 * realized per run — the rest sit in the circuit unexercised (static-prov.ts:
 * "All alternatives stay in the circuit (gray wires)"). Dashing the edge
 * flags exactly that "kept, not-necessarily-realized" shape, the same thing
 * `circuit-sexpr.ts`'s `(gray …)` wrap flags at the sexpr layer and
 * `to-wireframe.ts`'s `choiceWireRole` side map flags at the data layer —
 * keeping all three projections in agreement about whether this structure is
 * visible. A true selection-channel edge (`guard`, `closed`) and a borrowed
 * one (`alt`) share the SAME dash pattern on purpose (both mean "not a
 * guaranteed pass-through, read the label to know which"); the edge LABEL is
 * what still tells them apart, exactly as `guard` and `closed` already
 * differ only by label today.
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
 * ── determinism, and the shared-DAG dedup ───────────────────────────────────
 *
 * Node ids (`n0`, `n1`, …) are assigned in a stable PRE-ORDER walk (own id
 * first, then children left-to-right in field-declaration order), WITH
 * structural-sharing dedup keyed on `StaticProv` OBJECT IDENTITY (`renderNode`
 * below): a `prov` reference already visited earlier in the SAME render
 * reuses its existing id instead of minting a new one and re-walking its
 * subtree — the representation-sharing half of "a provenance circuit IS a
 * shared DAG" (Deutch-Milo-Roy-Tannen, ICDT 2014; the extract-side half is
 * `ExtractCtx.memo`, src/extract/index.ts, which is what makes two Refs to one
 * binding share the identical object in the first place). Dedup is a pure
 * REPRESENTATION choice — never semantics: a shared node renders as one box
 * with multiple in-edges rather than a duplicated subtree, but the same
 * input StaticProv always produces the exact same string (object identity is
 * fixed once `prov` is constructed, so the walk order — and therefore every
 * id and every line — is fully determined by the DAG itself), so a test can
 * assert against a golden string and two runs of this function always diff
 * cleanly. A fixture with no aliasing anywhere is unaffected by the dedup
 * check entirely, since it only ever changes anything when the SAME
 * reference is seen twice.
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
  /** Layout direction. `"full"` view defaults TD (the whole circuit reads as a
   *  dependency tree); `"infer"` view defaults LR (a crossing chain reads
   *  left-to-right, like the studio's own region render). */
  readonly direction?: "TD" | "LR";
  /** Which projection:
   *  - `"full"` (default) — every StaticProv node, the honest circuit.
   *  - `"infer"` — THE SEMANTIC VIEW. Keep only the membrane crossings (mints);
   *    contract all the plumbing (mux/build/string/fuse/choice/fan) that wraps
   *    one crossing's output into the next crossing's prompt down to a single
   *    WIRE. We never render or re-provenance the wrapping steps — the edge
   *    plus a point-query to storage IS the mechanism ("the dataflow graph is
   *    enough, as long as we cache the expensive points"). */
  readonly view?: "full" | "infer";
  /** The separate storage's point-query, used only by the `"infer"` view: given
   *  a crossing's site, return the recorded value that flowed on its output
   *  wire (the thing RegionView shows as the actual message text). Absent → the
   *  view shows wire STRUCTURE only (which field grounds where), never invents a
   *  value. This is the seam onto the content-addressed crossing cache. */
  readonly dataFor?: (site: NodeId) => string | undefined;
}

interface Ctx {
  readonly lines: string[];
  next: number;
  /** Shared-DAG dedup (object identity — the extract-side memo, src/extract/
   *  index.ts's `ExtractCtx.memo`, is what makes two Refs to one binding
   *  return the SAME StaticProv object; this map is what a RENDERER does with
   *  that identity). A revisited node emits ONLY the edge to its existing id
   *  — no second node line — which is exactly what makes the flowchart read
   *  as a DAG (one box, two in-edges) instead of a duplicated subtree.
   *  Mermaid draws a multi-parent node natively; no special syntax needed. */
  readonly seen: Map<StaticProv, string>;
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
 *  layer — see this file's header). Guards are the true SELECTION channel
 *  (dotted, "why this world"); alts are dashed too — a deliberate borrow of
 *  the same styling, not a channel reclassification (an alt's content is
 *  still CONTENT-channel data; see this file's header for the full
 *  rationale). The `"guard"` vs `"alt"` label is what tells the two apart. */
const renderChoice = (p: ChoiceProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeRhombus(id, withSite("choice", p.site)));
  for (const g of p.guards) {
    const childId = renderNode(g, ctx);
    ctx.lines.push(selectionEdge(id, childId, "guard"));
  }
  for (const a of p.alts) {
    const childId = renderNode(a, ctx);
    ctx.lines.push(selectionEdge(id, childId, "alt"));
  }
  return id;
};

/** A Fan is a SUPERPOSITION — the collection lifted to all element-states at
 *  once (invention I4, the z-axis). It renders as a z-STACK: a subgraph holding
 *  the per-element `body` template (one drawn iteration standing for all N),
 *  with the `collection` unwound INTO it and the wound result flowing OUT. A
 *  `body` that is itself a Fan nests — nested subgraphs = nested z-axes
 *  (`(map (λ row (filter p row)) matrix)`). Matches the studio region render's
 *  own `iterate ◇/map ◇` stacked boxes. `collapse` labels the axis. */
const renderFan = (p: FanProv, ctx: Ctx): string => {
  const id = `f${ctx.next++}`;
  ctx.lines.push(`subgraph ${id}[${escapeLabel(withSite(`⟳ fan · ${p.collapse} · z-stack`, p.site))}]`);
  ctx.lines.push("direction TB");
  const bodyId = renderNode(p.body, ctx); // the per-element template, INSIDE the axis
  ctx.lines.push("end");
  const collectionId = renderNode(p.collection, ctx);
  ctx.lines.push(contentEdge(collectionId, bodyId, "unwind"));
  return id;
};

const renderOpaque = (p: OpaqueProv, ctx: Ctx): string => {
  const id = freshId(ctx);
  ctx.lines.push(nodeCylinder(id, withSite(`opaque: ${p.reason}`, p.site)));
  return id;
};

/** `StaticProv` → mermaid node(s)/edge(s) for a NOT-YET-SEEN `prov`, returning
 *  the freshly-minted id. Exhaustive by tsc (no default arm) — adding an 11th
 *  `StaticProv` kind breaks this file at compile time, mirroring
 *  `circuit-sexpr.ts`'s and `extract`'s own totality proof (I1). Called only
 *  from `renderNode`, below, on a `ctx.seen` miss. */
function renderNodeFresh(prov: StaticProv, ctx: Ctx): string {
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

/** `StaticProv` → mermaid node(s)/edge(s), returning the id assigned to
 *  `prov` itself — SHARED-DAG AWARE: a `prov` object already rendered earlier
 *  in this SAME `circuitToMermaid` call returns its EXISTING id with no new
 *  node line emitted (the caller still emits its own edge TO that id — see
 *  e.g. `renderFused`'s loop — so a shared node ends up with multiple
 *  in-edges, drawn natively by mermaid). Dedup is by OBJECT IDENTITY, keyed
 *  on the exact same `StaticProv` reference the extract-side memo produces
 *  (src/extract/index.ts's `ExtractCtx.memo`) — two STRUCTURALLY equal but
 *  distinct object instances (e.g. two independent call sites' attributions
 *  that happen to look the same) are NOT merged, only genuine representation
 *  sharing is. Safe across a `fan`'s body boundary too: `renderFan` recurses
 *  through this same function with the SAME `ctx`, so a node shared between a
 *  fan's body and the surrounding circuit dedups exactly like any other. */
function renderNode(prov: StaticProv, ctx: Ctx): string {
  const existing = ctx.seen.get(prov);
  if (existing !== undefined) return existing;
  const id = renderNodeFresh(prov, ctx);
  ctx.seen.set(prov, id);
  return id;
}

/** `StaticProv` → a mermaid `flowchart` definition — see this file's header
 *  for the shape/edge/direction legend. Deterministic: the same `prov`
 *  always produces the exact same string (dedup walks in the same stable
 *  pre-order, so object-identity iteration order never varies run to run). */
export function circuitToMermaid(prov: StaticProv, opts: MermaidOptions = {}): string {
  if ((opts.view ?? "full") === "infer") return inferView(prov, opts);
  const direction = opts.direction ?? "TD";
  const ctx: Ctx = { lines: [], next: 0, seen: new Map() };
  renderNode(prov, ctx);
  return [`flowchart ${direction}`, ...ctx.lines].join("\n");
}

// ── the semantic infer view (crossing chain, plumbing contracted) ──────────────

/** The mints whose OUTPUT flows to `p`, following the CONTENT channel only — a
 *  mint is a leaf output, so we STOP at it (never descend into its own `closed`
 *  prompt) and never follow selection (choice guards). This is the contraction:
 *  every mux/build/string/fuse/choice-alt/fan between two crossings collapses to
 *  "these upstream crossings' outputs reach here", i.e. the WIRE. */
function outputCrossings(p: StaticProv, acc: Map<number, MintProv>): void {
  switch (p.kind) {
    case "mint":
      acc.set(p.site as number, p);
      return; // STOP — the mint's output is the wire's payload; its closed is a DIFFERENT wire.
    case "input":
    case "const":
    case "opaque":
      return;
    case "fused":
      p.sources.forEach((s) => outputCrossings(s, acc));
      return;
    case "mux":
      outputCrossings(p.source, acc);
      return;
    case "build":
      p.parts.forEach((pt) => outputCrossings(pt.prov, acc));
      return;
    case "string":
      p.runs.forEach((r) => outputCrossings(r, acc));
      return;
    case "choice":
      p.alts.forEach((a) => outputCrossings(a, acc)); // content = alts, never guards
      return;
    case "fan":
      outputCrossings(p.collection, acc);
      outputCrossings(p.body, acc);
      return;
  }
}

/** Every mint anywhere in the circuit (descends through closed + guards + all
 *  content) — the node set of the infer view. */
function allCrossings(p: StaticProv, acc: Map<number, MintProv>): void {
  switch (p.kind) {
    case "mint":
      acc.set(p.site as number, p);
      p.closed.forEach((c) => allCrossings(c, acc));
      return;
    case "input":
    case "const":
    case "opaque":
      return;
    case "fused":
      p.sources.forEach((s) => allCrossings(s, acc));
      return;
    case "mux":
      allCrossings(p.source, acc);
      return;
    case "build":
      p.parts.forEach((pt) => allCrossings(pt.prov, acc));
      return;
    case "string":
      p.runs.forEach((r) => allCrossings(r, acc));
      return;
    case "choice":
      p.guards.forEach((g) => allCrossings(g, acc));
      p.alts.forEach((a) => allCrossings(a, acc));
      return;
    case "fan":
      allCrossings(p.collection, acc);
      allCrossings(p.body, acc);
      return;
  }
}

/** Does the content of `p` (not its closed/guards) reach a `const` — a
 *  program-text fabrication on the wire, the thing the seal refuses? Used to
 *  flag a wire whose payload is (partly) fabricated rather than grounded. */
function contentHasConst(p: StaticProv): boolean {
  switch (p.kind) {
    case "const":
      return true;
    case "mint":
    case "input":
    case "opaque":
      return false;
    case "fused":
      return p.sources.some(contentHasConst);
    case "mux":
      return contentHasConst(p.source);
    case "build":
      return p.parts.some((pt) => contentHasConst(pt.prov));
    case "string":
      return p.runs.some(contentHasConst);
    case "choice":
      return p.alts.some(contentHasConst);
    case "fan":
      return contentHasConst(p.collection) || contentHasConst(p.body);
  }
}

function inferView(root: StaticProv, opts: MermaidOptions): string {
  const direction = opts.direction ?? "LR";
  const nodes = new Map<number, MintProv>();
  allCrossings(root, nodes);

  const lines: string[] = [];
  const nid = (site: number): string => `x${site}`;

  // Nodes: one per crossing. The label ABSORBS the crossing's identity (head)
  // and, when the storage resolver answers, the recorded value on its output —
  // the crossing's whole prompt struct collapses INTO the node, never drawn as
  // separate plumbing. (A prompt's template text is the instruction, benign —
  // not fabrication; only the OUTPUT's grounding is the seal's concern, below.)
  for (const [site, m] of nodes) {
    const data = opts.dataFor?.(m.site);
    const head = m.integrity === "ambient" ? `${m.head} · ambient` : m.head;
    const label = data !== undefined ? `${head}<br/>${data}` : head;
    lines.push(m.integrity === "ambient" ? nodeHexagon(nid(site), label) : nodeSubroutine(nid(site), label));
  }

  // Wires: for each crossing, which UPSTREAM crossings' outputs flow into its
  // prompt (its `closed` inputs). This is the contracted edge — the wrapping
  // steps that spliced the upstream value into this prompt are never rendered.
  // The wire's label is the recorded DATA if storage answers, else the arg slot.
  for (const [site, m] of nodes) {
    m.closed.forEach((c, i) => {
      const up = new Map<number, MintProv>();
      outputCrossings(c, up);
      for (const [upSite, upM] of up) {
        const wireData = opts.dataFor?.(upM.site);
        const lbl = wireData ?? (m.closed.length > 1 ? `arg${i}` : undefined);
        lines.push(contentEdge(nid(upSite), nid(site), lbl));
      }
    });
  }

  // OUTPUT: the crossings whose output is the program's final value. The one
  // place fabrication matters in this view: if the final value carries a `const`
  // on its content path with NO crossing behind it, the output is program-text —
  // fabricated, not grounded. That is the seal's verdict, surfaced at the sink.
  const outs = new Map<number, MintProv>();
  outputCrossings(root, outs);
  const outputFabricated = contentHasConst(root);
  if (outs.size > 0 || outputFabricated) {
    lines.push(nodeStadium("out", "OUTPUT"));
    for (const [upSite, upM] of outs) {
      lines.push(contentEdge(nid(upSite), "out", opts.dataFor?.(upM.site)));
    }
    if (outputFabricated) {
      lines.push(nodeFlag("outfab", "⚠ fabricated"));
      lines.push(contentEdge("outfab", "out"));
    }
  }

  const classes = outputFabricated
    ? ["classDef fab fill:#e5484d22,stroke:#e5484d,stroke-width:2px,color:#8f1e23;", "class outfab fab;"]
    : [];
  return [`flowchart ${direction}`, ...lines, ...classes].join("\n");
}

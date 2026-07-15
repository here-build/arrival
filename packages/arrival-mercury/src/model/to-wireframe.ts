/**
 * toWireframe — StaticProv → WireframeGraph, the render-compat projection
 * (T7a, docs/working-proposals/scheme-semantic-model-synthesis.md §2f, "the
 * money table" + "Design: one static object, two projections (bifunctor
 * discipline)"). `extract` (P4) produces StaticProv; this proves it renders
 * through the EXISTING workbench pane (`WireframeGraph`, the studio's ELK
 * pane target) UNCHANGED — no studio edit, no new node kind added to the
 * workbench's union. Semantics ride SIDE MAPS, never baked onto a
 * `WireframeNode`'s own fields — the invariant both existing ELK adapters
 * (`buildWireframe`'s source builder and this one) hold.
 *
 * ── the money table, as implemented ─────────────────────────────────────────
 *
 *   StaticProv kind │ WireframeNode kind │ side map                | delta
 *   ────────────────┼────────────────────┼──────────────────────────┼──────
 *   input           │ source             │ —                        | exact (op = param name)
 *   mint            │ source             │ integrity                | op = effect head
 *   const           │ opaque             │ fabrication (laundering  | THE GAP — see below
 *                    │                    │   guard)                 |
 *   fused           │ transparent        │ —                        | op = "fuse"
 *   mux             │ transparent        │ —                        | op = "mux" (exact per doc's
 *                    │                    │                          |   own money table row)
 *   build           │ transparent        │ buildShape (ctor + keys) | op = "build"
 *   string          │ transparent        │ —                        | op = "string"
 *   choice          │ mux                │ choiceWireRole           | arms = alts.length, all gray
 *   fan             │ fan                │ collapse, fanTemplates   | template = nested projection
 *   opaque          │ opaque             │ —                        | exact, reason surfaces as `op`
 *
 * ── THE GAP (report this, per the task brief) ───────────────────────────────
 *
 * `WireframeNode` has no `const` arm — the money table (§2f) names it as
 * "the one node kind to add," but adding a union member is a studio-workbench
 * change (`foundations/arrival/arrival/src/provenance/wireframe/types.ts`),
 * out of bounds for this pure projection. The closest HONEST existing kind is
 * `opaque` (a black box, "don't trust this") — never `source` (would claim
 * evidence-class ancestry a program-text literal does not have) and never
 * `transparent` (would claim pass-through fidelity a literal does not
 * preserve — there is nothing upstream to be transparent TO). A `const` node
 * is therefore rendered as `{kind:"opaque", op:"const", ...}`, and
 * `sideMaps.fabrication` carries the ONE authoritative bit: "is this node
 * REALLY a const" must always be answered from `fabrication`, never from the
 * node's own `kind`/`op` — reading `kind === "opaque"` alone conflates a
 * proven fabrication with a merely-unresolvable circuit (a real `OpaqueProv`),
 * which is exactly the laundering this side map exists to prevent. A future
 * workbench change adding a real `const` arm should replace this mapping, not
 * layer on top of it.
 *
 * ── span is a bare stringified NodeId, not `head@line:col` ─────────────────
 *
 * Same limit `circuit-sexpr.ts` documents: a `StaticProv` carries only a
 * `site: NodeId` with no accompanying span or source text to resolve one
 * against. Fabricating a `head@line:col`-shaped string would invent
 * structure I1 forbids; `span = String(site)` is the honest choice.
 *
 * ── wires carry no real dataflow — they are honest passthroughs ────────────
 *
 * `StaticProv` is transformation-blind (it never computes an op's result —
 * `static-prov.ts`'s header) and carries no source text to re-emit as a
 * `Wire`'s closed lambda body. Rather than fabricate a body that pretends to
 * DO something, every wire here is a literal identity passthrough of its
 * referenced upstream node — `(lambda (p0) p0)`, `paramRefs: [{kind:"node",
 * name:"p0", node: <upstream>}]` — which is exactly what a wire IS in this
 * graph model when it does no extra plumbing (the struct-fact case aside).
 * This is not a placeholder claim; "this slot receives that node's value,
 * unchanged" is true by construction of the projection.
 *
 * ── fan.lengthPreserving is a documented proxy, not a derivation ───────────
 *
 * `CollapseKind` (combine/route/lowered) is a DIFFERENT axis than
 * length-preservation — `StaticProv` deliberately does not carry a
 * map/filter/fold tag (the fan zoo vanishes into unwind/wind, §2c). There is
 * no honest derivation of `lengthPreserving` from `collapse` alone.
 * `lengthPreserving: collapse === "lowered"` is used as a conservative
 * proxy (never overclaims for the two collapse-kinds that are provably
 * NOT length-preserving — `combine` aggregates to one value, `route`
 * narrows to a subset); `sideMaps.collapse` carries the real, load-bearing
 * signal. Report this as a second gap: a true `lengthPreserving` bit needs a
 * field `extract` does not populate on `FanProv` today.
 *
 * ── shared-DAG dedup, scoped per graph level (G2, 2026-07-16) ──────────────
 *
 * `project` (below) recognizes a `StaticProv` object identity already
 * projected earlier and reuses its node index instead of re-projecting the
 * whole subtree — the representation-sharing half of "a provenance circuit
 * IS a shared DAG" (the extract-side memo, `ExtractCtx.memo` in
 * src/extract/index.ts, is the other half: it is what makes two Refs to one
 * binding return the identical object in the first place). Third documented
 * gap: this dedup is scoped to one `Builder` — one graph LEVEL — because a
 * `fan`'s body already projects through a RECURSIVE `toWireframe` call into
 * its OWN private index space (`fanTemplates`' own doc, above). A node shared
 * ACROSS a fan boundary (between the outer graph and a template, or between
 * two templates) still projects once per level it appears in — `Wire`
 * references a node index local to one `nodes` array, so there is no
 * cross-level slot to point a shared reference at without a bigger change to
 * `WireframeGraph` itself. Dedup WITHIN one level is unconditional and exact.
 *
 * ── choiceWireRole: closing the cross-projection parity gap (2026-07-16) ───
 *
 * A `choice`'s own wires are the one place a `WireframeNode`'s incoming wires
 * are NOT uniformly one channel: `guards` → SELECTION, `alts` → CONTENT
 * (static-prov.ts's `ChoiceProv` doc — "guards attribute the SELECTION...
 * alts attribute the CONTENT"). Every other kind's wires are unambiguous from
 * `provKind` alone (a `mint`'s `closed*` wires are always selection; a
 * `fused`/`build`/`string`/`mux`/`fan`'s argument wires are always content),
 * so only `choice` needs a per-wire map. Before this field, the only signal
 * was the `selector*`/`arm*` slot-name CONVENTION already documented on
 * `WireSlot` (arrival's `wireframe/types.ts`) — a string prefix a consumer
 * had to parse, never a first-class fact. `choiceWireRole` makes it one,
 * keyed by the exact same `(node, slot)` pair a `Wire.consumer` already
 * carries (`wireKey`, below) — no new identity invented, just a typed lookup
 * over data that was always there.
 *
 * This is the WIREFRAME leg of a three-projection parity fix: a cross-model
 * audit found `circuit-sexpr.ts` renders a `choice`'s kept, non-taken
 * alternatives distinctly (the `(gray …)` wrap) while `circuit-mermaid.ts`
 * rendered them as plain solid edges (indistinguishable from data flow) and
 * this projection exposed no distinct channel for them at all — three
 * projections of the same circuit disagreeing about what is visible, drift
 * risk on a security review surface. `circuit-mermaid.ts` now dashes a
 * `choice`'s alt edges too (its own header explains why that is a deliberate
 * borrow, not a `channels()` reclassification); `choiceWireRole` is this
 * file's side of the same fix — a reviewer (or a test) can now ask "does
 * this projection make the choice's alternative structure visible" and get
 * the SAME answer from all three.
 */
import type { Wire, WireConsumer, WireframeGraph, WireframeNode } from "@here.build/arrival/provenance";

import type {
  BuildProv,
  ChoiceProv,
  CollapseKind,
  ConstProv,
  FanProv,
  FusedProv,
  InputProv,
  Integrity,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "./static-prov.js";

/** Domain data that never rides on a `WireframeNode`'s own fields — keyed by
 *  index into the SAME graph's `nodes` array. `fanTemplates` nests one level
 *  per `fan` node (its `template` graph gets its OWN index space and its OWN
 *  side maps — the same "private interior" discipline `binder.interior`
 *  already holds in the workbench). */
export interface WireframeSideMaps {
  /** The ground-truth `StaticProv` kind for every node — always present,
   *  regardless of which (necessarily coarser) `WireframeNode` kind it
   *  projected onto. */
  readonly provKind: ReadonlyMap<number, StaticProv["kind"]>;
  /** `mint`/`input` integrity class (money table: "needs integrity class
   *  (side-table)"). Present only for nodes whose `provKind` is `mint`. */
  readonly integrity: ReadonlyMap<number, Integrity>;
  /** `fan` collapse-kind (money table: "needs collapse-kind (void-free AC
   *  vs lowered)"). Present only for nodes whose `provKind` is `fan`. */
  readonly collapse: ReadonlyMap<number, CollapseKind>;
  /** `build`'s ctor + ordered part keys (the "container shape" delta).
   *  Present only for nodes whose `provKind` is `build`. */
  readonly buildShape: ReadonlyMap<number, { readonly ctor: BuildProv["ctor"]; readonly keys: readonly (string | number)[] }>;
  /** THE render-laundering guard. A node index is in this set iff it is a
   *  `const` (program-text fabrication mark) projected onto the closest
   *  honest existing kind (`opaque`). A renderer/seal consumer MUST consult
   *  this before treating an `opaque` node as "merely unresolvable" — a
   *  `const` is a PROVEN fabrication, strictly worse than a gap. Never
   *  derive this from `kind`/`op`; that is exactly the laundering this map
   *  exists to prevent. */
  readonly fabrication: ReadonlySet<number>;
  /** Per-`fan`-node (keyed by the OUTER graph's node index) the INNER
   *  `template` graph's own side maps — the body is a private interior with
   *  its own index space, so its domain data cannot share this map. */
  readonly fanTemplates: ReadonlyMap<number, WireframeSideMaps>;
  /** `"guard"` (selection channel) vs `"alt"` (content channel) for a
   *  `choice`-projected node's own wires ONLY — the one `WireframeNode` kind
   *  whose incoming wires split across both `channels()` channels (see this
   *  file's header, "choiceWireRole"). Keyed by `wireKey(node, slot)`, the
   *  same `(node, slot)` pair every `Wire.consumer` already carries — never a
   *  new identity. Optional/additive: absent on a `WireframeSideMaps` built
   *  before this field existed (or hand-constructed by an older test/fixture),
   *  so every existing object literal still type-checks unchanged; a reader
   *  should treat a missing entry (or a missing map) the same as "no
   *  selection structure to show here," never throw on its absence. */
  readonly choiceWireRole?: ReadonlyMap<string, "guard" | "alt">;
}

export interface WireframeProjection {
  readonly graph: WireframeGraph;
  readonly sideMaps: WireframeSideMaps;
}

/** A wire whose body is the literal identity of the node it references —
 *  true by construction (see this file's header). */
function passthroughWire(fromNode: number, consumer: WireConsumer, span: string): Wire {
  return {
    source: "(lambda (p0) p0)",
    params: ["p0"],
    paramRefs: [{ kind: "node", name: "p0", node: fromNode }],
    span,
    consumer,
  };
}

/** The `choiceWireRole` map key — the exact `(node, slot)` pair a
 *  `Wire.consumer` already carries, turned into a lookup key. Not a new
 *  identity: a caller holding a `Wire` can reconstruct the SAME key from
 *  `wire.consumer.node`/`wire.consumer.slot` with no string-prefix parsing of
 *  the slot name itself required. */
const wireKey = (node: number, slot: string): string => `${node}:${slot}`;

interface Builder {
  readonly nodes: WireframeNode[];
  readonly wires: Wire[];
  readonly provKind: Map<number, StaticProv["kind"]>;
  readonly integrity: Map<number, Integrity>;
  readonly collapse: Map<number, CollapseKind>;
  readonly buildShape: Map<number, { readonly ctor: BuildProv["ctor"]; readonly keys: readonly (string | number)[] }>;
  readonly fabrication: Set<number>;
  readonly fanTemplates: Map<number, WireframeSideMaps>;
  /** `choice` wires only — see `WireframeSideMaps.choiceWireRole`'s doc. */
  readonly choiceWireRole: Map<string, "guard" | "alt">;
  /** Shared-DAG dedup (G2, 2026-07-16), scoped to THIS builder/graph level —
   *  see `project`'s doc for why a fan's nested `template` graph (its own
   *  Builder, its own index space — the "private interior" discipline this
   *  file's header already documents) is a SEPARATE dedup scope, not a gap in
   *  this one. */
  readonly seen: Map<StaticProv, number>;
}

function newBuilder(): Builder {
  return {
    nodes: [],
    wires: [],
    provKind: new Map(),
    integrity: new Map(),
    collapse: new Map(),
    buildShape: new Map(),
    fabrication: new Set(),
    fanTemplates: new Map(),
    choiceWireRole: new Map(),
    seen: new Map(),
  };
}

function pushNode(b: Builder, node: WireframeNode, kind: StaticProv["kind"]): number {
  const idx = b.nodes.length;
  b.nodes.push(node);
  b.provKind.set(idx, kind);
  return idx;
}

/** Wires a parent's children in as `${slotPrefix}${i}`-slotted passthroughs.
 *  `choiceRole`, when supplied, ALSO records each wire's `(node, slot)` key
 *  into `b.choiceWireRole` — used only by `projectChoice`'s two calls
 *  (`"guard"` for guards, `"alt"` for alts); every other caller (fused
 *  sources, build parts, string runs) omits it and gets the plain wiring
 *  unchanged, since those kinds' wires are already unambiguous from
 *  `provKind` alone (see `WireframeSideMaps.choiceWireRole`'s doc). */
function wireChildren(
  b: Builder,
  parent: number,
  span: string,
  slotPrefix: string,
  children: readonly StaticProv[],
  choiceRole?: "guard" | "alt",
): void {
  children.forEach((child, i) => {
    const childIdx = project(b, child);
    const slot = `${slotPrefix}${i}`;
    b.wires.push(passthroughWire(childIdx, { node: parent, slot }, span));
    if (choiceRole !== undefined) b.choiceWireRole.set(wireKey(parent, slot), choiceRole);
  });
}

function projectInput(b: Builder, prov: InputProv): number {
  return pushNode(b, { kind: "source", op: prov.name, span: String(prov.site) }, "input");
}

function projectMint(b: Builder, prov: MintProv): number {
  const span = String(prov.site);
  const idx = pushNode(b, { kind: "source", op: prov.head, span }, "mint");
  b.integrity.set(idx, prov.integrity);
  wireChildren(b, idx, span, "closed", prov.closed);
  return idx;
}

function projectConst(b: Builder, prov: ConstProv): number {
  const idx = pushNode(b, { kind: "opaque", op: "const", span: String(prov.site) }, "const");
  b.fabrication.add(idx);
  return idx;
}

function projectFused(b: Builder, prov: FusedProv): number {
  const span = String(prov.site);
  const idx = pushNode(b, { kind: "transparent", op: "fuse", span }, "fused");
  wireChildren(b, idx, span, "arg", prov.sources);
  return idx;
}

function projectMux(b: Builder, prov: MuxProv): number {
  const span = String(prov.site);
  const idx = pushNode(b, { kind: "transparent", op: "mux", span }, "mux");
  const sourceIdx = project(b, prov.source);
  b.wires.push(passthroughWire(sourceIdx, { node: idx, slot: "source" }, span));
  return idx;
}

function projectBuild(b: Builder, prov: BuildProv): number {
  const span = String(prov.site);
  const idx = pushNode(b, { kind: "transparent", op: "build", span }, "build");
  b.buildShape.set(idx, { ctor: prov.ctor, keys: prov.parts.map((p) => p.key) });
  wireChildren(
    b,
    idx,
    span,
    "arg",
    prov.parts.map((p) => p.prov),
  );
  return idx;
}

function projectString(b: Builder, prov: StringProv): number {
  const span = String(prov.site);
  const idx = pushNode(b, { kind: "transparent", op: "string", span }, "string");
  wireChildren(b, idx, span, "arg", prov.runs);
  return idx;
}

function projectChoice(b: Builder, prov: ChoiceProv): number {
  const span = String(prov.site);
  const idx = pushNode(b, { kind: "mux", op: "choice", span, arms: prov.alts.length }, "choice");
  wireChildren(b, idx, span, "selector", prov.guards, "guard");
  wireChildren(b, idx, span, "arm", prov.alts, "alt");
  return idx;
}

function projectFan(b: Builder, prov: FanProv): number {
  const span = String(prov.site);
  const bodyProjection = toWireframe(prov.body);
  const idx = pushNode(
    b,
    {
      kind: "fan",
      op: "fan",
      span,
      // Documented proxy, not a derivation — see this file's header.
      lengthPreserving: prov.collapse === "lowered",
      template: bodyProjection.graph,
    },
    "fan",
  );
  b.collapse.set(idx, prov.collapse);
  b.fanTemplates.set(idx, bodyProjection.sideMaps);
  const collectionIdx = project(b, prov.collection);
  b.wires.push(passthroughWire(collectionIdx, { node: idx, slot: "source" }, span));
  return idx;
}

function projectOpaque(b: Builder, prov: OpaqueProv): number {
  return pushNode(b, { kind: "opaque", op: prov.reason, span: String(prov.site) }, "opaque");
}

/** Exhaustive by tsc (no default arm) — adding an 11th `StaticProv` kind
 *  breaks this file at compile time, the same totality discipline
 *  `circuitToSexpr` and `extract` itself hold (I1). Called only from
 *  `project`, below, on a `b.seen` miss within THIS builder's scope. */
function projectFresh(b: Builder, prov: StaticProv): number {
  switch (prov.kind) {
    case "input":
      return projectInput(b, prov);
    case "mint":
      return projectMint(b, prov);
    case "const":
      return projectConst(b, prov);
    case "fused":
      return projectFused(b, prov);
    case "mux":
      return projectMux(b, prov);
    case "build":
      return projectBuild(b, prov);
    case "string":
      return projectString(b, prov);
    case "choice":
      return projectChoice(b, prov);
    case "fan":
      return projectFan(b, prov);
    case "opaque":
      return projectOpaque(b, prov);
  }
}

/** `StaticProv` → node index within `b`, returning the SAME index for a
 *  `prov` object identity already projected earlier within THIS builder —
 *  the shared-DAG dedup (G2, 2026-07-16; the extract-side memo,
 *  `ExtractCtx.memo` in src/extract/index.ts, is what makes two Refs to one
 *  binding return the identical `StaticProv` object in the first place). The
 *  CALLER still pushes its own `Wire` unconditionally (see `wireChildren`,
 *  `projectMux`, `projectFan`'s collection wiring), so a shared node ends up
 *  fed by multiple wires into the SAME node index — `WireframeGraph`/`Wire`
 *  impose no one-producer-per-node constraint, so this needs no schema
 *  change, and ELK (`WireframeElk.tsx`) lays out a multi-parent node exactly
 *  as it lays out any other.
 *
 *  SCOPE (documented, not a bug — mirrors this file's other "THE GAP"
 *  callouts): dedup is per-`Builder`, i.e. per graph LEVEL. A `fan` node's
 *  body projects through a RECURSIVE `toWireframe(prov.body)` call
 *  (`projectFan`, below), which allocates a BRAND NEW `Builder` — the "private
 *  interior" discipline this file's header already documents for
 *  `WireframeSideMaps.fanTemplates` (each template has its own index space
 *  from 0). A `StaticProv` object shared BETWEEN the outer graph and a fan's
 *  template (or between two different fans' templates) therefore still
 *  projects once per level — `WireframeGraph`'s wires reference node indices
 *  local to one `nodes` array, so a cross-level reference has nowhere to
 *  point without a bigger structural change to that type (out of scope
 *  here). Dedup WITHIN one level — the top graph, or one fan's own template —
 *  is unconditional and exact. */
function project(b: Builder, prov: StaticProv): number {
  const existing = b.seen.get(prov);
  if (existing !== undefined) return existing;
  const idx = projectFresh(b, prov);
  b.seen.set(prov, idx);
  return idx;
}

/** `StaticProv` → `WireframeGraph`, the render-compat projection. Pure and
 *  total (see `project`'s exhaustive switch). The value's own attribution
 *  circuit becomes every node but one; the last is the graph's own `port`
 *  egress (`WireframeGraph.egress`), wired from the circuit's root — a
 *  `StaticProv` IS a value's attribution, so unlike a whole-program
 *  `WireframeGraph` it always HAS an egress. */
export function toWireframe(prov: StaticProv): WireframeProjection {
  const b = newBuilder();
  const rootIdx = project(b, prov);
  const span = String(prov.site);
  const portIdx = b.nodes.length;
  b.nodes.push({ kind: "port", direction: "out", span });
  b.wires.push(passthroughWire(rootIdx, { node: portIdx, slot: "out" }, span));
  return {
    graph: { nodes: b.nodes, wires: b.wires, egress: portIdx },
    sideMaps: {
      provKind: b.provKind,
      integrity: b.integrity,
      collapse: b.collapse,
      buildShape: b.buildShape,
      fabrication: b.fabrication,
      fanTemplates: b.fanTemplates,
      choiceWireRole: b.choiceWireRole,
    },
  };
}

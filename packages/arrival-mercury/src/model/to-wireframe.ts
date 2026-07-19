/**
 * toWireframe — StaticProv → WireframeGraph, the render-compat projection:
 * one static object, two projections (bifunctor discipline). `extract`
 * produces StaticProv; this proves it renders
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
 * ── THE GAP ──────────────────────────────────────────────────────────────
 *
 * `WireframeNode` has no `const` arm — the money table above names it as
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
 * ── `fabrication` is CONTENT-CHANNEL scoped, never bare `const`-kind scoped ──
 *
 * `fabrication` is a SUBSET of `{idx : provKind.get(idx) === "const"}`, never
 * the whole set: a `const` disqualifies grounding only where it sits in
 * verdict/circuit-verdict.ts's CONTENT channel (`dataShaped`'s own check,
 * "no content position anywhere carries a `const`") — the render must not
 * claim MORE fabrication than the seal (verdict/circuit-verdict.ts + seal.ts)
 * would ever refuse on. Two positions are SELECTION, not content, and a
 * `const` living ONLY there is the author's own honest argument, never
 * laundering:
 *
 *   - a `mint`'s OWN `closed` inputs (`projectMint`'s "closed" wires) —
 *     static-prov.ts's `MintProv` doc: "closed is the attribution of the
 *     crossing's own inputs... a mint is a fresh source, its inputs ground
 *     the SELECTION story, never the content." `infer`'s own model-name/
 *     slot-key literals are the canonical example: structurally required by
 *     the call, not a forgery signal.
 *   - a `choice`'s OWN `guards` (`projectChoice`'s "selector" wires) —
 *     circuit-verdict.ts's `guardGroundsInEvidence` doc: "a guard MAY carry
 *     `const`s (a comparison threshold is the author's judgment, not a
 *     fabrication — the `1000` in `(< (:v e) 1000)`)"; `channelsFresh`'s
 *     `choice` arm folds guards into SELECTION only, never content.
 *
 * Everything else a `const` can be wired into — a `fused`/`build`/`string`
 * argument, a `choice`'s `alt`, a `fan`'s `body`/`collection` — is a
 * content-preserving edge in `channelsFresh`'s fold (verdict/circuit-verdict.ts's
 * header, "the absorptive lattice"): the CONTENT channel is transparent
 * through exactly those positions, so a `const` reached only through them
 * really does disqualify `dataShaped`, and `fabrication` keeps flagging it.
 * `circuit-mermaid.ts`'s `contentHasConst` (the `"infer"` view's own
 * fabrication check) already draws this SAME line — this file's `fabrication`
 * now agrees with it instead of over-flagging the closed/guard cases
 * `contentHasConst` was always careful to skip.
 *
 * SCOPE: the CHANNEL cut (closed-arg/guard), not where-provenance: a `mux`'s
 * `source` INHERITS the channel (both here and in `contentHasConst`),
 * so a `const` in a `mux`-narrowed-AWAY sibling — a decoy `:o "FAKE"` in
 * `(:v (dict :v <evidence> :o "FAKE"))`, never read at runtime — is still
 * flagged here even though the seal's `channels()` applies `narrowMux`
 * (verdict/circuit-verdict.ts) and EXCLUDES it from content (`content.consts
 * = 0`, `dataShaped = true`). That residual over-flag is a SEPARATE, finer
 * case (where-provenance): it is shared identically by both renders (this
 * file + `contentHasConst`) and by the studio's `contentPathFabrication`
 * helper, so closing it means teaching the whole render family to consume
 * the EXPORTED `narrowMux` partition (which changes per-part channel
 * assignment inside a `build`, not just a marking) — out of scope for this
 * channel cut. Until then `fabrication ⊆ seal` holds for the closed-arg/guard
 * distinction but NOT for the where-provenance sub-case; a consumer wanting
 * the exact seal verdict on a mux-projected leaf must still gate on
 * `channels(prov).content`, not this set alone.
 *
 * MECHANISM — a SEPARATE content-reachability pass, not a channel threaded
 * through the graph walk. `fabrication` is computed by `collectContentConsts`
 * (below), a walk that follows ONLY content edges (skips a `mint`'s `closed`
 * and a `choice`'s `guards` — both selection; skips a `fan`'s `body` — a
 * separate graph LEVEL whose consts its own nested `toWireframe` collects)
 * and gathers the `ConstProv` objects it reaches, which `toWireframe` then
 * maps to node indices through `Builder.seen`. The graph walk itself
 * (`project`/`projectFresh`) is UNCHANGED — it still projects every reachable
 * node with G2 dedup, so node/wire structure is identical; only which consts
 * land in `fabrication` narrows.
 *
 * WHY a separate pass and not a channel on the graph walk: the graph walk
 * dedups shared subtrees (G2), and a shared COMPOSITE first reached through a
 * selection edge would cache under selection and its later content re-visit
 * would hit the cache WITHOUT re-descending — silently UNDER-flagging a
 * content-reachable const inside it (`(let ((f (list "TAG" x))) (if (member y
 * f) f default))` — `f` is one shared object used in the guard AND returned
 * as content; the guard visit caches it, the content visit can't re-open it).
 * Under-flag is the DANGEROUS direction (a fabrication shown as grounded), so
 * the fabrication pass must NOT share the graph walk's dedup. A content-only
 * walk with its OWN object-dedup is sound precisely because EVERY edge it
 * follows is content: any node it reaches is content-reachable regardless of
 * how many selection references also point at it, so deduping cannot hide a
 * content path. This is the exact walk `circuit-mermaid.ts`'s `contentHasConst`
 * already runs (boolean instead of a node set) — one content-edge definition,
 * two consumers.
 *
 * render ⊆ seal is asserted by test, not a runtime check here (this projection
 * holds no seal-plane import and should not grow one to self-verify):
 * `to-wireframe.test.ts` cross-checks representative closed-arg/guard/
 * content-path circuits against `channels`/`dataShaped` (verdict/circuit-verdict.ts)
 * directly.
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
 * map/filter/fold tag (the fan zoo vanishes into unwind/wind). There is
 * no honest derivation of `lengthPreserving` from `collapse` alone.
 * `lengthPreserving: collapse === "lowered"` is used as a conservative
 * proxy (never overclaims for the two collapse-kinds that are provably
 * NOT length-preserving — `combine` aggregates to one value, `route`
 * narrows to a subset); `sideMaps.collapse` carries the real, load-bearing
 * signal. Report this as a second gap: a true `lengthPreserving` bit needs a
 * field `extract` does not populate on `FanProv` today.
 *
 * ── shared-DAG dedup, scoped per graph level (G2) ───────────────────────────
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
 * ── choiceWireRole: cross-projection parity for a choice's alternatives ────
 *
 * A `choice`'s own wires are the one place a `WireframeNode`'s incoming wires
 * are NOT uniformly one channel: `guards` → SELECTION, `alts` → CONTENT
 * (static-prov.ts's `ChoiceProv` doc — "guards attribute the SELECTION...
 * alts attribute the CONTENT"). Every other kind's wires are unambiguous from
 * `provKind` alone (a `mint`'s `closed*` wires are always selection; a
 * `fused`/`build`/`string`/`mux`/`fan`'s argument wires are always content),
 * so only `choice` needs a per-wire map. The `selector*`/`arm*` slot-name
 * CONVENTION on `WireSlot` (arrival's `wireframe/types.ts`) carries the same
 * fact implicitly — a string prefix a consumer would otherwise have to parse.
 * `choiceWireRole` makes it a first-class, typed lookup instead, keyed by the
 * exact same `(node, slot)` pair a `Wire.consumer` already carries (`wireKey`,
 * below) — no new identity invented.
 *
 * This is the WIREFRAME leg of a three-projection parity requirement:
 * `circuit-sexpr.ts` renders a `choice`'s kept, non-taken alternatives
 * distinctly (the `(gray …)` wrap), and `circuit-mermaid.ts` dashes a
 * `choice`'s alt edges too (its own header explains why that is a deliberate
 * borrow, not a `channels()` reclassification); `choiceWireRole` is this
 * file's side of the same requirement — a reviewer (or a test) can now ask
 * "does this projection make the choice's alternative structure visible" and
 * get the SAME answer from all three.
 */
import type { Wire, WireConsumer, WireframeGraph, WireframeNode } from "@inhuman.tools/arrival/provenance";

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
   *  honest existing kind (`opaque`) AND that const sits on the CONTENT
   *  channel — never merely because `provKind` says `"const"` (see this
   *  file's header, "`fabrication` is CONTENT-CHANNEL scoped"). A `const`
   *  reachable ONLY through a `mint`'s `closed` inputs or a `choice`'s
   *  `guards` (the SELECTION channel — an honest closed argument or
   *  comparison threshold) is deliberately EXCLUDED: the seal
   *  (verdict/circuit-verdict.ts's `dataShaped`) never disqualifies on it
   *  either. This CHANNEL cut is the guarantee — `fabrication ⊆` the
   *  seal's content-channel consts for the closed-arg/guard distinction. It
   *  is NOT the seal's FULL verdict: a `mux`-narrowed-away decoy sibling is
   *  still flagged here though `narrowMux` grounds it (see the header's
   *  "SCOPE" note); a consumer needing the exact seal verdict on
   *  a mux-projected leaf gates on `channels(prov).content`, not this set. A
   *  renderer/seal consumer MUST consult this before treating an `opaque`
   *  node as "merely unresolvable" — a flagged `const` is a program-text
   *  const on the content path, strictly worse than a gap. Never derive this
   *  from `kind`/`op` alone; that is exactly the laundering this map exists
   *  to prevent. */
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
  /** `StaticProv` object identity → its node index in THIS SAME level's `nodes` array — the
   *  bridge from a cone (a `fieldProv` answer, object-identity-valued) to render highlighting
   *  (node indexes). Literally `Builder.seen`,
   *  exposed instead of discarded — `project` (below) already builds this exact map for its own
   *  shared-DAG dedup; this field just hands the caller the same lookup. Optional/additive, same
   *  pattern as `choiceWireRole`: absent on a `WireframeSideMaps` built before this field existed
   *  (or hand-constructed by an older test/fixture), so every existing object literal still
   *  type-checks unchanged; a reader should treat a missing map as "no highlight lookup
   *  available," never throw on its absence. SCOPED PER GRAPH LEVEL, same as `fabrication`/
   *  `choiceWireRole`/`seen` itself — a fan's nested `template` graph has its OWN `nodeIndex`
   *  inside its own `fanTemplates` entry, not this one (see `project`'s doc for why dedup, and
   *  therefore this map, cannot cross a fan boundary). */
  readonly nodeIndex?: ReadonlyMap<StaticProv, number>;
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
  /** Shared-DAG dedup (G2), scoped to THIS builder/graph level —
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

/** Fabrication marking is NOT decided here — a `const`'s node is created
 *  unconditionally, and `toWireframe`'s content-reachability post-pass
 *  (`collectContentConsts`) decides whether it lands in `fabrication`. See
 *  this file's header, "MECHANISM," for why that must be a separate pass, not
 *  a per-node decision at projection time. */
function projectConst(b: Builder, prov: ConstProv): number {
  return pushNode(b, { kind: "opaque", op: "const", span: String(prov.site) }, "const");
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

/**
 * Collect every `const` reachable from `prov` following ONLY content edges —
 * the seal's CONTENT channel (verdict/circuit-verdict.ts's `channels()`):
 *   - a `mint`'s `closed` inputs are SELECTION → NOT followed (the mint's own
 *     identity is the sole content anchor; static-prov.ts's `MintProv` doc);
 *   - a `choice`'s `guards` are SELECTION → NOT followed, only `alts`
 *     (circuit-verdict.ts's `channels()` `choice` arm — a comparison
 *     threshold is the author's judgment, `guardGroundsInEvidence`'s doc);
 *   - a `fan`'s `body` is a separate graph LEVEL → NOT followed (its own
 *     nested `toWireframe` collects the body's consts into that template's
 *     `fabrication`); only `collection` is at this level;
 *   - a `mux`'s WHOLE `source` is followed (the documented where-provenance
 *     coarseness — the seal's `narrowMux` would narrow to the read part; see
 *     this file's header "SCOPE" note — shared with
 *     circuit-mermaid.ts's `contentHasConst`).
 *
 * Object-dedup via `visited` terminates on the shared DAG and is SOUND here
 * precisely because every edge followed is content: a node reached is
 * content-reachable no matter how many SELECTION references also point at it,
 * so deduping can never hide a content path (contrast the graph walk's dedup,
 * which — mixing both channels — could; see this file's header, "WHY a
 * separate pass"). Exhaustive by tsc, same totality discipline as
 * `projectFresh`. */
function collectContentConsts(prov: StaticProv, into: Set<StaticProv>, visited: Set<StaticProv>): void {
  if (visited.has(prov)) return;
  visited.add(prov);
  switch (prov.kind) {
    case "const":
      into.add(prov);
      return;
    case "input":
    case "opaque":
    case "mint": // closed = selection, never followed
      return;
    case "fused":
      prov.sources.forEach((s) => collectContentConsts(s, into, visited));
      return;
    case "mux":
      collectContentConsts(prov.source, into, visited);
      return;
    case "build":
      prov.parts.forEach((p) => collectContentConsts(p.prov, into, visited));
      return;
    case "string":
      prov.runs.forEach((r) => collectContentConsts(r, into, visited));
      return;
    case "choice":
      prov.alts.forEach((a) => collectContentConsts(a, into, visited)); // guards = selection
      return;
    case "fan":
      collectContentConsts(prov.collection, into, visited); // body = separate level
      return;
  }
}

/** `StaticProv` → node index within `b`, returning the SAME index for a
 *  `prov` object identity already projected earlier within THIS builder —
 *  the shared-DAG dedup (G2; the extract-side memo,
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
 *  is unconditional and exact.
 *
 *  This walk is CHANNEL-BLIND — it projects every reachable node for graph
 *  structure and does NOT decide `fabrication` (that is
 *  `collectContentConsts`'s content-only post-pass; see this file's header,
 *  "WHY a separate pass," for why the fabrication decision must not ride this
 *  dedup). */
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
  // FABRICATION: a content-only pass, NOT the channel-blind
  // graph walk above — only consts the seal's CONTENT channel would see are
  // flagged (see this file's header, "MECHANISM"). Every collected const is a
  // node at THIS level (the walk never crosses a fan-body boundary), so
  // `b.seen` always resolves it; the `!== undefined` guard is defensive.
  const contentConsts = new Set<StaticProv>();
  collectContentConsts(prov, contentConsts, new Set());
  for (const c of contentConsts) {
    const idx = b.seen.get(c);
    if (idx !== undefined) b.fabrication.add(idx);
  }
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
      nodeIndex: b.seen,
    },
  };
}

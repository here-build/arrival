/**
 * Q8b (docs/PROVENANCE-PLAN.md wave 6; docs/PROVENANCE.md §5 D3) — THE WIREFRAME
 * HASHER. Two named hashes over the prospective layer (§5 CHOSEN, round 2 D3):
 *
 *   - `templateHash` (spans STRIPPED — dedup and store identity; "the same expression
 *     at two program sites shares storage"): a content hash over a `WireframeGraph`'s
 *     CANONICAL form. In scope: every node's structural descriptor (kind, op, arity/
 *     arms, fan shape incl. its private `template` interior recursively, binder cycles,
 *     template-ref name, port direction) and every wire's emitted TEXT (`source`,
 *     `params`, `paramRefs`' kind+name+referenced-node-INDEX, `consumer`'s node-index+
 *     slot, its Q8c `fact` tag when present) plus the graph's `egress` index. OUT of
 *     scope: every node's/wire's `span` (scopeId) — the one field §5 D3 names as
 *     excluded ("NOT scopeIds/spans, those are position").
 *
 *   - Q8c TOUCH (flagged prominently per that wave's task instructions: this file is
 *     Q8b's, no sibling owns it this wave): `canonicalWire` below folds in `wire.fact`.
 *     The tag is CONTENT, not decoration — A5's struct-fact tag changes what a wire
 *     PROVES about its param (a count-demand may route through it; an untagged twin
 *     may not), and it is not always reconstructable from `source` text alone (two
 *     builder CONFIGURATIONS — different `materialNames`/`isBaseName` — could in
 *     principle serialize the same literal text with different tags; `builder.ts`'s
 *     `factTagOf` guards make this unlikely in practice, but the hash should not rely
 *     on that). Two wires identical in source/params/refs/consumer but differently
 *     tagged must not collide.
 *   - `siteHash` (spans KEPT — plane identity; "the two sites render as two wires"):
 *     `templateHash` combined with the INSTANTIATION site's own span — the call site
 *     of a `template-ref`, the fan node's own site for its private template, or (for a
 *     program's `main` graph, which has exactly one static instantiation) the whole-
 *     program root. Two textually-identical map bodies at two different `(map …)`
 *     call sites share ONE `templateHash` (one stored template) but mint two distinct
 *     `siteHash`es (two plane positions) — exactly D3's two-named-hashes rationale.
 *
 * GRANULARITY RULING (this file's own design decision, since §5 does not go this deep):
 * `templateHash` is per-GRAPH, not per-node — it addresses an entire `WireframeGraph`
 * (`WireframeProgram.main`, a `DefineTemplate.graph`, or a fan node's private
 * `template`), matching the task's literal phrasing ("content hash over a TEMPLATE
 * GRAPH's canonical form") and §5 C4's "wire TEMPLATES... keyed by template-hash" (the
 * template-store's storage unit — `TemplateStore`, `store/interfaces.ts`/`fakes.ts`).
 * RecordId uniqueness across MULTIPLE designated nodes sharing one graph (and, worse, across structurally-
 * identical nodes at unrelated program sites, since `templateHash` is content-not-
 * position-addressed) is NOT this hash's job — see `rootOrdinalPath` below and
 * `store/ids.ts`'s `OrdinalPath` doc: the root-binder ordinal is the mechanism that
 * keeps `RecordId` collision-free, deliberately kept separate from `templateHash` so
 * dedup stays maximal (position never leaks back into the content address).
 *
 * THE α-QUESTION (task-mandated ruling — spec §5 does not state one, so this file
 * DECIDES and DOCUMENTS, conservatively): `templateHash` is **NOT α-invariant**. Two
 * programs that are structurally identical up to bound-variable SPELLING (`(lambda (x)
 * (+ x 1))` vs `(lambda (y) (+ y 1))`) hash DIFFERENTLY, because a wire's canonical
 * form includes its literal `source` text and `params` names verbatim — both carry the
 * actual spelling. Ruling made conservative-position-inclusive-of-naming on purpose:
 * true α-canonicalization (De Bruijn-indexing every bound name before hashing) is
 * extra machinery this task does not need, and getting it wrong risks UNIFYING two
 * wires whose free-variable REFERENCES differ in ways that matter (a captured prelude/
 * base name is part of a wire's real semantics, not just a bound-variable label) —
 * the safer default is to hash MORE distinctions than strictly necessary, never fewer.
 * A later step MAY relax this (with its own law row) if template-store dedup pressure
 * demands it; this file's LIMIT is documented here so no future edit "fixes" it by
 * accident without weighing the tradeoff. `wireframe-hash.test.ts` pins BOTH directions: same
 * source parsed twice → identical hash; α-renamed-but-structurally-identical source →
 * DIFFERENT hash.
 */
import type { OrdinalPath, SiteHash, TemplateHash } from "../store/ids.js";
import type { Wire, WireframeGraph, WireframeNode, WireParam } from "./types.js";

/** FNV-1a over a prefixed canonical string — same shape as
 *  `eval/CompiledResolutionChain.ts`'s `hashSteps` (crc-v0 precedent: prefix tag +
 *  `|`-joined canonical parts, FNV-1a, zero-padded hex) — NOT imported from there
 *  (a different domain: that hash addresses a sealed env chain, this one a wireframe
 *  graph), but deliberately following its style so the codebase has ONE content-hash
 *  idiom rather than two incompatible ones. */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** One `WireParam`'s canonical form — `slot` params carry their (ingress) name only;
 *  `node` params carry the name they're bound to AND the referenced node's INDEX
 *  (structural, span-free — stable across re-parses since it's the node's position in
 *  `graph.nodes`, itself deterministic build order, §5 D1/root-binder-order). */
function canonicalParamRef(ref: WireParam): string {
  return ref.kind === "slot" ? `slot:${ref.name}` : `node:${ref.name}:${ref.node}`;
}

/** One `Wire`'s canonical form: its emitted TEXT (`source`, already span-free — a
 *  lambda-lifted body has no `__location__` of its own baked into the string), its
 *  formal `params`, its `paramRefs`, and its `consumer` (which node/slot it feeds —
 *  structural, not positional-in-source). `wire.span` is the ONE excluded field. */
function canonicalWire(wire: Wire): string {
  const refs = wire.paramRefs.map(canonicalParamRef).join(",");
  return [
    `src:${wire.source}`,
    `params:${wire.params.join(",")}`,
    `refs:${refs}`,
    `into:${wire.consumer.node}:${wire.consumer.slot}`,
    // Q8c: the struct-fact tag is CONTENT (see this file's header) — folded in so a
    // tagged wire never collides with an untagged twin that happens to share text.
    `fact:${wire.fact ? wire.fact.verb : ""}`,
  ].join("/");
}

/** One `WireframeNode`'s canonical form — every field EXCEPT `span`. A fan's private
 *  `template` interior (and a binder's `interior`) recurses through `hashGraph` (not
 *  re-serialized structurally here) so two fans/loops whose bodies are byte-identical
 *  dedupe to the same sub-hash regardless of where each call/loop sits. */
function canonicalNode(node: WireframeNode): string {
  switch (node.kind) {
    case "source":
    case "sink":
    case "transparent":
    case "opaque":
      return `${node.kind}:${node.op}`;
    case "mux":
      return `mux:${node.op}:${node.arms}`;
    case "fan":
      return [
        "fan",
        node.op,
        `len:${node.lengthPreserving}`,
        `elParams:${node.elementParams ? node.elementParams.join(",") : ""}`,
        `fnOp:${node.fnOp ?? ""}`,
        `roles:${node.callbackRoles ? JSON.stringify(node.callbackRoles) : ""}`,
        `template:${node.template ? hashGraph(node.template) : ""}`,
      ].join("/");
    case "binder":
      // Q8a′'s landed shape (params/interior — the loop's own private wireframe,
      // I5's fan-template pattern): recurse into `interior` exactly like a fan's
      // `template`, so two structurally-identical loop bodies dedupe the same way.
      return [
        "binder",
        node.op,
        `cycles:${node.cycles}`,
        `params:${node.params.join(",")}`,
        `interior:${hashGraph(node.interior)}`,
      ].join("/");
    case "recur":
      // The backedge marker — no payload of its own beyond its kind; its ingress
      // wires (arg0..argN) are canonicalized like any other node's incoming wires.
      return "recur";
    case "template-ref":
      return `template-ref:${node.name}`;
    case "port":
      return `port:${node.direction}`;
  }
}

/**
 * `templateHash` — content hash over a `WireframeGraph`'s canonical form (§5 D3;
 * see this file's header for the granularity ruling). Stable across re-parses of
 * identical source (the builder's walk is deterministic, so `graph.nodes`/`graph.wires`
 * land in the same order every time — verified by `wireframe-hash.test.ts`'s "same program
 * twice" row); sensitive to bound-variable spelling (the documented α-ruling above).
 */
export function hashGraph(graph: WireframeGraph): TemplateHash {
  const nodesCanon = graph.nodes.map(canonicalNode).join("|");
  const wiresCanon = graph.wires.map(canonicalWire).join("|");
  const canonical = `nodes:${nodesCanon}##wires:${wiresCanon}##egress:${graph.egress ?? "none"}`;
  return fnv1a("template-v0", canonical);
}

/**
 * `siteHash` — §5 D3's OTHER named hash: `templateHash` combined with the
 * instantiation SITE's span (spans KEPT — plane identity). Two sites sharing one
 * `templateHash` (dedup) mint two DIFFERENT `siteHash`es here, one per span — "the
 * two sites render as two wires." `site` is whatever `scopeId`-shaped string
 * identifies the instantiation point: a `template-ref` node's own `span`, a fan node's
 * own `span` (for its private template), or a stable sentinel for `main` (which has
 * exactly one static instantiation — the program root itself).
 */
export function siteHash(templateHash: TemplateHash, site: string): SiteHash {
  return fnv1a("site-v0", `${templateHash}::${site}`);
}

/** The stable sentinel `siteHash` uses for `WireframeProgram.main` — the program has
 *  exactly one static instantiation of its own root graph, so it needs no real span. */
export const MAIN_PROGRAM_SITE = "@main";

/**
 * Root-binder program order (docs/PROVENANCE.md §1 D6: "top-level program order
 * (begin/define sequencing) is owned by the root binder chain — prospective-only").
 *
 * REALIZATION: a `WireframeGraph`'s `nodes` array IS already the root-binder order —
 * `wireframe/builder.ts`'s `GraphBuilder` designates nodes via a deterministic,
 * left-to-right walk of the graph's top-level forms (main program forms in sequence,
 * or one define's body forms), pushing each designated node onto `this.nodes` the
 * moment it's cut. So a node's position in that array already IS "this node's
 * deterministic total-order position among the graph's designated sites" — no
 * separate ordinal-minting pass is needed; this function just NAMES that array index
 * as the root ordinal and wraps it as a length-1 `OrdinalPath` (§5 C2/D1's first
 * path entry, per `store/ids.ts`'s `OrdinalPath` doc).
 *
 * This is what keeps `RecordId` collision-free for nodes with NO enclosing fan/loop:
 * `templateHash` is content-addressed (§5 D3, spans stripped) and so may coincide for
 * two structurally-identical designated nodes at unrelated program sites (two separate
 * `(fetch-item 1)` calls, say) — their DIFFERENT root ordinals (their DIFFERENT
 * positions in `graph.nodes`) still keep `(templateHash, ordinalPath, regionEpoch)`
 * distinct. Nested fan/loop instances append further (runtime) ordinals on top via
 * `store/ids.ts`'s `appendOrdinal` — this function only ever produces the ROOT entry.
 */
export function rootOrdinalPath(nodeIndex: number): OrdinalPath {
  return [nodeIndex];
}

/** The instantiation-site span for a designated node, as `siteHash` needs it: the
 *  node's own `span` field — every `WireframeNode` kind carries one (see `types.ts`).
 *  `node.span` is already the `scopeId(surface form)` string the builder stamped at
 *  cut time; this is a tiny named helper so callers don't reach into node internals
 *  ad hoc when wiring a future `registerSite` call. */
export function siteOf(node: WireframeNode): string {
  return node.span;
}

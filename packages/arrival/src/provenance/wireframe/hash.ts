/**
 * Wireframe hashes — two named digests:
 *
 *   - `templateHash` / `hashGraph` — spans STRIPPED. Content over a whole graph
 *     (nodes structural, wires' source/params/paramRefs/consumer/`fact`, egress).
 *     Per-GRAPH (main, define template, fan interior), not per-node. `wire.fact`
 *     is content: differently tagged twins must not collide.
 *   - `siteHash` — templateHash + instantiation span (plane identity). Same
 *     template at two map sites → one templateHash, two siteHashes.
 *
 * RecordId uniqueness is NOT this hash's job — `rootOrdinalPath` / OrdinalPath
 * keep multi-site content collisions free without leaking position into content.
 *
 * Capture lists are content but hashed ONLY when non-empty (fan/binder), so every pre-closure
 * hash stays byte-stable. A closure's interior content hash is `hashGraph(closure.template)`
 * (spans stripped: two identical lambdas share it); its plane identity is
 * `siteHash(hashGraph(enclosing), closure.span)`.
 *
 * α-RULING: NOT α-invariant. Bound-variable spelling is in source/params; hashing
 * more distinctions is safer than De Bruijn (wrong α could unify free-name semantics).
 * Same source twice → same hash; α-renamed → different (pinned by tests).
 */
import { contentHash } from "../store/hash.js";
import type { OrdinalPath, SiteHash, TemplateHash } from "../store/ids.js";
import type { Wire, WireframeGraph, WireframeNode, WireParam } from "./types.js";

/** Domain-separated content hash (SHA-256/128 — `store/hash.ts`). */
function tagged(domain: string, canonical: string): string {
  return contentHash(domain, canonical);
}

function canonicalParamRef(ref: WireParam): string {
  if (ref.kind === "slot") return `slot:${ref.name}`;
  return ref.slot === undefined ? `node:${ref.name}:${ref.node}` : `node:${ref.name}:${ref.node}:${ref.slot}`;
}

/** Span excluded; fact tag included (content). */
function canonicalWire(wire: Wire): string {
  const refs = wire.paramRefs.map(canonicalParamRef).join(",");
  return [
    `src:${wire.source}`,
    `params:${wire.params.join(",")}`,
    `refs:${refs}`,
    `into:${wire.consumer.node}:${wire.consumer.slot}`,
    `fact:${wire.fact ? wire.fact.verb : ""}`,
  ].join("/");
}

/** Every field except span; fan/binder interiors recurse via hashGraph. */
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
        ...(node.captures.length > 0 ? [`captures:${node.captures.join(",")}`] : []),
      ].join("/");
    case "binder":
      return [
        "binder",
        node.op,
        `cycles:${node.cycles}`,
        `params:${node.params.join(",")}`,
        `interior:${hashGraph(node.interior)}`,
        ...(node.captures.length > 0 ? [`captures:${node.captures.join(",")}`] : []),
      ].join("/");
    case "closure":
      return [
        "closure",
        `params:${node.params.join(",")}`,
        `rest:${node.rest ?? ""}`,
        `ref:${node.ref ? `${node.ref.kind}:${node.ref.kind === "define" ? node.ref.name : node.ref.op}` : ""}`,
        `captures:${node.captures.join(",")}`,
        `template:${node.template ? hashGraph(node.template) : ""}`,
      ].join("/");
    case "guard":
      return `guard:${node.op}:${node.var}:${node.clauses}:${node.hasFinally}`;
    case "recur":
      return "recur";
    case "template-ref":
      return `template-ref:${node.name}`;
    case "port":
      return `port:${node.direction}`;
  }
}

export function hashGraph(graph: WireframeGraph): TemplateHash {
  const nodesCanon = graph.nodes.map(canonicalNode).join("|");
  const wiresCanon = graph.wires.map(canonicalWire).join("|");
  const canonical = `nodes:${nodesCanon}##wires:${wiresCanon}##egress:${graph.egress ?? "none"}`;
  return tagged("template-v1", canonical);
}

export function siteHash(templateHash: TemplateHash, site: string): SiteHash {
  return tagged("site-v1", `${templateHash}::${site}`);
}

/** Sentinel site for program.main (single static instantiation). */
export const MAIN_PROGRAM_SITE = "@main";

/**
 * Root ordinal = index in graph.nodes (deterministic builder order).
 * Separates content-addressed templateHash collisions across sites.
 */
export function rootOrdinalPath(nodeIndex: number): OrdinalPath {
  return [nodeIndex];
}

export function siteOf(node: WireframeNode): string {
  return node.span;
}

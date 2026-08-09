/**
 * WireframeElk — `WireframeProjection` (`toWireframe`'s output) → an ELK
 * layout → SVG, the fourth pure projection's gallery next to `CircuitMermaid`.
 *
 * arrival-mercury CANNOT import inhuman-studio (studio depends on
 * arrival-mercury for `toWireframe` — the reverse import is a cycle), so this
 * is a SELF-CONTAINED port of the essential shape of
 * `inhuman/saas/studio/src/workbench/trace/wireframe-elk-layout.ts`, not the
 * whole adapter:
 *   - one ELK node per `WireframeNode` (fixed 130×44 footprint — this gallery
 *     has no measured DOM content size, same honest fallback the studio
 *     adapter documents for its own `DEFAULT_NODE_W/H`);
 *   - one ELK edge per `Wire` that has at least one NODE-kind `paramRef` (a
 *     producer this graph can point an arrow at) — a wire fed only by
 *     `slot`-kind refs (program ingress) has no in-graph producer, so it is
 *     honestly skipped, same rule the studio adapter's `buildWireframeElkGraph`
 *     documents;
 *   - NO per-slot ports — this gallery only needs "A feeds B", not which
 *     named input slot; edges reference node ids directly (ELK attaches an
 *     id-referenced edge to the node's bounding-box perimeter with no port
 *     declared).
 *
 * ── fan DESCENDS — this adapter is the one place I5 exterior-collapse is
 * deliberately NOT held ──────────────────────────────────────────────────────
 *
 * The studio adapter (and this file, before this change) render a `fan` as
 * one opaque leaf — "from the enclosing graph this is ONE node." That's the
 * right discipline for a trace-driven workbench pane (the interior is
 * demand-replayed against records that may not exist yet). This gallery has
 * no such constraint: `toWireframe` already computed the fan's `template`
 * (a full nested `WireframeGraph`, `to-wireframe.ts`'s `projectFan`) and a
 * matching nested `WireframeSideMaps` (`sideMaps.fanTemplates.get(index)`)
 * eagerly, for every fan, at projection time — the data is sitting right
 * there. Collapsing it here was purely this gallery's own prior choice, not
 * a limit `toWireframe` imposes. So: a `fan` node becomes an ELK COMPOUND
 * node — `children`/`edges` built recursively from `node.template`, laid out
 * as its own nested sub-problem (elkjs sizes the parent box to its interior
 * automatically, standard hierarchical-graph behavior, no special
 * `hierarchyHandling` needed since no edge ever crosses a fan boundary — the
 * `source`/`collection` wire always terminates AT the fan node from outside,
 * never reaches into its interior). A fan inside a fan's template recurses
 * the same way, so GEPA's 4-deep `iterate → generation-map → evaluate-map →
 * ask/reflect` nesting draws as 4 levels of nested boxes, not one hollow
 * leaf. A fan whose `template` is absent or empty (I5's genuine "nothing to
 * descend into" case — a bare-symbol callback, `fnOp` only) still falls back
 * to today's collapsed-leaf rendering; this is additive; it never renders
 * less than before.
 *
 * ── layout engine: elkjs's fake-worker, wired by hand ──────────────────────
 *
 * See the import block below for the full story: elkjs's package MAIN
 * (`import ELK from "elkjs"`) fails under Storybook's static Vite build — its
 * no-real-worker fallback references an optional peer dep (`"web-worker"`)
 * in a way `require`-based Node tolerates but a browser bundle cannot. This
 * component instead drives `elk-api.js` + `elk-worker.min.js`'s bundled fake
 * worker directly, which runs the layout algorithm SYNCHRONOUSLY in the
 * calling thread behind the SAME Promise-returning API, with no Vite
 * worker-asset wiring (the studio's `elk-engine.ts` needs `?url` + a real
 * Worker for its off-main-thread path; this gallery does not). `elk.layout()`
 * is still async (Promise-based) either way, so this component still needs
 * the effect+state dance a real ELK consumer uses — it is not synchronous
 * just because there's no worker thread underneath.
 *
 * ── color is the security signal (the whole point of this gallery) ────────
 *
 * A node's border/fill color is read ONLY from `WireframeSideMaps`, never
 * from the node's own `kind`/`op` — `to-wireframe.ts`'s laundering guard
 * ("is this node REALLY a const must always be answered from `fabrication`,
 * never from the node's own kind/op") applies here with full force; this
 * component is the one place that guard's payoff becomes visible to a human:
 *   - `sideMaps.fabrication.has(idx)`     → RED    (a PROVEN fabrication mark)
 *   - `sideMaps.integrity.get(idx)`
 *       === "evidence"                    → green  (grounded crossing)
 *       === "ambient"                     → amber  (ungrounded crossing)
 *   - otherwise                           → neutral steel
 *
 * ── hideFabricated: the causal / teleological view drops the red entirely ──
 *
 * The `fabrication` tone above is the SECURITY reading. Causality and teleology
 * views instead pass `hideFabricated` (prop below): a `const` node carries no
 * lineage (empty where-provenance), so those views omit it and its out-edges
 * wholesale (`buildLevel`), leaving only the crossings and transforms that
 * actually carry evidence. Same projection, two complementary readings — one
 * paints fabrication red, the other elides it — and both still resolve
 * fabrication from the side map, never a node's own `kind`/`op`.
 *
 * This holds AT EVERY NESTING DEPTH: a node index is only meaningful paired
 * with the `WireframeSideMaps` object it was assigned from — a fan's
 * template graph gets its own private index space starting back at 0
 * (`to-wireframe.ts`'s "the same 'private interior' discipline `binder
 * .interior` already holds"), so index 0 inside a nested fan and index 0 at
 * the top level are unrelated nodes under unrelated side-map objects. The
 * ELK-id → (sideMaps, index) registry built below carries the CORRECT paired
 * side-map object down through every recursion level, so a fabrication or
 * evidence-class node four fans deep still resolves to the right color —
 * never the enclosing graph's side maps by mistake.
 */
import { type ReactElement, useEffect, useState } from "react";
// elkjs's PACKAGE MAIN (`elkjs` / `elkjs/lib/main.js`) is NOT usable under a
// Vite-bundled static build: its no-worker fallback path does
// `try { require.resolve('web-worker') } catch {}` to probe an OPTIONAL peer
// dep, which is fine under real Node `require` (throws MODULE_NOT_FOUND,
// caught) but Vite's CJS→ESM bundling turns that into a module-graph import
// of the literal specifier `"web-worker"` — evaluated at MODULE LOAD time,
// outside any try/catch, before this component's code ever runs. That
// specifier can't resolve (the package isn't installed, correctly — a real
// worker-threads polyfill is not what this gallery wants) and Storybook's
// error boundary reports "Failed to resolve module specifier 'web-worker'"
// for the WHOLE STORY, not a caught, in-component error. Confirmed via
// `build-storybook` + a headless load of `circuit-elk--decoy`.
//
// The fix is to bypass `elkjs/lib/main.js` entirely and drive its two
// dependencies directly: `elk-api.js` (the `ELK` class — same file
// `inhuman/saas/studio/.../elk-engine.ts` imports for its OWN worker-backed
// path) plus `elk-worker.min.js`'s bundled "fake worker" (the exact object
// `main.js` would have handed `elk-api.js` as `workerFactory` in its
// no-real-worker branch) — constructed OURSELVES as the `workerFactory`, so
// `main.js`'s probing code (and its `"web-worker"` reference) is never
// imported, never evaluated, never a module the bundler has to resolve. The
// fake worker still runs the layout algorithm synchronously in-thread behind
// the same Promise-returning `elk.layout()` API — no behavior change.
//
// elkjs is CJS with an ESM-style `.d.ts` for `elk-api.js` (`export default
// ElkConstructor`); under NodeNext both the default import and
// `namespace.default` mistype as the module namespace (no construct
// signatures) — same limit `elk-engine.ts` documents for its own import,
// though at runtime, via the bundler's CJS interop, the value IS the
// constructor. Cast to the ctor shape rather than fight the `.d.ts`.
// `elk-worker.min.js` ships NO `.d.ts` at all (only a same-named
// `elk-worker.d.ts` that just aliases the DOM `Worker` global, unrelated to
// this file) — imported as a namespace and read at runtime (never a static
// named import) since its `exports.Worker` assignment is itself inside a
// runtime `if`/`else` a bundler's static export analysis cannot see through.
import ElkApiDefault from "elkjs/lib/elk-api.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs";
import * as ElkFakeWorkerModule from "elkjs/lib/elk-worker.min.js";

import type { Wire, WireframeGraph, WireframeNode } from "@inhuman.tools/arrival/provenance";
import type { WireframeProjection, WireframeSideMaps } from "../to-wireframe.js";

interface FakeElkWorker {
  postMessage(data: unknown): void;
  onmessage?: (ev: { data: unknown }) => void;
}
type FakeElkWorkerCtor = new () => FakeElkWorker;
const FakeElkWorkerCtor = ((ElkFakeWorkerModule as Record<string, unknown>).Worker ??
  (ElkFakeWorkerModule as Record<string, unknown>).default) as FakeElkWorkerCtor;

type ElkCtor = new (opts: { workerFactory: () => FakeElkWorker }) => { layout(graph: ElkNode): Promise<ElkNode> };
const ElkCtor = ElkApiDefault as unknown as ElkCtor;

const NODE_W = 130;
const NODE_H = 44;

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.spacing.nodeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
};

/** Exhaustive over `WireframeNode`'s kinds (tsc's exhaustiveness check is the
 *  totality proof, same discipline `circuit-mermaid.ts` holds) — a future
 *  node kind fails typecheck here, not silently renders a blank label. */
function nodeLabel(node: WireframeNode): string {
  switch (node.kind) {
    case "source":
    case "sink":
    case "transparent":
    case "mux":
    case "fan":
    case "binder":
    case "opaque":
      return node.op;
    case "recur":
      return "recur";
    case "template-ref":
      return node.name;
    case "port":
      return node.direction;
  }
}

const isNodeRef = (ref: Wire["paramRefs"][number]): ref is Extract<Wire["paramRefs"][number], { kind: "node" }> =>
  ref.kind === "node";

/** Compound-node padding for a `fan`'s box — top is wider than the other
 *  three sides to reserve room for the "⟳ fan · <collapse>" label this
 *  component draws itself (ELK does not know about our manual SVG label
 *  render, so its auto-sizing of the parent box around laid-out children
 *  needs the padding spelled out explicitly, or the label would overlap the
 *  first interior row). */
const FAN_LAYOUT_OPTIONS: Record<string, string> = {
  ...LAYOUT_OPTIONS,
  "elk.padding": "[top=28.0,left=14.0,bottom=14.0,right=14.0]",
};

/** Paired (side-map object, index-within-that-object) for one ELK node id —
 *  see this file's header on why the index alone is not enough once fan
 *  templates nest (each template has its OWN index space from 0). */
interface SideMapRef {
  readonly sideMaps: WireframeSideMaps;
  readonly index: number;
}

interface ElkBuild {
  readonly root: ElkNode;
  /** elk node id (any nesting depth, `n0`, `n3.n1`, `n3.n1.n0`, …) → the
   *  paired side-map object + local index, for `toneOf` lookups at every
   *  depth. */
  readonly registry: ReadonlyMap<string, SideMapRef>;
}

/** Builds one level's `children`/`edges` — called once for the top graph and
 *  once more per descended `fan` template, recursively. `idPrefix` keeps
 *  every id globally unique across the whole nested tree (elkjs resolves
 *  edge `sources`/`targets` by id across the full graph, not per-level). */
function buildLevel(
  graph: WireframeGraph,
  sideMaps: WireframeSideMaps,
  idPrefix: string,
  registry: Map<string, SideMapRef>,
  hideFabricated: boolean,
): { children: ElkNode[]; edges: ElkExtendedEdge[] } {
  // A `const` (fabrication) node is a where-provenance LEAF — empty ancestry,
  // program-text only — so it is never part of an evidence-flow story. When
  // hidden, it is omitted from the layout and every edge touching it is pruned
  // (a `const` only ever PRODUCES into a consumer; the consumer keeps its other
  // inputs). No index remapping is needed: ELK ids are `n${index}` strings, so
  // omitting a node and its edges leaves the rest a valid subgraph under the
  // SAME ids. Read from `sideMaps.fabrication` (the per-level set), never a
  // node's own `kind`/`op` — the same laundering guard `toneOf` holds.
  const hidden = (index: number): boolean => hideFabricated && sideMaps.fabrication.has(index);

  const children: ElkNode[] = graph.nodes.flatMap((node, index): ElkNode[] => {
    if (hidden(index)) return [];
    const id = `${idPrefix}n${index}`;
    registry.set(id, { sideMaps, index });

    if (node.kind === "fan" && node.template && node.template.nodes.length > 0) {
      const templateSideMaps = sideMaps.fanTemplates.get(index);
      if (templateSideMaps) {
        const interior = buildLevel(node.template, templateSideMaps, `${id}.`, registry, hideFabricated);
        const collapse = sideMaps.collapse.get(index);
        return [
          {
            id,
            layoutOptions: FAN_LAYOUT_OPTIONS,
            children: interior.children,
            edges: interior.edges,
            labels: [{ text: `⟳ fan · ${collapse ?? node.op}` }],
          },
        ];
      }
    }
    // Leaf — either not a fan, or a fan with no descendable template
    // (I5's genuine case: a bare-symbol callback, `fnOp` only, nothing to
    // splice in). Same rendering every node kind had before this change.
    return [{ id, width: NODE_W, height: NODE_H, labels: [{ text: `${node.kind}: ${nodeLabel(node)}` }] }];
  });

  const edges: ElkExtendedEdge[] = graph.wires.flatMap((wire) => {
    if (hidden(wire.consumer.node)) return []; // consumer itself hidden — drop the whole edge
    const sources = wire.paramRefs
      .filter(isNodeRef)
      .filter((ref) => !hidden(ref.node)) // a fabricated producer contributes no wire in this view
      .map((ref) => `${idPrefix}n${ref.node}`);
    if (sources.length === 0) return []; // slot-only ingress, or every producer hidden — no arrow to draw
    return [
      {
        id: `${idPrefix}w:${wire.consumer.node}:${wire.consumer.slot}`,
        sources,
        targets: [`${idPrefix}n${wire.consumer.node}`],
      },
    ];
  });

  return { children, edges };
}

export function buildElkGraph(projection: WireframeProjection, hideFabricated: boolean): ElkBuild {
  const registry = new Map<string, SideMapRef>();
  const { children, edges } = buildLevel(projection.graph, projection.sideMaps, "", registry, hideFabricated);
  return { root: { id: "root", layoutOptions: LAYOUT_OPTIONS, children, edges }, registry };
}

type NodeTone = "fabrication" | "evidence" | "ambient" | "neutral";

function toneOf(sideMaps: WireframeProjection["sideMaps"], index: number): NodeTone {
  // Laundering guard: fabrication is read ONLY from the side set, never
  // inferred from the node's own kind/op (see this file's + to-wireframe.ts's
  // header) — checked FIRST since a `const` node's `kind` is `opaque`, which
  // would otherwise read as "neutral" or worse "merely unresolvable".
  if (sideMaps.fabrication.has(index)) return "fabrication";
  const integrity = sideMaps.integrity.get(index);
  if (integrity === "evidence") return "evidence";
  if (integrity === "ambient") return "ambient";
  return "neutral";
}

const TONE_COLOR: Record<NodeTone, { fill: string; stroke: string; text: string }> = {
  fabrication: { fill: "#3a1414", stroke: "#e5484d", text: "#ffb4b4" },
  evidence: { fill: "#12261c", stroke: "#3dd68c", text: "#a8f0cc" },
  ambient: { fill: "#2a2210", stroke: "#e0a92d", text: "#f6d989" },
  neutral: { fill: "#1c2029", stroke: "#4a5468", text: "#c9d1d9" },
};

/** One ELK edge → its laid-out path(s) — shared by the top level and every
 *  nested fan level (an edge only ever connects nodes at its OWN level, so it
 *  is always rendered in the same coordinate frame as its siblings' `<g
 *  transform>`, never needing depth-tracked offsets). */
function renderEdges(edges: readonly ElkExtendedEdge[] | undefined) {
  return (edges ?? []).flatMap((edge) => {
    const sections = edge.sections ?? [];
    return sections.map((section, i) => {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      const d = points.map((p, pi) => `${pi === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
      return (
        <path
          key={`${edge.id}-${i}`}
          d={d}
          fill="none"
          stroke="#4a5468"
          strokeWidth={1.5}
          markerEnd="url(#wireframe-elk-arrow)"
        />
      );
    });
  });
}

/** Renders one laid-out ELK node — recursively, for a `fan` compound node's
 *  `children`. ELK gives every node's `x`/`y` relative to its OWN parent's
 *  origin (standard nested-graph coordinate convention), so a `<g
 *  transform="translate(x,y)">` per node composes the right absolute
 *  position through arbitrary nesting depth with no manual offset
 *  arithmetic — the same reason `renderEdges` needs no depth parameter. */
function renderNode(n: ElkNode, registry: ReadonlyMap<string, SideMapRef>): ReactElement {
  // Map back by ELK node id (not array position) — `elk.layout()` is not
  // contractually obligated to preserve `children` array order, only to fill
  // in x/y/width/height per node; `registry` was built from the SAME ids at
  // graph-construction time, so this lookup is correct regardless of what
  // order the engine returns nodes in, at every nesting depth.
  const ref = registry.get(n.id);
  const tone = ref ? toneOf(ref.sideMaps, ref.index) : "neutral";
  const color = TONE_COLOR[tone];
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const w = n.width ?? NODE_W;
  const h = n.height ?? NODE_H;
  const label = n.labels?.[0]?.text ?? "";
  const children = n.children ?? [];
  const isCompound = children.length > 0;

  return (
    <g key={n.id} transform={`translate(${x},${y})`}>
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        rx={6}
        fill={isCompound ? "rgba(122,148,214,0.07)" : color.fill}
        stroke={color.stroke}
        strokeWidth={2}
        strokeDasharray={isCompound ? "5 3" : undefined}
      />
      <text
        x={isCompound ? 10 : w / 2}
        y={isCompound ? 16 : h / 2 - (tone === "fabrication" ? 6 : 0)}
        fill={isCompound ? "#a9bdec" : color.text}
        fontSize={11}
        fontWeight={isCompound ? "bold" : undefined}
        textAnchor={isCompound ? "start" : "middle"}
        dominantBaseline={isCompound ? "hanging" : "middle"}
      >
        {label}
      </text>
      {!isCompound && tone === "fabrication" && (
        <text x={w / 2} y={h / 2 + 12} fill={color.stroke} fontSize={11} fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
          ⚠ fabrication
        </text>
      )}
      {renderEdges(n.edges)}
      {children.map((c) => renderNode(c, registry))}
    </g>
  );
}

export interface WireframeElkProps {
  readonly projection: WireframeProjection;
  /** Omit `const` (fabrication) nodes and their out-edges from the layout.
   *  Causality and teleology dataflow views don't need program-text literals —
   *  a `const` is a where-provenance leaf, never part of evidence flow — so
   *  hiding them declutters the graph down to the crossings and transforms that
   *  actually carry lineage. The seal/attest path is unaffected (it reads
   *  `StaticProv` directly, not this render); the security-demo stories keep
   *  this OFF so the red fabrication markers stay visible. Default false. */
  readonly hideFabricated?: boolean;
}

export function WireframeElk({ projection, hideFabricated = false }: WireframeElkProps) {
  const { graph, sideMaps } = projection;
  const [laidOut, setLaidOut] = useState<ElkNode | null>(null);
  const [registry, setRegistry] = useState<ReadonlyMap<string, SideMapRef> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLaidOut(null);
    const { root, registry: builtRegistry } = buildElkGraph(projection, hideFabricated);
    const elk = new ElkCtor({ workerFactory: () => new FakeElkWorkerCtor() });
    elk
      .layout(root)
      .then((laid) => {
        if (!cancelled) {
          setLaidOut(laid as ElkNode);
          setRegistry(builtRegistry);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // graph+sideMaps identity that actually determines the built ELK input
    // (plus hideFabricated, which changes which nodes/edges are emitted);
    // `projection` itself is a fresh object per story render but its
    // constituent graph/sideMaps are what this effect depends on.
  }, [graph, sideMaps, hideFabricated]);

  if (error !== null) {
    return <pre style={{ color: "#e5484d", whiteSpace: "pre-wrap" }}>ELK layout error: {error}</pre>;
  }
  if (laidOut === null || registry === null) {
    return <div style={{ color: "#8b93a7", fontFamily: "system-ui, sans-serif" }}>laying out…</div>;
  }

  const width = laidOut.width ?? 400;
  const height = laidOut.height ?? 300;
  const nodes = laidOut.children ?? [];
  const edges = laidOut.edges ?? [];

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", color: "#c9d1d9", background: "#12161f", padding: 16 }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id="wireframe-elk-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#4a5468" />
          </marker>
        </defs>
        {renderEdges(edges)}
        {nodes.map((n) => renderNode(n, registry))}
      </svg>
    </div>
  );
}

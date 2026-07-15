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
 * Nested `fan` template graphs are NOT spliced in (same I5 exterior-collapse
 * discipline the studio adapter holds) — a `fan` renders as one collapsed
 * node here, its `sideMaps.fanTemplates` interior unvisited.
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
 */
import { useEffect, useState } from "react";
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

import type { Wire, WireframeGraph, WireframeNode } from "@here.build/arrival/provenance";
import type { WireframeProjection } from "../to-wireframe.js";

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

interface ElkBuild {
  readonly root: ElkNode;
  /** elk node id (`n${index}`) → the node's index, for side-map lookups. */
  readonly indexOf: ReadonlyMap<string, number>;
}

function buildElkGraph(graph: WireframeGraph): ElkBuild {
  const indexOf = new Map<string, number>();
  const children: ElkNode[] = graph.nodes.map((node, index) => {
    const id = `n${index}`;
    indexOf.set(id, index);
    return { id, width: NODE_W, height: NODE_H, labels: [{ text: `${node.kind}: ${nodeLabel(node)}` }] };
  });

  const edges: ElkExtendedEdge[] = graph.wires.flatMap((wire) => {
    const sources = wire.paramRefs.filter(isNodeRef).map((ref) => `n${ref.node}`);
    if (sources.length === 0) return []; // slot-only ingress — no in-graph producer to draw from
    return [{ id: `w:${wire.consumer.node}:${wire.consumer.slot}`, sources, targets: [`n${wire.consumer.node}`] }];
  });

  return { root: { id: "root", layoutOptions: LAYOUT_OPTIONS, children, edges }, indexOf };
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

export interface WireframeElkProps {
  readonly projection: WireframeProjection;
}

export function WireframeElk({ projection }: WireframeElkProps) {
  const { graph, sideMaps } = projection;
  const [laidOut, setLaidOut] = useState<ElkNode | null>(null);
  const [indexOf, setIndexOf] = useState<ReadonlyMap<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLaidOut(null);
    const { root, indexOf: builtIndexOf } = buildElkGraph(graph);
    const elk = new ElkCtor({ workerFactory: () => new FakeElkWorkerCtor() });
    elk
      .layout(root)
      .then((laid) => {
        if (!cancelled) {
          setLaidOut(laid as ElkNode);
          setIndexOf(builtIndexOf);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  if (error !== null) {
    return <pre style={{ color: "#e5484d", whiteSpace: "pre-wrap" }}>ELK layout error: {error}</pre>;
  }
  if (laidOut === null || indexOf === null) {
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
        {edges.map((edge) => {
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
        })}
        {nodes.map((n) => {
          // Map back by ELK node id (not array position) — `elk.layout()` is
          // not contractually obligated to preserve `children` array order,
          // only to fill in x/y/width/height per node; `indexOf` was built
          // from the SAME ids at graph-construction time, so this lookup is
          // correct regardless of what order the engine returns nodes in.
          const index = indexOf.get(n.id);
          const tone = index !== undefined ? toneOf(sideMaps, index) : "neutral";
          const color = TONE_COLOR[tone];
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          const w = n.width ?? NODE_W;
          const h = n.height ?? NODE_H;
          const label = n.labels?.[0]?.text ?? "";
          return (
            <g key={n.id}>
              <rect x={x} y={y} width={w} height={h} rx={6} fill={color.fill} stroke={color.stroke} strokeWidth={2} />
              <text x={x + w / 2} y={y + h / 2 - (tone === "fabrication" ? 6 : 0)} fill={color.text} fontSize={11} textAnchor="middle" dominantBaseline="middle">
                {label}
              </text>
              {tone === "fabrication" && (
                <text x={x + w / 2} y={y + h / 2 + 12} fill={color.stroke} fontSize={11} fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
                  ⚠ fabrication
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

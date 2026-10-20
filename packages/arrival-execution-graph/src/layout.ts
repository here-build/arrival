/**
 * RenderGraph → ELK → LaidOutGraph. Pure apart from the injected engine.
 *
 * Frames become compound nodes (children by `parent`); steps and transforms are leaves. An edge
 * lives in the lowest common ancestor of its endpoints (a frame's port → its own child lives in
 * the frame), which is where layered INCLUDE_CHILDREN routing expects a cross-hierarchy edge.
 * `shapeCoords`/`edgeCoords: ROOT` make every coordinate ELK returns absolute. ELK ids are the
 * RenderGraph ids (ports: `portKey`), so the graph itself is the side table.
 *
 * STATIC INPUT: everything fed to ELK is a function of the graph's structure and the measured
 * sizes, and the view measures structure-only skeletons — so a selection, a state or a value
 * never changes the layout.
 *
 * ROW DOCKS: a leaf whose every port has a measured anchor (`anchors`: port key → y offset in
 * the box, the centre of the operand or result row the port belongs to) gets FIXED_POS ports, so
 * a wire lands on the exact row it feeds. Other leaves and every frame keep FIXED_ORDER.
 *
 * ORDER DOCKS: an `order` edge leaves its predecessor's east side and enters its successor's west
 * side at the vertical middle of each box — a sequence reads along the boxes, not off a corner. A
 * leaf's order ports are FIXED_POS at half its measured height. A frame's size is ELK's to find,
 * and under INCLUDE_CHILDREN its ports are placed by the inner layering, so its order port is
 * declared for the layering and then moved to the middle of the laid-out box, the edge's end
 * jogging to it (`dockOrder`).
 *
 * AREAS: a frame's box IS its border; its head (caption, picker) sits ABOVE the border, so each
 * compound reserves the tallest child head in its top padding. A condition is a stack of lanes:
 * no padding and no spacing of its own; hidden lane anchors (`anchorLanes`) start every lane at
 * its first column, and after layout the arms are stretched to tile it (the dashed dividers are
 * lane tops). An arm carries its guard title inside, in its top padding.
 *
 * LOOP RETURN: `recur` edges are not routed by ELK. Each is drawn as the loop area's own
 * contour — out of the producer's row to the right border, along the bottom, up the left border
 * to the loop param's port, into it — so "this box loops" is its outline, not a tangle.
 *
 * SIBLING ORDER: authored order is the meaning (`then` above `else`, clause by clause), so
 * crossing minimization never reorders: it is `INTERACTIVE` over input positions that ARE the
 * authored rank (`authoredRank`), so each layer reads top-down in evaluation order. `NONE` was
 * not enough — under INCLUDE_CHILDREN it keeps ELK's internal flattening order, which put `else`
 * above `then`. The hierarchical LAYER_SWEEP (the default) reverses fan-outs and rotates
 * unconnected siblings, no `considerModelOrder.*` knob overrides it, and `forceNodeModelOrder`
 * crashes on compound graphs. ELK requires the strategy on every compound node, not only the
 * root, and reads spacing per compound, so both go everywhere.
 *
 * WRAPPING: a seq (or the root) with more than `WRAP_AFTER` children wraps its layer chain to
 * `elk.aspectRatio` — long sequential programs would otherwise lay out as one very wide row.
 */
import type { ElkEngine, ElkNode } from "./elk-engine.js";
import {
  type Box,
  edgeLabelKey,
  type LaidOutGraph,
  type PathStep,
  type Point,
  portIds,
  portKey,
  type RenderEdge,
  type RenderFrame,
  type RenderGraph,
  type RenderNode,
  type RenderPort,
  type Size,
} from "./types.js";

type ElkPort = NonNullable<ElkNode["ports"]>[number];
type ElkEdge = NonNullable<ElkNode["edges"]>[number];

const SIDE: Record<RenderPort["side"], string> = { in: "WEST", out: "EAST", control: "NORTH" };

/** Room inside an area's border around its children. */
export const FRAME_PAD = 12;
/** Room under an arm's guard title before its first child. */
const LANE_GAP = 8;
/** The frame radius: area ports keep clear of the rounded corners; the loop contour bends at it. */
export const FRAME_RADIUS = 12;
const FALLBACK: Size = { width: 120, height: 40 };

/** Set on the root AND every compound node: ELK rejects a mixed crossing-minimization setup and
 *  reads spacing per compound. Harness's airy spacing. */
const COMPOUND_OPTIONS: Record<string, string> = {
  "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
  "elk.spacing.nodeNode": "34",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.edgeEdge": "12",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.spacing.edgeNode": "16",
  "elk.layered.spacing.edgeNodeBetweenLayers": "16",
  "elk.spacing.edgeLabel": "2",
  // room for an area port's label between two rings
  "elk.spacing.portPort": "16",
};

const WRAP_AFTER = 8;
const WRAP_OPTIONS: Record<string, string> = {
  "elk.layered.wrapping.strategy": "MULTI_EDGE",
  "elk.aspectRatio": "1.6",
};

const wrapIf = (count: number | undefined): Record<string, string> => ((count ?? 0) > WRAP_AFTER ? WRAP_OPTIONS : {});

const ROOT_OPTIONS: Record<string, string> = {
  ...COMPOUND_OPTIONS,
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "org.eclipse.elk.json.shapeCoords": "ROOT",
  "org.eclipse.elk.json.edgeCoords": "ROOT",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.edgeRouting": "ORTHOGONAL",
};

/** A frame drawn as a box whose head sits above its border (not a lane, not a stub pill). */
export const headAbove = (n: RenderNode): n is RenderFrame => n.kind === "frame" && n.frame !== "arm" && !isStub(n);

/** A collapsed frame is a stub pill — except an arm, which is always a lane of its condition. */
export const isStub = (n: RenderNode): boolean => n.kind === "frame" && n.collapsed === true && n.frame !== "arm";

/** `.url[0]` — a projection's path as its wire label. */
export function pathText(path: readonly PathStep[]): string {
  return path
    .map((s) => {
      if ("field" in s) return `.${s.field.replace(/^:/, "")}`;
      if ("car" in s) return "[0]";
      return `[${s.index}]`;
    })
    .join("");
}

/** What a wire's label pill says, and how: a projection path, else a compact expression (mono,
 *  clamped), else an explicit label. */
export function edgeLabel(e: RenderEdge): { text: string; kind: "path" | "expr" | "label" } | undefined {
  if (e.path && e.path.length > 0) return { text: pathText(e.path), kind: "path" };
  if (e.expr !== undefined) return { text: e.expr, kind: "expr" };
  return e.label === undefined ? undefined : { text: e.label, kind: "label" };
}

/** The text a wire's label pill carries (see `edgeLabel`). */
export const edgeText = (e: RenderEdge): string | undefined => edgeLabel(e)?.text;

/** The program's own top-level frame: it is the page, not an area — no box, no ports. */
export const isPage = (n: RenderNode | undefined): boolean => n?.kind === "frame" && n.parent === null;

export async function layout(
  graph: RenderGraph,
  sizes: ReadonlyMap<string, Size>,
  engine: ElkEngine,
  anchors: ReadonlyMap<string, number> = new Map(),
): Promise<LaidOutGraph> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, RenderNode[]>();
  for (const n of graph.nodes) childrenOf.set(n.parent, [...(childrenOf.get(n.parent) ?? []), n]);
  const sizeOf = (id: string): Size => sizes.get(id) ?? FALLBACK;
  /** The tallest head a child area hangs above its border, reserved in the parent's top pad. */
  const headRoom = (id: string | null): number =>
    Math.max(0, ...(childrenOf.get(id) ?? []).filter(headAbove).map((c) => sizes.get(c.id)?.height ?? 0));

  const rank = authoredRank(graph);
  const elkOf = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: "__root__",
    layoutOptions: {
      ...ROOT_OPTIONS,
      ...wrapIf(childrenOf.get(null)?.length),
      "elk.padding": `[top=${FRAME_PAD + headRoom(null)},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`,
    },
    children: [],
    edges: [],
  };

  const routed = graph.edges.filter(
    (e) =>
      e.kind !== "recur" &&
      byId.has(e.from.node) &&
      byId.has(e.to.node) &&
      !isPage(byId.get(e.from.node)) &&
      !isPage(byId.get(e.to.node)),
  );
  const orderSides = new Map<string, Set<OrderSide>>();
  const addSide = (node: string, side: OrderSide) =>
    orderSides.set(node, (orderSides.get(node) ?? new Set()).add(side));
  for (const e of routed) {
    if (e.from.port === portIds.order) addSide(e.from.node, "out");
    if (e.to.port === portIds.order) addSide(e.to.node, "in");
  }

  for (const n of graph.nodes) {
    const kids = childrenOf.get(n.id)?.length;
    const order = orderSides.get(n.id) ?? NO_SIDES;
    const node =
      kids === undefined
        ? leaf(n, sizeOf(n.id), anchors, order)
        : compound(n as RenderFrame, sizeOf(n.id), kids, headRoom(n.id), order);
    // The authored rank, read by INTERACTIVE crossing minimization (see SIBLING ORDER).
    node.x = 0;
    node.y = rank.get(n.id)!;
    elkOf.set(n.id, node);
    const parent = n.parent === null ? root : elkOf.get(n.parent);
    if (parent === undefined)
      throw new Error(`execution-graph layout: node ${n.id} listed before its parent ${n.parent}`);
    parent.children = [...(parent.children ?? []), node];
  }

  const lca = (a: string, b: string): ElkNode => {
    const common = commonAncestor(byId, a, b);
    return common === undefined ? root : elkOf.get(common)!;
  };
  // An `order` end is the node's order port on that side; an endpoint naming a port the node does
  // not declare attaches to the node.
  const end = (e: { node: string; port: string }, side: OrderSide): string => {
    if (e.port === portIds.order) return portKey(e.node, ORDER[side]);
    return byId.get(e.node)!.ports.some((p) => p.id === e.port) ? portKey(e.node, e.port) : e.node;
  };

  // A wire into the page's own `out` says only "this is the program's result": not drawn, not routed.
  for (const e of routed) {
    const edge = elkEdge(e, end, sizes);
    const container = lca(e.from.node, e.to.node);
    container.edges = [...(container.edges ?? []), edge];
  }
  const branches = graph.nodes.filter((n) => n.kind === "frame" && n.frame === "branch");
  for (const b of branches) anchorLanes(b.id, byId, childrenOf, routed, elkOf.get(b.id)!);

  const laid = readBack(await engine.layout(root));
  tileLanes(graph, childrenOf, laid);
  dockOrder(routed, childrenOf, laid);
  for (const e of graph.edges.filter((x) => x.kind === "recur")) {
    const contour = loopContour(e, byId, laid);
    if (contour) laid.edges.set(e.id, contour);
  }
  return laid;
}

/** The ancestors of `id`, root first, `id` last. */
function chainOf(byId: ReadonlyMap<string, RenderNode>, id: string): string[] {
  const out: string[] = [];
  for (let cur = byId.get(id); cur; cur = cur.parent === null ? undefined : byId.get(cur.parent)) out.unshift(cur.id);
  return out;
}

/** The lowest common ancestor of two nodes, counting a node as its own ancestor. */
function commonAncestor(byId: ReadonlyMap<string, RenderNode>, a: string, b: string): string | undefined {
  const [ca, cb] = [chainOf(byId, a), chainOf(byId, b)];
  let i = 0;
  while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  return i === 0 ? undefined : ca[i - 1];
}

/** One wire as an ELK edge; a labelled wire (projection path) carries its measured label box. */
function elkEdge(
  e: RenderEdge,
  end: (x: RenderEdge["from"], side: OrderSide) => string,
  sizes: ReadonlyMap<string, Size>,
): ElkEdge {
  const text = edgeText(e);
  const label = text === undefined ? undefined : sizes.get(edgeLabelKey(e.id));
  return {
    id: e.id,
    sources: [end(e.from, "out")],
    targets: [end(e.to, "in")],
    // elkjs only imports a label that carries `text`; without it the label is silently unplaced.
    ...(label && text !== undefined
      ? {
          labels: [
            {
              id: edgeLabelKey(e.id),
              text,
              width: label.width,
              height: label.height,
              layoutOptions: { "elk.edgeLabels.placement": "CENTER" },
            },
          ],
        }
      : {}),
  };
}

/** Authored order as a number per node: its place in the graph's (evaluation) order; a transform
 *  ranks just before the node its result feeds, so it sits beside its consumer, not after
 *  everything else. */
/** Far larger than any box: INTERACTIVE compares node CENTRES, so with a small step a tall card
 *  ranked before a short empty lane sank below it (`else` above `then` inside a loop body). */
const RANK_STEP = 10_000;

function authoredRank(graph: RenderGraph): Map<string, number> {
  const rank = new Map(graph.nodes.map((n, i) => [n.id, i * RANK_STEP]));
  for (const n of graph.nodes) {
    if (n.kind !== "transform") continue;
    const feeds = graph.edges.find((e) => e.from.node === n.id && e.kind !== "recur");
    const consumer = feeds && rank.get(feeds.to.node);
    if (consumer !== undefined) rank.set(n.id, consumer - RANK_STEP / 2);
  }
  return rank;
}

/** ELK orders a side's ports clockwise, so the west side counts bottom-up: its indices are
 *  reversed to keep declared order top-down. */
function elkPorts(n: RenderNode): ElkPort[] {
  return n.ports.map((p, i) => ({
    id: portKey(n.id, p.id),
    width: 0,
    height: 0,
    layoutOptions: {
      "elk.port.side": SIDE[p.side],
      "elk.port.index": String(p.side === "in" ? n.ports.length - i : i),
    },
  }));
}

type OrderSide = "in" | "out";
/** The two sides of the `order` port, as ELK port ids under the node. */
const ORDER: Record<OrderSide, string> = { in: "order:in", out: "order:out" };
const NO_SIDES: ReadonlySet<OrderSide> = new Set();

/** A node's order ports: `in` west, `out` east — at the vertical middle of a FIXED_POS box of
 *  size `at`, after the side's other ports otherwise. */
function orderPorts(n: RenderNode, sides: ReadonlySet<OrderSide>, at?: Size): ElkPort[] {
  return [...sides].map((side) => ({
    id: portKey(n.id, ORDER[side]),
    width: 0,
    height: 0,
    ...(at ? { x: side === "in" ? 0 : at.width, y: at.height / 2 } : {}),
    layoutOptions: { "elk.port.side": SIDE[side] },
  }));
}

/** A step or transform: its measured box; FIXED_POS ports on measured rows when every port has one
 *  (order ports at the vertical middle). */
function leaf(n: RenderNode, size: Size, anchors: ReadonlyMap<string, number>, order: ReadonlySet<OrderSide>): ElkNode {
  const ys = n.ports.map((p) => anchors.get(portKey(n.id, p.id)));
  const docked = n.ports.length + order.size > 0 && ys.every((y) => y !== undefined);
  const X: Record<RenderPort["side"], number> = { in: 0, out: size.width, control: size.width / 2 };
  const ports = elkPorts(n).map((p, i) => {
    const side = n.ports[i]!.side;
    return docked ? { ...p, x: X[side], y: side === "control" ? 0 : ys[i]! } : p;
  });
  ports.push(...orderPorts(n, order, docked ? size : undefined));
  return {
    id: n.id,
    ports,
    width: size.width,
    height: size.height,
    layoutOptions: { "elk.portConstraints": docked ? "FIXED_POS" : "FIXED_ORDER" },
  };
}

/** A frame with children. `size` is its measured head (or, for an arm, its lane title): the
 *  width becomes the minimum frame width, the height the room it needs (above the border for a
 *  head, inside for a lane title). */
function compound(
  n: RenderFrame,
  size: Size,
  children: number,
  headRoom: number,
  order: ReadonlySet<OrderSide>,
): ElkNode {
  let padding: string;
  const extra: Record<string, string> = {};
  switch (n.frame) {
    case "branch": {
      padding = "[top=0,left=0,bottom=0,right=0]";
      extra["elk.spacing.nodeNode"] = "0";
      break;
    }
    case "arm": {
      padding = `[top=${size.height + LANE_GAP + headRoom},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`;
      break;
    }
    case "seq": {
      padding = `[top=${headRoom},left=0,bottom=0,right=0]`;
      break;
    }
    default: {
      padding = `[top=${FRAME_PAD + headRoom},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`;
    }
  }
  return {
    id: n.id,
    ports: [...elkPorts(n), ...orderPorts(n, order)],
    children: [],
    edges: [],
    layoutOptions: {
      ...COMPOUND_OPTIONS,
      ...(n.frame === "seq" ? wrapIf(children) : {}),
      ...extra,
      "elk.portConstraints": "FIXED_ORDER",
      "elk.spacing.portsSurrounding": `[top=${FRAME_RADIUS},left=${FRAME_RADIUS},bottom=${FRAME_RADIUS},right=${FRAME_RADIUS}]`,
      "elk.padding": padding,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${size.width + (n.frame === "seq" ? 0 : 2 * FRAME_PAD)},${n.frame === "arm" ? size.height + LANE_GAP : FRAME_PAD})`,
    },
  };
}

const LANE_PORT = "__lanes__";

/**
 * Under INCLUDE_CHILDREN the layering is global, so a lane's steps take whatever columns their
 * wires pull them to and lanes interleave (an arm whose only step feeds the branch's `out` slides
 * right of its sibling). A hidden west port on the condition, wired to every lane's first steps in
 * authored order, starts every lane at the condition's first column — so the lanes stack, in
 * order, and tile. The hidden wires are layout-only: the view draws `graph.edges`.
 */
function anchorLanes(
  branch: string,
  byId: ReadonlyMap<string, RenderNode>,
  childrenOf: ReadonlyMap<string | null, RenderNode[]>,
  routed: readonly RenderEdge[],
  elk: ElkNode,
) {
  const hidden = portKey(branch, LANE_PORT);
  const edges: ElkEdge[] = [];
  for (const arm of childrenOf.get(branch) ?? []) {
    const kids = childrenOf.get(arm.id) ?? [];
    /** The arm's child holding `id`, if `id` is inside the arm. */
    const kidOf = (id: string): string | undefined => {
      for (let cur = byId.get(id); cur; cur = cur.parent === null ? undefined : byId.get(cur.parent))
        if (cur.parent === arm.id) return cur.id;
      return undefined;
    };
    const fed = new Set(
      routed.flatMap((e) => {
        const [from, to] = [kidOf(e.from.node), kidOf(e.to.node)];
        return from !== undefined && to !== undefined && from !== to ? [to] : [];
      }),
    );
    // An empty lane is a leaf: anchor the lane itself, so it shares a column with its siblings'
    // first steps and takes its authored place among them.
    const firsts = kids.length === 0 ? [arm] : kids.filter((k) => !fed.has(k.id));
    for (const first of firsts) edges.push({ id: `${hidden}->${first.id}`, sources: [hidden], targets: [first.id] });
  }
  if (edges.length === 0) return;
  elk.ports = [
    { id: hidden, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST", "elk.port.index": "0" } },
    ...(elk.ports ?? []),
  ];
  elk.edges = [...(elk.edges ?? []), ...edges];
}

/** A frame's order ports to the vertical middle of its laid-out box; each order edge's end at a
 *  frame jogs to it, close to the border. A leaf's order ports are already there. */
function dockOrder(
  routed: readonly RenderEdge[],
  childrenOf: ReadonlyMap<string | null, RenderNode[]>,
  laid: LaidOutGraph,
): void {
  for (const e of routed) {
    const routedPts = laid.edges.get(e.id);
    if (e.kind !== "order" || !routedPts || routedPts.length < 2) continue;
    let pts: Point[] = routedPts;
    const ends: [RenderEdge["from"], OrderSide][] = [
      [e.from, "out"],
      [e.to, "in"],
    ];
    for (const [{ node, port }, side] of ends) {
      const box = laid.boxes.get(node);
      if (port !== portIds.order || !childrenOf.has(node) || !box) continue;
      const mid = { x: side === "in" ? box.x : box.x + box.width, y: box.y + box.height / 2 };
      laid.ports.set(portKey(node, ORDER[side]), mid);
      // Work on the end as the polyline's last point; the start is the reversed polyline's.
      const run = side === "in" ? pts : pts.toReversed();
      const [a, b] = [run.at(-2)!, run.at(-1)!];
      if (Math.abs(b.y - mid.y) < 0.5) continue;
      const jx = b.x + Math.sign(a.x - b.x) * Math.min(FRAME_PAD, Math.abs(a.x - b.x) / 2);
      const docked = [...run.slice(0, -1), { x: jx, y: b.y }, { x: jx, y: mid.y }, mid];
      pts = side === "in" ? docked : docked.toReversed();
      laid.edges.set(e.id, pts);
    }
  }
}

/** A condition's arms tile it: full width, each lane reaching down to the next one's top. */
function tileLanes(graph: RenderGraph, childrenOf: ReadonlyMap<string | null, RenderNode[]>, laid: LaidOutGraph) {
  for (const n of graph.nodes) {
    if (n.kind !== "frame" || n.frame !== "branch") continue;
    const outer = laid.boxes.get(n.id);
    const lanes = (childrenOf.get(n.id) ?? [])
      .filter((c) => c.kind === "frame" && c.frame === "arm")
      .map((c) => ({ id: c.id, box: laid.boxes.get(c.id) }))
      .filter((l): l is { id: string; box: Box } => l.box !== undefined)
      .toSorted((a, b) => a.box.y - b.box.y);
    if (!outer || lanes.length === 0) continue;
    const tops = lanes.map((l, i) =>
      i === 0 ? outer.y : (lanes[i - 1]!.box.y + lanes[i - 1]!.box.height + l.box.y) / 2,
    );
    for (const [i, l] of lanes.entries()) {
      const bottom = i === lanes.length - 1 ? outer.y + outer.height : tops[i + 1]!;
      laid.boxes.set(l.id, { x: outer.x, y: tops[i]!, width: outer.width, height: bottom - tops[i]! });
    }
  }
}

/** The loop return as the loop area's contour: right border, bottom, left border, into the
 *  target (the rising left-border run is where its label sits). The nearest `loop` frame at or above the target owns it. */
function loopContour(e: RenderEdge, byId: ReadonlyMap<string, RenderNode>, laid: LaidOutGraph): Point[] | undefined {
  let loop: RenderNode | undefined = byId.get(e.to.node);
  while (loop && !(loop.kind === "frame" && loop.frame === "loop"))
    loop = loop.parent === null ? undefined : byId.get(loop.parent);
  const box = loop && laid.boxes.get(loop.id);
  if (!box) return undefined;
  const fromBox = laid.boxes.get(e.from.node);
  const s =
    laid.ports.get(portKey(e.from.node, e.from.port)) ??
    (fromBox && { x: fromBox.x + fromBox.width, y: fromBox.y + fromBox.height / 2 });
  const toBox = laid.boxes.get(e.to.node);
  const t = laid.ports.get(portKey(e.to.node, e.to.port)) ?? (toBox && { x: toBox.x, y: toBox.y + toBox.height / 2 });
  if (!s || !t) return undefined;
  const [left, right, bottom] = [box.x, box.x + box.width, box.y + box.height];
  // Into the param port on the border: a short hop inward carries the arrowhead.
  const tip = t.x - left < 1 ? { x: left + 8, y: t.y } : t;
  const around = [{ x: right, y: bottom }, { x: left, y: bottom }, { x: left, y: t.y }, tip];
  // A loop counter (`i` ← `(+ i 1)`) feeds its own param: no producer row, the return is the
  // contour alone, from the right border at the param's height.
  const self = e.from.node === e.to.node && e.from.port === e.to.port;
  return self ? [{ x: right, y: t.y }, ...around] : [s, { x: right, y: s.y }, ...around];
}

/** ELK's result, already absolute (`shapeCoords`/`edgeCoords: ROOT`), as boxes, port anchors, edge polylines and label boxes. */
function readBack(result: ElkNode): LaidOutGraph {
  const boxes = new Map<string, Box>();
  const ports = new Map<string, Point>();
  const edges = new Map<string, Point[]>();
  const labels = new Map<string, Box>();
  const walk = (n: ElkNode): void => {
    if (n !== result) boxes.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 });
    for (const p of n.ports ?? [])
      ports.set(p.id, { x: (p.x ?? 0) + (p.width ?? 0) / 2, y: (p.y ?? 0) + (p.height ?? 0) / 2 });
    for (const e of n.edges ?? []) {
      const pts: Point[] = [];
      for (const s of e.sections ?? []) pts.push(s.startPoint, ...(s.bendPoints ?? []), s.endPoint);
      edges.set(
        e.id,
        pts.map(({ x, y }) => ({ x, y })),
      );
      const l = e.labels?.[0];
      if (l) labels.set(e.id, { x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0 });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(result);

  return { width: result.width ?? 0, height: result.height ?? 0, boxes, ports, edges, labels };
}

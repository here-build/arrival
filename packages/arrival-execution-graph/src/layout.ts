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
 * no padding and no spacing of its own; hidden lane anchors (`anchorLanes`) keep every lane at
 * the condition's first column, and after layout the arms are stretched to tile it (the dashed
 * dividers are lane tops). An arm carries its guard title inside, in its top padding.
 *
 * LOOP RETURN: `recur` edges are not routed by ELK. Each is drawn as the loop area's own
 * contour — out of the producer's row to the right border, along the bottom, up the left border
 * to the loop param's port, into it — so "this box loops" is its outline, not a tangle. A loop
 * with several loop variables nests its returns, RETURN_STEP apart, in authored param order (the
 * topmost param outermost), so no two share a segment and none crosses at the param ports.
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
 * COLUMNS: execution order reads left to right, so the columns are ours, not ELK's (its own
 * layering sent wires backwards and, wrapped, laid long sequences out like text). A node's column
 * is one past the latest of its predecessors over every non-`recur` edge — data, control AND
 * order (authored order counts). An edge is lifted to the siblings under the endpoints' lowest
 * common ancestor: the frame stands for all its children, so an edge into a frame (or into a
 * child of it) puts the whole frame after its source, one out of it puts its consumers after the
 * frame's last column. A frame's own ports are its border: a param sits before its first column,
 * `out` after its last, so those edges (an endpoint inside the other) add nothing. A frame
 * spans a contiguous range covering its children; siblings no wire relates may share columns.
 * `recur` edges are the loop contour, not a dependency. Cycles are not expected; one is cut
 * at the earliest-authored node and its wire stays visibly backward. ELK gets the column as the
 * node's input `x` (`COL_STEP` apart) under `layering.strategy: INTERACTIVE` on every compound; a
 * child's `x` is relative to its parent's first column, which is how ELK reads it. Columns depend
 * on ids, parents and edges alone — never on counts, selections, states or values. A transform
 * (a pure computed block) is as late as it can be: the column just before its first consumer.
 *
 * BUS: a value feeding several consumers is ONE line that forks into each of them. Edges are
 * grouped by (container, source node, source port, kind); a group of 2+ consumers is a bus. The
 * consumers in the first consumer column fork straight off the source port (ELK merges one gap's
 * worth). For every LATER consumer column C a junction — a 1x1 layout-only node with a west and
 * an east port, in column C-1, so it costs no width — joins a chain source → j → j → …, each
 * trunk edge straight-priority; the fork into a consumer leaves the junction of its column and
 * carries the wire's label. After layout each original edge is rebuilt as its trunk sections up
 * to its junction plus its fork, under the original id; junctions never reach `boxes`/`ports`.
 * `forks` are the points where a branch leaves what it shares with its siblings, found from the
 * rebuilt polylines alone. Every consumer column gets a junction, the first included, unless it
 * is the column right after the source's: a branch leaves the trunk as late as it can, never
 * early (ELK routes a long first gap per edge, which draws parallel runs that rejoin).
 *
 * ENTRY: 2+ branches of a bus that end inside one child area (a frame, or one arm of a condition:
 * the arms are the lanes) enter it ONCE: a layout-only WEST port on that area, one trunk edge to
 * it, and the bus goes on from the port inside the area as a level of its own (columns, junctions,
 * forks, and entries into areas deeper still). A branch's polyline is outer trunk + entry + inner
 * trunk + fork, under its own id. The port sits on the area's border (an arm's is moved to the
 * condition's border when the arms tile it) and is exposed as `crossings`, for a ring.
 *
 * ROWS: a page wider than `ROW_TARGET` (as laid out in one row) is cut into rows stacked top to
 * bottom, each its own ELK pass, strictly left to right. A cut falls only BETWEEN two consecutive
 * top-level forms (the page's children that are not transforms; a transform belongs to the form it
 * feeds) and only where it is clean: every wire across it runs from the last form above to the
 * first form below, with at most ONE `order` wire and at most ONE other wire (and those end on the
 * forms themselves, at an `in` / `out` or order port). A cut that is not clean is not taken, so a
 * page with no clean cut stays one long row. The wires across a cut are not ELK's: each is drawn
 * as one channel of its own — out of the right end of the upper row, down, back left in the gap
 * between the rows, down the left margin, into the lower row — under its original id (two wires
 * across one cut take lanes that do not cross). A connector that would still touch a card voids
 * its cut, and the rows are laid out again without it. Only structure and measured skeleton sizes
 * decide any of it.
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
  "elk.layered.layering.strategy": "INTERACTIVE",
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

/** One row, or the whole graph when it needs no breaking: a single ELK pass (see COLUMNS .. BUS). */
async function layoutRow(
  graph: RenderGraph,
  sizes: ReadonlyMap<string, Size>,
  engine: ElkEngine,
  anchors: ReadonlyMap<string, number>,
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
  const columns = columnsOf(graph, routed);
  const orderSides = new Map<string, Set<OrderSide>>();
  const addSide = (node: string, side: OrderSide) =>
    orderSides.set(node, (orderSides.get(node) ?? new Set()).add(side));
  for (const e of routed) {
    if (e.from.port === portIds.order) addSide(e.from.node, "out");
    if (e.to.port === portIds.order) addSide(e.to.node, "in");
  }

  for (const n of graph.nodes) {
    const kids = childrenOf.get(n.id);
    const order = orderSides.get(n.id) ?? NO_SIDES;
    const node =
      kids === undefined
        ? leaf(n, sizeOf(n.id), anchors, order)
        : compound(n as RenderFrame, sizeOf(n.id), headRoom(n.id), order);
    // INTERACTIVE reads the input position twice: `y` is the authored rank (crossing
    // minimization, see SIBLING ORDER), `x` the column (layering, see COLUMNS).
    node.x = (columns.offset.get(n.id) ?? 0) * COL_STEP;
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
  const taken = new Set([...byId.keys(), ...graph.edges.map((e) => e.id)]);
  const forkOf = new Map<string, { source: string; id: string; container: ElkNode }>();
  const rebuilds: { id: string; pieces: string[] }[] = [];
  const hidden = { nodes: new Set<string>(), edges: new Set<string>(), ports: new Set<string>() };
  /** Per entry port: the area it sits on, the edge ending at it, the edges starting at it. */
  const entries = new Map<string, { unit: string; enter: string; starts: string[] }>();
  const startAt = (source: string, id: string): void => {
    entries.get(source)?.starts.push(id);
  };
  /** A layout-only id nothing else uses. */
  const fresh = (base: string): string => {
    let id = base;
    while (taken.has(id)) id = `_${id}`;
    taken.add(id);
    return id;
  };
  const buses = fanOuts(routed, byId, columns, rank);

  /**
   * One level of a bus (see BUS and ENTRY): the branches of `members` that share `source`, a port
   * inside `container`. Junctions chain along the columns, each branch leaves at the junction just
   * before its consumer's column; 2+ branches into one child area enter it ONCE (a layout-only west
   * port) and the bus goes on inside, as a level of its own. `pieces` of a branch: the ELK edges
   * that make up its polyline so far.
   */
  const descend = (
    container: ElkNode,
    source: string,
    srcCol: number,
    jrank: number,
    base: string,
    members: Hop[],
    top: boolean,
  ): void => {
    const colOf = (m: Hop): number => columns.offset.get(m.chain[m.depth]!) ?? 0;
    const cols = [...new Set(members.map(colOf))].toSorted((a, b) => a - b);
    const tap = new Map<number, { out: string; trunk: string[] }>();
    const trunk: string[] = [];
    let tail = source;
    for (const col of cols.filter((c) => c - 1 > srcCol)) {
      const j = fresh(`${base}${col}`);
      const [inPort, outPort, trunkId] = [portKey(j, "in"), portKey(j, "out"), `${j}~trunk`];
      container.children = [...(container.children ?? []), junction(j, inPort, outPort, col - 1, jrank)];
      container.edges = [
        ...(container.edges ?? []),
        {
          id: trunkId,
          sources: [tail],
          targets: [inPort],
          layoutOptions: { "elk.layered.priority.straightness": "100" },
        },
      ];
      startAt(tail, trunkId);
      trunk.push(trunkId);
      tap.set(col, { out: outPort, trunk: [...trunk] });
      tail = outPort;
      hidden.nodes.add(j);
      hidden.edges.add(trunkId);
    }
    // the area each branch would enter, if 2+ branches go to the same one
    const unitOf = (m: Hop): number | undefined => {
      const lifted = byId.get(m.chain[m.depth]!);
      const u = lifted?.kind === "frame" && lifted.frame === "branch" ? m.depth + 1 : m.depth;
      return m.chain.length > u + 1 && childrenOf.has(m.chain[u]!) ? u : undefined;
    };
    const into = Map.groupBy(members, (m) => {
      const u = unitOf(m);
      return u === undefined ? undefined : m.chain[u];
    });
    let k = 0;
    for (const m of members) {
      const u = unitOf(m);
      const group = u === undefined ? undefined : into.get(m.chain[u]);
      const from = tap.get(colOf(m))?.out ?? source;
      const prefix = [...m.pieces, ...(tap.get(colOf(m))?.trunk ?? [])];
      if (u === undefined || group === undefined || group.length < 2) {
        const id = `${m.edge.id}~fork`;
        if (top && prefix.length === 0) continue; // straight off the source port: a plain edge
        forkOf.set(m.edge.id, { source: from, id, container });
        startAt(from, id);
        rebuilds.push({ id: m.edge.id, pieces: [...prefix, id] });
        hidden.edges.add(id);
        continue;
      }
      if (group[0] !== m) continue; // the group is entered once, by its first branch
      const unit = m.chain[u]!;
      const port = portKey(unit, fresh(`__enter${base}${k++}__`));
      const enterId = fresh(`${port}~enter`);
      const holder = elkOf.get(unit)!;
      holder.ports = [
        ...(holder.ports ?? []),
        { id: port, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST", "elk.port.index": "0" } },
      ];
      container.edges = [
        ...(container.edges ?? []),
        {
          id: enterId,
          sources: [from],
          targets: [port],
          layoutOptions: { "elk.layered.priority.straightness": "100" },
        },
      ];
      hidden.edges.add(enterId);
      hidden.ports.add(port);
      entries.set(port, { unit, enter: enterId, starts: [] });
      const inside = group.map((g): Hop => ({ ...g, depth: u + 1, pieces: [...prefix, enterId] }));
      const first = Math.min(...inside.map((g) => rank.get(g.chain[g.depth]!) ?? 0)) - 1;
      descend(holder, port, -1, first, `${base}${k}_`, inside, false);
    }
  };
  for (const [n, bus] of buses.entries()) {
    const container = bus.container === null ? root : elkOf.get(bus.container)!;
    descend(
      container,
      end(bus.source, "out"),
      bus.col,
      bus.rank,
      fresh(`__bus${n}__`),
      bus.members.map((m): Hop => ({ ...m, pieces: [] })),
      true,
    );
  }
  for (const e of routed) {
    const edge = elkEdge(e, end, sizes);
    const fork = forkOf.get(e.id);
    const container = fork?.container ?? lca(e.from.node, e.to.node);
    container.edges = [...(container.edges ?? []), fork ? { ...edge, id: fork.id, sources: [fork.source] } : edge];
  }
  const branches = graph.nodes.filter((n) => n.kind === "frame" && n.frame === "branch");
  for (const b of branches) anchorLanes(b.id, byId, childrenOf, routed, elkOf.get(b.id)!);

  const laid = readBack(await engine.layout(root));
  tileLanes(graph, childrenOf, laid);
  snapEntries(entries, laid);
  const crossings = [...hidden.ports].flatMap((k) => laid.ports.get(k) ?? []);
  rebuildBuses(rebuilds, hidden, laid);
  laid.crossings.push(...crossings);
  dockOut(graph, routed, byId, childrenOf, laid);
  dockOrder(routed, childrenOf, laid);
  markForks(buses, laid);
  const returns = new Map<string, RenderEdge[]>();
  for (const e of graph.edges.filter((x) => x.kind === "recur")) {
    const loop = loopOf(e, byId);
    if (loop) returns.set(loop.id, [...(returns.get(loop.id) ?? []), e]);
  }
  const clear = labelObstacles(graph, laid);
  for (const [loopId, es] of returns) {
    const params = byId.get(loopId)!.ports.map((p) => p.id);
    const ordered = es.toSorted((a, b) => params.indexOf(a.to.port) - params.indexOf(b.to.port));
    for (const [k, e] of ordered.entries()) {
      const contour = loopContour(e, byId, laid, k, ordered.length);
      if (!contour) continue;
      laid.edges.set(e.id, contour);
      const text = edgeText(e);
      if (text === undefined) continue;
      const label = returnLabel(contour, sizes.get(edgeLabelKey(e.id)) ?? fallbackLabel(text), clear);
      laid.labels.set(e.id, label);
      clear.push(label);
    }
  }
  return laid;
}

/** A page laid out wider than this (layout units, one row) is cut into rows where a clean cut exists. */
export const ROW_TARGET = 1600;
/** Room added between two rows' page boxes, beyond their own padding: the connectors' channel. */
const ROW_GAP = 24;
/** Distance between two connectors' parallel lanes, and the first lane's distance outside the page border
 *  (the canvas keeps a FRAME_PAD margin around the page, room for two lanes). */
const LANE = 4;

export async function layout(
  graph: RenderGraph,
  sizes: ReadonlyMap<string, Size>,
  engine: ElkEngine,
  anchors: ReadonlyMap<string, number> = new Map(),
): Promise<LaidOutGraph> {
  const whole = await layoutRow(graph, sizes, engine, anchors);
  if (whole.width <= ROW_TARGET) return whole;
  const split = splitOf(graph);
  if (!split) return whole;
  const banned = new Set<number>();
  for (;;) {
    const cuts = chooseCuts(split, whole, banned);
    if (cuts.length === 0) return whole;
    const stacked = await stackRows(graph, split, cuts, sizes, engine, anchors);
    if (stacked.bad.size === 0) return stacked.laid;
    for (const c of stacked.bad) banned.add(c);
  }
}

/** The page's top-level forms and where every node sits among them. */
interface Split {
  page: string;
  byId: ReadonlyMap<string, RenderNode>;
  /** Form count. */
  forms: number;
  /** Form index of a node: its top-level ancestor's (a transform: that of the form it feeds). */
  formOf: (id: string) => number | undefined;
  /** The wires between nodes of different forms, as form indices (never page ends or recur). */
  wires: { edge: RenderEdge; a: number; b: number }[];
  /** Cut `c` (after form c) is clean, apart from the cuts in `banned`. */
  clean: (c: number) => boolean;
  /** The top-level children (forms and transforms) per form index. */
  members: string[][];
}

function splitOf(graph: RenderGraph): Split | undefined {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pages = graph.nodes.filter((n) => n.parent === null);
  const page = pages[0];
  if (pages.length !== 1 || page?.kind !== "frame") return undefined;
  const kids = graph.nodes.filter((n) => n.parent === page.id);
  const forms = kids.filter((k) => k.kind !== "transform");
  if (forms.length < 2) return undefined;
  const index = new Map(forms.map((f, i) => [f.id, i]));
  const edges = graph.edges.filter(
    (e) =>
      e.kind !== "recur" &&
      byId.has(e.from.node) &&
      byId.has(e.to.node) &&
      !isPage(byId.get(e.from.node)) &&
      !isPage(byId.get(e.to.node)),
  );
  const top = (id: string): string | undefined => chainOf(byId, id)[1];
  // A transform sits with the form it feeds (the earliest one), else the last form feeding it.
  const placed = new Map<string, number>();
  const resolve = (id: string, seen: ReadonlySet<string>): number => {
    const known = index.get(id) ?? placed.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    const around = (outgoing: boolean): number[] =>
      edges
        .filter((e) => (outgoing ? e.from.node === id : e.to.node === id))
        .map((e) => top(outgoing ? e.to.node : e.from.node))
        .filter((t): t is string => t !== undefined && t !== id)
        .map((t) => resolve(t, next));
    const [feeds, fed] = [around(true), around(false)];
    const at = feeds.length > 0 ? Math.min(...feeds) : fed.length > 0 ? Math.max(...fed) : 0;
    placed.set(id, at);
    return at;
  };
  const formOf = (id: string): number | undefined => {
    const t = top(id);
    return t === undefined ? undefined : resolve(t, new Set());
  };
  const wires = edges.flatMap((edge) => {
    const [a, b] = [formOf(edge.from.node), formOf(edge.to.node)];
    return a === undefined || b === undefined || a === b ? [] : [{ edge, a, b }];
  });
  const members: string[][] = Array.from({ length: forms.length }, () => []);
  for (const k of kids) members[formOf(k.id) ?? 0]!.push(k.id);

  const endOk = (end: RenderEdge["from"], side: "in" | "out"): boolean => {
    if (chainOf(byId, end.node).length !== 2) return false;
    if (end.port === portIds.order) return true;
    const port = byId.get(end.node)!.ports.find((p) => p.id === end.port);
    return port === undefined || port.side === side;
  };
  const clean = (c: number): boolean => {
    const across = wires.filter((w) => Math.min(w.a, w.b) <= c && c < Math.max(w.a, w.b));
    if (across.some((w) => w.a !== c || w.b !== c + 1 || !endOk(w.edge.from, "out") || !endOk(w.edge.to, "in")))
      return false;
    const order = across.filter((w) => w.edge.kind === "order").length;
    return order <= 1 && across.length - order <= 1;
  };
  return { page: page.id, byId, forms: forms.length, formOf, wires, clean, members };
}

/**
 * The cuts: walking the forms in order, a row that would stand wider than `ROW_TARGET` (by the
 * one-row layout's own boxes) ends at the latest clean cut before the overflow, else at the first
 * clean one after it; no clean cut, no break.
 */
function chooseCuts(split: Split, whole: LaidOutGraph, banned: ReadonlySet<number>): number[] {
  const span = split.members.map((ids) => {
    const boxes = ids.flatMap((id) => whole.boxes.get(id) ?? []);
    return { lo: Math.min(...boxes.map((b) => b.x)), hi: Math.max(...boxes.map((b) => b.x + b.width)) };
  });
  const width = (s: number, e: number): number =>
    Math.max(...span.slice(s, e + 1).map((x) => x.hi)) -
    Math.min(...span.slice(s, e + 1).map((x) => x.lo)) +
    2 * FRAME_PAD;
  const ok = (c: number): boolean => c < split.forms - 1 && !banned.has(c) && split.clean(c);
  const cuts: number[] = [];
  let s = 0;
  for (;;) {
    let e = s;
    while (e < split.forms && width(s, e) <= ROW_TARGET) e++;
    if (e >= split.forms) return cuts;
    const before = Array.from({ length: e - s }, (_, i) => e - 1 - i).find(ok);
    const after = Array.from({ length: split.forms - 1 - e }, (_, i) => e + i).find(ok);
    const cut = before ?? after;
    if (cut === undefined) return cuts;
    cuts.push(cut);
    s = cut + 1;
  }
}

const shiftBox = (b: Box, dy: number): Box => ({ ...b, y: b.y + dy });
const shiftPt = (p: Point, dy: number): Point => ({ x: p.x, y: p.y + dy });

/** Whether two orthogonal polylines touch anywhere (a segment's box meets the other's). */
function polylinesTouch(a: readonly Point[], b: readonly Point[]): boolean {
  const seg = (p: Point, q: Point): Box => ({
    x: Math.min(p.x, q.x),
    y: Math.min(p.y, q.y),
    width: Math.abs(p.x - q.x),
    height: Math.abs(p.y - q.y),
  });
  return a.slice(1).some((q, i) => {
    const s = seg(a[i]!, q);
    return b.slice(1).some((r, j) => {
      const t = seg(b[j]!, r);
      return s.x <= t.x + t.width && t.x <= s.x + s.width && s.y <= t.y + t.height && t.y <= s.y + s.height;
    });
  });
}

/** Every permutation of 0..n-1, in a fixed order. */
const permutations = (n: number): number[][] =>
  n === 0
    ? [[]]
    : permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)]));

/**
 * Lays each row out on its own, stacks them, and draws the wires across the cuts (see ROWS).
 * `bad` holds the cuts whose connectors would touch a card: nothing is stacked then.
 */
async function stackRows(
  graph: RenderGraph,
  split: Split,
  cuts: readonly number[],
  sizes: ReadonlyMap<string, Size>,
  engine: ElkEngine,
  anchors: ReadonlyMap<string, number>,
): Promise<{ laid: LaidOutGraph; bad: Set<number> }> {
  const last = [...cuts, split.forms - 1];
  const rowOf = (id: string): number | undefined => {
    const f = split.formOf(id);
    return f === undefined ? undefined : last.findIndex((end) => f <= end);
  };
  const rowGraphs: RenderGraph[] = last.map(() => ({ nodes: [], edges: [], diagnostics: graph.diagnostics }));
  for (const n of graph.nodes) {
    const r = n.id === split.page ? undefined : rowOf(n.id);
    for (const [k, g] of rowGraphs.entries()) if (r === undefined || r === k) g.nodes.push(n);
  }
  const links: { edge: RenderEdge; cut: number; upper: number }[] = [];
  for (const e of graph.edges) {
    const [ra, rb] = [rowOf(e.from.node), rowOf(e.to.node)];
    if (ra !== undefined && rb !== undefined && ra !== rb) {
      links.push({ edge: e, cut: last[Math.min(ra, rb)]!, upper: Math.min(ra, rb) });
      continue;
    }
    rowGraphs[ra ?? rb ?? 0]!.edges.push(e);
  }

  const rows: LaidOutGraph[] = [];
  for (const g of rowGraphs) rows.push(await layoutRow(g, sizes, engine, anchors));

  const out: LaidOutGraph = {
    width: 0,
    height: 0,
    boxes: new Map(),
    ports: new Map(),
    edges: new Map(),
    labels: new Map(),
    forks: [],
    bus: new Map(),
    crossings: [],
  };
  const pages: Box[] = [];
  let y = 0;
  for (const l of rows) {
    for (const [k, b] of l.boxes) out.boxes.set(k, shiftBox(b, y));
    for (const [k, p] of l.ports) out.ports.set(k, shiftPt(p, y));
    for (const [k, pts] of l.edges)
      out.edges.set(
        k,
        pts.map((p) => shiftPt(p, y)),
      );
    for (const [k, b] of l.labels) out.labels.set(k, shiftBox(b, y));
    for (const [k, pts] of l.bus)
      out.bus.set(
        k,
        pts.map((p) => shiftPt(p, y)),
      );
    out.forks.push(...l.forks.map((p) => shiftPt(p, y)));
    out.crossings.push(...l.crossings.map((p) => shiftPt(p, y)));
    pages.push(shiftBox(l.boxes.get(split.page)!, y));
    out.width = Math.max(out.width, l.width);
    y += l.height + ROW_GAP;
  }
  out.height = y - ROW_GAP;
  const [first, bottom] = [pages[0]!, pages.at(-1)!];
  out.boxes.set(split.page, {
    x: Math.min(...pages.map((p) => p.x)),
    y: first.y,
    width: Math.max(...pages.map((p) => p.x + p.width)) - Math.min(...pages.map((p) => p.x)),
    height: bottom.y + bottom.height - first.y,
  });

  const bad = new Set<number>();
  const blockers = graph.nodes.flatMap((n) => (n.id === split.page ? [] : (out.boxes.get(n.id) ?? [])));
  for (const [upper, group] of Map.groupBy(links, (l) => l.upper)) {
    const [hi, lo] = [pages[upper]!, pages[upper + 1]!];
    const centre = (hi.y + hi.height + lo.y) / 2;
    const ends = group.map((l) => ({
      from: endpoint(out, split.byId, l.edge.from, "out"),
      to: endpoint(out, split.byId, l.edge.to, "in"),
    }));
    // lanes: which line each connector takes at the right margin, in the gap, at the left margin
    const route = (lx: number[], lc: number[], ll: number[]): Point[][] =>
      ends.map(({ from, to }, k) => {
        const xr = hi.x + hi.width + LANE + LANE * lx[k]!;
        const xl = lo.x - LANE - LANE * ll[k]!;
        const ch = centre + 2 * LANE * (lc[k]! - (group.length - 1) / 2);
        return [from, { x: xr, y: from.y }, { x: xr, y: ch }, { x: xl, y: ch }, { x: xl, y: to.y }, to];
      });
    const options = permutations(group.length).flatMap((lx) =>
      permutations(group.length).flatMap((lc) => permutations(group.length).map((ll) => route(lx, lc, ll))),
    );
    // the first set of lanes where the fewest connectors touch (none, unless the ends swap order)
    const touching = (r: Point[][]): number =>
      r.reduce((n, a, i) => n + r.slice(i + 1).filter((b) => polylinesTouch(a, b)).length, 0);
    const scored = options.map((r) => ({ r, n: touching(r) }));
    const routes = scored.find((o) => o.n === Math.min(...scored.map((x) => x.n)))!.r;
    for (const [k, l] of group.entries()) {
      const pts = routes[k]!;
      if (crossesBox(pts, blockers)) bad.add(l.cut);
      out.edges.set(l.edge.id, pts);
      const text = edgeText(l.edge);
      if (text === undefined) continue;
      const size = sizes.get(edgeLabelKey(l.edge.id)) ?? fallbackLabel(text);
      const [a, b] = [pts[2]!, pts[3]!];
      out.labels.set(l.edge.id, {
        x: (a.x + b.x) / 2 - size.width / 2,
        y: a.y - size.height / 2,
        width: size.width,
        height: size.height,
      });
    }
  }
  return { laid: out, bad };
}

/** Where a wire across a cut meets a node: its port, else the middle of the node's side. */
function endpoint(
  laid: LaidOutGraph,
  byId: ReadonlyMap<string, RenderNode>,
  end: RenderEdge["from"],
  side: OrderSide,
): Point {
  const box = laid.boxes.get(end.node)!;
  const key = portKey(end.node, end.port === portIds.order ? ORDER[side] : end.port);
  const declared = byId.get(end.node)!.ports.some((p) => p.id === end.port) || end.port === portIds.order;
  const port = declared ? laid.ports.get(key) : undefined;
  return port ?? { x: side === "out" ? box.x + box.width : box.x, y: box.y + box.height / 2 };
}

/** One fan-out: 2+ consumers of one source port and kind, all under one container. */
interface Bus {
  /** The container the edges live in (the endpoints' lowest common ancestor); null: the root. */
  container: string | null;
  source: RenderEdge["from"];
  /** The source's column among the container's children (-1: the container's own port). */
  col: number;
  /** Input `y` of the junctions: the source's authored rank. */
  rank: number;
  /** The consumers, by the column of the container's child holding the target. */
  members: Hop[];
}

/** One branch of a bus: its wire, the chain of its target's ancestors (root first), `depth` the
 *  chain index of the node holding it at the current level, `pieces` the ELK edges it has so far. */
interface Hop {
  edge: RenderEdge;
  chain: string[];
  depth: number;
  pieces: string[];
}

/**
 * The fan-outs worth a bus (see BUS), in graph order. A consumer joins when its lifted node sits
 * strictly after the source (a frame's own port counts as before everything); a wire into the
 * container's own port, or into a branch's lanes, stays a plain edge.
 */
function fanOuts(
  routed: readonly RenderEdge[],
  byId: ReadonlyMap<string, RenderNode>,
  columns: { offset: ReadonlyMap<string, number> },
  rank: ReadonlyMap<string, number>,
): Bus[] {
  const groups = new Map<string, Bus>();
  for (const e of routed) {
    const [ca, cb] = [chainOf(byId, e.from.node), chainOf(byId, e.to.node)];
    let i = 0;
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
    if (i === cb.length) continue;
    const container = i === 0 ? null : ca[i - 1]!;
    const holder = container === null ? undefined : byId.get(container);
    if (holder?.kind === "frame" && holder.frame === "branch") continue;
    const own = i === ca.length;
    const col = columns.offset.get(cb[i]!) ?? 0;
    if (!own && col <= (columns.offset.get(ca[i]!) ?? 0)) continue;
    const key = `${container}\0${e.from.node}\0${e.from.port}\0${e.kind}`;
    const bus = groups.get(key) ?? {
      container,
      source: e.from,
      col: own ? -1 : (columns.offset.get(ca[i]!) ?? 0),
      rank: (own ? undefined : rank.get(ca[i]!)) ?? Number.POSITIVE_INFINITY,
      members: [],
    };
    bus.rank = own ? Math.min(bus.rank, (rank.get(cb[i]!) ?? 0) - 1) : bus.rank;
    bus.members.push({ edge: e, chain: cb, depth: i, pieces: [] });
    groups.set(key, bus);
  }
  return [...groups.values()].filter((b) => b.members.length >= 2);
}

/** A bus junction: a layout-only point, west port in, east port out, at column `col`. */
function junction(id: string, inPort: string, outPort: string, col: number, rank: number): ElkNode {
  const port = (pid: string, side: string): ElkPort => ({
    id: pid,
    width: 0,
    height: 0,
    y: 0.5,
    layoutOptions: { "elk.port.side": side },
  });
  return {
    id,
    x: col * COL_STEP,
    y: rank,
    width: 1,
    height: 1,
    ports: [port(inPort, "WEST"), port(outPort, "EAST")],
    layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
  };
}

const onPath = (path: readonly Point[], p: Point): boolean =>
  path.some((a, k) => k > 0 && segDist(p, path[k - 1]!, a) < 0.75);

const segDist = (p: Point, a: Point, b: Point): number => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Drops the middle point of three collinear ones and repeated points. */
function simplify(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1.5) continue;
    const prev = out.at(-2);
    if (prev && last && segDist(last, prev, p) < 0.5) out.pop();
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Each forked edge as its trunk sections up to its junction, then its fork, under its own id; the
 *  fork's label box moves to the edge; junctions and their edges vanish. */
function rebuildBuses(
  rebuilds: readonly { id: string; pieces: readonly string[] }[],
  hidden: { nodes: ReadonlySet<string>; edges: ReadonlySet<string>; ports: ReadonlySet<string> },
  laid: LaidOutGraph,
): void {
  const joined = rebuilds.map(({ id, pieces }) => ({
    id,
    pts: simplify(pieces.flatMap((k) => laid.edges.get(k) ?? [])),
    label: laid.labels.get(pieces.at(-1)!),
  }));
  for (const k of hidden.edges) {
    laid.edges.delete(k);
    laid.labels.delete(k);
  }
  for (const k of hidden.ports) laid.ports.delete(k);
  for (const j of hidden.nodes) {
    laid.boxes.delete(j);
    laid.ports.delete(portKey(j, "in"));
    laid.ports.delete(portKey(j, "out"));
  }
  for (const { id, pts, label } of joined) {
    laid.edges.set(id, pts);
    if (label) laid.labels.set(id, label);
  }
}

/** An entry port sits on its area's west border. An arm is stretched to its condition's border
 *  after layout, so its port (and the wires that end and start at it) move with it. */
function snapEntries(
  entries: ReadonlyMap<string, { unit: string; enter: string; starts: readonly string[] }>,
  laid: LaidOutGraph,
): void {
  for (const [port, { unit, enter, starts }] of entries) {
    const [p, box] = [laid.ports.get(port), laid.boxes.get(unit)];
    if (!p || !box || Math.abs(p.x - box.x) < 0.5) continue;
    const to = { x: box.x, y: p.y };
    laid.ports.set(port, to);
    const end = laid.edges.get(enter);
    if (end && end.length >= 2) {
      const before = end.at(-2)!;
      end.splice(-1, 1, ...(before.y === p.y && before.x <= to.x ? [to] : [p, to]));
    }
    for (const id of starts) {
      const pts = laid.edges.get(id);
      if (!pts || pts.length < 2) continue;
      const after = pts[1]!;
      pts.splice(0, 1, ...(after.y === p.y && after.x >= to.x ? [to] : [to, p]));
    }
  }
}

/** Where `p` leaves `q`: the last point of `p`'s run that `q` also draws (both start at the source). */
function leavesAt(p: readonly Point[], q: readonly Point[]): Point {
  let at = p[0]!;
  for (let k = 1; k < p.length; k++) {
    const [a, b] = [p[k - 1]!, p[k]!];
    if (!onPath(q, a)) break;
    if (onPath(q, b) && onPath(q, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) {
      at = b;
      continue;
    }
    at = a;
    for (const v of q)
      if (
        segDist(v, a, b) < 0.75 &&
        Math.hypot(v.x - a.x, v.y - a.y) > Math.hypot(at.x - a.x, at.y - a.y) &&
        onPath(q, { x: (a.x + v.x) / 2, y: (a.y + v.y) / 2 })
      )
        at = v;
    break;
  }
  return at;
}

/** `forks` and `bus` of the laid-out graph: for every pair of branches of a bus, the point where
 *  they part. */
function markForks(buses: readonly Bus[], laid: LaidOutGraph): void {
  for (const bus of buses) {
    const ids = bus.members.map((m) => m.edge.id).filter((id) => (laid.edges.get(id)?.length ?? 0) >= 2);
    const forks: Point[] = [];
    for (const a of ids)
      for (const b of ids) {
        if (a === b) continue;
        const f = leavesAt(laid.edges.get(a)!, laid.edges.get(b)!);
        if (!forks.some((q) => Math.hypot(q.x - f.x, q.y - f.y) < 1)) forks.push(f);
      }
    for (const id of ids) laid.bus.set(id, forks);
    laid.forks.push(...forks);
  }
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

/** Far larger than any box, like RANK_STEP: INTERACTIVE layers by the overlap of the nodes' x extents. */
const COL_STEP = 10_000;

/**
 * Column of every node (see COLUMNS): `offset` is the node's first column relative to its parent's
 * first column, `span` how many columns it covers (1 for a leaf and an empty frame).
 */
function columnsOf(
  graph: RenderGraph,
  edges: readonly RenderEdge[],
): { offset: Map<string, number>; span: Map<string, number> } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const kidsOf = new Map<string | null, string[]>();
  for (const n of graph.nodes) kidsOf.set(n.parent, [...(kidsOf.get(n.parent) ?? []), n.id]);

  // Lifted predecessors: an edge relates the siblings under its endpoints' lowest common ancestor.
  // When one endpoint holds the other (a frame's own port) it relates nothing.
  const before = new Map<string, Set<string>>();
  for (const e of edges) {
    const [ca, cb] = [chainOf(byId, e.from.node), chainOf(byId, e.to.node)];
    let i = 0;
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
    if (i === ca.length || i === cb.length) continue;
    before.set(cb[i]!, (before.get(cb[i]!) ?? new Set()).add(ca[i]!));
  }

  const offset = new Map<string, number>();
  const span = new Map<string, number>();
  const place = (parent: string | null): void => {
    const kids = kidsOf.get(parent) ?? [];
    const done = new Set<string>();
    let width = 1;
    while (done.size < kids.length) {
      const pending = kids.filter((k) => !done.has(k));
      const preds = (k: string): string[] => [...(before.get(k) ?? [])];
      // The earliest-authored child whose predecessors are all placed; on a cycle, the earliest one.
      const k = pending.find((c) => preds(c).every((p) => done.has(p))) ?? pending[0]!;
      const start = Math.max(
        0,
        ...preds(k)
          .filter((p) => done.has(p))
          .map((p) => offset.get(p)! + span.get(p)!),
      );
      offset.set(k, start);
      width = Math.max(width, start + span.get(k)!);
      done.add(k);
    }
    if (parent !== null) span.set(parent, width);
  };
  // Children first: a frame's span is the far end of its children.
  for (const n of graph.nodes.toReversed()) {
    place(n.id);
  }
  place(null);
  // A transform is as late as it can be: the column just before its first consumer. Chains settle
  // by repetition (a transform feeding a transform waits for the latter to move).
  const transforms = graph.nodes.filter((n) => n.kind === "transform");
  for (let pass = 0; pass < transforms.length; pass++) {
    let moved = false;
    for (const t of transforms) {
      let limit = Number.POSITIVE_INFINITY;
      for (const e of edges.filter((x) => x.from.node === t.id)) {
        const [ca, cb] = [chainOf(byId, e.from.node), chainOf(byId, e.to.node)];
        let i = 0;
        while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
        // only a plain sibling consumer bounds it; a frame's own port leaves the transform where it is
        limit = i === ca.length || i === cb.length || ca[i] !== t.id ? -1 : Math.min(limit, offset.get(cb[i]!)! - 1);
        if (limit < 0) break;
      }
      if (Number.isFinite(limit) && limit > offset.get(t.id)!) {
        offset.set(t.id, limit);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { offset, span };
}

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
function compound(n: RenderFrame, size: Size, headRoom: number, order: ReadonlySet<OrderSide>): ElkNode {
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

/**
 * OUT DOCKS: ELK puts a frame's `out` port at a corner of the border; the wire feeding it from
 * inside would then climb the frame's whole height. The port moves to the height of an inner
 * wire that feeds it, kept off the rounded corners: of the feeders' source rows and their middle,
 * the one that gives the fewest bends (ties: the last authored feeder's row — a sequence's value
 * is its last — then the middle). Structure alone decides it: ids, parents, ports and edges, laid
 * out. The inner wires end at the new port (straight along the row, else a channel run ending at
 * it, else a jog at the border), the wires that leave it start there, jogging back to ELK's
 * route. A route that would run through a node is not taken; if no row works the port stays where
 * ELK put it. A condition's own `out` stays where its arms tile it.
 */
function dockOut(
  graph: RenderGraph,
  routed: readonly RenderEdge[],
  byId: ReadonlyMap<string, RenderNode>,
  childrenOf: ReadonlyMap<string | null, RenderNode[]>,
  laid: LaidOutGraph,
): void {
  /** What a route from `from` must not run through: every node box but its own ancestors'. */
  const blockers = (from: string): Box[] => {
    const own = new Set(chainOf(byId, from));
    return graph.nodes.flatMap((n) => (own.has(n.id) || isPage(n) ? [] : (laid.boxes.get(n.id) ?? [])));
  };
  for (const frame of graph.nodes) {
    const box = laid.boxes.get(frame.id);
    if (frame.kind !== "frame" || frame.frame === "branch" || !childrenOf.has(frame.id) || isPage(frame) || !box)
      continue;
    let floor = box.y + FRAME_RADIUS;
    for (const port of frame.ports.filter((p) => p.side === "out")) {
      const key = portKey(frame.id, port.id);
      const old = laid.ports.get(key);
      const feeders = routed.filter(
        (e) =>
          e.to.node === frame.id &&
          e.to.port === port.id &&
          (laid.edges.get(e.id)?.length ?? 0) >= 2 &&
          e.from.node !== frame.id &&
          chainOf(byId, e.from.node).includes(frame.id),
      );
      if (!old || feeders.length === 0) continue;
      const rows = feeders.map((e) => laid.edges.get(e.id)![0]!.y);
      const [lo, hi] = [floor, Math.max(floor, box.y + box.height - FRAME_RADIUS)];
      const clamp = (y: number): number => Math.min(Math.max(y, lo), hi);
      const middle = clamp((Math.min(...rows) + Math.max(...rows)) / 2);
      const wanted = [...new Set([...rows.toReversed().map(clamp), middle])];
      let best: { y: number; docked: Map<string, Point[]>; bends: number } | undefined;
      for (const y of wanted) {
        const to = { x: old.x, y };
        const docked = new Map<string, Point[]>();
        for (const e of feeders) {
          const route = dockedFeeders(laid.edges.get(e.id)!, old, to).find(
            (r) => !crossesBox(r, blockers(e.from.node)),
          );
          if (route) docked.set(e.id, route);
        }
        if (docked.size < feeders.length) continue;
        const bends = [...docked.values()].reduce((n, r) => n + r.length, 0);
        if (!best || bends < best.bends) best = { y, docked, bends };
      }
      if (!best) continue;
      floor = best.y + 16;
      if (Math.abs(best.y - old.y) < 0.5) continue;
      const to = { x: old.x, y: best.y };
      laid.ports.set(key, to);
      for (const [id, pts] of best.docked) laid.edges.set(id, pts);
      for (const e of routed) {
        const pts = laid.edges.get(e.id);
        if (pts && pts.length >= 2 && e.from.node === frame.id && e.from.port === port.id)
          laid.edges.set(e.id, simplify(departure(pts, old, to)));
      }
    }
  }
}

/** Whether an orthogonal route runs through the inside of a box. */
function crossesBox(pts: readonly Point[], boxes: readonly Box[]): boolean {
  return pts.some((q, k) => {
    const p = pts[k - 1];
    if (!p) return false;
    const [x0, x1, y0, y1] = [Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(p.y, q.y), Math.max(p.y, q.y)];
    return boxes.some((b) => x0 < b.x + b.width - 0.5 && x1 > b.x + 0.5 && y0 < b.y + b.height - 0.5 && y1 > b.y + 0.5);
  });
}

/** An inner wire's route, ending at the moved port `to` (it ended at `old`): the ways to do it,
 *  straightest first. */
function dockedFeeders(pts: readonly Point[], old: Point, to: Point): Point[][] {
  const out: Point[][] = [];
  // the route's last point at the port's new height: from there the wire runs straight in
  for (let k = pts.length - 2; k >= 0; k--) {
    if (Math.abs(pts[k]!.y - to.y) < 0.5 && pts[k]!.x <= to.x) {
      out.push(simplify([...pts.slice(0, k + 1), to]));
      break;
    }
  }
  // a vertical channel run into the old row: the run just ends at the new one
  const [c, a] = [pts.at(-3), pts.at(-2)!];
  if (c && Math.abs(a.y - old.y) < 0.5 && Math.abs(c.x - a.x) < 0.5)
    out.push(simplify([...pts.slice(0, -2), { x: a.x, y: to.y }, to]));
  const jx = old.x + Math.sign(a.x - old.x) * Math.min(FRAME_PAD, Math.abs(a.x - old.x) / 2);
  out.push(simplify([...pts.slice(0, -1), { x: jx, y: old.y }, { x: jx, y: to.y }, to]));
  return out;
}

/** A wire leaving the moved port: it starts at `to`, jogging back to ELK's route from `old`. */
function departure(pts: readonly Point[], old: Point, to: Point): Point[] {
  const next = pts[1]!;
  if (Math.abs(next.x - old.x) < 0.5) return [to, ...pts.slice(1)];
  const jx = old.x + Math.sign(next.x - old.x) * Math.min(FRAME_PAD, Math.abs(next.x - old.x) / 2);
  return [to, { x: jx, y: to.y }, { x: jx, y: old.y }, ...pts.slice(1)];
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

/** Rough width of one monospace character of a port label or an expression pill. */
export const PORT_CHAR = 6.7;

const fallbackLabel = (text: string): Size => ({ width: Math.min(text.length, 34) * PORT_CHAR + 10, height: 20 });

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * What a loop return's label pill must stay clear of: the other wires' label boxes, every area
 * port's ring, and the room an area port's label may take on either side of its ring (the view
 * puts it outside or inside by the canvas edge, so both are kept free).
 */
function labelObstacles(graph: RenderGraph, laid: LaidOutGraph): Box[] {
  const out: Box[] = [...laid.labels.values()];
  for (const p of [...laid.ports.values(), ...laid.crossings])
    out.push({ x: p.x - 4, y: p.y - 4, width: 8, height: 8 });
  for (const n of graph.nodes) {
    if (n.kind !== "frame" || isPage(n) || n.frame === "call") continue;
    for (const port of n.ports) {
      const at = laid.ports.get(portKey(n.id, port.id));
      if (!at || !port.label || port.side === "control") continue;
      const room = port.label.length * PORT_CHAR + 10;
      out.push({ x: at.x - room, y: at.y - 18, width: 2 * room, height: 22 });
    }
  }
  return out;
}

/**
 * Where a loop return's pill sits: on the contour's bottom run — the one stretch no port, ring or
 * port label shares with it — centred, else the nearest spot along the run (clear of the rounded
 * corners) that touches none of `clear`, else the same under the run. The first free candidate in a fixed scan order, so the
 * place is a function of the geometry alone.
 */
function returnLabel(contour: readonly Point[], size: Size, clear: readonly Box[]): Box {
  const [a, b] = [contour.at(-4)!, contour.at(-3)!];
  const [lo, hi] = [
    Math.min(a.x, b.x) + FRAME_RADIUS + size.width / 2,
    Math.max(a.x, b.x) - FRAME_RADIUS - size.width / 2,
  ];
  const mid = (a.x + b.x) / 2;
  const at = (cx: number, dy: number): Box => ({
    x: cx - size.width / 2,
    y: a.y + dy - size.height / 2,
    width: size.width,
    height: size.height,
  });
  const free = (box: Box): boolean =>
    !clear.some((o) => overlaps(box, { x: o.x - 2, y: o.y - 2, width: o.width + 4, height: o.height + 4 }));
  // a run too crowded for the pill to fit along it: the pill hangs under it, a pill-height lower each time
  for (const dy of [0, 1, 2, 3].map((k) => k * (size.height + 2))) {
    if (lo >= hi) {
      if (free(at(mid, dy))) return at(mid, dy);
      continue;
    }
    for (let d = 0; mid - d >= lo || mid + d <= hi; d += 8) {
      for (const cx of d === 0 ? [mid] : [mid - d, mid + d])
        if (cx >= lo && cx <= hi && free(at(cx, dy))) return at(cx, dy);
    }
  }
  return at(mid, 0);
}

/** The loop frame that owns a `recur` edge: the nearest `loop` at or above its target. */
function loopOf(e: RenderEdge, byId: ReadonlyMap<string, RenderNode>): RenderNode | undefined {
  let loop: RenderNode | undefined = byId.get(e.to.node);
  while (loop && !(loop.kind === "frame" && loop.frame === "loop"))
    loop = loop.parent === null ? undefined : byId.get(loop.parent);
  return loop;
}

/** How far each return of one loop steps in from the border, per recur index. */
const RETURN_STEP = 6;

/**
 * The loop return as the loop area's contour: right border, bottom, left border, into the target
 * (the rising left-border run is where its label sits). The nearest `loop` frame at or above the
 * target owns it. A loop with several loop variables has one return each, nested: the return of
 * recur index `k` (authored param order) runs `k * RETURN_STEP` inside the border all the way
 * round, so the topmost param's return is the outermost. That order is the one that cannot cross
 * at the param ports: an inner return's hop into its port goes right, away from the outer
 * returns' rising runs. `count` returns share the loop; every hop ends at the innermost run's
 * x plus the arrowhead, so the arrows line up.
 */
function loopContour(
  e: RenderEdge,
  byId: ReadonlyMap<string, RenderNode>,
  laid: LaidOutGraph,
  index = 0,
  count = 1,
): Point[] | undefined {
  const loop = loopOf(e, byId);
  const box = loop && laid.boxes.get(loop.id);
  if (!box) return undefined;
  const fromBox = laid.boxes.get(e.from.node);
  const s =
    laid.ports.get(portKey(e.from.node, e.from.port)) ??
    (fromBox && { x: fromBox.x + fromBox.width, y: fromBox.y + fromBox.height / 2 });
  const toBox = laid.boxes.get(e.to.node);
  const t = laid.ports.get(portKey(e.to.node, e.to.port)) ?? (toBox && { x: toBox.x, y: toBox.y + toBox.height / 2 });
  if (!s || !t) return undefined;
  const inset = index * RETURN_STEP;
  const [left, right, bottom] = [box.x + inset, box.x + box.width - inset, box.y + box.height - inset];
  // Into the param port on the border: a short hop inward carries the arrowhead.
  const tip = t.x - box.x < 1 ? { x: box.x + 8 + (count - 1) * RETURN_STEP, y: t.y } : t;
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

  return {
    width: result.width ?? 0,
    height: result.height ?? 0,
    boxes,
    ports,
    edges,
    labels,
    forks: [],
    bus: new Map(),
    crossings: [],
  };
}

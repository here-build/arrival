import { describe, expect, it } from "vitest";

import { EASK, FIXTURES } from "../__fixtures__/render-graphs.js";
import { defaultEngine as engine } from "../elk-engine.js";
import { FRAME_PAD, layout, pathText, ROW_MIN, ROW_TARGET } from "../layout.js";
import {
  type Box,
  edgeLabelKey,
  type LaidOutGraph,
  portIds,
  type Point,
  portKey,
  type RenderEdge,
  type RenderFrame,
  type RenderGraph,
  type RenderNode,
  type RenderPort,
  type RenderStep,
  type Size,
} from "../types.js";

const sizesOf = (g: RenderGraph): Map<string, Size> =>
  new Map([
    ...g.nodes.map((n): [string, Size] => [
      n.id,
      n.kind === "step" ? { width: 140, height: 48 } : { width: 90, height: 24 },
    ]),
    ...g.edges.filter((e) => e.label).map((e): [string, Size] => [edgeLabelKey(e.id), { width: 80, height: 14 }]),
  ]);

const inside = (c: Box, p: Box): boolean =>
  c.x >= p.x && c.y >= p.y && c.x + c.width <= p.x + p.width && c.y + c.height <= p.y + p.height;

const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/** Whether an orthogonal polyline runs through the inside of any box. */
const crossesCard = (pts: readonly Point[], boxes: readonly Box[]): boolean =>
  pts.slice(1).some((q, k) => {
    const p = pts[k]!;
    const [x0, x1, y0, y1] = [Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(p.y, q.y), Math.max(p.y, q.y)];
    return boxes.some((b) => x0 < b.x + b.width - 0.5 && x1 > b.x + 0.5 && y0 < b.y + b.height - 0.5 && y1 > b.y + 0.5);
  });

/** Whether two orthogonal segments share a point. */
const touches = ([a, b]: [Point, Point], [c, d]: [Point, Point]): boolean =>
  Math.min(a.x, b.x) <= Math.max(c.x, d.x) &&
  Math.min(c.x, d.x) <= Math.max(a.x, b.x) &&
  Math.min(a.y, b.y) <= Math.max(c.y, d.y) &&
  Math.min(c.y, d.y) <= Math.max(a.y, b.y);

describe.each(Object.entries(FIXTURES))("layout(%s)", (_name, graph) => {
  let laid: LaidOutGraph;

  it("is a clean fixture (no diagnostics)", () => {
    expect(graph.diagnostics).toEqual({ unplacedInvocations: 0, droppedEdges: 0, notes: [] });
  });

  it("gives every node a box with positive size", async () => {
    laid = await layout(graph, sizesOf(graph), engine);
    for (const n of graph.nodes) {
      const b = laid.boxes.get(n.id);
      expect(b, n.id).toBeDefined();
      expect(b!.width).toBeGreaterThan(0);
      expect(b!.height).toBeGreaterThan(0);
    }
  });

  it("keeps every child box inside its parent frame box", () => {
    for (const n of graph.nodes) {
      if (n.parent === null) continue;
      expect(inside(laid.boxes.get(n.id)!, laid.boxes.get(n.parent)!), `${n.id} in ${n.parent}`).toBe(true);
    }
  });

  it("routes every edge from its source port to its target port", () => {
    for (const e of graph.edges.filter((x) => x.kind !== "recur")) {
      const pts = laid.edges.get(e.id);
      expect(pts, e.id).toBeDefined();
      expect(pts!.length).toBeGreaterThanOrEqual(2);
      const from = laid.ports.get(portKey(e.from.node, e.from.port));
      const to = laid.ports.get(portKey(e.to.node, e.to.port));
      if (from) expect(near(pts![0]!, from), `${e.id} start`).toBe(true);
      if (to) expect(near(pts![pts!.length - 1]!, to), `${e.id} end`).toBe(true);
    }
  });

  it("places every edge label inside the layout bounds", () => {
    for (const e of graph.edges.filter((x) => x.label && x.kind !== "recur")) {
      const b = laid.labels.get(e.id);
      expect(b, e.id).toMatchObject({ width: 80, height: 14 });
      expect(inside(b!, { x: 0, y: 0, width: laid.width, height: laid.height })).toBe(true);
      // ELK actually placed it next to its own route (an unplaced label sits at its container's origin).
      const c = { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
      const pts = laid.edges.get(e.id)!;
      const dist = Math.min(...pts.slice(1).map((q, i) => segDist(c, pts[i]!, q)));
      expect(dist, e.id).toBeLessThan(b!.width / 2 + 16);
    }
  });

  it("is deterministic: two layouts of the same graph agree on ids and boxes", async () => {
    const again = await layout(graph, sizesOf(graph), engine);
    expect([...again.boxes.keys()]).toEqual([...laid.boxes.keys()]);
    expect([...again.edges.keys()]).toEqual([...laid.edges.keys()]);
    expect([...again.boxes.values()]).toEqual([...laid.boxes.values()]);
  });
});

describe("layout edge cases", () => {
  it("lays out cross-frame edges (outer step → step two frames deep) without throwing", async () => {
    const g = FIXTURES.callInTrack;
    const cross: RenderGraph = {
      nodes: g.nodes,
      edges: [
        ...g.edges,
        {
          id: "cross",
          from: { node: "ask@3:13", port: portIds.out },
          to: { node: EASK, port: portIds.arg(0) },
          kind: "data",
        },
      ],
      diagnostics: g.diagnostics,
    };
    const laid = await layout(cross, sizesOf(cross), engine);
    expect(laid.edges.get("cross")!.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a node listed before its parent", async () => {
    const g: RenderGraph = {
      nodes: [
        {
          kind: "step",
          id: "s",
          parent: "f",
          span: "x@1:1",
          symbol: "x",
          instance: { key: "x@1:1", ordinals: [], span: "x@1:1" },
          input: [],
          output: { hasValue: false },
          state: "potential",
          ports: [],
        },
        { kind: "frame", id: "f", parent: null, span: "f", frame: "seq", label: "", state: "potential", ports: [] },
      ],
      edges: [],
      diagnostics: { unplacedInvocations: 0, droppedEdges: 0, notes: [] },
    };
    await expect(layout(g, new Map(), engine)).rejects.toThrow(/before its parent/);
  });
});

/** The siblings under the lowest common ancestor of an edge's endpoints; undefined when one holds the other. */
const lifted = (g: RenderGraph, e: RenderGraph["edges"][number]): [RenderNode, RenderNode] | undefined => {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const chain = (id: string): RenderNode[] => {
    const out: RenderNode[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parent === null ? undefined : byId.get(cur.parent)) out.unshift(cur);
    return out;
  };
  const [a, b] = [chain(e.from.node), chain(e.to.node)];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === a.length || i === b.length ? undefined : [a[i]!, b[i]!];
};

describe.each(Object.entries(FIXTURES))("columns(%s)", (_name, graph) => {
  it("sends every routed wire left to right: strictly across siblings, never back at a frame's own port", async () => {
    const laid = await layout(graph, sizesOf(graph), engine);
    const page = new Set(graph.nodes.filter((n) => n.kind === "frame" && n.parent === null).map((n) => n.id));
    for (const e of graph.edges.filter((x) => x.kind !== "recur")) {
      if (page.has(e.from.node) || page.has(e.to.node)) continue;
      const pts = laid.edges.get(e.id)!;
      expect(pts.at(-1)!.x, `${e.id} ends left of its start`).toBeGreaterThanOrEqual(pts[0]!.x);
      const sibs = lifted(graph, e);
      if (!sibs) continue;
      const [from, to] = sibs.map((n) => laid.boxes.get(n.id)!) as [Box, Box];
      expect(to.x, `${e.id}: ${sibs[1].id} not after ${sibs[0].id}`).toBeGreaterThanOrEqual(from.x + from.width);
    }
  });
});

describe("columns", () => {
  const step = (id: string, parent: string, i: number): RenderStep => ({
    kind: "step",
    id,
    parent,
    span: `s@${i + 1}:1`,
    symbol: "s",
    instance: { key: `s@${i + 1}:1`, ordinals: [], span: `s@${i + 1}:1` },
    input: [],
    output: { hasValue: false },
    state: "potential",
    ports: [
      { id: portIds.arg(0), side: "in" },
      { id: portIds.out, side: "out" },
    ],
  });
  const seq = (n: number): RenderGraph => ({
    nodes: [
      {
        kind: "frame",
        id: "seq",
        parent: null,
        span: "seq",
        frame: "seq",
        label: "program",
        state: "potential",
        ports: [],
      },
      ...Array.from({ length: n }, (_, i) => step(`s${i}`, "seq", i)),
    ],
    edges: [],
    diagnostics: { unplacedInvocations: 0, droppedEdges: 0, notes: [] },
  });

  // A chain this long cannot be one row (see ROWS): it breaks at clean cuts, each row left to right.
  const chain = (n: number): RenderGraph => {
    const g = seq(n);
    g.edges = Array.from({ length: n - 1 }, (_, i) => ({
      id: `o${i}`,
      from: { node: `s${i}`, port: portIds.out },
      to: { node: `s${i + 1}`, port: portIds.arg(0) },
      kind: "order" as const,
    }));
    return g;
  };

  it("lays a long seq chain out left to right in rows (it was one 6000-unit row before ROWS)", async () => {
    const n = 30;
    const g = chain(n);
    const laid = await layout(g, sizesOf(g), engine);
    const rowOf = (i: number): number => laid.boxes.get(`s${i}`)!.y;
    const starts = Array.from({ length: n }, (_, i) => i).filter((i) => i === 0 || rowOf(i) > rowOf(i - 1) + 1);
    expect(starts.length).toBeGreaterThan(1);
    for (let i = 0; i < n - 1; i++) {
      const [a, b] = [laid.boxes.get(`s${i}`)!, laid.boxes.get(`s${i + 1}`)!];
      if (starts.includes(i + 1)) {
        // a new row starts at the left edge, below the previous one
        expect(b.x, `s${i + 1} row start`).toBeLessThan(a.x);
        expect(b.y, `s${i + 1} below`).toBeGreaterThan(a.y + a.height);
      } else {
        expect(b.x, `s${i + 1}`).toBeGreaterThan(a.x + a.width);
        expect(Math.abs(b.y - a.y), `s${i + 1} row`).toBeLessThan(a.height);
      }
    }
    // each row stays within the target, plus the one card that overflowed it
    for (const [k, first] of starts.entries()) {
      const end = starts[k + 1] ?? n;
      const row = Array.from({ length: end - first }, (_, i) => laid.boxes.get(`s${first + i}`)!);
      const width = Math.max(...row.map((b) => b.x + b.width)) - row[0]!.x;
      expect(width, `row ${k}`).toBeLessThanOrEqual(ROW_TARGET + 140);
    }
    expect(laid.width).toBeLessThanOrEqual(ROW_TARGET + 140);
    expect(laid.height).toBeGreaterThan(laid.boxes.get("s0")!.height * starts.length);
  });

  it("draws a cut's wire as one channel: right of the upper row, back left in the gap, into the lower row", async () => {
    const g = chain(30);
    const laid = await layout(g, sizesOf(g), engine);
    const boxes = [...laid.boxes].filter(([id]) => id !== "seq").map(([, b]) => b);
    let connectors = 0;
    for (const e of g.edges) {
      const pts = laid.edges.get(e.id)!;
      const [a, z] = [pts[0]!, pts.at(-1)!];
      const from = laid.boxes.get(e.from.node)!;
      const to = laid.boxes.get(e.to.node)!;
      expect(a.x, `${e.id} leaves the east side`).toBeCloseTo(from.x + from.width, 0);
      expect(z.x, `${e.id} enters the west side`).toBeCloseTo(to.x, 0);
      if (z.x >= a.x) continue; // a wire inside a row
      connectors++;
      expect(pts.length, e.id).toBe(6);
      const [out, down, gap, back] = pts.slice(1, 5) as [Point, Point, Point, Point];
      expect(out.x).toBeGreaterThan(from.x + from.width);
      expect(down.x).toBe(out.x);
      expect(down.y).toBe(gap.y);
      expect(gap.y).toBeGreaterThan(from.y + from.height);
      expect(gap.y).toBeLessThan(to.y);
      expect(back.x).toBeLessThan(to.x);
      expect(back.x).toBe(gap.x);
      expect(crossesCard(pts, boxes), `${e.id} through a card`).toBe(false);
    }
    expect(connectors).toBeGreaterThan(0);
    // a wire inside a row runs strictly left to right
    for (const e of g.edges) {
      const pts = laid.edges.get(e.id)!;
      if (pts.at(-1)!.x >= pts[0]!.x)
        for (let k = 1; k < pts.length; k++) expect(pts[k]!.x).toBeGreaterThanOrEqual(pts[k - 1]!.x);
    }
  });

  it("is deterministic when it breaks into rows", async () => {
    const g = chain(30);
    const [a, b] = [await layout(g, sizesOf(g), engine), await layout(g, sizesOf(g), engine)];
    expect([...b.boxes]).toEqual([...a.boxes]);
    expect([...b.edges]).toEqual([...a.edges]);
    expect([a.width, a.height]).toEqual([b.width, b.height]);
  });

  it("does not break where the only clean cuts leave a row narrower than ROW_MIN", async () => {
    // every cut but the first and the last carries two data wires: those two cuts would make a one-card row
    const n = 30;
    const g = chain(n);
    for (const s of g.nodes) if (s.kind === "step") s.ports.push({ id: portIds.arg(1), side: "in" });
    g.edges = Array.from({ length: n - 1 }, (_, i) =>
      i === 0 || i === n - 2
        ? [g.edges[i]!]
        : [0, 1].map((k) => ({
            id: `d${i}.${k}`,
            from: { node: `s${i}`, port: portIds.out },
            to: { node: `s${i + 1}`, port: portIds.arg(k) },
            kind: "data" as const,
          })),
    ).flat();
    const laid = await layout(g, sizesOf(g), engine);
    expect(ROW_MIN).toBeGreaterThan(140 + 2 * FRAME_PAD);
    expect(laid.width).toBeGreaterThan(ROW_TARGET * 3);
    for (let i = 1; i < n; i++)
      expect(laid.boxes.get(`s${i}`)!.x, `s${i} right of s${i - 1}`).toBeGreaterThan(laid.boxes.get(`s${i - 1}`)!.x);
  });

  it("does not break where every cut carries two data wires", async () => {
    const n = 30;
    const g = chain(n);
    for (const s of g.nodes) if (s.kind === "step") s.ports.push({ id: portIds.arg(1), side: "in" });
    g.edges = Array.from({ length: n - 1 }, (_, i) =>
      [0, 1].map((k) => ({
        id: `d${i}.${k}`,
        from: { node: `s${i}`, port: portIds.out },
        to: { node: `s${i + 1}`, port: portIds.arg(k) },
        kind: "data" as const,
      })),
    ).flat();
    const laid = await layout(g, sizesOf(g), engine);
    expect(laid.width).toBeGreaterThan(ROW_TARGET * 3);
    for (let i = 0; i < n; i++)
      expect(laid.boxes.get(`s${i}`)!.x, `s${i} same row`).toBe(
        laid.boxes.get("s0")!.x + i * (laid.boxes.get("s1")!.x - laid.boxes.get("s0")!.x),
      );
  });

  it("breaks where a cut carries the order wire and one data wire, on lanes that do not touch", async () => {
    const n = 30;
    const g = chain(n);
    for (const s of g.nodes) if (s.kind === "step") s.ports.push({ id: portIds.arg(1), side: "in" });
    g.edges = Array.from({ length: n - 1 }, (_, i) => [
      { ...g.edges[i]!, from: { node: `s${i}`, port: portIds.order }, to: { node: `s${i + 1}`, port: portIds.order } },
      {
        id: `d${i}`,
        from: { node: `s${i}`, port: portIds.out },
        to: { node: `s${i + 1}`, port: portIds.arg(1) },
        kind: "data" as const,
      },
    ]).flat();
    // dock rows apart (the data wire above the order wire's middle at both ends), so the two start from different points and can nest
    const anchors = new Map(
      g.nodes.flatMap((x) => [
        [portKey(x.id, portIds.arg(0)), 12] as const,
        [portKey(x.id, portIds.arg(1)), 6] as const,
        [portKey(x.id, portIds.out), 12] as const,
      ]),
    );
    const laid = await layout(g, sizesOf(g), engine, anchors);
    const boxes = [...laid.boxes].filter(([id]) => id !== "seq").map(([, b]) => b);
    const cuts = Array.from({ length: n - 1 }, (_, i) => i).filter(
      (i) => laid.boxes.get(`s${i + 1}`)!.y > laid.boxes.get(`s${i}`)!.y + 1,
    );
    expect(cuts.length).toBeGreaterThan(0);
    for (const i of cuts) {
      const [o, d] = [laid.edges.get(g.edges[2 * i]!.id)!, laid.edges.get(`d${i}`)!];
      expect(crossesCard(o, boxes)).toBe(false);
      expect(crossesCard(d, boxes)).toBe(false);
      for (const [k, a] of o.entries())
        if (k > 0)
          for (const [m, b] of d.entries())
            if (m > 0) expect(touches([o[k - 1]!, a], [d[m - 1]!, b]), `cut ${i}`).toBe(false);
    }
  });

  it("puts the successor of an order edge between independent steps in a later column", async () => {
    const g = seq(3);
    g.edges = [
      { id: "o", from: { node: "s0", port: portIds.order }, to: { node: "s2", port: portIds.order }, kind: "order" },
    ];
    const laid = await layout(g, sizesOf(g), engine);
    const [a, b, c] = ["s0", "s1", "s2"].map((id) => laid.boxes.get(id)!) as [Box, Box, Box];
    expect(c.x).toBeGreaterThan(a.x + a.width);
    // the unrelated middle step has no predecessor: it shares the first column
    expect(b.x).toBeCloseTo(a.x, 0);
  });

  it("does not crash on a cycle among non-recur edges", async () => {
    const g = seq(2);
    g.edges = [
      { id: "ab", from: { node: "s0", port: portIds.out }, to: { node: "s1", port: portIds.arg(0) }, kind: "data" },
      { id: "ba", from: { node: "s1", port: portIds.out }, to: { node: "s0", port: portIds.arg(0) }, kind: "data" },
    ];
    const laid = await layout(g, sizesOf(g), engine);
    expect(laid.boxes.size).toBe(3);
  });
});

describe("collapsed frames", () => {
  it.each(Object.entries(FIXTURES))(
    "%s: every collapsed frame is laid out at exactly its measured size",
    async (_name, graph) => {
      const sizes = sizesOf(graph);
      const laid = await layout(graph, sizes, engine);
      for (const n of graph.nodes) {
        // An arm is always a lane, tiled to its condition; every other collapsed frame is a stub.
        if (n.kind !== "frame" || !n.collapsed || n.frame === "arm") continue;
        const box = laid.boxes.get(n.id)!;
        const size = sizes.get(n.id)!;
        expect(Math.abs(box.width - size.width), n.id).toBeLessThanOrEqual(1);
        expect(Math.abs(box.height - size.height), n.id).toBeLessThanOrEqual(1);
      }
    },
  );
});

// ── v3: areas, docks, transforms, the loop contour ──────────────────────────

const CLEAN = { unplacedInvocations: 0, droppedEdges: 0, notes: [] };
const OUT: RenderPort = { id: portIds.out, side: "out" };
const leafStep = (id: string, parent: string, args = 1): RenderStep => ({
  kind: "step",
  id,
  parent,
  span: id,
  symbol: id,
  instance: { key: id, ordinals: [], span: id },
  input: Array.from({ length: args }, (_, k) => ({ slot: `arg${k}`, source: `x${k}`, hasValue: false })),
  output: { hasValue: false },
  state: "potential",
  ports: [...Array.from({ length: args }, (_, k): RenderPort => ({ id: portIds.arg(k), side: "in" })), OUT],
});
const area = (
  id: string,
  parent: string | null,
  frame: RenderFrame["frame"],
  extra: Partial<RenderFrame> = {},
): RenderFrame => ({
  kind: "frame",
  id,
  parent,
  span: id,
  frame,
  label: id,
  state: "potential",
  ports: [],
  ...extra,
});
const sized = (g: RenderGraph, frameHead = 24): Map<string, Size> =>
  new Map(
    g.nodes.map((n: RenderNode): [string, Size] => [
      n.id,
      n.kind === "frame" ? { width: 90, height: n.frame === "arm" ? 16 : frameHead } : { width: 140, height: 80 },
    ]),
  );

describe("areas", () => {
  it("reserves a child area's head above its border: the head never overlaps the parent's top", async () => {
    const g: RenderGraph = {
      nodes: [area("root", null, "seq"), area("par", "root", "par"), leafStep("s", "par")],
      edges: [],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g, 30), engine);
    const par = laid.boxes.get("par")!;
    expect(par.y - 30).toBeGreaterThanOrEqual(laid.boxes.get("root")!.y);
    expect(laid.boxes.get("s")!.y - par.y).toBeGreaterThanOrEqual(FRAME_PAD);
  });

  it("tiles a condition with its lanes, in authored order, full width", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        area("b", "root", "branch", { ports: [{ id: portIds.control, side: "control" }, OUT] }),
        area("then", "b", "arm"),
        leafStep("t", "then"),
        area("elif", "b", "arm"),
        leafStep("test", "elif"),
        leafStep("u", "elif", 2),
        area("else", "b", "arm"),
        leafStep("v", "else"),
        leafStep("sel", "root"),
      ],
      // The first lane's only step feeds the condition's `out`, the second lane is two columns
      // deep: under a global layering the lanes would interleave and reorder.
      edges: [
        { id: "c", from: { node: "sel", port: "out" }, to: { node: "b", port: "control" }, kind: "control" },
        { id: "c2", from: { node: "test", port: "out" }, to: { node: "b", port: "control" }, kind: "control" },
        { id: "o", from: { node: "test", port: "out" }, to: { node: "u", port: portIds.arg(1) }, kind: "order" },
        ...["t", "u", "v"].map((id): RenderGraph["edges"][number] => ({
          id: `${id}-out`,
          from: { node: id, port: "out" },
          to: { node: "b", port: "out" },
          kind: "data",
        })),
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    const b = laid.boxes.get("b")!;
    const lanes = ["then", "elif", "else"].map((id) => laid.boxes.get(id)!);
    expect(lanes[0]!.y).toBeCloseTo(b.y);
    expect(lanes[1]!.y).toBeCloseTo(lanes[0]!.y + lanes[0]!.height);
    expect(lanes[2]!.y).toBeCloseTo(lanes[1]!.y + lanes[1]!.height);
    expect(lanes[2]!.y + lanes[2]!.height).toBeCloseTo(b.y + b.height);
    for (const l of lanes) expect(l).toMatchObject({ x: b.x, width: b.width });
    // each step stays in its lane, under the lane's title
    for (const [lane, step] of [
      ["then", "t"],
      ["elif", "test"],
      ["elif", "u"],
      ["else", "v"],
    ] as const) {
      expect(inside(laid.boxes.get(step)!, laid.boxes.get(lane)!), lane).toBe(true);
      expect(laid.boxes.get(step)!.y - laid.boxes.get(lane)!.y, lane).toBeGreaterThanOrEqual(16);
    }
  });

  it("docks a wire on the measured row: FIXED_POS ports at the anchored offsets", async () => {
    const g: RenderGraph = {
      nodes: [area("root", null, "seq"), leafStep("a", "root"), leafStep("b", "root", 2)],
      edges: [{ id: "ab", from: { node: "a", port: "out" }, to: { node: "b", port: portIds.arg(1) }, kind: "data" }],
      diagnostics: CLEAN,
    };
    const anchors = new Map([
      [portKey("a", portIds.arg(0)), 30],
      [portKey("a", "out"), 62],
      [portKey("b", portIds.arg(0)), 30],
      [portKey("b", portIds.arg(1)), 46],
      [portKey("b", "out"), 62],
    ]);
    const laid = await layout(g, sized(g), engine, anchors);
    const [a, b] = [laid.boxes.get("a")!, laid.boxes.get("b")!];
    expect(laid.ports.get(portKey("a", "out"))).toEqual({ x: a.x + a.width, y: a.y + 62 });
    expect(laid.ports.get(portKey("b", portIds.arg(1)))).toEqual({ x: b.x, y: b.y + 46 });
    const pts = laid.edges.get("ab")!;
    expect(near(pts[0]!, { x: a.x + a.width, y: a.y + 62 })).toBe(true);
    expect(near(pts.at(-1)!, { x: b.x, y: b.y + 46 })).toBe(true);
  });

  it("docks an order edge at the vertical middle: out of a step's east side, into an area's west side", async () => {
    const order = (id: string, from: string, to: string): RenderGraph["edges"][number] => ({
      id,
      from: { node: from, port: portIds.order },
      to: { node: to, port: portIds.order },
      kind: "order",
    });
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("a", "root"),
        area("par", "root", "par"),
        leafStep("p1", "par"),
        leafStep("p2", "par"),
        leafStep("z", "root"),
      ],
      edges: [order("a-par", "a", "par"), order("par-z", "par", "z")],
      diagnostics: CLEAN,
    };
    const anchors = new Map(
      ["a", "p1", "p2", "z"].flatMap((id) => [
        [portKey(id, portIds.arg(0)), 30] as const,
        [portKey(id, "out"), 62] as const,
      ]),
    );
    const laid = await layout(g, sized(g), engine, anchors);
    const mid = (id: string, side: "in" | "out") => {
      const b = laid.boxes.get(id)!;
      return { x: side === "in" ? b.x : b.x + b.width, y: b.y + b.height / 2 };
    };
    const into = laid.edges.get("a-par")!;
    expect(near(into[0]!, mid("a", "out")), "a's east middle").toBe(true);
    expect(near(into.at(-1)!, mid("par", "in")), "the area's west middle").toBe(true);
    const out = laid.edges.get("par-z")!;
    expect(near(out[0]!, mid("par", "out")), "the area's east middle").toBe(true);
    expect(near(out.at(-1)!, mid("z", "in")), "z's west middle").toBe(true);
    for (const pts of [into, out]) {
      for (const [i, p] of pts.slice(1).entries()) {
        expect(Math.abs(p.x - pts[i]!.x) < 0.5 || Math.abs(p.y - pts[i]!.y) < 0.5, "orthogonal").toBe(true);
      }
    }
  });

  it("lays out a transform block between producers and the consumer port", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("a", "root"),
        leafStep("b", "root"),
        {
          kind: "transform",
          id: "t",
          parent: "root",
          op: "+",
          text: "(+ a b)",
          state: "potential",
          hasValue: false,
          ports: [{ id: "in:0", side: "in" }, { id: "in:1", side: "in" }, OUT],
        },
        leafStep("c", "root"),
      ],
      edges: [
        { id: "a-t", from: { node: "a", port: "out" }, to: { node: "t", port: "in:0" }, kind: "data" },
        { id: "b-t", from: { node: "b", port: "out" }, to: { node: "t", port: "in:1" }, kind: "data" },
        { id: "t-c", from: { node: "t", port: "out" }, to: { node: "c", port: portIds.arg(0) }, kind: "data" },
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    const [a, t, c] = ["a", "t", "c"].map((id) => laid.boxes.get(id)!);
    expect(t!.x).toBeGreaterThan(a!.x + a!.width);
    expect(c!.x).toBeGreaterThan(t!.x + t!.width);
    expect(laid.ports.get(portKey("t", "in:0"))!.y).toBeLessThan(laid.ports.get(portKey("t", "in:1"))!.y);
  });
});

describe("the loop return", () => {
  const g: RenderGraph = {
    nodes: [
      area("root", null, "seq"),
      leafStep("seed", "root"),
      area("L", "root", "loop", { ports: [{ id: portIds.param("acc"), side: "in", label: "acc" }, OUT] }),
      leafStep("step", "L"),
      leafStep("after", "root"),
    ],
    edges: [
      { id: "in", from: { node: "seed", port: "out" }, to: { node: "L", port: portIds.param("acc") }, kind: "data" },
      {
        id: "use",
        from: { node: "L", port: portIds.param("acc") },
        to: { node: "step", port: portIds.arg(0) },
        kind: "data",
      },
      {
        id: "recur",
        from: { node: "step", port: "out" },
        to: { node: "L", port: portIds.param("acc") },
        kind: "recur",
      },
      { id: "out", from: { node: "step", port: "out" }, to: { node: "L", port: "out" }, kind: "data" },
      { id: "next", from: { node: "L", port: "out" }, to: { node: "after", port: portIds.arg(0) }, kind: "data" },
    ],
    diagnostics: CLEAN,
  };

  it("is the loop area's own contour: right border, bottom, left border, into the param port", async () => {
    const laid = await layout(g, sized(g), engine);
    const L = laid.boxes.get("L")!;
    const pts = laid.edges.get("recur")!;
    const from = laid.ports.get(portKey("step", "out"))!;
    const into = laid.ports.get(portKey("L", portIds.param("acc")))!;
    expect(pts[0]).toEqual(from);
    expect(pts.slice(1, 5)).toEqual([
      { x: L.x + L.width, y: from.y },
      { x: L.x + L.width, y: L.y + L.height },
      { x: L.x, y: L.y + L.height },
      { x: L.x, y: into.y },
    ]);
    // a short hop inward carries the arrowhead
    expect(pts[5]!.y).toBe(into.y);
    expect(pts[5]!.x).toBeGreaterThan(L.x);
  });
});

describe("a loop return's label", () => {
  const g: RenderGraph = {
    nodes: [
      area("root", null, "seq"),
      area("L", "root", "loop", {
        ports: [
          { id: portIds.param("attempt"), side: "in", label: "attempt" },
          { id: portIds.param("suspects"), side: "in", label: "suspects" },
          OUT,
        ],
      }),
      leafStep("step", "L", 2),
    ],
    edges: [
      {
        id: "count",
        from: { node: "L", port: portIds.param("attempt") },
        to: { node: "L", port: portIds.param("attempt") },
        kind: "recur",
        expr: "(+ attempt 1)",
      },
      {
        id: "again",
        from: { node: "step", port: "out" },
        to: { node: "L", port: portIds.param("suspects") },
        kind: "recur",
        expr: "(rest suspects)",
      },
    ],
    diagnostics: CLEAN,
  };
  const sizes = (stepWidth = 320): Map<string, Size> =>
    new Map([
      ...[...sized(g)].map(([id, s]): [string, Size] => [id, id === "step" ? { ...s, width: stepWidth } : s]),
      ...g.edges.map((e): [string, Size] => [edgeLabelKey(e.id), { width: 96, height: 18 }]),
    ]);

  it("sits on the contour's bottom run, clear of every port label and ring, and of its sibling return", async () => {
    const laid = await layout(g, sizes(), engine);
    const L = laid.boxes.get("L")!;
    const pills = ["count", "again"].map((id) => laid.labels.get(id)!);
    const portLabels = g.nodes
      .flatMap((n) => (n.kind === "frame" ? n.ports.map((p) => ({ n, p })) : []))
      .filter(({ p }) => p.label !== undefined)
      .map(({ n, p }) => ({ at: laid.ports.get(portKey(n.id, p.id))!, room: p.label!.length * 6.7 + 5 }));
    for (const pill of pills) {
      expect(pill.x, "inside the border").toBeGreaterThan(L.x);
      expect(pill.x + pill.width, "inside the border").toBeLessThan(L.x + L.width);
      expect(Math.abs(pill.y + pill.height / 2 - (L.y + L.height)), "on the bottom run").toBeLessThan(10);
      for (const { at, room } of portLabels) {
        const clear =
          pill.y + pill.height < at.y - 12 ||
          pill.y > at.y + 4 ||
          pill.x + pill.width < at.x - room ||
          pill.x > at.x + room;
        expect(clear, "a port label's room").toBe(true);
      }
      for (const p of laid.ports.values()) {
        const hit = p.x > pill.x && p.x < pill.x + pill.width && p.y > pill.y && p.y < pill.y + pill.height;
        expect(hit, "a ring").toBe(false);
      }
    }
    const [a, b] = pills as [Box, Box];
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(apart, "the two returns' pills").toBe(true);
  });

  it("hangs under a run too short for both pills rather than overlap", async () => {
    const laid = await layout(g, sizes(140), engine);
    const [a, b] = ["count", "again"].map((id) => laid.labels.get(id)!) as [Box, Box];
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(apart).toBe(true);
  });

  it("steps aside along the run for whatever is in the way, the same way every time", async () => {
    const [x, y] = [await layout(g, sizes(), engine), await layout(g, sizes(), engine)];
    expect(x.labels.get("count")).toEqual(y.labels.get("count"));
    expect(x.labels.get("again")).toEqual(y.labels.get("again"));
  });
});

describe("a frame's out port", () => {
  // `top` is a chain that feeds nothing, above the chain `a → b` whose `b` feeds `M`'s out.
  const g: RenderGraph = {
    nodes: [
      area("root", null, "seq"),
      area("M", "root", "par", { ports: [OUT] }),
      leafStep("top1", "M", 0),
      leafStep("top2", "M"),
      leafStep("a", "M", 0),
      leafStep("b", "M"),
      leafStep("after", "root"),
    ],
    edges: [
      { id: "t", from: { node: "top1", port: "out" }, to: { node: "top2", port: portIds.arg(0) }, kind: "data" },
      { id: "ab", from: { node: "a", port: "out" }, to: { node: "b", port: portIds.arg(0) }, kind: "data" },
      { id: "feed", from: { node: "b", port: "out" }, to: { node: "M", port: "out" }, kind: "data" },
      { id: "next", from: { node: "M", port: "out" }, to: { node: "after", port: portIds.arg(0) }, kind: "data" },
    ],
    diagnostics: CLEAN,
  };

  it("sits at the height of the wire that feeds it, not at a corner of the border", async () => {
    const laid = await layout(g, sized(g), engine);
    const port = laid.ports.get(portKey("M", "out"))!;
    const feed = laid.edges.get("feed")!;
    const M = laid.boxes.get("M")!;
    expect(port.x).toBeCloseTo(M.x + M.width);
    expect(port.y).toBeCloseTo(feed[0]!.y);
    expect(port.y).toBeGreaterThanOrEqual(Math.min(...feed.map((p) => p.y)));
    expect(port.y).toBeLessThanOrEqual(Math.max(...feed.map((p) => p.y)));
    expect(feed.at(-1)).toEqual(port);
    // and the wire out of it starts there
    expect(laid.edges.get("next")![0]).toEqual(port);
  });

  it("with several feeders sits within the span of their rows", async () => {
    const two: RenderGraph = {
      ...g,
      edges: [
        ...g.edges,
        { id: "feed2", from: { node: "top2", port: "out" }, to: { node: "M", port: "out" }, kind: "data" },
      ],
    };
    const laid = await layout(two, sized(two), engine);
    const port = laid.ports.get(portKey("M", "out"))!;
    const rows = ["feed", "feed2"].map((id) => laid.edges.get(id)![0]!.y);
    expect(port.y).toBeGreaterThanOrEqual(Math.min(...rows) - 0.5);
    expect(port.y).toBeLessThanOrEqual(Math.max(...rows) + 0.5);
    for (const id of ["feed", "feed2"]) expect(laid.edges.get(id)!.at(-1)).toEqual(port);
  });
});

describe("lanes at depth", () => {
  it("keeps authored lane order in a condition inside a loop body, an empty lane included", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("seed", "root"),
        area("L", "root", "loop", { ports: [{ id: portIds.param("d"), side: "in", label: "d" }, OUT] }),
        area("if", "L", "branch", { ports: [OUT] }),
        area("then", "if", "arm"),
        leafStep("critique", "then"),
        area("else", "if", "arm"),
      ],
      edges: [
        { id: "in", from: { node: "seed", port: "out" }, to: { node: "L", port: portIds.param("d") }, kind: "data" },
        {
          id: "use",
          from: { node: "L", port: portIds.param("d") },
          to: { node: "critique", port: portIds.arg(0) },
          kind: "data",
        },
        {
          id: "back",
          from: { node: "critique", port: "out" },
          to: { node: "L", port: portIds.param("d") },
          kind: "recur",
        },
        { id: "res", from: { node: "if", port: "out" }, to: { node: "L", port: "out" }, kind: "data" },
      ],
      diagnostics: CLEAN,
    };
    // a tall card in the first lane, a short empty second lane: ranks must not compare by size
    const sizes = new Map<string, Size>(
      [...sized(g)].map(([id, s]) => [id, id === "critique" ? { width: 160, height: 140 } : s]),
    );
    const laid = await layout(g, sizes, engine);
    expect(laid.boxes.get("then")!.y).toBeLessThan(laid.boxes.get("else")!.y);
    expect(inside(laid.boxes.get("critique")!, laid.boxes.get("then")!)).toBe(true);
  });
});

describe("a loop counter", () => {
  it("feeds its own param: the return is the contour alone, from the right border at the param's height", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        area("L", "root", "loop", { ports: [{ id: portIds.param("i"), side: "in", label: "i" }, OUT] }),
        leafStep("step", "L"),
      ],
      edges: [
        {
          id: "count",
          from: { node: "L", port: portIds.param("i") },
          to: { node: "L", port: portIds.param("i") },
          kind: "recur",
          expr: "(+ i 1)",
        },
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    const L = laid.boxes.get("L")!;
    const into = laid.ports.get(portKey("L", portIds.param("i")))!;
    expect(laid.edges.get("count")).toEqual([
      { x: L.x + L.width, y: into.y },
      { x: L.x + L.width, y: L.y + L.height },
      { x: L.x, y: L.y + L.height },
      { x: L.x, y: into.y },
      { x: L.x + 8, y: into.y },
    ]);
  });
});

describe("the page", () => {
  it("does not route a wire into the program's own `out` (it says only: the result)", async () => {
    const g: RenderGraph = {
      nodes: [area("root", null, "seq", { ports: [OUT] }), leafStep("a", "root")],
      edges: [{ id: "res", from: { node: "a", port: "out" }, to: { node: "root", port: "out" }, kind: "data" }],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    expect(laid.edges.has("res")).toBe(false);
    expect(laid.boxes.has("a")).toBe(true);
  });
});

describe("pathText", () => {
  it("prints a projection path the way the program reads it", () => {
    expect(pathText([{ field: ":url" }])).toBe(".url");
    expect(pathText([{ field: "items" }, { index: 2 }, { car: true }])).toBe(".items[2][0]");
  });
});

describe("a bus: one value feeding several consumers is one line that forks", () => {
  const edge = (id: string, from: string, to: string, arg: number, extra: Partial<RenderEdge> = {}): RenderEdge => ({
    id,
    from: { node: from, port: portIds.out },
    to: { node: to, port: portIds.arg(arg) },
    kind: "data",
    ...extra,
  });
  // `s` feeds a (column 1), b (column 2) and c (column 3); a → b → c is the ladder that makes the columns.
  const ladder: RenderGraph = {
    nodes: [
      area("root", null, "seq"),
      leafStep("s", "root", 0),
      leafStep("a", "root"),
      leafStep("b", "root", 2),
      leafStep("c", "root", 2),
    ],
    edges: [
      edge("s-a", "s", "a", 0),
      edge("a-b", "a", "b", 0),
      edge("b-c", "b", "c", 0),
      edge("s-b", "s", "b", 1, { path: [{ field: ":subject" }] }),
      edge("s-c", "s", "c", 1, { path: [{ field: ":id" }] }),
    ],
    diagnostics: CLEAN,
  };
  const withLabels = (g: RenderGraph): Map<string, Size> =>
    new Map([
      ...sized(g),
      ...g.edges.filter((e) => e.path).map((e): [string, Size] => [edgeLabelKey(e.id), { width: 60, height: 14 }]),
    ]);
  const forked = ["s-a", "s-b", "s-c"];
  const alongTo = (pts: readonly Point[], p: Point): number => {
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      if (segDist(p, pts[i - 1]!, pts[i]!) < 0.75) return run + Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y);
      run += len;
    }
    return Number.NaN;
  };

  it("draws ONE trunk: the polylines share their prefix, one horizontal track between the first and the last fork", async () => {
    const laid = await layout(ladder, withLabels(ladder), engine);
    const [a, b, c] = forked.map((id) => laid.edges.get(id)!) as [Point[], Point[], Point[]];
    const start = laid.ports.get(portKey("s", portIds.out))!;
    for (const pts of [a, b, c]) expect(near(pts[0]!, start)).toBe(true);
    // the branch to the farthest consumer runs along the trunk at least as far as every other fork
    const forks = laid.bus.get("s-c")!;
    expect(forks.length).toBeGreaterThanOrEqual(2);
    for (const f of forks) {
      const on = [a, b, c].filter((pts) => !Number.isNaN(alongTo(pts, f)));
      expect(on.length, `fork ${f.x},${f.y} sits on at least two branches`).toBeGreaterThanOrEqual(2);
    }
    const [x0, x1] = [Math.min(...forks.map((f) => f.x)), Math.max(...forks.map((f) => f.x))];
    const tracks = new Set<number>();
    for (const pts of [a, b, c])
      for (let i = 1; i < pts.length - 1; i++) {
        const [p, q] = [pts[i - 1]!, pts[i]!];
        if (Math.abs(p.y - q.y) < 0.5 && Math.max(p.x, q.x) > x0 + 1 && Math.min(p.x, q.x) < x1 - 1)
          tracks.add(Math.round(p.y));
      }
    expect(tracks.size).toBe(1);
  });

  it("exposes the fork points, and tells each edge which bus it is a branch of", async () => {
    const laid = await layout(ladder, withLabels(ladder), engine);
    expect(laid.forks.length).toBeGreaterThanOrEqual(2);
    for (const id of forked) expect(laid.bus.get(id), id).toBeDefined();
    expect(laid.bus.has("a-b")).toBe(false);
    for (const f of laid.bus.get("s-a")!) expect(laid.forks.some((g) => near(f, g))).toBe(true);
  });

  it("hangs a label on its own branch, after the fork, never the shared trunk", async () => {
    const laid = await layout(ladder, withLabels(ladder), engine);
    for (const id of ["s-b", "s-c"]) {
      const box = laid.labels.get(id);
      expect(box, id).toMatchObject({ width: 60, height: 14 });
      const [pts, forks] = [laid.edges.get(id)!, laid.bus.get(id)!];
      const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
      const dist = Math.min(...pts.slice(1).map((q, i) => segDist(centre, pts[i]!, q)));
      expect(dist, `${id} label beside its route`).toBeLessThan(box!.width / 2 + 16);
      // not left of the first fork: the part of the route before it belongs to every branch
      expect(centre.x + box!.width / 2, id).toBeGreaterThan(Math.min(...forks.map((f) => f.x)));
    }
    expect(laid.labels.has("s-a")).toBe(false);
  });

  it("keeps the junctions out of the result", async () => {
    const laid = await layout(ladder, withLabels(ladder), engine);
    const ids = new Set(ladder.nodes.map((n) => n.id));
    expect([...laid.boxes.keys()].filter((k) => !ids.has(k))).toEqual([]);
    expect([...laid.ports.keys()].filter((k) => !ids.has(k.split("::")[0]!))).toEqual([]);
    expect([...laid.edges.keys()].filter((k) => !ladder.edges.some((e) => e.id === k))).toEqual([]);
    expect([...laid.labels.keys()].filter((k) => !ladder.edges.some((e) => e.id === k))).toEqual([]);
  });

  it("costs no column: the junctions sit in the columns the chain already has", async () => {
    const chain: RenderGraph = { ...ladder, edges: ladder.edges.filter((e) => !["s-b", "s-c"].includes(e.id)) };
    const [bus, plain] = await Promise.all([
      layout(ladder, sized(ladder), engine),
      layout(chain, sized(chain), engine),
    ]);
    expect(bus.width).toBeLessThanOrEqual(plain.width + 1);
  });

  it("is deterministic: two layouts agree on every route and fork", async () => {
    const [x, y] = await Promise.all([
      layout(ladder, withLabels(ladder), engine),
      layout(ladder, withLabels(ladder), engine),
    ]);
    expect([...y.edges]).toEqual([...x.edges]);
    expect(y.forks).toEqual(x.forks);
  });

  it("leaves a single-consumer wire out of every bus", async () => {
    const g: RenderGraph = { ...ladder, edges: ladder.edges.slice(0, 3) };
    const laid = await layout(g, sized(g), engine);
    expect(laid.forks).toEqual([]);
    expect(laid.bus.size).toBe(0);
  });

  it("forks off a frame's own port: a param feeding several children is one line", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("src", "root", 0),
        area("map", "root", "par", { ports: [{ id: portIds.param("x"), side: "in", label: "x" }] }),
        leafStep("p", "map"),
        leafStep("q", "map", 2),
        leafStep("r", "map", 2),
      ],
      edges: [
        { id: "in", from: { node: "src", port: "out" }, to: { node: "map", port: portIds.param("x") }, kind: "data" },
        {
          id: "x-p",
          from: { node: "map", port: portIds.param("x") },
          to: { node: "p", port: portIds.arg(0) },
          kind: "data",
        },
        edge("p-q", "p", "q", 0),
        edge("q-r", "q", "r", 0),
        {
          id: "x-q",
          from: { node: "map", port: portIds.param("x") },
          to: { node: "q", port: portIds.arg(1) },
          kind: "data",
        },
        {
          id: "x-r",
          from: { node: "map", port: portIds.param("x") },
          to: { node: "r", port: portIds.arg(1) },
          kind: "data",
        },
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    for (const id of ["x-p", "x-q", "x-r"]) expect(laid.bus.has(id), id).toBe(true);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect([...laid.boxes.keys()].filter((k) => !ids.has(k))).toEqual([]);
    for (const id of ["x-p", "x-q", "x-r"]) {
      const pts = laid.edges.get(id)!;
      expect(near(pts[0]!, laid.ports.get(portKey("map", portIds.param("x")))!), id).toBe(true);
      expect(near(pts.at(-1)!, laid.ports.get(portKey(id.slice(2), portIds.arg(id === "x-p" ? 0 : 1)))!), id).toBe(
        true,
      );
    }
  });
});

describe("a transform sits as late as it can", () => {
  const transform = (id: string, parent: string, ins: number): RenderNode => ({
    kind: "transform",
    id,
    parent,
    op: "list",
    text: `(${id})`,
    state: "potential",
    hasValue: false,
    ports: [...Array.from({ length: ins }, (_, k): RenderPort => ({ id: `in:${k}`, side: "in" })), OUT],
  });
  const data = (id: string, from: [string, string], to: [string, string]): RenderEdge => ({
    id,
    from: { node: from[0], port: from[1] },
    to: { node: to[0], port: to[1] },
    kind: "data",
  });

  it("is the column just before its consumer, not right after its inputs", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("a", "root", 0),
        leafStep("b", "root"),
        leafStep("c", "root"),
        transform("t", "root", 1),
        leafStep("d", "root", 2),
      ],
      edges: [
        data("a-b", ["a", "out"], ["b", portIds.arg(0)]),
        data("b-c", ["b", "out"], ["c", portIds.arg(0)]),
        data("c-d", ["c", "out"], ["d", portIds.arg(0)]),
        data("a-t", ["a", "out"], ["t", "in:0"]),
        data("t-d", ["t", "out"], ["d", portIds.arg(1)]),
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    const [a, b, c, t, d] = ["a", "b", "c", "t", "d"].map((id) => laid.boxes.get(id)!) as [Box, Box, Box, Box, Box];
    expect(t.x).toBeGreaterThanOrEqual(c.x - 1);
    expect(t.x).toBeGreaterThan(b.x + b.width);
    expect(d.x).toBeGreaterThan(t.x + t.width);
    expect(a.x + a.width).toBeLessThan(t.x);
  });

  it("settles a chain: a transform feeding a transform waits for the latter", async () => {
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("a", "root", 0),
        leafStep("b", "root"),
        leafStep("c", "root"),
        transform("t1", "root", 1),
        transform("t2", "root", 1),
        leafStep("d", "root", 2),
      ],
      edges: [
        data("a-b", ["a", "out"], ["b", portIds.arg(0)]),
        data("b-c", ["b", "out"], ["c", portIds.arg(0)]),
        data("c-d", ["c", "out"], ["d", portIds.arg(0)]),
        data("a-t1", ["a", "out"], ["t1", "in:0"]),
        data("t1-t2", ["t1", "out"], ["t2", "in:0"]),
        data("t2-d", ["t2", "out"], ["d", portIds.arg(1)]),
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    const [b, c, t1, t2, d] = ["b", "c", "t1", "t2", "d"].map((id) => laid.boxes.get(id)!) as [Box, Box, Box, Box, Box];
    expect(t2.x).toBeGreaterThanOrEqual(c.x - 1);
    expect(t1.x).toBeGreaterThan(b.x - 1);
    expect(t2.x).toBeGreaterThan(t1.x + t1.width);
    expect(d.x).toBeGreaterThan(t2.x + t2.width);
  });
});

/** Collinear overlap of two polylines, in px: how far a segment of `a` lies on a segment of `b`. */
const overlapLen = (a: readonly Point[], b: readonly Point[]): number => {
  let sum = 0;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1]!, a[i]!, b[j - 1]!, b[j]!];
      if (Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - s.y) < 0.5 && Math.abs(p.y - r.y) < 0.5)
        sum += Math.max(
          0,
          Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)),
        );
      if (Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - s.x) < 0.5 && Math.abs(p.x - r.x) < 0.5)
        sum += Math.max(
          0,
          Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)),
        );
    }
  return sum;
};

/** The part of `a` after it first leaves `b`: its polyline from the first segment not lying on `b`. */
const afterLeaving = (a: readonly Point[], b: readonly Point[]): Point[] => {
  const onB = (p: Point): boolean => b.some((q, k) => k > 0 && segDist(p, b[k - 1]!, q) < 0.75);
  for (let i = 1; i < a.length; i++)
    if (!onB(a[i]!) || !onB({ x: (a[i]!.x + a[i - 1]!.x) / 2, y: (a[i]!.y + a[i - 1]!.y) / 2 })) return a.slice(i - 1);
  return [];
};

describe("a bus enters a child area once", () => {
  const data = (id: string, from: string, to: string, arg: number): RenderEdge => ({
    id,
    from: { node: from, port: portIds.out },
    to: { node: to, port: portIds.arg(arg) },
    kind: "data",
  });
  // `s` feeds x1 (column 1) and p, q, r inside `F`, which `x2 → p` pushes to column 3: the consumers in
  // `F` all lift to F's one column.
  const g: RenderGraph = {
    nodes: [
      area("root", null, "seq"),
      leafStep("s", "root", 0),
      leafStep("x1", "root"),
      leafStep("x2", "root"),
      area("F", "root", "par"),
      leafStep("p", "F", 2),
      leafStep("q", "F"),
      leafStep("r", "F"),
    ],
    edges: [
      data("s-x1", "s", "x1", 0),
      data("x1-x2", "x1", "x2", 0),
      data("x2-p", "x2", "p", 0),
      data("s-p", "s", "p", 1),
      data("s-q", "s", "q", 0),
      data("s-r", "s", "r", 0),
    ],
    diagnostics: CLEAN,
  };

  it("crosses the area's west border ONCE for all its consumers, and forks inside", async () => {
    const laid = await layout(g, sized(g), engine);
    const F = laid.boxes.get("F")!;
    expect(laid.crossings).toHaveLength(1);
    const ring = laid.crossings[0]!;
    expect(ring.x).toBeCloseTo(F.x);
    expect(ring.y).toBeGreaterThan(F.y);
    expect(ring.y).toBeLessThan(F.y + F.height);
    for (const id of ["s-p", "s-q", "s-r"]) {
      const pts = laid.edges.get(id)!;
      expect(
        pts.slice(1).some((q, i) => segDist(ring, pts[i]!, q) < 0.75),
        `${id} passes the ring`,
      ).toBe(true);
      expect(near(pts.at(-1)!, laid.ports.get(portKey(id.slice(2), portIds.arg(id === "s-p" ? 1 : 0)))!), id).toBe(
        true,
      );
    }
    // only the junction-free ports of the real graph remain
    const ids = new Set(g.nodes.map((n) => n.id));
    expect([...laid.ports.keys()].filter((k) => !ids.has(k.split("::")[0]!))).toEqual([]);
    expect([...laid.boxes.keys()].filter((k) => !ids.has(k))).toEqual([]);
  });

  it("runs into the ring along one line: the branches share the whole run before it", async () => {
    const laid = await layout(g, sized(g), engine);
    const ring = laid.crossings[0]!;
    // every branch to F runs through the ring on the same horizontal line
    const runs = ["s-p", "s-q", "s-r"].map((id) => {
      const pts = laid.edges.get(id)!;
      const k = pts.findIndex((p, i) => i > 0 && segDist(ring, pts[i - 1]!, p) < 0.75);
      return pts.slice(0, k + 1).at(-2)!.y;
    });
    expect(new Set(runs.map((y) => Math.round(y))).size).toBe(1);
  });

  it("enters a condition per lane: a ring on each arm that holds 2+ consumers, none on the others", async () => {
    const c: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("s", "root", 0),
        leafStep("x", "root"),
        area("B", "root", "branch", { ports: [{ id: portIds.control, side: "control" }, OUT] }),
        area("A0", "B", "arm"),
        leafStep("p", "A0", 2),
        leafStep("q", "A0"),
        area("A1", "B", "arm"),
        leafStep("r", "A1"),
      ],
      edges: [
        data("s-x", "s", "x", 0),
        { id: "c", from: { node: "x", port: "out" }, to: { node: "B", port: "control" }, kind: "control" },
        data("s-p", "s", "p", 0),
        data("s-q", "s", "q", 0),
        data("s-r", "s", "r", 0),
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(c, sized(c), engine);
    expect(laid.crossings).toHaveLength(1);
    const A0 = laid.boxes.get("A0")!;
    expect(laid.crossings[0]!.x).toBeCloseTo(A0.x);
    expect(laid.crossings[0]!.y).toBeGreaterThanOrEqual(A0.y);
    expect(laid.crossings[0]!.y).toBeLessThanOrEqual(A0.y + A0.height);
  });

  it("is deterministic", async () => {
    const [x, y] = await Promise.all([layout(g, sized(g), engine), layout(g, sized(g), engine)]);
    expect(y.crossings).toEqual(x.crossings);
    expect([...y.edges]).toEqual([...x.edges]);
  });
});

describe.each(Object.entries(FIXTURES))("the branches of a bus(%s)", (_name, graph) => {
  it("never overlap or run in parallel once they have left each other", async () => {
    const laid = await layout(graph, sizesOf(graph), engine);
    const groups = new Set(laid.bus.values());
    for (const forks of groups) {
      const ids = [...laid.bus].filter(([, f]) => f === forks).map(([id]) => id);
      for (const a of ids)
        for (const b of ids) {
          if (a >= b) continue;
          const [pa, pb] = [laid.edges.get(a)!, laid.edges.get(b)!];
          const [ra, rb] = [afterLeaving(pa, pb), afterLeaving(pb, pa)];
          expect(overlapLen(ra, rb), `${a} and ${b}`).toBeLessThan(1);
        }
    }
  });
});

describe("a bus (targeted): consumers lifted into one later frame leave the trunk at one junction", () => {
  it("leave together, before the frame: no branch drops early and rejoins a shared run", async () => {
    // `s` is in column 0; the frame is four columns on. Its three consumers lift to it.
    const e = (id: string, to: string, arg: number): RenderEdge => ({
      id,
      from: { node: "s", port: portIds.out },
      to: { node: to, port: portIds.arg(arg) },
      kind: "data",
    });
    const chain = (id: string, from: string, to: string): RenderEdge => ({
      id,
      from: { node: from, port: portIds.out },
      to: { node: to, port: portIds.arg(0) },
      kind: "data",
    });
    const g: RenderGraph = {
      nodes: [
        area("root", null, "seq"),
        leafStep("s", "root", 0),
        leafStep("a", "root"),
        leafStep("b", "root"),
        leafStep("c", "root"),
        area("B", "root", "branch", { ports: [{ id: portIds.control, side: "control" }, OUT] }),
        area("A0", "B", "arm"),
        leafStep("p", "A0", 2),
        area("A1", "B", "arm"),
        leafStep("q", "A1", 2),
        area("A2", "B", "arm"),
        leafStep("r", "A2", 2),
      ],
      edges: [
        chain("s-a", "s", "a"),
        chain("a-b", "a", "b"),
        chain("b-c", "b", "c"),
        { id: "c-B", from: { node: "c", port: "out" }, to: { node: "B", port: "control" }, kind: "control" },
        e("s-p", "p", 1),
        e("s-q", "q", 1),
        e("s-r", "r", 1),
      ],
      diagnostics: CLEAN,
    };
    const laid = await layout(g, sized(g), engine);
    const B = laid.boxes.get("B")!;
    // the branches part only in the gap just before B (after the last step before it), never early
    const c = laid.boxes.get("c")!;
    const src = laid.boxes.get("s")!;
    // (the jog off the source port itself, a few px right of it, is not a fork of interest)
    const forks = laid.bus.get("s-p")!.filter((f) => f.x > src.x + src.width + 20);
    expect(forks.length).toBeGreaterThanOrEqual(1);
    for (const f of forks) {
      expect(f.x, "fork after c").toBeGreaterThan(c.x + c.width);
      expect(f.x, "fork before B").toBeLessThan(B.x);
    }
    // ... and the branches that left share no run
    const [p, q, r] = ["s-p", "s-q", "s-r"].map((id) => laid.edges.get(id)!) as [Point[], Point[], Point[]];
    for (const [x, y] of [
      [p, q],
      [p, r],
      [q, r],
    ] as const)
      expect(overlapLen(afterLeaving(x, y), afterLeaving(y, x))).toBeLessThan(1);
  });
});

describe("loop returns nest", () => {
  const param = (name: string): RenderPort => ({ id: portIds.param(name), side: "in", label: name });
  const g: RenderGraph = {
    nodes: [
      area("root", null, "seq"),
      leafStep("seed", "root", 0),
      area("L", "root", "loop", { ports: [param("a"), param("b"), OUT] }),
      leafStep("s1", "L"),
      leafStep("s2", "L"),
    ],
    edges: [
      { id: "ina", from: { node: "seed", port: "out" }, to: { node: "L", port: portIds.param("a") }, kind: "data" },
      { id: "inb", from: { node: "seed", port: "out" }, to: { node: "L", port: portIds.param("b") }, kind: "data" },
      {
        id: "ua",
        from: { node: "L", port: portIds.param("a") },
        to: { node: "s1", port: portIds.arg(0) },
        kind: "data",
      },
      {
        id: "ub",
        from: { node: "L", port: portIds.param("b") },
        to: { node: "s2", port: portIds.arg(0) },
        kind: "data",
      },
      // authored the other way round: the nesting follows the params, not the edges' order
      { id: "rb", from: { node: "s2", port: "out" }, to: { node: "L", port: portIds.param("b") }, kind: "recur" },
      { id: "ra", from: { node: "s1", port: "out" }, to: { node: "L", port: portIds.param("a") }, kind: "recur" },
    ],
    diagnostics: CLEAN,
  };

  it("share no segment: each loop variable's return is its own line", async () => {
    const laid = await layout(g, sized(g), engine);
    const [ra, rb] = [laid.edges.get("ra")!, laid.edges.get("rb")!];
    expect(overlapLen(ra, rb)).toBe(0);
    const L = laid.boxes.get("L")!;
    // the first param's return is outermost: on the border; the second steps in
    expect(ra.some((p) => Math.abs(p.x - L.x) < 0.5)).toBe(true);
    expect(rb.every((p) => p.x > L.x + 1 || p.y < L.y)).toBe(true);
    expect(Math.max(...rb.map((p) => p.y))).toBeLessThan(Math.max(...ra.map((p) => p.y)));
    expect(Math.max(...rb.map((p) => p.x))).toBeLessThan(Math.max(...ra.map((p) => p.x)));
  });

  it("do not cross: the topmost param's return is outermost, every hop goes inward past all the rising runs", async () => {
    const laid = await layout(g, sized(g), engine);
    const [ra, rb] = [laid.edges.get("ra")!, laid.edges.get("rb")!];
    const crossings = (p: readonly Point[], q: readonly Point[]): number => {
      let n = 0;
      for (let i = 1; i < p.length; i++)
        for (let j = 1; j < q.length; j++) {
          const [a, b, c, d] = [p[i - 1]!, p[i]!, q[j - 1]!, q[j]!];
          const [ah, ch] = [Math.abs(a.y - b.y) < 0.5, Math.abs(c.y - d.y) < 0.5];
          if (ah === ch) continue;
          const [h0, h1, v0, v1] = ah ? [a, b, c, d] : [c, d, a, b];
          if (
            v0.x > Math.min(h0.x, h1.x) + 0.5 &&
            v0.x < Math.max(h0.x, h1.x) - 0.5 &&
            h0.y > Math.min(v0.y, v1.y) + 0.5 &&
            h0.y < Math.max(v0.y, v1.y) - 0.5
          )
            n++;
        }
      return n;
    };
    // the producers' rows are in authored order too (s1 above s2), so the whole nest is crossing-free
    expect(crossings(ra, rb)).toBe(0);
    const [into1, into2] = [
      laid.ports.get(portKey("L", portIds.param("a")))!,
      laid.ports.get(portKey("L", portIds.param("b")))!,
    ];
    expect(into1.y).toBeLessThan(into2.y);
    expect(ra.at(-1)!.y).toBeCloseTo(into1.y);
    expect(rb.at(-1)!.y).toBeCloseTo(into2.y);
  });
});

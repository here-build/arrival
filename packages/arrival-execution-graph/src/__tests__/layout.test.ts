import { describe, expect, it } from "vitest";

import { EASK, FIXTURES } from "../__fixtures__/render-graphs.js";
import { defaultEngine as engine } from "../elk-engine.js";
import { FRAME_PAD, layout, pathText } from "../layout.js";
import {
  type Box,
  edgeLabelKey,
  type LaidOutGraph,
  portIds,
  portKey,
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

describe("layout wrapping", () => {
  it("wraps a long seq chain instead of laying it out as one row", async () => {
    const n = 30;
    const g: RenderGraph = {
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
        ...Array.from({ length: n }, (_, i) => ({
          kind: "step" as const,
          id: `s${i}`,
          parent: "seq",
          span: `s@${i + 1}:1`,
          symbol: "s",
          instance: { key: `s@${i + 1}:1`, ordinals: [], span: `s@${i + 1}:1` },
          input: [],
          output: { hasValue: false },
          state: "potential" as const,
          ports: [
            { id: portIds.arg(0), side: "in" as const },
            { id: portIds.out, side: "out" as const },
          ],
        })),
      ],
      edges: Array.from({ length: n - 1 }, (_, i) => ({
        id: `o${i}`,
        from: { node: `s${i}`, port: portIds.out },
        to: { node: `s${i + 1}`, port: portIds.arg(0) },
        kind: "order" as const,
      })),
      diagnostics: { unplacedInvocations: 0, droppedEdges: 0, notes: [] },
    };
    const laid = await layout(g, sizesOf(g), engine);
    expect(Number.isFinite(laid.width) && Number.isFinite(laid.height)).toBe(true);
    expect(laid.width).toBeLessThan(2 * laid.height);
    for (const b of laid.boxes.values()) expect([b.x, b.y, b.width, b.height].every(Number.isFinite)).toBe(true);
    for (const pts of laid.edges.values())
      expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
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

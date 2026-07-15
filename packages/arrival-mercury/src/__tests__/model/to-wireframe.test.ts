/**
 * toWireframe's own contract (T7a). FIXTURE-FIRST, same discipline as
 * model/circuit-sexpr.test.ts: every circuit below is HAND-BUILT (never
 * produced by calling `extract`), and `site` is irrelevant to any check here
 * beyond identity — every node shares one dummy NodeId.
 */
import { describe, expect, it } from "vitest";

import type { NodeId } from "../../coreform/types.js";
import { toWireframe, type WireframeSideMaps } from "../../model/to-wireframe.js";
import type {
  BuildProv,
  ChoiceProv,
  CollapseKind,
  ConstProv,
  FanProv,
  FusedProv,
  Integrity,
  InputProv,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "../../model/static-prov.js";

const S = 0 as NodeId;

const input = (name: string): InputProv => ({ kind: "input", site: S, name });
const mint = (head: string, integrity: Integrity, closed: readonly StaticProv[] = []): MintProv => ({
  kind: "mint",
  site: S,
  head,
  integrity,
  closed,
});
const konst = (): ConstProv => ({ kind: "const", site: S });
const fused = (...sources: StaticProv[]): FusedProv => ({ kind: "fused", site: S, sources });
const muxOf = (k: string | number | null, source: StaticProv): MuxProv => ({ kind: "mux", site: S, key: k, source });
const build = (ctor: BuildProv["ctor"], parts: BuildProv["parts"]): BuildProv => ({ kind: "build", site: S, ctor, parts });
const stringOf = (...runs: StaticProv[]): StringProv => ({ kind: "string", site: S, runs });
const choice = (guards: readonly StaticProv[], alts: readonly StaticProv[]): ChoiceProv => ({
  kind: "choice",
  site: S,
  guards,
  alts,
});
const fan = (collection: StaticProv, body: StaticProv, collapse: CollapseKind): FanProv => ({
  kind: "fan",
  site: S,
  collection,
  body,
  collapse,
});
const opaque = (reason = "test/unmodeled"): OpaqueProv => ({ kind: "opaque", site: S, reason });

/** Every StaticProv kind, one fixture apiece — the fuzz row over all kinds. */
const ALL_KIND_FIXTURES: readonly StaticProv[] = [
  input("e"),
  mint("infer", "evidence"),
  konst(),
  fused(input("a"), input("b")),
  muxOf("v", input("e")),
  build("pair", [{ key: 0, prov: konst() }]),
  stringOf(konst(), input("e")),
  choice([input("guard")], [konst(), input("e")]),
  fan(input("xs"), input("x"), "combine"),
  opaque("unknown-head/frobnicate"),
];

describe("toWireframe — totality over every StaticProv kind", () => {
  it("never throws, and tags every node with its ground-truth provKind", () => {
    for (const prov of ALL_KIND_FIXTURES) {
      const { graph, sideMaps } = toWireframe(prov);
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(sideMaps.provKind.get(0)).toBe(prov.kind);
    }
  });

  it("egress always points at a `port{out}` node fed by the root", () => {
    const { graph } = toWireframe(input("e"));
    expect(graph.egress).not.toBeNull();
    const portNode = graph.nodes[graph.egress as number];
    expect(portNode).toEqual({ kind: "port", direction: "out", span: "0" });
    const feedingWire = graph.wires.find((w) => w.consumer.node === graph.egress && w.consumer.slot === "out");
    expect(feedingWire).toBeDefined();
    expect(feedingWire?.paramRefs).toEqual([{ kind: "node", name: "p0", node: 0 }]);
  });
});

describe("toWireframe — the money-table mapping", () => {
  it("input -> source, op = param name", () => {
    const { graph } = toWireframe(input("e"));
    expect(graph.nodes[0]).toEqual({ kind: "source", op: "e", span: "0" });
  });

  it("mint -> source, op = head, integrity rides the side map ONLY", () => {
    const { graph, sideMaps } = toWireframe(mint("infer", "evidence"));
    expect(graph.nodes[0]).toEqual({ kind: "source", op: "infer", span: "0" });
    expect(sideMaps.integrity.get(0)).toBe("evidence");
    // Structural guard: integrity is nowhere on the node's own fields.
    expect("integrity" in graph.nodes[0]).toBe(false);
  });

  it("mint's closed inputs wire in as ordinary children", () => {
    const { graph } = toWireframe(mint("now", "ambient", [konst()]));
    expect(graph.nodes).toHaveLength(3); // mint, const(closed0), port(out)
    const closedWire = graph.wires.find((w) => w.consumer.slot === "closed0");
    expect(closedWire?.consumer.node).toBe(0);
    expect(closedWire?.paramRefs).toEqual([{ kind: "node", name: "p0", node: 1 }]);
  });

  it("fused -> transparent, op = fuse", () => {
    // Pre-order: the parent node is pushed before its children are projected.
    const { graph } = toWireframe(fused(input("a"), input("b")));
    expect(graph.nodes[0]).toEqual({ kind: "transparent", op: "fuse", span: "0" });
  });

  it("mux (StaticProv) -> transparent, op = mux, exact per the doc's own row", () => {
    const { graph } = toWireframe(muxOf("v", input("e")));
    expect(graph.nodes[0]).toEqual({ kind: "transparent", op: "mux", span: "0" });
  });

  it("build -> transparent, ctor + keys ride the side map, never the node", () => {
    const b = build("pair", [
      { key: 0, prov: konst() },
      { key: "name", prov: input("e") },
    ]);
    const { graph, sideMaps } = toWireframe(b);
    const buildNodeIdx = graph.nodes.findIndex((n) => n.kind === "transparent" && n.op === "build");
    expect(buildNodeIdx).toBeGreaterThanOrEqual(0);
    expect(graph.nodes[buildNodeIdx]).toEqual({ kind: "transparent", op: "build", span: "0" });
    expect(sideMaps.buildShape.get(buildNodeIdx)).toEqual({ ctor: "pair", keys: [0, "name"] });
    expect("ctor" in graph.nodes[buildNodeIdx]).toBe(false);
  });

  it("string -> transparent, op = string, ordered runs wire in by index", () => {
    const { graph } = toWireframe(stringOf(konst(), input("e")));
    const idx = graph.nodes.findIndex((n) => n.kind === "transparent" && n.op === "string");
    expect(graph.nodes[idx]).toEqual({ kind: "transparent", op: "string", span: "0" });
    expect(graph.wires.some((w) => w.consumer.node === idx && w.consumer.slot === "arg0")).toBe(true);
    expect(graph.wires.some((w) => w.consumer.node === idx && w.consumer.slot === "arg1")).toBe(true);
  });

  it("choice -> mux, arms = alts.length, guards feed selector slots, alts feed arm slots — all gray (no valuation field anywhere)", () => {
    const c = choice([input("guard")], [konst(), input("e")]);
    const { graph } = toWireframe(c);
    const idx = graph.nodes.findIndex((n) => n.kind === "mux");
    expect(graph.nodes[idx]).toEqual({ kind: "mux", op: "choice", span: "0", arms: 2 });
    expect(graph.wires.some((w) => w.consumer.node === idx && w.consumer.slot === "selector0")).toBe(true);
    expect(graph.wires.some((w) => w.consumer.node === idx && w.consumer.slot === "arm0")).toBe(true);
    expect(graph.wires.some((w) => w.consumer.node === idx && w.consumer.slot === "arm1")).toBe(true);
    // No "taken"/"chosen" field anywhere on the node — a runtime overlay concern.
    expect("taken" in graph.nodes[idx]).toBe(false);
    expect("chosen" in graph.nodes[idx]).toBe(false);
  });

  it("fan -> fan, collapse rides the side map, body becomes a nested `template` graph", () => {
    const f = fan(input("xs"), input("x"), "combine");
    const { graph, sideMaps } = toWireframe(f);
    const idx = graph.nodes.findIndex((n) => n.kind === "fan");
    const node = graph.nodes[idx];
    expect(node.kind).toBe("fan");
    if (node.kind !== "fan") throw new Error("unreachable");
    expect(node.op).toBe("fan");
    expect(node.span).toBe("0");
    expect(sideMaps.collapse.get(idx)).toBe("combine");
    expect("collapse" in node).toBe(false);
    // The body ("x") became the template's own graph, not spliced into this one.
    expect(node.template).toBeDefined();
    expect(node.template?.nodes[0]).toEqual({ kind: "source", op: "x", span: "0" });
    // The template's own side maps are reachable too — nesting doesn't drop them.
    const templateSideMaps = sideMaps.fanTemplates.get(idx) as WireframeSideMaps;
    expect(templateSideMaps.provKind.get(0)).toBe("input");
  });

  it("opaque -> opaque, reason surfaces verbatim as `op` — never prettified, never guessed at", () => {
    const { graph } = toWireframe(opaque("unknown-head/frobnicate"));
    expect(graph.nodes[0]).toEqual({ kind: "opaque", op: "unknown-head/frobnicate", span: "0" });
  });
});

describe("toWireframe — the render-laundering guard (const)", () => {
  it("const projects onto `opaque`, NEVER `source` or `transparent`", () => {
    const { graph, sideMaps } = toWireframe(konst());
    expect(graph.nodes[0].kind).toBe("opaque");
    expect(graph.nodes[0].kind).not.toBe("source");
    expect(graph.nodes[0].kind).not.toBe("transparent");
    expect(sideMaps.fabrication.has(0)).toBe(true);
  });

  it("a const nested anywhere in the tree is flagged in fabrication, however deep", () => {
    const nested = fan(input("xs"), choice([input("guard")], [fused(mint("infer", "evidence"), konst())]), "lowered");
    const { graph, sideMaps } = toWireframe(nested);
    // The const lives inside the fan's body -> its OWN nested projection,
    // keyed by the fan node's index in the OUTER graph.
    const fanIdx = graph.nodes.findIndex((n) => n.kind === "fan");
    const templateSideMaps = sideMaps.fanTemplates.get(fanIdx) as WireframeSideMaps | undefined;
    expect(templateSideMaps).toBeDefined();
    expect(templateSideMaps!.fabrication.size).toBe(1);
  });

  it("a real OpaqueProv (not a const) is NEVER flagged as fabrication — the guard doesn't over-fire", () => {
    const { sideMaps } = toWireframe(opaque("unknown-head/frobnicate"));
    expect(sideMaps.fabrication.size).toBe(0);
  });

  it("opaque never prettified — const's `op` and a real opaque's `op` stay textually distinguishable", () => {
    const constWireframe = toWireframe(konst());
    const opaqueWireframe = toWireframe(opaque("unknown-head/frobnicate"));
    expect(constWireframe.graph.nodes[0].op).toBe("const");
    expect(opaqueWireframe.graph.nodes[0].op).toBe("unknown-head/frobnicate");
    expect(constWireframe.graph.nodes[0].op).not.toBe(opaqueWireframe.graph.nodes[0].op);
  });
});

describe("toWireframe — semantics-in-side-maps, structurally", () => {
  it("no WireframeNode ever carries integrity/collapse/ctor/fabrication/provKind fields directly", () => {
    for (const prov of ALL_KIND_FIXTURES) {
      const { graph } = toWireframe(prov);
      for (const node of graph.nodes) {
        expect("integrity" in node).toBe(false);
        expect("collapse" in node).toBe(false);
        expect("ctor" in node).toBe(false);
        expect("fabrication" in node).toBe(false);
        expect("provKind" in node).toBe(false);
      }
    }
  });

  it("wires never fabricate real dataflow — every wire body is the honest identity passthrough", () => {
    const { graph } = toWireframe(fused(input("a"), input("b")));
    for (const wire of graph.wires) {
      expect(wire.source).toBe("(lambda (p0) p0)");
      expect(wire.params).toEqual(["p0"]);
      expect(wire.paramRefs).toHaveLength(1);
      expect(wire.paramRefs[0].kind).toBe("node");
    }
  });
});

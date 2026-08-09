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
// The seal's OWN authoritative channel fold (READ-ONLY single source, prov-render
// F1) — every render-side "is this ⊆ what the seal proves" test below cross-checks
// against these, never re-derives its own notion of grounded/fabricated.
import { channels, dataShaped } from "../../verdict/circuit-verdict.js";

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

describe("toWireframe — fabrication is CONTENT-CHANNEL scoped (prov-render F1: render ⊆ seal)", () => {
  it("a const bound as a mint's closed argument is NOT flagged — an honest closed-arg, never laundering", () => {
    // infer's own model-name/slot-key literals are the canonical shape: a
    // membrane crossing always needs SOME closed argument, and that argument
    // is the author's declared parameter, not data standing in for content.
    const circuit = mint("infer", "evidence", [konst()]);
    const { sideMaps } = toWireframe(circuit);
    expect(sideMaps.fabrication.size).toBe(0);
    // Cross-check against the seal's OWN authoritative fold
    // (verdict/circuit-verdict.ts): a mint's `closed` feeds SELECTION only, so
    // this const never reaches the CONTENT channel either — the render's
    // non-flag is consistent with (⊆) what `dataShaped` would ever refuse.
    expect(channels(circuit).content.consts).toBe(0);
    expect(dataShaped(circuit)).toBe(true);
  });

  it("a const used as a choice's guard is NOT flagged — a comparison threshold is the author's judgment, never laundering (mirrors mint.closed)", () => {
    // circuit-verdict.ts's own `guardGroundsInEvidence` doc uses exactly this
    // shape as its worked example: "the `1000` in `(< (:v e) 1000)`."
    const circuit = choice([konst()], [input("a"), input("b")]);
    const { sideMaps } = toWireframe(circuit);
    expect(sideMaps.fabrication.size).toBe(0);
    expect(channels(circuit).content.consts).toBe(0);
    expect(dataShaped(circuit)).toBe(true);
  });

  it("a const substituted into a data/content position is STILL flagged — real laundering, matching the seal's content-channel disqualification", () => {
    const circuit = fused(mint("infer", "evidence"), konst());
    const { sideMaps } = toWireframe(circuit);
    const constIdx = [...sideMaps.provKind.entries()].find(([, kind]) => kind === "const")?.[0];
    expect(constIdx).toBeDefined();
    expect(sideMaps.fabrication.has(constIdx!)).toBe(true);
    // Cross-check: the seal's content channel DOES see this const, so
    // `dataShaped` correctly refuses — the render's flag is consistent with
    // (⊆, and here exactly equal to) what disqualifies the seal's verdict.
    expect(channels(circuit).content.consts).toBeGreaterThan(0);
    expect(dataShaped(circuit)).toBe(false);
  });

  it("guard-threshold const excluded, alt-position const included, in ONE circuit — the canonical guard-swap shape", () => {
    // The guard is fused(evidence, threshold-const) — a `(< (:v e) 1000)`
    // shape; one alt is a bare const (the forge), the other genuine evidence.
    const circuit = choice([fused(input("v"), konst())], [konst(), input("fallback")]);
    const { graph, sideMaps } = toWireframe(circuit);
    // Exactly ONE const is flagged — the alt's, never the guard's threshold —
    // even though both are the same StaticProv kind at the same tree depth.
    expect(sideMaps.fabrication.size).toBe(1);
    expect(channels(circuit).content.consts).toBe(1);
    const [flaggedIdx] = sideMaps.fabrication;
    const feedingWire = graph.wires.find((w) => w.paramRefs.some((ref) => ref.kind === "node" && ref.node === flaggedIdx));
    // The flagged node is wired into an `arm*` (content) slot, never a
    // `selector*` (selection) slot.
    expect(feedingWire?.consumer.slot.startsWith("arm")).toBe(true);
  });

  it("a shared const reachable via BOTH a closed-arg path and a content path is flagged — content is absorptive, a clean path never wins", () => {
    const shared = konst();
    // `shared` is BOTH a mint's closed argument (selection) AND a fused
    // source (content) — the shared-DAG dedup (G2) means it projects once;
    // this proves the fabrication mark still reflects the CONTENT occurrence
    // regardless of which path the walk happens to visit first.
    const circuit = fused(mint("infer", "evidence", [shared]), shared);
    const { sideMaps } = toWireframe(circuit);
    expect(sideMaps.nodeIndex?.get(shared)).toBeDefined();
    expect(sideMaps.fabrication.has(sideMaps.nodeIndex!.get(shared)!)).toBe(true);
    expect(channels(circuit).content.consts).toBeGreaterThan(0);
    expect(dataShaped(circuit)).toBe(false);
  });

  it("a shared COMPOSITE reached via a guard (selection) FIRST then as content still flags its const descendant — no under-flag from graph-dedup", () => {
    // The soundness case the separate content-pass exists for: `shared` is one
    // build object used BOTH as a choice guard (selection, visited first) AND
    // as a content alt. A channel threaded through the DEDUPED graph walk would
    // cache `shared` under selection on the guard visit and skip re-descending
    // on the content visit — silently under-flagging the "TAG" const inside it
    // (a fabrication shown as grounded, the dangerous direction). The
    // content-only post-pass has its own dedup and cannot miss it.
    const tag = konst();
    const shared = build("vector", [{ key: 0, prov: tag }]);
    const circuit = choice([shared], [shared, input("default")]);
    const { sideMaps } = toWireframe(circuit);
    const tagIdx = sideMaps.nodeIndex?.get(tag);
    expect(tagIdx).toBeDefined();
    expect(sideMaps.fabrication.has(tagIdx!)).toBe(true);
    // Cross-check the seal agrees this is a real content-path fabrication.
    expect(channels(circuit).content.consts).toBeGreaterThan(0);
    expect(dataShaped(circuit)).toBe(false);
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

describe("toWireframe — nodeIndex side map (C3, field-granular-access.md §6.2)", () => {
  it("a shared node (same StaticProv object reached twice) gets ONE index, and nodeIndex.get(that object) resolves it — the bridge from a cone's object identity to render highlighting", () => {
    const shared = konst();
    const f = fused(shared, shared);
    const { graph, sideMaps } = toWireframe(f);
    expect(sideMaps.nodeIndex).toBeDefined();
    const sharedIdx = sideMaps.nodeIndex!.get(shared);
    expect(sharedIdx).toBeDefined();
    // Only ONE node was ever projected for the shared object (the existing G2 dedup) —
    // nodeIndex just exposes the SAME lookup `project` already builds and used to discard.
    expect(graph.nodes[sharedIdx!]!.kind).toBe("opaque"); // const projects onto opaque
    expect(sideMaps.provKind.get(sharedIdx!)).toBe("const");
    // A structurally-identical but DISTINCT object never collides — identity, not shape, is the key.
    const other = konst();
    expect(sideMaps.nodeIndex!.get(other)).toBeUndefined();
  });

  it("is scoped PER LEVEL — a fan's template gets its OWN nodeIndex, never the outer graph's", () => {
    const bodyNode = input("x");
    const f = fan(input("xs"), bodyNode, "lowered");
    const { sideMaps } = toWireframe(f);
    const fanIdx = [...sideMaps.provKind.entries()].find(([, kind]) => kind === "fan")?.[0];
    expect(fanIdx).toBeDefined();
    const templateSideMaps = sideMaps.fanTemplates.get(fanIdx!) as WireframeSideMaps;
    // The body's node lives in the TEMPLATE's own private index space (its own recursive
    // toWireframe/Builder — this file's "shared-DAG dedup, scoped per graph level" header note) —
    // its nodeIndex resolves it, the OUTER graph's nodeIndex never saw it at all.
    expect(templateSideMaps.nodeIndex?.get(bodyNode)).toBeDefined();
    expect(sideMaps.nodeIndex?.get(bodyNode)).toBeUndefined();
  });
});

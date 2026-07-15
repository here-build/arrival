/**
 * circuitToMermaid's own contract. Same fixture-first discipline as
 * circuit-sexpr.test.ts: every circuit below is HAND-BUILT (never produced by
 * calling `extract`), and `site` is irrelevant to any check here beyond
 * "renders honestly as the bare NodeId" — every node shares one dummy
 * NodeId.
 */
import { describe, expect, it } from "vitest";

import type { NodeId } from "../../coreform/types.js";
import { circuitToMermaid } from "../../model/circuit-mermaid.js";
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

describe("circuitToMermaid — every StaticProv kind renders a node", () => {
  it("input → stadium shape, the evidence source", () => {
    expect(circuitToMermaid(input("e"))).toBe('flowchart TD\nn0(["evidence: e (site 0)"])');
  });

  it("mint → subroutine for evidence-class, hexagon for ambient-class (visually distinct)", () => {
    expect(circuitToMermaid(mint("infer", "evidence"))).toBe('flowchart TD\nn0[["infer (site 0)"]]');
    expect(circuitToMermaid(mint("now", "ambient"))).toBe('flowchart TD\nn0{{"now (site 0)"}}');
  });

  it("mint's closed inputs are the SELECTION channel (dotted), never content", () => {
    expect(circuitToMermaid(mint("infer", "evidence", [konst()]))).toBe(
      'flowchart TD\nn0[["infer (site 0)"]]\nn1>"⚠ const (site 0)"]\nn0 -.->|"closed"| n1',
    );
  });

  it("const → flag shape + unmistakable ⚠ marker — THE fabrication mark", () => {
    const out = circuitToMermaid(konst());
    expect(out).toBe('flowchart TD\nn0>"⚠ const (site 0)"]');
    // the flag shape (`>...]`) is the one shape no other kind uses, and no
    // other kind's label carries the warning glyph — both together make a
    // const impossible to mistake for anything else scrolling past.
    expect(out).toContain("⚠");
    expect(out).toMatch(/^flowchart TD\nn0>/);
  });

  it("fused → rectangle, all sources on the content channel (solid)", () => {
    expect(circuitToMermaid(fused(input("a"), input("b")))).toBe(
      'flowchart TD\n' +
        'n0["⊗ fuse (site 0)"]\n' +
        'n1(["evidence: a (site 0)"])\n' +
        "n0 --> n1\n" +
        'n2(["evidence: b (site 0)"])\n' +
        "n0 --> n2",
    );
  });

  it("mux → parallelogram, key rendered (and nil for a statically-unknown key)", () => {
    expect(circuitToMermaid(muxOf("v", input("e")))).toBe(
      'flowchart TD\nn0[/"mux: v (site 0)"/]\nn1(["evidence: e (site 0)"])\nn0 --> n1',
    );
    expect(circuitToMermaid(muxOf(null, input("e")))).toBe(
      'flowchart TD\nn0[/"mux: nil (site 0)"/]\nn1(["evidence: e (site 0)"])\nn0 --> n1',
    );
  });

  it("build → each part's edge carries its KEY", () => {
    const b = build("dict", [
      { key: "a", prov: konst() },
      { key: "b", prov: input("e") },
    ]);
    expect(circuitToMermaid(b)).toBe(
      'flowchart TD\n' +
        'n0["dict (site 0)"]\n' +
        'n1>"⚠ const (site 0)"]\n' +
        'n0 -->|"a"| n1\n' +
        'n2(["evidence: e (site 0)"])\n' +
        'n0 -->|"b"| n2',
    );
  });

  it("string → rectangle, runs in declared order", () => {
    expect(circuitToMermaid(stringOf(konst(), input("e")))).toBe(
      'flowchart TD\n' +
        'n0["str (site 0)"]\n' +
        'n1>"⚠ const (site 0)"]\n' +
        "n0 --> n1\n" +
        'n2(["evidence: e (site 0)"])\n' +
        "n0 --> n2",
    );
  });

  it("choice → rhombus decision; guards dotted (selection), alts solid (content)", () => {
    const c = choice([input("guard")], [konst(), input("e")]);
    const out = circuitToMermaid(c);
    expect(out).toBe(
      'flowchart TD\n' +
        'n0{"choice (site 0)"}\n' +
        'n1(["evidence: guard (site 0)"])\n' +
        'n0 -.->|"guard"| n1\n' +
        'n2>"⚠ const (site 0)"]\n' +
        'n0 -->|"alt"| n2\n' +
        'n3(["evidence: e (site 0)"])\n' +
        'n0 -->|"alt"| n3',
    );
    // the two channels use visually distinct arrow syntax — a reviewer
    // doesn't need a legend to tell selection from content.
    expect(out).toContain("-.->|");
    expect(out).toContain("-->|");
  });

  it("fan → a z-STACK subgraph: the body template inside the axis, the collection unwound in", () => {
    const f = fan(input("xs"), input("x"), "combine");
    expect(circuitToMermaid(f)).toBe(
      'flowchart TD\n' +
        'subgraph f0["⟳ fan · combine · z-stack (site 0)"]\n' +
        'direction TB\n' +
        'n1(["evidence: x (site 0)"])\n' + // the per-element body template, INSIDE the axis
        'end\n' +
        'n2(["evidence: xs (site 0)"])\n' +
        'n2 -->|"unwind"| n1', // the collection unwinds into the body
    );
  });

  it("opaque → cylinder, reason surfaces honestly", () => {
    expect(circuitToMermaid(opaque("unknown-head/frobnicate"))).toBe(
      'flowchart TD\nn0[("opaque: unknown-head/frobnicate (site 0)")]',
    );
  });
});

describe("circuitToMermaid — cross-cutting properties", () => {
  it("is deterministic: the same StaticProv renders the exact same string twice", () => {
    const c = fan(input("xs"), choice([input("guard")], [fused(mint("infer", "evidence"), konst())]), "lowered");
    expect(circuitToMermaid(c)).toBe(circuitToMermaid(c));
  });

  it("escapes mermaid-special characters so a hostile label can't break node/edge syntax", () => {
    const out = circuitToMermaid(input('he said "hi" [x] | y'));
    // the literal quote is replaced by mermaid's own entity, never a bare
    // backslash-escape (mermaid doesn't treat `\"` as an escape in a label).
    expect(out).toBe('flowchart TD\nn0(["evidence: he said #quot;hi#quot; [x] | y (site 0)"])');
    expect(out).not.toContain('"hi"');
  });

  it("opts.direction overrides the default TD", () => {
    expect(circuitToMermaid(input("e"), { direction: "LR" })).toBe('flowchart LR\nn0(["evidence: e (site 0)"])');
  });

  it("nests arbitrarily deep — a choice of fused mints inside a fan body", () => {
    const nested = fan(
      input("xs"),
      choice([input("guard")], [fused(mint("infer", "evidence"), konst())]),
      "lowered",
    );
    const out = circuitToMermaid(nested);
    expect(out).toContain('subgraph f0["⟳ fan · lowered · z-stack (site 0)"]');
    expect(out).toContain('"⚠ const (site 0)"');
  });
});

describe("circuitToMermaid — golden: a small realistic circuit, read the full string", () => {
  it("renders `(if cond (fuse (infer …) FAKE) fallback)` as an eyeball-able graph", () => {
    // guard = evidence input; taken alt = an inferred value fused with a
    // program-text constant (the thing a reviewer is hunting for); the other
    // alt = a plain evidence fallback. No valuation exists at this static
    // layer, so BOTH alts render — gray/taken is a runtime overlay this
    // function never sees (see the module header).
    const circuit = choice(
      [input("cond")],
      [fused(mint("infer", "evidence"), konst()), input("fallback")],
    );

    expect(circuitToMermaid(circuit)).toBe(
      [
        "flowchart TD",
        'n0{"choice (site 0)"}',
        'n1(["evidence: cond (site 0)"])',
        'n0 -.->|"guard"| n1',
        'n2["⊗ fuse (site 0)"]',
        'n3[["infer (site 0)"]]',
        "n2 --> n3",
        'n4>"⚠ const (site 0)"]',
        "n2 --> n4",
        'n0 -->|"alt"| n2',
        'n5(["evidence: fallback (site 0)"])',
        'n0 -->|"alt"| n5',
      ].join("\n"),
    );
  });
});

// ── the semantic infer view (crossing chain, plumbing contracted) ──────────────

describe("circuitToMermaid — view:'infer' (the semantic crossing chain)", () => {
  // Distinct sites: the infer view keys nodes BY site, so a chain needs them.
  const mintAt = (site: number, head: string, closed: readonly StaticProv[] = []): MintProv => ({
    kind: "mint",
    site: site as NodeId,
    head,
    integrity: "evidence",
    closed,
  });

  it("contracts plumbing to a direct infer→infer wire — a prompt built from a prior crossing's output", () => {
    // rewritten's prompt is a dict whose field wraps labelled's output through
    // mux/build plumbing; the infer view must show ONE wire labelled -> rewritten,
    // never the intervening dict/mux nodes.
    const labelled = mintAt(2, "infer/chat", [konst()]);
    const rewritten = mintAt(13, "infer/chat", [build("dict", [{ key: "prev", prov: muxOf("label", labelled) }])]);
    const out = circuitToMermaid(rewritten, { view: "infer" });
    expect(out).toContain("flowchart LR");
    expect(out).toContain('x2[["infer/chat"]]');
    expect(out).toContain('x13[["infer/chat"]]');
    expect(out).toContain("x2 --> x13"); // the contracted wire (single-arg → no arg label)
    // NO plumbing nodes leaked:
    expect(out).not.toContain("dict");
    expect(out).not.toContain("mux");
    // rewritten's output is the value → OUTPUT edge:
    expect(out).toContain('out(["OUTPUT"])');
    expect(out).toContain("x13 --> out");
  });

  it("absorbs the recorded data onto nodes and wires when the storage resolver answers", () => {
    const labelled = mintAt(2, "infer/chat", [konst()]);
    const rewritten = mintAt(13, "infer/chat", [build("dict", [{ key: "prev", prov: muxOf("label", labelled) }])]);
    const store: Record<number, string> = { 2: "LABEL: negative", 13: "this app changed my life" };
    const out = circuitToMermaid(rewritten, { view: "infer", dataFor: (s) => store[s as number] });
    expect(out).toContain("infer/chat<br/>LABEL: negative");
    expect(out).toContain("infer/chat<br/>this app changed my life");
    // the wire carries the UPSTREAM crossing's recorded output:
    expect(out).toContain('x2 -->|"LABEL: negative"| x13');
  });

  it("a program-text output (a const final value, no crossing behind it) flags ⚠ fabricated at the sink", () => {
    const out = circuitToMermaid(konst(), { view: "infer" });
    expect(out).toContain('out(["OUTPUT"])');
    expect(out).toContain("outfab");
    expect(out).toContain("⚠ fabricated");
    expect(out).toContain("class outfab fab;");
  });

  it("a plain evidence output (single crossing, no chain) is one node to OUTPUT, no fabrication", () => {
    const out = circuitToMermaid(mintAt(5, "infer", []), { view: "infer" });
    expect(out).toContain('x5[["infer"]]');
    expect(out).toContain("x5 --> out");
    expect(out).not.toContain("fab");
  });

  it("defaults to LR but honors an explicit TD", () => {
    expect(circuitToMermaid(mintAt(5, "infer"), { view: "infer" })).toContain("flowchart LR");
    expect(circuitToMermaid(mintAt(5, "infer"), { view: "infer", direction: "TD" })).toContain("flowchart TD");
  });
});

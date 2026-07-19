/**
 * circuitToMermaid's own contract. Same fixture-first discipline as
 * circuit-sexpr.test.ts: every circuit below is HAND-BUILT (never produced by
 * calling `extract`), and `site` is irrelevant to any check here beyond
 * "renders honestly as the bare NodeId" — every node shares one dummy
 * NodeId.
 *
 * The per-kind render rows are ONE protocol table (`MERMAID_ROWS`) over the
 * shared hand-built constructors (`circuit-render-fixtures.ts`, shared with
 * the sexpr twin): `{ name, circuit, golden }`, plus `contains`/`notContains`/
 * `matches` columns for the rows that pin properties beyond the whole string.
 */
import { describe, expect, it } from "vitest";

import type { NodeId } from "../../coreform/types.js";
import { circuitToMermaid } from "../../model/circuit-mermaid.js";
import type { MintProv, StaticProv } from "../../model/static-prov.js";
import { build, choice, fan, fused, input, konst, mint, muxOf, opaque, stringOf } from "./circuit-render-fixtures.js";

interface MermaidRow {
  readonly name: string;
  readonly circuit: StaticProv;
  /** Whole-string golden (`toBe`) when present… */
  readonly golden?: string;
  /** …plus extra pins asserted when present. */
  readonly contains?: readonly string[];
  readonly notContains?: readonly string[];
  readonly matches?: readonly RegExp[];
}

const MERMAID_ROWS: readonly MermaidRow[] = [
  {
    name: "input → stadium shape, the evidence source",
    circuit: input("e"),
    golden: 'flowchart TD\nn0(["evidence: e (site 0)"])',
  },
  {
    name: "mint, evidence-class → subroutine shape",
    circuit: mint("infer", "evidence"),
    golden: 'flowchart TD\nn0[["infer (site 0)"]]',
  },
  {
    name: "mint, ambient-class → hexagon shape (visually distinct from evidence)",
    circuit: mint("now", "ambient"),
    golden: 'flowchart TD\nn0{{"now (site 0)"}}',
  },
  {
    name: "mint's closed inputs are the SELECTION channel (dotted), never content",
    circuit: mint("infer", "evidence", [konst()]),
    golden: 'flowchart TD\nn0[["infer (site 0)"]]\nn1>"⚠ const (site 0)"]\nn0 -.->|"closed"| n1',
  },
  {
    name: "const → flag shape + unmistakable ⚠ marker — THE fabrication mark",
    circuit: konst(),
    golden: 'flowchart TD\nn0>"⚠ const (site 0)"]',
    // the flag shape (`>...]`) is the one shape no other kind uses, and no
    // other kind's label carries the warning glyph — both together make a
    // const impossible to mistake for anything else scrolling past.
    contains: ["⚠"],
    matches: [/^flowchart TD\nn0>/],
  },
  {
    name: "fused → rectangle, all sources on the content channel (solid)",
    circuit: fused(input("a"), input("b")),
    golden:
      'flowchart TD\n' +
      'n0["⊗ fuse (site 0)"]\n' +
      'n1(["evidence: a (site 0)"])\n' +
      "n0 --> n1\n" +
      'n2(["evidence: b (site 0)"])\n' +
      "n0 --> n2",
  },
  {
    name: "mux → parallelogram, key rendered",
    circuit: muxOf("v", input("e")),
    golden: 'flowchart TD\nn0[/"mux: v (site 0)"/]\nn1(["evidence: e (site 0)"])\nn0 --> n1',
  },
  {
    name: "mux → parallelogram, nil for a statically-unknown key",
    circuit: muxOf(null, input("e")),
    golden: 'flowchart TD\nn0[/"mux: nil (site 0)"/]\nn1(["evidence: e (site 0)"])\nn0 --> n1',
  },
  {
    name: "build → each part's edge carries its KEY",
    circuit: build("dict", [
      { key: "a", prov: konst() },
      { key: "b", prov: input("e") },
    ]),
    golden:
      'flowchart TD\n' +
      'n0["dict (site 0)"]\n' +
      'n1>"⚠ const (site 0)"]\n' +
      'n0 -->|"a"| n1\n' +
      'n2(["evidence: e (site 0)"])\n' +
      'n0 -->|"b"| n2',
  },
  {
    name: "string → rectangle, runs in declared order",
    circuit: stringOf(konst(), input("e")),
    golden:
      'flowchart TD\n' +
      'n0["str (site 0)"]\n' +
      'n1>"⚠ const (site 0)"]\n' +
      "n0 --> n1\n" +
      'n2(["evidence: e (site 0)"])\n' +
      "n0 --> n2",
  },
  {
    name: "choice → rhombus decision; guards dotted (selection), alts dashed too (borrowed selection styling), told apart by label",
    circuit: choice([input("guard")], [konst(), input("e")]),
    golden:
      'flowchart TD\n' +
      'n0{"choice (site 0)"}\n' +
      'n1(["evidence: guard (site 0)"])\n' +
      'n0 -.->|"guard"| n1\n' +
      'n2>"⚠ const (site 0)"]\n' +
      'n0 -.->|"alt"| n2\n' +
      'n3(["evidence: e (site 0)"])\n' +
      'n0 -.->|"alt"| n3',
    // both of a choice's own edges are dashed now (a deliberate borrow — see
    // circuit-mermaid.ts's header); the LABEL, not the dash pattern, is what
    // still tells a guard apart from an alt. A leaf-only choice like this one
    // (guard/alts are all terminal nodes) has NO solid edge anywhere.
    contains: ['-.->|"guard"|', '-.->|"alt"|'],
    notContains: ["-->|"],
  },
  {
    name: "fan → a z-STACK subgraph: the body template inside the axis, the collection unwound in",
    circuit: fan(input("xs"), input("x"), "combine"),
    golden:
      'flowchart TD\n' +
      'subgraph f0["⟳ fan · combine · z-stack (site 0)"]\n' +
      'direction TB\n' +
      'n1(["evidence: x (site 0)"])\n' + // the per-element body template, INSIDE the axis
      'end\n' +
      'n2(["evidence: xs (site 0)"])\n' +
      'n2 -->|"unwind"| n1', // the collection unwinds into the body
  },
  {
    name: "opaque → cylinder, reason surfaces honestly",
    circuit: opaque("unknown-head/frobnicate"),
    golden: 'flowchart TD\nn0[("opaque: unknown-head/frobnicate (site 0)")]',
  },
];

describe("circuitToMermaid — every StaticProv kind renders a node", () => {
  for (const row of MERMAID_ROWS) {
    it(row.name, () => {
      const out = circuitToMermaid(row.circuit);
      if (row.golden !== undefined) expect(out).toBe(row.golden);
      for (const fragment of row.contains ?? []) expect(out).toContain(fragment);
      for (const fragment of row.notContains ?? []) expect(out).not.toContain(fragment);
      for (const re of row.matches ?? []) expect(out).toMatch(re);
    });
  }
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
    // function never sees (see the module header). The choice's OWN edges to
    // both alts are dashed (the borrowed selection styling); the fused node's
    // OWN edges to its sources (`n2 --> n3`/`n2 --> n4`) stay solid — those
    // are genuine, unconditional content edges one level further in, a
    // different edge than the choice's structural one.
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
        'n0 -.->|"alt"| n2',
        'n5(["evidence: fallback (site 0)"])',
        'n0 -.->|"alt"| n5',
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

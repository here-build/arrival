/**
 * `fieldProv`'s own contract (field-granular-access.md §2/§3/§2.5) — U1's
 * step-table coverage, U2's INV-5 agreement law, and U4's fail-closed-table
 * suite, one test per row. FIXTURE-FIRST where the shape is simple and
 * stable (mirrors circuit-verdict.test.ts's own convention verbatim: same
 * hand-built constructors, same dummy `NodeId`), REAL `extract()` (the same
 * `run` helper circuit-verdict.test.ts uses) where the two key alphabets — a
 * mux's own self-key vs. a build's numeric part keys — are the entire point
 * of the case, so a hand-built approximation would risk re-encoding the
 * exact wrong assumption the case exists to catch.
 *
 * Never modifies circuit-verdict.test.ts; reuses its "two-alphabets" fixture
 * SHAPES as the seed corpus for INV-5, per this lane's own instruction.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import type { NodeId } from "../../coreform/types.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { extractProgram } from "../../extract/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import type {
  BuildProv,
  ChoiceProv,
  CollapseKind,
  ConstProv,
  FanProv,
  FusedProv,
  InputProv,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "../../model/static-prov.js";
import { channels } from "../../verdict/circuit-verdict.js";
import { fieldProv, type FieldPath } from "../../verdict/field-prov.js";

const S = 0 as NodeId;

const input = (name: string): InputProv => ({ kind: "input", site: S, name });
const muxOf = (key: string | number | null, source: StaticProv): MuxProv => ({ kind: "mux", site: S, key, source });
const konst = (): ConstProv => ({ kind: "const", site: S });
const fused = (...sources: StaticProv[]): FusedProv => ({ kind: "fused", site: S, sources });
const stringNode = (...runs: StaticProv[]): StringProv => ({ kind: "string", site: S, runs });
const mint = (head: string, integrity: "evidence" | "ambient", closed: readonly StaticProv[] = []): MintProv => ({
  kind: "mint",
  site: S,
  head,
  integrity,
  closed,
});
const opaque = (reason = "test/unmodeled"): OpaqueProv => ({ kind: "opaque", site: S, reason });
const choice = (guards: readonly StaticProv[], alts: readonly StaticProv[]): ChoiceProv => ({ kind: "choice", site: S, guards, alts });
const fan = (collection: StaticProv, body: StaticProv, collapse: CollapseKind, site: NodeId = S): FanProv => ({
  kind: "fan",
  site,
  collection,
  body,
  collapse,
});
const dictOf = (...entries: readonly (readonly [string | number, StaticProv])[]): BuildProv => ({
  kind: "build",
  site: S,
  ctor: "dict",
  parts: entries.map(([key, prov]) => ({ key, prov })),
});
const vectorOf = (...provs: readonly StaticProv[]): BuildProv => ({
  kind: "build",
  site: S,
  ctor: "vector",
  parts: provs.map((prov, i) => ({ key: i, prov })),
});

/** REAL `extract` — same pipeline circuit-verdict.test.ts's own `run` helper
 *  uses, for the two cases where fidelity to extract's OWN key-minting
 *  alphabet (not a hand-built approximation of it) is the point. */
const run = (src: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(src)));
  return extractProgram(forms, defaultRegistry);
};

/** The "equivalent mux tower" INV-5 checks against: `muxOf(pₙ, … muxOf(p₁,
 *  root))`, nesting one mux per path segment — the spec's own notation
 *  (§3.1). No such helper exists in production code (nothing needs it
 *  outside this test), so it lives here only. */
function muxTowerOf(root: StaticProv, path: FieldPath): StaticProv {
  return path.reduce<StaticProv>((acc, seg) => muxOf(seg, acc), root);
}

function expectCone(result: ReturnType<typeof fieldProv>) {
  expect(result.kind).toBe("cone");
  if (result.kind !== "cone") throw new Error("unreachable — asserted above");
  return result;
}

function expectRefused(result: ReturnType<typeof fieldProv>) {
  expect(result.kind).toBe("refused");
  if (result.kind !== "refused") throw new Error("unreachable — asserted above");
  return result;
}

// ── U2 — INV-5: the agreement law ───────────────────────────────────────────

describe("INV-5 — fieldProv narrowing agrees with channels()'s own mux tower", () => {
  it("single-segment paths over the two-alphabets dict fixture (the v/o keys)", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["o", konst()]);
    for (const path of [["v"], ["o"]] as const) {
      const result = expectCone(fieldProv(e, path));
      expect(result.frontier).toBeUndefined();
      expect(channels(result.cone)).toEqual(channels(muxTowerOf(e, path)));
    }
  });

  it("a provably-absent key's tower agrees too (both sides fail closed to opaque)", () => {
    const e = dictOf(["v", mint("infer", "evidence")]);
    const tower = muxTowerOf(e, ["z"]);
    // fieldProv REFUSES an absent key (§2.5) rather than returning a cone —
    // the tower's own mux, by contrast, is a valid StaticProv whose verdict
    // (via channels' 0-hit "dead" fallback) is the fail-closed opaque. The
    // agreement law is about cones that DO resolve; an absent key is outside
    // its scope by construction (there is no cone to compare). Pin both
    // halves of that split explicitly rather than leaving it implicit.
    expectRefused(fieldProv(e, ["z"]));
    expect(channels(tower).content.opaques).toBe(1);
  });

  it("nested two-segment paths over a dict-of-dict, WHERE the intervening level has no sibling to conflate", () => {
    // Single-part intermediate build: channels(inner) degenerates to exactly
    // the leaf's own channels, so the tower's single-level narrowMux (which
    // resolves "pool" against root, then stops — see the finding below) still
    // lands on the right answer here. This is the faithful two-segment
    // analogue of the cited suite's single-segment cases.
    const inner = dictOf(["score", mint("infer", "evidence")]);
    const root = dictOf(["pool", inner], ["other", konst()]);
    const path = ["pool", "score"] as const;
    const result = expectCone(fieldProv(root, path));
    expect(channels(result.cone)).toEqual(channels(muxTowerOf(root, path)));
  });

  it("FINDING — a two-segment tower does NOT compose across levels when the intervening build has a sibling: not a fieldProv bug, a documented boundary of the agreement law", () => {
    // fieldProv itself is EXACT here: build-recursion narrows all the way to
    // the mint, unconditionally, with no sibling involved at any step.
    const inner = dictOf(["score", mint("infer", "evidence")], ["flag", konst()]);
    const root = dictOf(["pool", inner], ["other", konst()]);
    const path = ["pool", "score"] as const;
    const result = expectCone(fieldProv(root, path));
    expect(result.cone).toBe(inner.parts[0]!.prov); // the mint itself, precisely
    expect(channels(result.cone).content.consts).toBe(0); // clean — "flag" never enters

    // The "equivalent mux tower" — muxOf("score", muxOf("pool", root)) — does
    // NOT reproduce that precision. narrowMux (circuit-verdict.ts, frozen —
    // not this lane's to change) only narrows when its OWN, IMMEDIATE source
    // is a literal `build`; the OUTER ("score") mux's source is the INNER
    // ("pool") mux — a mux, not a build — so per narrowMux's documented
    // "non-build source ⇒ whole" fallback, it never gets to apply "score"
    // against inner's own parts at all. It just defers wholesale to
    // channels(innerMux), which correctly narrows "pool" against root but
    // then reports the WHOLE inner dict's channels (score AND flag) — the
    // sibling "flag" const leaks in. This is EXISTING, already-tested,
    // single-level-by-design behavior (circuit-verdict.ts's own "no
    // narrowing applies: the whole source is the sound over-approximation"
    // fallback) — a real characteristic of `channels()`'s mux narrowing, not
    // a defect this lane introduced or may fix. It means INV-5's "equivalent
    // mux tower" is a faithful cross-check ONLY for single mux-step
    // narrowing (exactly the shape the cited two-alphabets suite tests);
    // multi-segment paths over MULTI-KEY intermediate builds are outside
    // that law's actual coverage, and `fieldProv`'s own build-recursion (the
    // primary, exact narrowing path) is unaffected by it.
    const tower = muxTowerOf(root, path);
    expect(channels(tower).content.consts).toBe(1); // "flag" leaks into the tower's reading
    expect(channels(tower)).not.toEqual(channels(result.cone));
  });

  it("a real vector-ref mux-over-build circuit agrees (both key alphabets match)", () => {
    const prov = run(`(vector-ref (vector (:v e) "FAKE") 0)`) as MuxProv;
    expect(prov.kind).toBe("mux");
    const source = prov.source;
    const result = expectCone(fieldProv(source, [0]));
    expect(channels(result.cone)).toEqual(channels(muxTowerOf(source, [0])));
    // ...and both agree with the REAL extracted mux itself (prov ≡ muxOf(0, source) structurally).
    expect(channels(result.cone)).toEqual(channels(prov));
  });
});

// ── U1 — step-table positive coverage (beyond the fail-closed rows) ────────

describe("U1 — step-table positive coverage", () => {
  it("empty path — cone is the root node itself, verbatim, for every kind (no mux normalization)", () => {
    const nodes: readonly StaticProv[] = [
      input("e"),
      mint("infer", "evidence"),
      konst(),
      fused(input("a")),
      muxOf("v", input("e")),
      vectorOf(input("a")),
      stringNode(input("a")),
      choice([input("g")], [konst(), konst()]),
      fan(muxOf("xs", input("e")), muxOf(null, muxOf("xs", input("e"))), "lowered"),
      opaque(),
    ];
    for (const node of nodes) {
      const result = expectCone(fieldProv(node, []));
      expect(result.cone).toBe(node);
      expect(result.frontier).toBeUndefined();
      expect(result.crossedFans).toEqual([]);
      expect(result.candidates).toBeUndefined();
    }
  });

  it("build — a single hit descends and consumes the segment (dict AND vector alphabets)", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["o", konst()]);
    const vHit = expectCone(fieldProv(e, ["v"]));
    expect(vHit.cone).toBe(e.parts[0]!.prov);

    const vec = vectorOf(input("a"), konst());
    const idx0 = expectCone(fieldProv(vec, [0]));
    expect(idx0.cone).toBe(vec.parts[0]!.prov);
  });

  it("fan (lowered/route) — a numeric step descends into the per-template body and records the crossing", () => {
    const collection = muxOf("xs", input("e"));
    const element = muxOf(null, collection);
    const body = dictOf(["score", element]);
    const loweredFan = fan(collection, body, "lowered", 7 as NodeId);
    const result = expectCone(fieldProv(loweredFan, [3, "score"]));
    expect(result.cone).toBe(element);
    expect(result.crossedFans).toEqual([loweredFan.site]);
  });

  it("nested fans accumulate crossedFans root-to-leaf", () => {
    const innerCollection = muxOf(null, muxOf("rows", input("e")));
    const innerElement = muxOf(null, innerCollection);
    const innerFan = fan(innerCollection, innerElement, "lowered", 2 as NodeId);
    const outerFan = fan(muxOf("rows", input("e")), innerFan, "lowered", 1 as NodeId);
    const result = expectCone(fieldProv(outerFan, [0, 1]));
    expect(result.crossedFans).toEqual([outerFan.site, innerFan.site]);
  });

  it("choice — a non-empty path frontiers at the choice node (verdict-bearing algebra never distributes)", () => {
    const j = choice([fused(muxOf("a", input("e")), konst())], [konst(), konst()]);
    const result = expectCone(fieldProv(j, ["whatever"]));
    expect(result.cone).toBe(j);
    expect(result.frontier).toEqual({ remainder: ["whatever"] });
  });
});

// ── U4 — the fail-closed table (§2.5), one test per row ─────────────────────

describe("U4 — fail-closed table, one test per row", () => {
  it("absent-key refusal — door lists the container's actual keys", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["o", konst()]);
    const result = expectRefused(fieldProv(e, ["score"]));
    expect(result.code).toBe("path/absent-key");
    expect(result.teach).toContain('"v"');
    expect(result.teach).toContain('"o"');
    expect(result.teach).toContain("score");
  });

  it("into-scalar — stepping past a fused OR a string node refuses", () => {
    const e = input("e");
    const arithmetic = fused(muxOf("a", e), muxOf("b", e));
    const root = dictOf(["total", arithmetic]);
    const fusedResult = expectRefused(fieldProv(root, ["total", "cents"]));
    expect(fusedResult.code).toBe("path/into-scalar");

    const stringRoot = dictOf(["label", stringNode(muxOf("id", e), konst())]);
    const stringResult = expectRefused(fieldProv(stringRoot, ["label", 0]));
    expect(stringResult.code).toBe("path/into-scalar");
  });

  it("into-aggregate (combine fan) — any step into a combine-collapsed fan refuses", () => {
    const collection = muxOf("xs", input("e"));
    const combineFan = fan(collection, fused(muxOf(null, collection), konst()), "combine");
    const numeric = expectRefused(fieldProv(combineFan, [0]));
    expect(numeric.code).toBe("path/into-aggregate");
    const stringStep = expectRefused(fieldProv(combineFan, ["whatever"]));
    expect(stringStep.code).toBe("path/into-aggregate");
  });

  it("index-expected — a string step into a lowered/route fan body refuses (wrong alphabet, not coarseness)", () => {
    const collection = muxOf("xs", input("e"));
    const loweredFan = fan(collection, muxOf(null, collection), "lowered");
    const result = expectRefused(fieldProv(loweredFan, ["score"]));
    expect(result.code).toBe("path/index-expected");
  });

  it("car-over-cons conservatism — cone is the dead mux (not-attestable), and the pair's OWN build answers :at (0) positionally", () => {
    const prov = run(`(car (cons (:v e) (:w e)))`);
    const result = expectCone(fieldProv(prov, [0]));
    expect(result.cone).toBe(prov); // the cone IS the mux itself, unrewritten
    expect(result.frontier).toBeUndefined(); // discarded, never surfaced — a conservatism, not coarseness
    expect(channels(result.cone).content.opaques).toBe(1); // not-attestable, verdict-side (channels' own opaque)

    // The worked alternative (§5.2): address the RAW pair build positionally,
    // bypassing the car/cdr mux entirely — the numeric alphabets match there.
    const pairBuild = (prov as MuxProv).source as BuildProv;
    const positional = expectCone(fieldProv(pairBuild, [0]));
    expect(channels(positional.cone).content.opaques).toBe(0); // clean
  });

  it("null-key frontier — a dynamic index (or any non-build source) stops the mux with the remainder recorded", () => {
    // A "whole" mux (non-build source) reached with a genuinely non-empty
    // remainder past it — the null-key/non-build-source row's frontier.
    const root = dictOf(["outer", muxOf("v", input("e"))]);
    const result = expectCone(fieldProv(root, ["outer", "sub"]));
    expect(result.frontier).toEqual({ remainder: ["sub"] });

    // The null-key (dynamic-index) shape directly, mirroring
    // circuit-verdict.test.ts's own "a null key (dynamic index) over a build
    // stays conservative" fixture family.
    const dynamicIndexRoot = muxOf(null, vectorOf(input("a"), konst()));
    const nullKeyResult = expectCone(fieldProv(dynamicIndexRoot, ["whatever"]));
    expect(nullKeyResult.cone).toBe(dynamicIndexRoot);
    expect(nullKeyResult.frontier).toEqual({ remainder: ["whatever"] });
  });

  it("duplicate-key candidates — the shape is pinned; the conjunction itself is the seal lane's job", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["v", konst()], ["o", mint("infer", "evidence")]);
    const result = expectCone(fieldProv(e, ["v"]));
    expect(result.candidates).toHaveLength(2);
    expect(result.cone).toBe(result.candidates![0]);
    expect(result.candidates).toEqual([e.parts[0]!.prov, e.parts[1]!.prov]);
  });

  it("mint-with-remainder frontier — static-coarse, the remainder is recorded verbatim", () => {
    const root = dictOf(["evidence", mint("infer/chat", "evidence", [input("prompt")])]);
    const result = expectCone(fieldProv(root, ["evidence", "label"]));
    expect(result.cone.kind).toBe("mint");
    expect(result.frontier).toEqual({ remainder: ["label"] });
  });
});

/**
 * T4's own contract — the circuit-verdict channel
 * (docs/foundations/arrival-scheme/provenance-by-perturbation.md §3;
 * docs/working-proposals/scheme-semantic-model-synthesis.md §2g). FIXTURE-
 * FIRST: `extract` is built in parallel by other agents, so every circuit
 * below is HAND-BUILT to mirror src/__tests__/extract/fixture-corpus.ts's
 * five adversarial rows (plus additional circuits exercising `channels()`
 * directly) — never produced by calling `extract`.
 *
 * `site` is irrelevant to every check here (channels report it but never
 * compare on it — see circuit-verdict.ts's `ChannelAnchor` doc), so every
 * hand-built node shares one dummy `NodeId`.
 */
import { describe, expect, it } from "vitest";

import type { NodeId } from "../../coreform/types.js";
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
import { channels, circuitVerdict, dataShaped, judgmentShaped } from "../../verdict/circuit-verdict.js";

const S = 0 as NodeId;

const input = (name: string): InputProv => ({ kind: "input", site: S, name });
const muxOf = (key: string | number | null, source: StaticProv): MuxProv => ({ kind: "mux", site: S, key, source });
const konst = (): ConstProv => ({ kind: "const", site: S });
const fused = (...sources: StaticProv[]): FusedProv => ({ kind: "fused", site: S, sources });
const mint = (head: string, integrity: Integrity, closed: readonly StaticProv[] = []): MintProv => ({
  kind: "mint",
  site: S,
  head,
  integrity,
  closed,
});
const opaque = (reason = "test/unmodeled"): OpaqueProv => ({ kind: "opaque", site: S, reason });
const choice = (guards: readonly StaticProv[], alts: readonly StaticProv[]): ChoiceProv => ({ kind: "choice", site: S, guards, alts });
const fan = (collection: StaticProv, body: StaticProv, collapse: CollapseKind): FanProv => ({
  kind: "fan",
  site: S,
  collection,
  body,
  collapse,
});

// ── the fixture-corpus mirrors (fixture-corpus.ts's five rows, as concrete circuits) ──

describe("fixture-corpus row 1 — guard-swap forge", () => {
  // (if (< (:v e) 1000) "SAFE" (number->string (:v e)))
  const guardSwap = choice([fused(muxOf("v", input("e")), konst())], [konst(), fused(muxOf("v", input("e")))]);

  it("dataShaped is FALSE — the const alt poisons content (every world must ground)", () => {
    expect(dataShaped(guardSwap)).toBe(false);
  });

  it("judgmentShaped is FALSE — alts are not all bare consts (one is a fused)", () => {
    expect(judgmentShaped(guardSwap)).toBe(false);
  });

  it("circuitVerdict is not-attestable for both roles", () => {
    expect(circuitVerdict(guardSwap, "data")).toBe("not-attestable");
    expect(circuitVerdict(guardSwap, "judgment")).toBe("not-attestable");
  });
});

describe("the two-literal judgment circuit", () => {
  // (if (< (:v e) 1000) "SAFE" "UNSAFE") — same guard, both alts bare consts.
  const twoLiteralJudgment = choice([fused(muxOf("v", input("e")), konst())], [konst(), konst()]);

  it("judgmentShaped is TRUE — alts are both bare consts, guard grounds in evidence", () => {
    expect(judgmentShaped(twoLiteralJudgment)).toBe(true);
  });

  it("dataShaped is FALSE — pure consts in content, no anchor at all", () => {
    expect(dataShaped(twoLiteralJudgment)).toBe(false);
  });

  it("circuitVerdict: judgment-shaped for the judgment role, not-attestable for the data role", () => {
    expect(circuitVerdict(twoLiteralJudgment, "judgment")).toBe("judgment-shaped");
    expect(circuitVerdict(twoLiteralJudgment, "data")).toBe("not-attestable");
  });
});

describe("fixture-corpus row 4 — genuine content", () => {
  // (number->string (:v e)) — pure transformation of evidence.
  const genuineContent = fused(muxOf("v", input("e")));

  it("dataShaped is TRUE", () => {
    expect(dataShaped(genuineContent)).toBe(true);
    expect(circuitVerdict(genuineContent, "data")).toBe("data-shaped");
  });

  it("judgmentShaped is FALSE — the root is not a choice", () => {
    expect(judgmentShaped(genuineContent)).toBe(false);
    expect(circuitVerdict(genuineContent, "judgment")).toBe("not-attestable");
  });
});

describe("fixture-corpus row 5 — plain fuse", () => {
  // (+ (:a e) (:b e)) — ⊗ baseline, both evidence projections contribute.
  const plainFuse = fused(muxOf("a", input("e")), muxOf("b", input("e")));

  it("dataShaped is TRUE and channels() reports two clean evidence anchors, no selection", () => {
    expect(dataShaped(plainFuse)).toBe(true);
    const c = channels(plainFuse);
    expect(c.content.consts).toBe(0);
    expect(c.content.opaques).toBe(0);
    expect(c.content.anchors).toHaveLength(2);
    expect(c.content.anchors.every((a) => a.kind === "input" && a.integrity === "evidence")).toBe(true);
    expect(c.selection).toEqual({ anchors: [], consts: 0, opaques: 0 });
  });
});

describe("fixture-corpus row 3 — hidden-const fold (longcat's forge)", () => {
  // (fold (lambda (acc x) (if (eq? x "s") "FABRICATED" x)) "" (:xs e))
  // per extract/index.ts's Bound doc: the fan body's element binding is
  // MuxProv{key:null} over the collection — mirrored here concretely.
  const xsCollection = muxOf("xs", input("e"));
  const elementRef = muxOf(null, xsCollection);
  const hiddenConstFold = fan(xsCollection, choice([fused(elementRef, konst())], [konst(), elementRef]), "lowered");

  it("dataShaped is FALSE — the const inside the LOWERED body poisons content even nested under a fan", () => {
    expect(dataShaped(hiddenConstFold)).toBe(false);
    expect(circuitVerdict(hiddenConstFold, "data")).toBe("not-attestable");
  });
});

// ── ambient vs. evidence integrity ──────────────────────────────────────────────

describe("mint integrity — ambient vs. evidence in content position", () => {
  it("an ambient mint in content position is NOT data-shaped (ungrounded-ambient, not fabrication, still not attestable)", () => {
    const ambientMintContent = mint("now", "ambient");
    expect(dataShaped(ambientMintContent)).toBe(false);
    expect(circuitVerdict(ambientMintContent, "data")).toBe("not-attestable");
  });

  it("an evidence-class mint in content position IS data-shaped — contrast case for the same shape", () => {
    const evidenceMintContent = mint("infer", "evidence");
    expect(dataShaped(evidenceMintContent)).toBe(true);
    expect(circuitVerdict(evidenceMintContent, "data")).toBe("data-shaped");
  });
});

// ── opaque anywhere ──────────────────────────────────────────────────────────────

describe("opaque anywhere defeats attestation", () => {
  it("a bare opaque root is not-attestable for both roles", () => {
    const rootOpaque = opaque("unsupported-form/quasiquote");
    expect(circuitVerdict(rootOpaque, "data")).toBe("not-attestable");
    expect(circuitVerdict(rootOpaque, "judgment")).toBe("not-attestable");
  });

  it("an opaque NESTED beside real evidence still poisons dataShaped — not just a root-level case", () => {
    const nestedOpaque = fused(input("e"), opaque("computed-callee"));
    expect(dataShaped(nestedOpaque)).toBe(false);
  });
});

// ── adversarial: every world must ground ────────────────────────────────────────

describe("adversarial choice — one grounded alt, one const alt", () => {
  it("dataShaped is FALSE — the adversary picks the const branch", () => {
    const adversarialMixedAlts = choice([input("e")], [muxOf("id", input("e")), konst()]);
    expect(dataShaped(adversarialMixedAlts)).toBe(false);
  });
});

// ── build/string transparency (mirrors seal.ts's own worked examples) ──────────

describe("build and string nodes are transparent to content", () => {
  it("(cons (:name e) \"FABRICATED\") — the cdr's bare const poisons content", () => {
    const buildNode: BuildProv = {
      kind: "build",
      site: S,
      ctor: "pair",
      parts: [
        { key: "car", prov: input("a") },
        { key: "cdr", prov: konst() },
      ],
    };
    expect(dataShaped(buildNode)).toBe(false);
  });

  it('(string-append (:id e) "-FAKE") — the fabricated run is visible per-segment', () => {
    const stringNode: StringProv = { kind: "string", site: S, runs: [input("id"), konst()] };
    expect(dataShaped(stringNode)).toBe(false);
  });
});

// ── judgmentShaped: the per-guard existential, independent of the alts check ────

describe("judgmentShaped — guards must each independently ground in evidence", () => {
  it("FALSE when the only guard is fully ambient, even though both alts are bare consts", () => {
    const ambientGuardJudgment = choice([mint("now", "ambient")], [konst(), konst()]);
    expect(judgmentShaped(ambientGuardJudgment)).toBe(false);
  });

  it("FALSE when a guard reaches an opaque, even alongside a real evidence anchor (soundness call — see circuit-verdict.ts's guardGroundsInEvidence doc)", () => {
    const mixedGuard = fused(input("e"), opaque("computed-callee"));
    const j = choice([mixedGuard], [konst(), konst()]);
    expect(judgmentShaped(j)).toBe(false);
  });

  it("TRUE through a nested choice tower — (if g1 \"A\" (if g2 \"B\" \"C\")) lowers to nested binary choices, all flattened", () => {
    const g1 = fused(muxOf("a", input("e")), konst());
    const g2 = fused(muxOf("b", input("e")), konst());
    const tower = choice([g1], [konst(), choice([g2], [konst(), konst()])]);
    expect(judgmentShaped(tower)).toBe(true);
    expect(circuitVerdict(tower, "judgment")).toBe("judgment-shaped");
  });
});

// ── mint's closed inputs ground selection, never content ────────────────────────

describe("mint's closed inputs", () => {
  it("channels() routes closed into selection, and never into content", () => {
    const closedInput = input("prompt");
    const m = mint("infer", "evidence", [closedInput]);
    const c = channels(m);
    expect(c.content).toEqual({ anchors: [{ kind: "mint", integrity: "evidence", site: S }], consts: 0, opaques: 0 });
    expect(c.selection.anchors).toEqual([{ kind: "input", integrity: "evidence", site: S }]);
  });
});

// ── fan collapse:"route" — the collection plays a selection role ────────────────

describe("fan collapse kind and the collection's selection role", () => {
  it('collapse:"route" promotes the collection\'s content into the fan\'s selection channel', () => {
    const collection = muxOf("xs", input("e"));
    const elementRef = muxOf(null, collection);
    const routeFan = fan(collection, elementRef, "route");
    expect(channels(routeFan).selection.anchors.length).toBeGreaterThan(0);
  });

  it('collapse:"combine" does NOT — only route makes the fan a selection over its own elements', () => {
    const collection = muxOf("xs", input("e"));
    const elementRef = muxOf(null, collection);
    const combineFan = fan(collection, elementRef, "combine");
    expect(channels(combineFan).selection.anchors).toHaveLength(0);
  });
});

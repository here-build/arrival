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
 *
 * A handful of cases below (the "car/cdr accessors vs container builds"
 * describe block, the vector-ref case in the mux-narrowing block, and the
 * guardless-choice case in the `judgmentShaped` block) call `extract` FOR
 * REAL via the `run` helper, rather than hand-building, specifically where
 * fidelity to extract's own key-minting alphabet is the entire point of the
 * case and a hand-built fixture would risk re-encoding the same wrong
 * assumption the case exists to catch. The rest of the file stays hand-built,
 * unchanged in spirit — FIXTURE-FIRST is still the right default where the
 * shape is simple and stable.
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

/** REAL `extract`, for the handful of cases where fidelity to extract's own
 *  key-minting alphabet (not a hand-built approximation of it) is the point
 *  — same pipeline and registry as extract-corpus.test.ts's J1 gate
 *  (`classify(desugar(parseSexprs(src))).forms` through `extractProgram`
 *  with the REAL `defaultRegistry`, not a test-local stand-in), so a future
 *  change to extract's key alphabets is caught here automatically instead of
 *  silently re-diverging from a frozen hand-built fixture. */
const run = (src: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(src)));
  return extractProgram(forms, defaultRegistry);
};

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

describe("fixture-corpus row 3 — hidden-const fold (the fold-collapse forge)", () => {
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
    // Parts keyed 0/1, NOT "car"/"cdr" — a real `cons` keys its build parts
    // NUMERICALLY by argument position regardless of ctor (arm-control.ts's
    // dispatchKnownHead "build" case); "car"/"cdr" are the ACCESSOR's own
    // self-key, a DIFFERENT alphabet entirely (see the "car/cdr accessors vs
    // container builds" describe block below — Finding B, a prior version of
    // this fixture used the accessor's string keys here, a key space extract
    // never actually emits for a build). This test is unaffected by which
    // alphabet is used, since the "build" case folds every part into content
    // unconditionally without reading `key` at all (circuit-verdict.ts) — the
    // fix is fidelity to what extract emits, not a behavior change.
    const buildNode: BuildProv = {
      kind: "build",
      site: S,
      ctor: "pair",
      parts: [
        { key: 0, prov: input("a") },
        { key: 1, prov: konst() },
      ],
    };
    expect(dataShaped(buildNode)).toBe(false);
  });

  it('(string-append (:id e) "-FAKE") — the fabricated run is visible per-segment', () => {
    const stringNode: StringProv = { kind: "string", site: S, runs: [input("id"), konst()] };
    expect(dataShaped(stringNode)).toBe(false);
  });
});

// ── mux where-provenance narrowing (BKT 2001; the T6c STOP finding) ─────────────

describe("mux narrows into the keyed part, not the whole container (BKT where-provenance)", () => {
  // Both key alphabets below are verified against extract's own minting, not
  // assumed (Finding B follow-through): `dictOf`'s STRING keys mirror
  // arm-containers.ts's `extractContainer` (`(dict :v x)` keys each part by
  // its literal `:field` name, a string, ARM-C's own special-form path — the
  // generic numeric "build" case in arm-control.ts never runs for `dict`);
  // the `vector`-ctor builds below mirror the generic "build" case's NUMERIC
  // positional keys, the SAME path `cons`/`list`/`make-vector` all share. So
  // `dict-ref`/`vector-ref`'s accessor keys (a literal argument, string or
  // number respectively — arm-control.ts's `dispatchMux`, `keyArg` a
  // positional index) line up with their container's own alphabet — REAL
  // narrowing, unlike `car`/`cdr`'s STRING self-key over a NUMERIC-keyed pair
  // build (see the "car/cdr accessors vs container builds" block below).
  const dictOf = (...entries: readonly [string, StaticProv][]): BuildProv => ({
    kind: "build",
    site: S,
    ctor: "dict",
    parts: entries.map(([key, prov]) => ({ key, prov })),
  });

  it("(:v e) on (dict :v <evidence> :o \"FAKE\") is data-shaped — the sibling decoy does NOT flow to the v-projection", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["o", konst()]);
    expect(dataShaped(muxOf("v", e))).toBe(true);
  });

  it("(:o e) on the same container is NOT data-shaped — projecting the decoy key yields the const", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["o", konst()]);
    expect(dataShaped(muxOf("o", e))).toBe(false);
  });

  it("(:z e) — a key PROVABLY ABSENT from a literal container fails closed (opaque), never a spurious attest of nil", () => {
    const e = dictOf(["v", mint("infer", "evidence")]);
    expect(dataShaped(muxOf("z", e))).toBe(false);
  });

  it("a duplicate-keyed container unions the CANDIDATES — a fabricated second binding poisons, siblings still excluded", () => {
    const e = dictOf(["v", mint("infer", "evidence")], ["v", konst()], ["o", mint("infer", "evidence")]);
    expect(dataShaped(muxOf("v", e))).toBe(false); // the const among the v-candidates poisons
  });

  it("a null key (dynamic index) over a build stays conservative — the whole container", () => {
    const cleanVec: BuildProv = { kind: "build", site: S, ctor: "vector", parts: [{ key: 0, prov: input("e") }] };
    const poisonedVec: BuildProv = {
      kind: "build",
      site: S,
      ctor: "vector",
      parts: [
        { key: 0, prov: input("e") },
        { key: 1, prov: konst() },
      ],
    };
    expect(dataShaped(muxOf(null, cleanVec))).toBe(true);
    expect(dataShaped(muxOf(null, poisonedVec))).toBe(false);
  });

  it("mux over a non-build source (an input) stays transparent — the free-e field idiom", () => {
    expect(dataShaped(muxOf("v", input("e")))).toBe(true);
  });

  it("(vector-ref (vector (:v e) \"FAKE\") 0) IS data-shaped — a REAL numeric accessor key over a REAL numeric build key, run through actual extract, not hand-built", () => {
    // Contrast with the "car/cdr accessors vs container builds" block below:
    // same shape (accessor-over-a-freshly-built-container), but here BOTH
    // sides of the projection are numeric (vector-ref's literal index arg vs
    // the generic "build" case's positional part keys), so the alphabets
    // MATCH and where-provenance narrowing genuinely excludes the decoy at
    // index 1 — this is the positive case FIX B(a) asks to keep alongside
    // the negative car/cdr one, run via `extractProgram` for the same reason.
    const prov = run(`(vector-ref (vector (:v e) "FAKE") 0)`);
    expect(prov).toMatchObject({ kind: "mux", key: 0, source: { kind: "build", ctor: "vector" } });
    expect(dataShaped(prov)).toBe(true);
    expect(circuitVerdict(prov, "data")).toBe("data-shaped");
  });
});

// ── car/cdr accessors vs container builds — the two key alphabets ──

describe("car/cdr accessors vs container builds — the two key alphabets", () => {
  // extract mints TWO DIFFERENT key alphabets for containers vs. their fixed
  // unary accessors: a generic container build (`cons`/`list`/`vector` — the
  // "build" case in arm-control.ts's dispatchKnownHead) keys its parts
  // NUMERICALLY by argument position (`key: i`); a self-keyed accessor
  // (`car`/`cdr`/`first`/`rest` — dispatchMux's "self" arm) keys ITSELF by
  // its own name (`key: "car"`). A `(car (cons a b))` mux therefore filters a
  // STRING key against the pair build's NUMERIC part keys {0, 1} — zero
  // matches, unconditionally — so circuit-verdict.ts's mux case falls to its
  // 0-hits fallback (an explicit opaque, "provably absent from this literal
  // container"). This is SOUND-BUT-CONSERVATIVE, never a forge: nothing is
  // mislabeled as attestable that shouldn't be, and the evidence-idiom law
  // (cons/car is a primitives-materialization idiom) predicts exactly this
  // — a lost precision, not a hole. It is the documented intended behavior;
  // extract's key minting is NOT to be changed to "fix" it.
  it('(car (cons (:v e) (:w e))) is NOT data-shaped — both slots are clean evidence, yet the string/numeric key mismatch blinds the projection', () => {
    const prov = run(`(car (cons (:v e) (:w e)))`);
    expect(prov).toMatchObject({
      kind: "mux",
      key: "car",
      source: { kind: "build", ctor: "pair", parts: [{ key: 0 }, { key: 1 }] },
    });
    expect(dataShaped(prov)).toBe(false);
    expect(circuitVerdict(prov, "data")).toBe("not-attestable");
  });

  it('(cdr (cons (:v e) (:w e))) is likewise NOT data-shaped — the SAME conservatism from the other accessor', () => {
    const prov = run(`(cdr (cons (:v e) (:w e)))`);
    expect(prov).toMatchObject({ kind: "mux", key: "cdr", source: { kind: "build", ctor: "pair" } });
    expect(dataShaped(prov)).toBe(false);
    expect(circuitVerdict(prov, "data")).toBe("not-attestable");
  });

  it("channels() reports the opaque explicitly (fail-closed), not an empty/vacuous content — the projection is refused, never silently blessed", () => {
    const prov = run(`(car (cons (:v e) (:w e)))`);
    const c = channels(prov).content;
    expect(c.opaques).toBe(1);
    expect(c.anchors).toHaveLength(0);
  });
});

// ── judgmentShaped: the per-guard existential, independent of the alts check ────

describe("judgmentShaped — guards must each independently ground in evidence", () => {
  it("FALSE when there are NO guards at all — a guardless choice is not a judgment, even with all-bare-const alts (the vacuous-every fix)", () => {
    // (and "YES") — extractAndOr's `guards: provs.slice(0, -1)` (arm-control.ts)
    // is EMPTY for a single-argument and/or. Array.prototype.every vacuously
    // returns true on an empty array, so `guards.every(guardGroundsInEvidence)`
    // alone could not distinguish "every guard grounds in evidence" from
    // "there is no guard to check" — before the fix, this real, reachable
    // shape read as judgment-shaped: a bare author literal with nothing
    // grounding why it was "selected" (there was no selection to make).
    const prov = run(`(and "YES")`);
    expect(prov).toMatchObject({ kind: "choice", guards: [], alts: [{ kind: "const" }] });
    expect(judgmentShaped(prov)).toBe(false);
    expect(circuitVerdict(prov, "judgment")).toBe("not-attestable");
  });

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

// ── s/* reclassified to fuse — the extract-registry consequence (V's ruling, 2026-07-16) ──

/**
 * `s/object`/`s/field/string`/… were left as unknown-head opaque by the
 * 2026-07-15 GEPA sweep (arm-containers.ts's header, at the time) on the
 * theory that an `infer/chat` output-schema arg never carries evidence. V's
 * ruling overturned that theory: the whole `s/` namespace is arrival's TYPE
 * SYNTAX — the narrowing it performs at a crossing is identity-or-crash on
 * execution, contributing nothing to attribution — so a descriptor CALL like
 * `(s/object (s/field/string "label"))` is just ordinary data built from its
 * args, and the honest classification is `fuse` (arm-containers.ts's `s/`
 * namespace rule), never opaque.
 *
 * The opaque was not cosmetic. It rode straight into `infer/chat`'s `closed`
 * (a mint's own crossing inputs — static-prov.ts's `MintProv` doc), which
 * grounds the SELECTION channel, never content. `guardGroundsInEvidence`
 * fails closed on ANY opaque reachable from a guard, through EITHER channel —
 * so a guard built from a genuinely evidence-grounded `infer/chat` crossing
 * still read as ungrounded, purely because its schema arg happened to be an
 * unclassified head. The five cases below pin the fix (case 1: honest fused
 * shape) and its consequence (case 2: THE FLIP — a GEPA-shaped judgment moves
 * from not-attestable to judgment-shaped), then pin the two soundness rails
 * that must survive the reclassification unchanged (case 3: a fabricated
 * schema string leaked into content still poisons; case 4: a guard with zero
 * real evidence anywhere still does not ground, fused consts or not), plus
 * one more positive (case 5: a schema built from a live evidence read stays
 * VISIBLE instead of vanishing into opaque).
 */
describe("s/* reclassified to fuse — the extract-registry consequence of V's ruling", () => {
  it('(s/object (s/field/string "label")) extracts with no opaque anywhere — fused consts, honest descriptor construction', () => {
    const prov = run(`(s/object (s/field/string "label"))`);
    expect(prov).toMatchObject({
      kind: "fused",
      sources: [{ kind: "fused", sources: [{ kind: "const" }] }],
    });
  });

  it("THE FLIP — a GEPA-shaped judgment is now judgmentShaped (was not-attestable purely because the schema arg opaqued the guard's selection channel)", () => {
    const prov = run(
      `(if (string-ci=? (:label (car (infer/chat "m" (list (infer/chat/user "p")) (s/object (s/field/string "label")) "k"))) (:expected e)) 1 0)`,
    );
    expect(prov.kind).toBe("choice");
    expect(judgmentShaped(prov)).toBe(true);
    expect(circuitVerdict(prov, "judgment")).toBe("judgment-shaped");
  });

  it('soundness guard 1 — a schema value leaked into CONTENT still poisons: (number->string (s/object (s/field/string "FORGED"))) stays not-attestable for role data (consts in content = fabrication marks survive fuse)', () => {
    const prov = run(`(number->string (s/object (s/field/string "FORGED")))`);
    expect(dataShaped(prov)).toBe(false);
    expect(circuitVerdict(prov, "data")).toBe("not-attestable");
  });

  it('soundness guard 2 — a pure-const guard (no evidence anchor anywhere) still does not ground: (if (s/field/string "x") "A" "B") is NOT judgment-shaped (the reclassification must not open an all-authored-judgment hole)', () => {
    const prov = run(`(if (s/field/string "x") "A" "B")`);
    expect(judgmentShaped(prov)).toBe(false);
    expect(circuitVerdict(prov, "judgment")).toBe("not-attestable");
  });

  it("dynamic schema visibility — (s/field/string (:v e)) reaches the input anchor; fuse preserves evidence flow instead of swallowing it into opaque", () => {
    const prov = run(`(s/field/string (:v e))`);
    const anchors = channels(prov).content.anchors;
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ kind: "input", integrity: "evidence" });
  });
});

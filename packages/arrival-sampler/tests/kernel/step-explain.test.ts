// step-explain.test.ts — the SHARED bucketer `buildStepExplain`, model-free. It mirrors the decode's LAZY
// probability-reduction walk: descend the prob-ranked tokens, OMIT the masked ones (each tagged with its veto
// REASON — the catalog RuleId, or base `structural`/`sigma`) until the FIRST feasible token (chosen), then
// stop with one `tail` peek. `rank = omitted.length`. Synthetic topIds/logits over the real oracle.

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { buildStepExplain } from "../../src/step-explain.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

// ── Toy vocab ─────────────────────────────────────────────────────────────────────────────────────────
const TOKENS: { id: number; str: string }[] = [
  { id: 0, str: "(" },
  { id: 1, str: ")" },
  { id: 2, str: "car" },
  { id: 3, str: "cdr" },
  { id: 4, str: "foo" },
  { id: 5, str: "5" },
  { id: 6, str: " " },
];
const EOS_ID = 7;
const VOCAB_SIZE = 8;

const idOf = (s: string): number => TOKENS.find((t) => t.str === s)!.id;
const strOf = (id: number): string | undefined => TOKENS.find((t) => t.id === id)?.str;

const callable = (x: unknown): unknown => x;
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({ car: callable, cdr: callable });
}

function fakeLogits(logitMap: Record<number, number>, base = -1e9): Float32Array {
  const data = new Float32Array(VOCAB_SIZE).fill(base);
  for (const [id, v] of Object.entries(logitMap)) data[Number(id)] = v;
  return data;
}
/** The descending-logit order over the toy vocab (ties broken by id). */
function topOrder(logits: Float32Array): number[] {
  return TOKENS.map((t) => t.id).toSorted((a, b) => logits[b] - logits[a] || a - b);
}

describe("buildStepExplain — the lazy omitted/chosen/tail walk", () => {
  it("omits the masked-preferred tokens with their veto REASON, stops at chosen, peeks one tail", () => {
    const scanner = makeOracle(grantEnv());
    // At "(" (operator slot): the model ranks foo(unbound symbol → generic Σ mask) #1, then 5 (a number at the
    // OPERATOR head → R-LITERAL-NOT-OPERATOR), then car (bound → FEASIBLE, the pick), then cdr (also feasible).
    const logits = fakeLogits({ [idOf("foo")]: 9, [idOf("5")]: 8, [idOf("car")]: 7, [idOf("cdr")]: 6 });
    const topIds = topOrder(logits); // foo, 5, car, cdr, then the -1e9 ties by id.
    const e = buildStepExplain({
      index: 0,
      prefixBefore: "(",
      topIds,
      chosenId: idOf("car"),
      getLogit: (id) => logits[id],
      decode: strOf,
      scanner,
    });

    // omitted = the two masked-preferred tokens BEFORE car, in prob order, each with its decisive reason.
    expect(e.omitted.map((o) => o.token)).toEqual(["foo", "5"]);
    expect(e.omitted[0].reason).toBe("sigma"); // a generic unbound symbol — base Σ class, no catalog rule.
    expect(e.omitted[1].reason).toBe("R-LITERAL-NOT-OPERATOR"); // a literal at the operator head — a RULE.
    expect(e.omitted[0].probability).toBe(logits[idOf("foo")]);
    // rank = how deep the constraint reached = omitted.length.
    expect(e.rank).toBe(2);
    // chosen = the first feasible token; tail = the next UNTESTED token after it (cdr).
    expect(e.chosen.token).toBe("car");
    expect(e.chosen.probability).toBe(logits[idOf("car")]);
    expect(e.tail?.token).toBe("cdr");
  });

  it("rank 0 when the model's argmax is already feasible (the constraint was passive)", () => {
    const scanner = makeOracle(grantEnv());
    // car (feasible) is the argmax → nothing omitted before it.
    const logits = fakeLogits({ [idOf("car")]: 9, [idOf("cdr")]: 8 });
    const e = buildStepExplain({
      index: 1,
      prefixBefore: "(",
      topIds: topOrder(logits),
      chosenId: idOf("car"),
      getLogit: (id) => logits[id],
      decode: strOf,
      scanner,
    });
    expect(e.omitted).toEqual([]);
    expect(e.rank).toBe(0);
    expect(e.chosen.token).toBe("car");
    expect(e.tail?.token).toBe("cdr"); // the peek is still the next token.
  });

  it("base `structural` reason for a grammar/balance reject (no catalog rule)", () => {
    const scanner = makeOracle(grantEnv());
    // At "": ")" cannot open a program (a closer with no opener → structural reject, NOT a catalog rule);
    // "(" is feasible (the pick).
    const logits = fakeLogits({ [idOf(")")]: 9, [idOf("(")]: 8 });
    const e = buildStepExplain({
      index: 0,
      prefixBefore: "",
      topIds: topOrder(logits),
      chosenId: idOf("("),
      getLogit: (id) => logits[id],
      decode: strOf,
      scanner,
    });
    expect(e.omitted.map((o) => o.token)).toEqual([")"]);
    expect(e.omitted[0].reason).toBe("structural");
    expect(e.chosen.token).toBe("(");
  });

  it("EOS / empty-decode ids are skipped as candidates (never omitted)", () => {
    const scanner = makeOracle(grantEnv());
    // EOS_ID decodes to undefined; the model ranks it #1, then foo (sigma masked), then car (pick).
    const logits = fakeLogits({ [idOf("foo")]: 8, [idOf("car")]: 7 });
    const topIds = [EOS_ID, idOf("foo"), idOf("car"), idOf("cdr")];
    const e = buildStepExplain({
      index: 2,
      prefixBefore: "(",
      topIds,
      chosenId: idOf("car"),
      getLogit: (id) => logits[id] ?? Number.NaN,
      decode: strOf,
      scanner,
    });
    // EOS is not a classifiable candidate — it never appears in omitted; only foo (the real mask) does.
    expect(e.omitted.map((o) => o.token)).toEqual(["foo"]);
    expect(e.rank).toBe(1); // omitted.length — EOS did not count.
    expect(e.chosen.token).toBe("car");
  });

  it("a non-committed step (chosenId = -1) yields an empty chosen, rank -1, and no tail", () => {
    const scanner = makeOracle(grantEnv());
    const logits = fakeLogits({ [idOf("foo")]: 9 });
    const e = buildStepExplain({
      index: 0,
      prefixBefore: "(",
      topIds: [idOf("foo")],
      chosenId: -1,
      getLogit: (id) => logits[id],
      decode: strOf,
      scanner,
    });
    expect(e.chosen.token).toBe("");
    expect(e.rank).toBe(-1);
    expect(e.tail).toBeUndefined();
    // the masked tokens are still collected (foo was preferred and vetoed).
    expect(e.omitted.map((o) => o.token)).toEqual(["foo"]);
  });

  it("entropy — -Σ p·log(p) over the tracked topIds window, ALWAYS computed; nucleus omitted by default", () => {
    const scanner = makeOracle(grantEnv());
    const probs: Record<number, number> = { [idOf("car")]: 0.7, [idOf("cdr")]: 0.3 };
    const topIds = [idOf("car"), idOf("cdr")];
    const e = buildStepExplain({
      index: 0,
      prefixBefore: "(",
      topIds,
      chosenId: idOf("car"),
      getLogit: (id) => probs[id] ?? 0,
      decode: strOf,
      scanner,
    });
    const expected = -(0.7 * Math.log(0.7) + 0.3 * Math.log(0.3));
    expect(e.entropy).toBeCloseTo(expected, 10);
    // nucleus is opt-in (no `nucleusMass` passed) — undefined, not an empty array.
    expect(e.nucleus).toBeUndefined();
  });
});

// ── NON-LAZY nucleus mode (opt-in via `nucleusMass`) ──────────────────────────────────────────────────
describe("buildStepExplain — opt-in nucleus classification (grammarOK/typeOK per candidate)", () => {
  it("cumulates probability mass to `nucleusMass`, classifying every candidate along the way", async () => {
    // An ARRAY-typed slot (mirrors structure-gate-e2e.test.ts): `set-tags` is stamped array via a mock lens,
    // so a scalar literal ("5") is TYPE-rejected (R-ARRAY-REJECTS-SCALAR) while `]` is GRAMMAR-rejected
    // (R-BRACKET-MISMATCH — it would close the `(`-opened call) and `items` (a bound symbol) is feasible.
    // (`[` is no longer a grammar example — the vector literal is first-class since the reader parses it.)
    const grant = oracleEnvFromBindings({ "set-tags": callable, items: callable });
    const lens: AsyncTypeLens = {
      getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
      getSlotIsArray: () => Promise.resolve(true),
      getSlotAcceptsBareWord: () => Promise.resolve(null),
      getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
    };
    const scanner = narrowByTypeAsync(makeOracle(grant), lens);
    const slot = "(set-tags ";
    await scanner.prefill(slot);
    const state = scanner.analyze(slot);
    expect(state.slotIsArray, "the array-slot stamp must reach the OracleState").toBe(true);

    const NUC_TOKENS: { id: number; str: string }[] = [
      { id: 0, str: "5" },
      { id: 1, str: "]" },
      { id: 2, str: "items" },
      { id: 3, str: "(" },
    ];
    const nucIdOf = (s: string): number => NUC_TOKENS.find((t) => t.str === s)!.id;
    const nucStrOf = (id: number): string | undefined => NUC_TOKENS.find((t) => t.id === id)?.str;
    const probs: Record<number, number> = { 0: 0.4, 1: 0.3, 2: 0.2, 3: 0.1 }; // prob-descending, sums to 1.

    const e = buildStepExplain({
      index: 0,
      prefixBefore: slot,
      topIds: [nucIdOf("5"), nucIdOf("]"), nucIdOf("items"), nucIdOf("(")],
      chosenId: nucIdOf("items"), // the lazy walk's own pick — unaffected by the nucleus opt-in.
      getLogit: (id) => probs[id] ?? 0,
      decode: nucStrOf,
      scanner,
      slotState: state,
      nucleusMass: 0.5, // cumulative: 5→0.4 (< .5, continue), ]→0.7 (>= .5 at next check → stop before items).
    });

    // Nucleus stops once cumulative mass reaches 0.5 — BEFORE classifying "items"/"(" (mass already spent).
    expect(e.nucleus?.map((n) => n.token)).toEqual(["5", "]"]);
    const five = e.nucleus!.find((n) => n.token === "5")!;
    expect(five).toMatchObject({ feasible: false, grammarOK: true, typeOK: false }); // TYPE-rejected only.
    const bracket = e.nucleus!.find((n) => n.token === "]")!;
    expect(bracket).toMatchObject({ feasible: false, grammarOK: false, typeOK: true }); // GRAMMAR-rejected only.

    // The lazy walk is unaffected by the opt-in: omitted/chosen/tail read exactly as without `nucleusMass`.
    expect(e.omitted.map((o) => o.token)).toEqual(["5", "]"]);
    expect(e.chosen.token).toBe("items");
  });

  it("nucleus is undefined when `nucleusMass` is omitted (the default, byte-identical to the lazy-only record)", () => {
    const scanner = makeOracle(grantEnv());
    const logits = fakeLogits({ [idOf("car")]: 9, [idOf("cdr")]: 8 });
    const e = buildStepExplain({
      index: 0,
      prefixBefore: "(",
      topIds: topOrder(logits),
      chosenId: idOf("car"),
      getLogit: (id) => logits[id],
      decode: strOf,
      scanner,
    });
    expect(e.nucleus).toBeUndefined();
  });
});

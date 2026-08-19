// lazy.test.ts — the BOUNDED top-K constrained decision (`selectConstrainedStep`) against the eager
// `compileMask` reference. Model-free (real oracle + toy vocab). `selectConstrainedStep` is the unified
// per-step decision used by all current backends — testing it covers the bounded path for every one.
//
// The contracts proven here:
//   1. eager ⊇ bounded — the kernel's KEPT set is always a SUBSET of the eager allowed set (the bounded
//      walk never admits an invalid token).
//   2. argmax-equality — greedy (`keepN=1`) keeps exactly the eager-allowed token with the highest
//      model rank (the constrained argmax), even when the model's top pick is invalid.
//   3. O(K) — the bounded path makes ≤ topK oracle calls, NOT vocab-many (the real perf win, as a test).
//   4. the unbound-operator money shot — at `(` with a car/cdr-only grant, if the model ranks `foo`
//      above `car`, the kernel SKIPS `foo` (masked) and keeps `car`.
//   5. the zero-valid-in-top-K fallback fires its diagnostic reporter and does not hang.

// Resolved to arrival-scheme SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect, vi } from "vitest";

import { compileMask, type Tokenizer } from "../../src/mask-compiler.js";
import type { OracleScanner } from "../../src/oracle-types.js";
import { selectConstrainedStep } from "../../src/select-constrained-step.js";

// ── Toy vocab ────────────────────────────────────────────────────────────────────────────────────
const TOKENS = [
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

const toyTok: Tokenizer = { eosId: EOS_ID, entries: () => TOKENS };

const idOf = (s: string): number => TOKENS.find((t) => t.str === s)!.id;
const decodeToy = (ids: readonly number[]): string =>
  ids.map((id) => TOKENS.find((t) => t.id === id)?.str ?? "").join("");

const callable = (x: unknown): unknown => x;
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({ car: callable, cdr: callable });
}

/** The model's preference-ranked vocab ids, BEST FIRST: every id 0..VOCAB_SIZE-1, sorted descending by the
 *  logit `logitMap` assigns it (ids absent from the map default to `base`). This is the `rankedIds` source
 *  the kernel consumes — it replaces the old fake-logit `Tensor`, expressing the model's rank DIRECTLY (the
 *  only thing the bounded walk reads off a distribution). Stable sort ⇒ ties keep ascending-id order
 *  (irrelevant: tied tokens are the unset/invalid ones the gate masks anyway). */
function rankedOf(logitMap: Record<number, number>, base = 0): number[] {
  const logit = (id: number): number => (id in logitMap ? logitMap[id] : base);
  const ids = Array.from({ length: VOCAB_SIZE }, (_, id) => id);
  return ids.toSorted((a, b) => logit(b) - logit(a));
}

/** Wrap a scanner to COUNT oracle calls (feasible and analyze) — the perf assertion. */
function countingScanner(inner: OracleScanner): { scanner: OracleScanner; calls: () => number } {
  let n = 0;
  const scanner: OracleScanner = {
    feasible: (p) => {
      n++;
      return inner.feasible(p);
    },
    analyze: (p) => {
      n++;
      return inner.analyze(p);
    },
  };
  return { scanner, calls: () => n };
}

/** Run the SHARED bounded per-step kernel for one step at `prefix` over the `ranked` vocab, returning the
 *  mask (`keepSet`) plus the two fallback flags. This is the gguf-aligned migration of the old
 *  (historical) `LazyOracleConstraintProcessor._call` + `Tensor`: `keepSet` IS the mask the old lazy path would have written,
 *  and `widened`/`fallback` are the booleans the processor's telemetry counted per step. The
 *  `slotState`/`closeable` computation mirrors the shipping loop (lazy-processor.ts:250-255). */
function kernelStep(
  scanner: OracleScanner,
  prefix: string,
  ranked: readonly number[],
  opts: { topK?: number; keepN?: number; wideK?: number } = {},
): { keepSet: Set<number>; widened: boolean; fallback: boolean } {
  const idToStr = new Map(TOKENS.map((t) => [t.id, t.str]));
  const prefixState = scanner.analyze(prefix);
  const slotState =
    prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
      ? scanner.analyze(`${prefix} `)
      : prefixState;
  const { keepSet, widened, fallback } = selectConstrainedStep({
    scanner,
    prefix,
    rankedIds: (limit) => ranked.slice(0, limit),
    idToString: (id) => idToStr.get(id),
    allIds: () => ranked,
    slotState,
    closeable: prefixState.closeable,
    keepN: opts.keepN ?? Infinity,
    topK: opts.topK ?? VOCAB_SIZE,
    wideK: opts.wideK ?? 1024,
    eos: { addId: EOS_ID },
  });
  return { keepSet, widened, fallback };
}

// ── 1. eager ⊇ bounded, across a corpus of prefixes ─────────────────────────────────────────────────
describe("bounded ⊆ eager — the kernel kept set never admits a token the eager mask rejects", () => {
  // `((` omitted — R-HEAD-IS-SYMBOL makes a committed sub-application head an unreachable dead-end.
  const PREFIXES = ["", "(", "(car", "(car ", "(car 5", "(car 5)", "(cdr ", "(car (cdr "];
  // Ranks the toy tokens in a fixed, slightly perverse order (foo high, to stress masking).
  const LOGITS = {
    [idOf("foo")]: 9,
    [idOf("car")]: 8,
    [idOf("cdr")]: 7,
    [idOf("(")]: 6,
    [idOf("5")]: 5,
    [idOf(")")]: 4,
    [idOf(" ")]: 3,
  };

  describe.each([undefined, grantEnv()] as const)("[%s]", (grant) => {
    const label = grant ? "Σ-live" : "structural";
    it.each(PREFIXES)(`[${label}] prefix %j: kept ⊆ eager.allowed`, (prefix) => {
      const scanner = makeOracle(grant);
      const eager = compileMask(scanner, prefix, toyTok);
      const { keepSet } = kernelStep(scanner, prefix, rankedOf(LOGITS), { topK: VOCAB_SIZE, keepN: Infinity });
      for (const id of keepSet) {
        expect(eager.allowed.has(id), `kernel kept ${id} (${decodeToy([id])}) not in eager allowed`).toBe(true);
      }
    });
  });
});

// ── 2. greedy argmax-equality ─────────────────────────────────────────────────────────────────────
describe("greedy (keepN=1) keeps exactly the highest-ranked EAGER-ALLOWED token (constrained argmax)", () => {
  it("model's top pick is VALID ⇒ the kernel keeps it", () => {
    const scanner = makeOracle(grantEnv());
    // At "(", car is allowed and ranked highest among allowed.
    const ranked = rankedOf({ [idOf("car")]: 9, [idOf("cdr")]: 8, [idOf("foo")]: 7, [idOf("(")]: 6 });
    const { keepSet } = kernelStep(scanner, "(", ranked, { topK: VOCAB_SIZE, keepN: 1 });
    expect(keepSet.has(idOf("car"))).toBe(true);
    expect(keepSet.size).toBe(1);
  });

  it("model's top pick is INVALID (foo at operator slot) ⇒ the kernel descends to the first valid (car)", () => {
    const scanner = makeOracle(grantEnv());
    // foo ranked ABOVE car: the model WANTS the unbound operator. Greedy must skip it.
    const ranked = rankedOf({ [idOf("foo")]: 9, [idOf("car")]: 8, [idOf("cdr")]: 7, [idOf("(")]: 6 });
    const { keepSet } = kernelStep(scanner, "(", ranked, { topK: VOCAB_SIZE, keepN: 1 });
    expect(keepSet.has(idOf("foo"))).toBe(false); // masked — unbound operator
    expect(keepSet.has(idOf("car"))).toBe(true); // the constrained argmax
    expect(keepSet.size).toBe(1);
  });

  it("greedy kept token == the highest-ranked token of the EAGER allowed set", () => {
    const scanner = makeOracle(grantEnv());
    const ranked = rankedOf({ [idOf("foo")]: 9, [idOf(")")]: 8, [idOf("car")]: 7, [idOf("cdr")]: 6, [idOf("(")]: 5 });
    const eager = compileMask(scanner, "(", toyTok);
    // Highest-ranked eager-allowed token, computed independently from the rank order.
    const order = [idOf("foo"), idOf(")"), idOf("car"), idOf("cdr"), idOf("(")];
    const expectedArgmax = order.find((id) => eager.allowed.has(id))!;
    const { keepSet } = kernelStep(scanner, "(", ranked, { topK: VOCAB_SIZE, keepN: 1 });
    expect([...keepSet]).toEqual([expectedArgmax]);
  });
});

// ── 3. O(K) oracle calls, NOT O(vocab) ────────────────────────────────────────────────────────────
describe("oracle-call count is O(topK), not O(vocab) — the perf property", () => {
  it("the bounded path makes ≤ topK feasibility calls; eager makes ~vocab", () => {
    const TOP_K = 3;
    const prefix = "(";
    const ranked = rankedOf({
      [idOf("foo")]: 9,
      [idOf("car")]: 8,
      [idOf("cdr")]: 7,
      [idOf("(")]: 6,
      [idOf("5")]: 5,
      [idOf(")")]: 4,
      [idOf(" ")]: 3,
    });

    // Bounded: count oracle calls during one step.
    const lazyCounter = countingScanner(makeOracle(grantEnv()));
    kernelStep(lazyCounter.scanner, prefix, ranked, { topK: TOP_K, keepN: Infinity });
    const lazyCalls = lazyCounter.calls();

    // Eager: count oracle calls for the same prefix.
    const eagerCounter = countingScanner(makeOracle(grantEnv()));
    compileMask(eagerCounter.scanner, prefix, toyTok);
    const eagerCalls = eagerCounter.calls();

    // The bounded walk consults the oracle for at most topK candidates (≤2 oracle calls each: feasible +
    // analyze) plus one closeable/slot `analyze`. The KEY claim: it does NOT scale with vocab.
    expect(lazyCalls).toBeLessThanOrEqual(TOP_K * 2 + 1);
    // Eager scales with the FULL vocab (one feasible + up to one analyze per entry, + closeable).
    expect(eagerCalls).toBeGreaterThan(TOKENS.length); // > 7 — touched every entry
    // The headline ratio: the bounded path did strictly fewer oracle calls than eager.
    expect(lazyCalls).toBeLessThan(eagerCalls);
  });
});

// ── 4. the unbound-operator money shot ────────────────────────────────────────────────────────────
describe("money shot — at '(' with a car/cdr-only grant, model ranking foo above car ⇒ the kernel keeps car not foo", () => {
  it("foo masked, car kept (top-valid keepN=Infinity)", () => {
    const scanner = makeOracle(grantEnv());
    const ranked = rankedOf({ [idOf("foo")]: 100, [idOf("car")]: 50, [idOf("cdr")]: 40, [idOf("(")]: 10 });
    const { keepSet } = kernelStep(scanner, "(", ranked, { topK: VOCAB_SIZE, keepN: Infinity });
    expect(keepSet.has(idOf("foo"))).toBe(false);
    expect(keepSet.has(idOf("car"))).toBe(true);
    expect(keepSet.has(idOf("cdr"))).toBe(true);
  });
});

// ── 5. zero-valid-in-top-K fallback ───────────────────────────────────────────────────────────────
describe("fallback — zero valid in top-K fires the diagnostic reporter and does NOT hang", () => {
  it("widens K, then forces structural completion + reports; closeable prefix keeps EOS", () => {
    // A scanner where NOTHING is feasible but the prefix IS closeable (so EOS rescues generation). The
    // reporter spy stands in for the lazy backend's console.warn — the kernel fires its injected `report`
    // callback on the structural fallback; that the callback runs once IS the diagnostic contract.
    const deadButCloseable: OracleScanner = {
      feasible: () => false,
      analyze: () => ({
        midToken: false,
        position: "top" as const,
        formKind: "top" as const,
        closeable: true,
        overClosed: false,
        validSymbols: () => null,
      }),
    };
    const ranked = rankedOf({ [idOf("foo")]: 9, [idOf("car")]: 8 });
    const idToStr = new Map(TOKENS.map((t) => [t.id, t.str]));
    const report = vi.fn();
    const state = deadButCloseable.analyze("(");
    const { keepSet, widened, fallback } = selectConstrainedStep(
      {
        scanner: deadButCloseable,
        prefix: "(",
        rankedIds: (limit) => ranked.slice(0, limit),
        idToString: (id) => idToStr.get(id),
        allIds: () => ranked,
        slotState: state,
        closeable: state.closeable,
        keepN: Infinity,
        topK: 2,
        wideK: VOCAB_SIZE,
        eos: { addId: EOS_ID },
      },
      report,
    );
    // The kernel widened (zero valid in top-K), then ran the structural fallback, firing the reporter once.
    expect(widened).toBe(true);
    expect(fallback).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    // EOS kept (closeable) — generation can terminate cleanly, no hang.
    expect(keepSet.has(EOS_ID)).toBe(true);
  });

  it("over-constrained (nothing feasible AND not closeable) throws instead of hanging", () => {
    const deadScanner: OracleScanner = {
      feasible: () => false,
      analyze: () => ({
        midToken: false,
        position: "top" as const,
        formKind: "top" as const,
        closeable: false,
        overClosed: false,
        validSymbols: () => null,
      }),
    };
    const ranked = rankedOf({ [idOf("foo")]: 9 });
    expect(() => kernelStep(deadScanner, "(", ranked, { topK: 2, wideK: VOCAB_SIZE })).toThrow(/over-constrained/);
  });
});

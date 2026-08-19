// select-constrained-step.test.ts — the UNIT contract for the shared per-step decision both decoders use.
//
// `selectConstrainedStep` is the shared decision used by the reference path and the llama backend(s)
// both call (the extraction that killed the slotState-threading divergence). lazy.test.ts /
// session-parity.test.ts / structure-gate-e2e.test.ts exercise it THROUGH the lazy processor; this file
// pins it DIRECTLY, model-free, so its contract is legible on its own:
//
//   (a) keepN / topK / wideK behavior; the session-vs-rescan branch AGREE; `slotState` threads into the
//       type-derived list-structure gate; the structural-closer fallback + over-constrained throw.
//   (b) the LLAMA-core read (greedy `kept[0]`, EOS competing in rank order via `isEos`) masks a scalar
//       literal at an array slot — the coverage gap that let the GGUF bug live (the llama loop walked the
//       distribution itself and never threaded slotState, so the gate was dead there).
//
// It runs in the DEFAULT suite (a verdict, per .claude/rules/tests.md).

// Resolved to arrival SOURCE via the vitest alias (vitest.config.ts) — the REAL oracle (Σ + structure).

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, expect, it, vi } from "vitest";

import type { OracleScanner, OracleState } from "../../src/oracle-types.js";
import { selectConstrainedStep, type SelectConstrainedStepArgs } from "../../src/select-constrained-step.js";
import { narrowByTypeAsync, type AsyncTypeLens } from "../../src/typed-scanner-async.js";

const callable = (x: unknown): unknown => x;
/** A grant env binding the callees the structure/Σ cases reference. */
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({
    "set-tags": callable,
    "set-name": callable,
    items: callable,
    car: callable,
  });
}

// A toy vocab spanning the literal openers + structural tokens, shared by the synthetic cases. The id↔str
// maps mirror what each backend injects (lazy's `idToStr`, llama's `model.detokenize`).
const VOCAB: { id: number; str: string }[] = [
  { id: 0, str: '"' }, // string-literal opener (scalar)
  { id: 1, str: "[" }, // vector materializer (list)
  { id: 2, str: "'" }, // quote-list materializer (list)
  { id: 3, str: "(" }, // a call (always legal)
  { id: 4, str: "items" }, // a bound bare symbol (always legal)
  { id: 5, str: ")" }, // a closer
  { id: 6, str: "5" }, // a number literal (scalar)
];
const EOS_ID = 99;
const idToString = (id: number): string | undefined => VOCAB.find((t) => t.id === id)?.str;
const allIds = (): Iterable<number> => VOCAB.map((t) => t.id);
/** A ranked id list (best-first) limited to `limit`. */
const rankedFrom =
  (order: number[]) =>
  (limit: number): number[] =>
    order.slice(0, limit);

/** Base args with sane defaults; per-test overrides merge on top. */
function baseArgs(
  over: Partial<SelectConstrainedStepArgs> & Pick<SelectConstrainedStepArgs, "scanner" | "prefix" | "slotState">,
): SelectConstrainedStepArgs {
  return {
    rankedIds: rankedFrom(VOCAB.map((t) => t.id)),
    idToString,
    allIds,
    closeable: over.slotState.closeable,
    keepN: Infinity,
    topK: VOCAB.length,
    wideK: VOCAB.length,
    ...over,
  };
}

// ── (a1) keepN / topK / wideK ────────────────────────────────────────────────────────────────────────
describe("selectConstrainedStep — keepN / topK / wideK", () => {
  it("keepN=1 stops at the FIRST feasible id (the constrained argmax); keepN=Infinity keeps all", () => {
    const scanner = makeOracle(grantEnv());
    const slotState = scanner.analyze("("); // operator slot — `car`/`items`/`set-tags`… are bound, `5`/`"` are not callable
    // Rank tokens illegal at the operator HEAD first ("5" — a number can't be an operator; "(" — a
    // sub-application head, masked by R-HEAD-IS-SYMBOL), then the bound symbol `items`.
    const ranked = rankedFrom([6, 4, 3]); // 5, items, (
    const greedy = selectConstrainedStep(baseArgs({ scanner, prefix: "(", slotState, rankedIds: ranked, keepN: 1 }));
    // `5` is sigma-rejected at operator → first feasible is `items` (a bound callable).
    expect(greedy.kept).toEqual([4]);
    const all = selectConstrainedStep(
      baseArgs({ scanner, prefix: "(", slotState, rankedIds: ranked, keepN: Infinity }),
    );
    // keepN=Infinity keeps every feasible: ONLY `items`. `5` is sigma-masked (number-not-callable) and `(`
    // is head-masked (R-HEAD-IS-SYMBOL — a sub-application can never be the operator head).
    expect(all.kept).toEqual([4]);
    expect(all.kept).not.toContain(6); // 5 — sigma
    expect(all.kept).not.toContain(3); // ( — R-HEAD-IS-SYMBOL
  });

  it("topK bounds the walk; widening to wideK recovers a feasible id ranked beyond topK", () => {
    const scanner = makeOracle(grantEnv());
    const slotState = scanner.analyze("(");
    // `5` is sigma-rejected at the operator slot (a number can't be an operator); `items` (bound callable)
    // is the only feasible one here. Rank `5` first with topK=1 so the first pass misses `items` at rank 2.
    const ranked = rankedFrom([6, 4]); // 5, items
    const res = selectConstrainedStep(
      baseArgs({ scanner, prefix: "(", slotState, rankedIds: ranked, keepN: 1, topK: 1, wideK: VOCAB.length }),
    );
    expect(res.widened, "topK=1 had no feasible → must widen").toBe(true);
    expect(res.fallback).toBe(false);
    expect(res.kept).toEqual([4]); // recovered by the wideK pass
  });
});

// ── (a2) session-vs-rescan AGREEMENT (the perf path must match the correctness-first path) ─────────────
describe("selectConstrainedStep — session path === forceRescan path (verdict identity)", () => {
  // `((` omitted: R-HEAD-IS-SYMBOL makes a committed sub-application head unreachable (every continuation
  // of `((` is masked), so it is not a valid decode state to assert parity over.
  const PREFIXES = ["", "(", "(car", "(car ", "(car 5", "(car 5)", "(car (cdr "];
  describe.each([undefined, grantEnv()] as const)("[%s]", (grant) => {
    const label = grant ? "Σ-live" : "structural";
    describe.each([1, Infinity])("keepN=%s", (keepN) => {
      it.each(PREFIXES)(`[${label}] keepN=${keepN} prefix %j: kept identical`, (prefix) => {
        const scanner = makeOracle(grant);
        const slotState = scanner.analyze(prefix);
        const mk = (forceRescan: boolean): number[] =>
          selectConstrainedStep(baseArgs({ scanner, prefix, slotState, keepN, forceRescan })).kept;
        // makeOracle exposes session() → the default path uses it; forceRescan forces the stateless walk.
        expect(mk(false)).toEqual(mk(true));
      });
    });
  });
});

// ── (a3) slotState threads into the type-derived list-structure gate ──────────────────────────────────
// A MOCK lens stamping `slotIsArray` by the enclosing call (mirrors structure-gate-e2e). The point: the
// SAME `slotState` object the caller computes is what the shared fn must consult for the structure gate —
// if it forgets to thread it, a wrong-shaped literal slips through (the exact GGUF bug).
const ATOM = /[^\s()[\]{}"';]/;
function headOfOpenCall(prefix: string): string | null {
  const open = prefix.lastIndexOf("(");
  if (open === -1) return null;
  let i = open + 1;
  while (i < prefix.length && /\s/.test(prefix[i])) i++;
  let head = "";
  while (i < prefix.length && ATOM.test(prefix[i])) head += prefix[i++];
  return head === "" ? null : head;
}
function mockLens(): AsyncTypeLens {
  return {
    getTypeValidCandidates: (_s, _o, candidates) => Promise.resolve([...candidates]),
    getSlotIsArray: (scheme, off) => {
      const head = headOfOpenCall(scheme.slice(0, off));
      if (head === null) return Promise.resolve(null);
      if (head.startsWith("set-tags")) return Promise.resolve(true);
      if (head.startsWith("set-name")) return Promise.resolve(false);
      return Promise.resolve(null);
    },
    // The scalar-string Σ exemption is inert here (null) — this suite isolates the structure-gate axis.
    getSlotAcceptsBareWord: () => Promise.resolve(null),
    // CUT A's array-element axis stays inert here (this suite isolates the OUTER-slot structure gate).
    getSlotElementType: () => Promise.resolve({ isStringy: null, enum: null }),
  };
}

describe("selectConstrainedStep — slotState threads the list-structure gate (the bug this extraction kills)", () => {
  it("ARRAY slot (set-tags): a scalar literal is masked; list materializers + symbol survive", async () => {
    // narrowByTypeAsync is SESSION-LESS → the shared fn takes the re-scan path and reads slotState.
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags ";
    await scanner.prefill(slot);
    const slotState = scanner.analyze(slot);
    expect(slotState.slotIsArray, "the array-slot stamp must reach the state").toBe(true);

    // keepN=Infinity, all tokens ranked. The scalar literals (`"`, `5`) must be masked; the list
    // materializers (`'`, `[`), a call (`(`), and a bound symbol (`items`) survive.
    const res = selectConstrainedStep(baseArgs({ scanner, prefix: slot, slotState }));
    const keptStrs = new Set(res.kept.map((id) => idToString(id)));
    expect(keptStrs.has('"'), "a string literal opens a SCALAR — masked at an array slot").toBe(false);
    expect(keptStrs.has("5"), "a number literal is a SCALAR — masked at an array slot").toBe(false);
    expect(keptStrs.has("["), "the vector-literal materializer is first-class at an array slot").toBe(true);
    expect(keptStrs.has("'"), "the quote-list materializer survives").toBe(true);
    expect(keptStrs.has("("), "a call survives (return type checked at the callee)").toBe(true);
    expect(keptStrs.has("items"), "a bound bare symbol survives").toBe(true);
  });

  it("WITHOUT threading slotState the gate is dead — the GGUF bug, reproduced as a negative control", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags ";
    await scanner.prefill(slot);
    const stamped = scanner.analyze(slot);
    // Pass a NON-stamped state (slotIsArray absent) — exactly what the llama loop did before this fix
    // (it never computed/threaded the value-slot state). The scalar `"`/`5` then slip through.
    const unstamped: OracleState = { ...stamped, slotIsArray: undefined };
    const res = selectConstrainedStep(baseArgs({ scanner, prefix: slot, slotState: unstamped }));
    const keptStrs = new Set(res.kept.map((id) => idToString(id)));
    expect(keptStrs.has('"'), "un-threaded slotState ⇒ the structure gate is a no-op (the bug)").toBe(true);
    expect(keptStrs.has("5"), "un-threaded slotState ⇒ scalar number also slips through").toBe(true);
  });
});

// ── (b) the LLAMA-core read: greedy kept[0] masks a scalar at an array slot; EOS competes via isEos ─────
describe("selectConstrainedStep — the llama greedy/EOS read of `kept`", () => {
  it("greedy kept[0] at an ARRAY slot skips the model's scalar top pick for a list materializer", async () => {
    const scanner = narrowByTypeAsync(makeOracle(grantEnv()), mockLens());
    const slot = "(set-tags ";
    await scanner.prefill(slot);
    const slotState = scanner.analyze(slot);
    // The model RANKS a scalar string first (its label-bias preference), then the quote-list materializer.
    const ranked = rankedFrom([0, 2, 4]); // ", ', items
    const res = selectConstrainedStep(
      baseArgs({
        scanner,
        prefix: slot,
        slotState,
        rankedIds: ranked,
        keepN: 1,
        eos: { isEos: (id) => id === EOS_ID },
      }),
    );
    // Greedy llama picks kept[0]; the scalar `"` is structure-masked, so kept[0] is the list opener `'`.
    expect(idToString(res.kept[0])).toBe("'");
  });

  it("EOS competes in rank order via isEos: at a closeable prefix a high-ranked EOS becomes the greedy pick", () => {
    const scanner = makeOracle(grantEnv());
    const slotState = scanner.analyze("(car 5)"); // a balanced, CLOSEABLE form
    expect(slotState.closeable).toBe(true);
    // Rank EOS first (the model wants to stop), then a `)` (over-close, infeasible) and a space.
    const res = selectConstrainedStep({
      scanner,
      prefix: "(car 5)",
      rankedIds: rankedFrom([EOS_ID, 5]),
      idToString,
      allIds: () => [EOS_ID, 5],
      slotState,
      closeable: true,
      keepN: 1,
      topK: 5,
      wideK: 5,
      eos: { isEos: (id) => id === EOS_ID }, // llama's in-walk EOS detection (no addId — it reads `kept`)
    });
    // EOS is live (closeable) at rank 1 → the greedy constrained argmax IS EOS (stop here).
    expect(res.kept[0]).toBe(EOS_ID);
  });

  it("EOS does NOT compete when NOT closeable: a mid-form EOS is skipped, a feasible content token wins", () => {
    const scanner = makeOracle(grantEnv());
    const slotState = scanner.analyze("("); // open application — NOT closeable
    expect(slotState.closeable).toBe(false);
    const res = selectConstrainedStep({
      scanner,
      prefix: "(",
      rankedIds: rankedFrom([EOS_ID, 4]), // EOS, items
      idToString,
      allIds: () => [EOS_ID, 4],
      slotState,
      closeable: false,
      keepN: 1,
      topK: 5,
      wideK: 5,
      eos: { isEos: (id) => id === EOS_ID },
    });
    expect(res.kept[0], "EOS masked mid-form → the bound symbol `items` is the pick").toBe(4);
  });
});

// ── structural fallback + over-constrained throw (shared by both backends) ─────────────────────────────
/** A dead top-level OracleState (nothing bound) with the given closeability — the fallback fixtures. */
const deadState = (closeable: boolean): OracleState => ({
  midToken: false,
  position: "top",
  formKind: "top",
  closeable,
  overClosed: false,
  validSymbols: () => null,
});

describe("selectConstrainedStep — structural fallback and over-constrained throw", () => {
  /** A scanner where NOTHING is feasible (session-less → re-scan path). */
  const deadScanner: OracleScanner = { feasible: () => false, analyze: () => deadState(false) };

  it("zero feasible + closeable: fallback fires (empty kept), the reporter is called once, no throw", () => {
    const report = vi.fn();
    const res = selectConstrainedStep(
      {
        scanner: { feasible: () => false, analyze: () => deadState(true) },
        prefix: "(",
        rankedIds: rankedFrom([0, 4]),
        idToString,
        allIds,
        slotState: deadState(true),
        closeable: true,
        keepN: Infinity,
        topK: 1,
        wideK: VOCAB.length,
        eos: { addId: EOS_ID }, // the mask-by-keepSet backend's EOS add
      },
      report,
    );
    expect(res.widened, "topK=1 had no feasible → widened").toBe(true);
    expect(res.fallback, "wideK also had no feasible → structural fallback").toBe(true);
    expect(report).toHaveBeenCalledOnce();
    expect(res.keepSet.has(EOS_ID), "closeable ⇒ EOS added to the mask set").toBe(true);
    expect(res.kept, "nothing structural admitted (all infeasible) ⇒ kept stays empty").toEqual([]);
  });

  it("zero feasible + NOT closeable + no admissible closer: throws over-constrained", () => {
    expect(() =>
      selectConstrainedStep({
        scanner: deadScanner,
        prefix: "(",
        rankedIds: rankedFrom([0, 4]),
        idToString,
        allIds,
        slotState: deadState(false),
        closeable: false,
        keepN: Infinity,
        topK: 1,
        wideK: VOCAB.length,
        eos: { addId: EOS_ID },
      }),
    ).toThrow(/over-constrained/);
  });

  it("zero feasible + NOT closeable but a closer IS live: the closer reaches BOTH kept and keepSet", () => {
    // A scanner that rejects everything EXCEPT the bare closer `)` — the structural-progress fallback.
    const closerOnly: OracleScanner = {
      analyze: () => deadState(false),
      feasible: (p: string) => p === "(items" || p.endsWith(")"), // accept the seed + a `)`-terminated continuation
    };
    const res = selectConstrainedStep({
      scanner: closerOnly,
      prefix: "(items",
      rankedIds: rankedFrom([0]), // only the (infeasible) string opener is ranked → forces the fallback
      idToString,
      allIds, // the full vocab includes `)` (id 5) — the fallback scans here
      slotState: deadState(false),
      closeable: false,
      keepN: Infinity,
      topK: VOCAB.length,
      wideK: VOCAB.length,
      eos: { isEos: (id) => id === EOS_ID, addId: EOS_ID },
    });
    expect(res.fallback).toBe(true);
    // The closer is pickable by the llama-core read (`kept`) AND maskable by the lazy read (`keepSet`).
    expect(res.kept.map(idToString), "the live closer reaches kept (llama can pick it)").toContain(")");
    expect([...res.keepSet].map(idToString), "and keepSet (lazy can mask to it)").toContain(")");
  });
});

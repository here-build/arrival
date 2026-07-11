// kwargs-decode-errors — RED suite for the kwargs zod-decode humanizer (Phase 0 of
// docs/args-error-reporting-v2.md's landing strategy, §7.2). Coordinates with
// arrival-manifold docs/args-error-reporting-v2.md — the frozen strings below are
// H-4-adjacent; do not implement piecemeal.
//
// Today (rosetta.ts:114, `z.decode(kwargsSchema, collectKwargsObject(args))`), a rejected
// kwargs decode propagates the raw ZodError issues dump — no per-issue humanization, no
// stable line grammar. §2.5 of the design doc freezes the intended shape:
//
//   <name>: arguments rejected — <n> problem(s):
//     :<path> — <humanized issue>
//
// so the localized args-misuse door (mcp-substrate, landed later) can parse `:<path> —`
// off the FIRST line with no heuristics (the own-decode clue family, §2.5 point 2). Every
// row here is `it.fails`: it must fail NOW (today's raw dump doesn't match the frozen
// shape) and flip mechanically — silently, loudly if it flips green before the humanizer
// lands (P15) — the moment `common/kwargs-rejection.ts` (design doc §7.3 Phase 1) ships.
//
// Harness: mirrors common/__tests__/kwargs-runtime.test.ts's UNIT plane — a `symbol.rosetta`
// kwargs contract exercised directly via `def.run.call(testCallCtx(), ...pluck pairs...)`,
// no evaluator round trip needed to reach rosetta.ts:114's decode chokepoint.

import { describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { symbol, testCallCtx } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";

/** Build a keyword `ASymbol` exactly as evaluating `:key` now does (self-evaluating —
 *  keyword-tagless-apply.md) — the SAME helper kwargs-runtime.test.ts's UNIT plane uses. */
function pluck(key: string): unknown {
  return new ASymbol(CONSTANT_CTX, `:${key}`);
}

describe("kwargs decode rejection — humanized frozen shape (docs/args-error-reporting-v2.md §2.5, §7.2 R1-R3)", () => {
  // R1: a single value-mismatch issue (the 45edee trajectory's attempt 1 shape — a scalar
  // sent where the kwargs field declares an object) humanizes to the frozen head + one
  // per-issue line, instead of today's raw ZodError issues dump.
  it.fails(
    "R1 — a single-issue kwargs rejection humanizes to '<name>: arguments rejected — 1 problem(s):' " +
      "+ one ':<param> — expected <type>, got <type>: <preview>' line (today: raw ZodError dump — the " +
      "known regression fixed by the rosetta.ts kwargs-decode humanizer, design doc §2.5)",
    async () => {
      const def = symbol.rosetta`greet: kwargs greeting`(
        { input: [], inputRest: { query: z.object({ term: z.string.optional() }) }, output: [z.string] },
        (args) => JSON.stringify(args.query),
      );
      let caught: unknown;
      try {
        await def.run.call(testCallCtx(), pluck("query"), new AString(CONSTANT_CTX, "King Saud University"));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        'greet: arguments rejected — 1 problem(s):\n  :query — expected object, got string: "King Saud University"',
      );
    },
  );

  // R2: THE SILENT-STRIP PROBE (Open Question 1). zod's `z.object` default STRIPS unknown
  // keys rather than rejecting them — verified empirically against zod 4.3.6 (this
  // package's pinned version) on 2026-07-11: `z.decode(z.object({query: z.string(),
  // pageSize: z.number().optional()}), {query: "x", pagesize: 50})` succeeds silently with
  // `pageSize` left `undefined` — the misspelled OPTIONAL key vanishes with NO rejection at
  // all, exactly the "worse than any error" silent failure the design doc's Open Question 1
  // warns about. This row pins that a misspelled kwarg key is REJECTED, never silently
  // dropped — CONFIRMED FAILING at authoring time (2026-07-11): the call below resolves
  // instead of rejecting. Stays `it.fails` until the strictObject fix (design doc Open
  // Question 1 — a separate commit, since it changes accept/reject behavior, not just
  // reporting) lands; flips to a plain pin the day this hazard is disproven for real.
  it.fails(
    "R2 — THE SILENT-STRIP PROBE: a misspelled OPTIONAL kwarg key (:pagesize vs declared :pageSize) is " +
      "REJECTED, never silently dropped (CONFIRMED failing 2026-07-11 — z.object's default strip mode lets " +
      "it through with pageSize left undefined; z.strictObject is the fix, design doc Open Question 1)",
    async () => {
      const def = symbol.rosetta`search: kwargs search`(
        { input: [], inputRest: { query: z.string, pageSize: z.number.optional() }, output: [z.string] },
        (args) => `${args.query}:${args.pageSize}`,
      );
      await expect(
        def.run.call(
          testCallCtx(),
          pluck("query"),
          new AString(CONSTANT_CTX, "King Saud University"),
          // Typo: "pagesize" (lowercase s) — the declared field is "pageSize".
          pluck("pagesize"),
          new AString(CONSTANT_CTX, "50"),
        ),
      ).rejects.toThrow();
    },
  );

  // R3: multi-issue rejection counts every problem and lists each on its own line, in
  // schema declaration order (verified against zod 4.3.6 directly: `z.decode` on a
  // multi-required-field object returns issues in shape-declaration order, not sent-arg
  // order) — a model reading a truncated observation should see the FIRST-declared miss
  // first, matching the signature it was just shown.
  it.fails(
    "R3 — a two-issue kwargs rejection counts BOTH problems and lists each on its own line, in schema " +
      "declaration order (query before pageSize) — today: raw ZodError dump, no stable count/order contract",
    async () => {
      const def = symbol.rosetta`search: kwargs search two-required`(
        { input: [], inputRest: { query: z.string, pageSize: z.number }, output: [z.string] },
        (args) => `${args.query}:${args.pageSize}`,
      );
      let caught: unknown;
      try {
        // Zero args — both required kwargs missing.
        await def.run.call(testCallCtx());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        "search: arguments rejected — 2 problem(s):\n  :query — missing (required)\n  :pageSize — missing (required)",
      );
    },
  );
});

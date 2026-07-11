/**
 * LAW — scheme-zod's container codecs charge the run's heap meter (CONSTANT_CTX-audit
 * §2.2, "worst by blast radius" #2 — docs/working-proposals/arrival-constant-ctx-audit-
 * 2026-07-11.md).
 *
 * Before this law's fix, a `list`/`vector`/`dict`-typed rosetta/procedure crossing was a
 * SECOND, completely unmetered path to materialize an arbitrary amount of scheme
 * structure, invisible to `heapBudget` (heap-budget.ts's own per-run allocation bound):
 *
 *   - DECODE (`spineToArray`, list's scheme→JS direction): walked an existing pair spine
 *     into a JS array with NO charge at all — unlike `env/pack-helpers.ts`'s `to_array`,
 *     which charges the SAME shape of walk for every list-consuming builtin (append/
 *     join/reverse/…). A `list(...)`-typed contract ARG was a hole straight around it.
 *   - ENCODE (list/vector/dict's JS→scheme direction): minted the fresh spine under
 *     CONSTANT_CTX — a run-NEUTRAL ctx whose `heapMeter` is always `undefined`, so even a
 *     `chargeHeap` call against it is a permanent no-op. Every rosetta RETURN typed
 *     `list(...)`/`vector(...)`/`dict(...)` was silently exempt from the run's budget.
 *
 * This suite pins both directions for `list` (the case named explicitly in the rework
 * brief) plus `vector`/`dict` (named in the same audit finding) — and the control case
 * (a small crossing under the identical tight budget stays unaffected, so the trips below
 * are the container's OWN charge, not budget exhaustion from test setup).
 */
import { describe, expect, it } from "vitest";
import * as z from "../../common/scheme-zod.js";
import { CONSTANT_CTX, makeRunContext } from "../../values/primitives/RunContext.js";
import { APair } from "../../values/primitives/APair.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ADict } from "../../values/primitives/ADict.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import type { AListAlike, SchemeValue } from "../../values/types.js";

const TIGHT_BUDGET = 50;

function schemeExactList(n: number, ctx = makeRunContext({ heapBudget: TIGHT_BUDGET })): AListAlike {
  const elements: SchemeValue[] = Array.from({ length: n }, (_, i) => new AExact(ctx, BigInt(i)));
  return APair.fromArray(ctx, elements, false);
}

describe("LAW — list codec DECODE (spineToArray) charges the operand's own heap meter", () => {
  it("decoding a large list arg under a tight budget dies on the budget door", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    const big = schemeExactList(500, ctx);
    expect(() => z.decode(z.list(z.integer), big)).toThrow(/heap budget exceeded/);
  });

  it("decoding a small list under the SAME tight budget is unaffected (normal-size crossings survive)", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    const small = schemeExactList(3, ctx);
    expect(z.decode(z.list(z.integer), small)).toEqual([0, 1, 2]);
  });

  it("decoding a large QUOTED list (CONSTANT_CTX — no meter) is unaffected, matching to_array's own rule: parse-bounded, never metered", () => {
    const big = schemeExactList(500, CONSTANT_CTX);
    expect(z.decode(z.list(z.integer), big)).toHaveLength(500);
  });
});

describe("LAW — list/vector/dict codec ENCODE mints under the crossing's own run, heap-charged", () => {
  it("encoding a large array into a list under a tight budget dies on the budget door", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    const elements: SchemeValue[] = Array.from({ length: 500 }, (_, i) => new AExact(ctx, BigInt(i)));
    expect(() => z.encode(z.list(z.value), elements)).toThrow(/heap budget exceeded/);
  });

  it("encoding a small array into a list under the SAME tight budget is unaffected", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    const elements: SchemeValue[] = [new AExact(ctx, 1n), new AExact(ctx, 2n)];
    const result = z.encode(z.list(z.value), elements);
    expect(result).toBeInstanceOf(APair);
  });

  it("encoding a large array into a vector under a tight budget dies on the budget door", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    const elements: SchemeValue[] = Array.from({ length: 500 }, (_, i) => new AExact(ctx, BigInt(i)));
    expect(() => z.encode(z.vector(z.value), elements)).toThrow(/heap budget exceeded/);
  });

  it("encoding a large record into a dict under a tight budget dies on the budget door", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    const rec: Record<string, SchemeValue> = {};
    for (let i = 0; i < 500; i++) rec[`k${i}`] = new AExact(ctx, BigInt(i));
    expect(() => z.encode(z.dict(), rec)).toThrow(/heap budget exceeded/);
  });

  it("decoding a large dict under a tight budget ALSO dies on the budget door (the key-walk, not just the mint)", () => {
    const ctx = makeRunContext({ heapBudget: TIGHT_BUDGET });
    // Keys/values minted under CONSTANT_CTX (ASymbol interning charges its OWN heap on
    // construction — unrelated to this law) — the ADict CONTAINER itself is built directly
    // under the tight `ctx`, so this test isolates the DECODE-side (key-walk) charge, which
    // reads `ctxOf(src)` (the dict's own ctx), from both ASymbol's charge and the ENCODE-side
    // (mint) charge pinned separately above.
    const entries: [ASymbol, SchemeValue][] = Array.from({ length: 500 }, (_, i) => [
      new ASymbol(CONSTANT_CTX, `k${i}`),
      new AExact(CONSTANT_CTX, BigInt(i)),
    ]);
    const dict = new ADict(ctx, entries);
    expect(() => z.decode(z.dict(), dict)).toThrow(/heap budget exceeded/);
  });

  it("an EMPTY container has no element to inherit a run from — mints under CONSTANT_CTX (no meter), never throws", () => {
    expect(() => z.encode(z.list(z.value), [] as SchemeValue[])).not.toThrow();
    expect(() => z.encode(z.vector(z.value), [] as SchemeValue[])).not.toThrow();
    expect(() => z.encode(z.dict(), {})).not.toThrow();
  });
});

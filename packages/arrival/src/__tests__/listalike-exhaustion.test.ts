// B3-REAL (second-foundation/arrival-manifold/docs/benchmark-defect-register.md §B3 +
// LOAD-BEARING CONSTRAINT #1) — the `listAlike` codec is DEAD for scheme-bodied verbs, and the
// consequence is an INFINITE LOOP, not a wrong answer.
//
// The chain, verified against the code (grok-triad review, 2026-07-14):
//   1. `listAlike` (env/srfi/srfi-1.ts) was made a `z.codec` materializing AJSArray → pair-list.
//   2. But its consumers are `symbol.define` (scheme bodies), and define-bake.ts's impl does
//      `if (def.validate) z.decode(def.in, args)` — the decoded value is DISCARDED, and NO verb in
//      the tree sets `validate: true` (0 of 207). So the raw AJSArray (kind="vector") reaches the body.
//   3. `AVector["arrival/tagless-final/cdr"]` returns `new AVector(slice(1))` — on an EMPTY vector it
//      returns ANOTHER EMPTY VECTOR, never ANil. And `null?` is `is_nil`/ANil-only.
//   4. Therefore every body shaped `(if (null? xs) <base> (loop (cdr xs)))` NEVER TERMINATES on a
//      vector — it spins on the empty-vector fixpoint until the allocation budget kills the call.
//
// TRIGGER: `(delete-duplicates (any-tool-returning-a-json-array))` — the most ordinary
// compose-in-program idiom there is, over EVERY MCP tool that returns a JSON array. STRICTLY WORSE
// than the clean ZodError reject it replaced.
//
// The previously-shipped regression test was a FALSE GREEN: it only checked `(any? odd? [2,4,6,7])`,
// whose predicate matches on the LAST element — so the walk never reaches the empty tail and the bug
// cannot fire. EVERY case below is chosen to WALK TO EXHAUSTION.
//
// Each test carries an explicit short timeout: a regression must FAIL the test, never hang CI.
import { describe, expect, it } from "vitest";

import { mintFrame } from "../AmbientRuntime.js";
import { execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { schemeToJs } from "../index.js";
import { jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

/** `xs` is bound through `jsToScheme`, so it arrives as a real `AJSArray` — exactly what an MCP
 *  tool returning a JSON array hands the model. That receiver is the whole point of this file. */
const run = (code: string, bindings: Record<string, unknown> = {}) =>
  execState(code, {
    env: mintFrame(
      inferenceEnv,
      "listalike-exhaustion",
      Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, jsToScheme(CONSTANT_CTX, v)])),
    ),
  });

const out = async (code: string, bindings: Record<string, unknown> = {}) => {
  const { values } = await run(code, bindings);
  return schemeToJs(values[0], {});
};

const HANG_GUARD = { timeout: 8000 } as const;

describe("listAlike consumers must TERMINATE on an AJSArray receiver — §B3, constraint #1", () => {
  it("any? — predicate FALSE for every element (the false-green test matched the LAST element)", HANG_GUARD, async () => {
    expect(await out("(any? even? xs)", { xs: [1, 3, 5] })).toBe(false);
  });

  it("delete-duplicates — the register's canonical trigger", HANG_GUARD, async () => {
    expect(await out("(delete-duplicates xs)", { xs: [1, 2, 1] })).toEqual([1, 2]);
  });

  it("fold-right — a right fold walks the whole spine", HANG_GUARD, async () => {
    expect(await out("(fold-right + 0 xs)", { xs: [1, 2, 3] })).toBe(6);
  });

  it("find-tail — no match, so it must reach the empty tail to answer", HANG_GUARD, async () => {
    const r = await out("(find-tail even? xs)", { xs: [1, 3, 5] });
    expect(r === false || r === null || (Array.isArray(r) && r.length === 0)).toBe(true);
  });

  it("partition — both arms consume the full spine", HANG_GUARD, async () => {
    expect(await out("(partition even? xs)", { xs: [1, 2, 3, 4] })).toEqual([
      [2, 4],
      [1, 3],
    ]);
  });

  it("delete — removes matches, walks the rest", HANG_GUARD, async () => {
    expect(await out("(delete 2 xs)", { xs: [1, 2, 3] })).toEqual([1, 3]);
  });

  it("append-reverse — consumes the head list to exhaustion", HANG_GUARD, async () => {
    expect(await out("(append-reverse xs '())", { xs: [1, 2, 3] })).toEqual([3, 2, 1]);
  });

  it("every? — predicate TRUE for all (must reach the end to answer)", HANG_GUARD, async () => {
    expect(await out("(every? odd? xs)", { xs: [1, 3, 5] })).toBe(true);
  });

  it("PRE-EXISTING GREEN must stay green: count / first on an AJSArray", HANG_GUARD, async () => {
    expect(await out("(count even? xs)", { xs: [1, 2, 3, 4] })).toBe(2);
    expect(await out("(first xs)", { xs: [9, 8] })).toBe(9);
  });

  it("proper pair-lists are unaffected — the fix materializes the RECEIVER, never changes list semantics", HANG_GUARD, async () => {
    expect(await out("(delete-duplicates '(1 2 1))")).toEqual([1, 2]);
    expect(await out("(any? even? '(1 3 5))")).toBe(false);
  });
});

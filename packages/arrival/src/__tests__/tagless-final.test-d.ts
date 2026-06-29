// tagless-final — TYPE-LEVEL PROOF that the runtime op-name list and the type-derived op set
// stay in lock-step.
//
// `TaglessOp` is DERIVED from AValue's `arrival/tagless-final/<op>` members (the single source
// of truth); `TAGLESS_OP_NAMES` is the runtime mirror (keyof is type-only, so the list must be
// hand-maintained). These two must cover each other exactly — a typo in the list, or adding an
// op on one side without the other, is a real bug. The proof was inline in `tagless-final.ts`
// (`type _ListCoversAlgebra` / `_AlgebraCoversList` / exported `_TaglessSync`); it rode the
// build's tsc but was never a TEST. It now lives here as a `*.test-d.ts` run under
// `vitest --typecheck` (see `vitest.typecheck.config.ts` + `tsconfig.typecheck.json`, which
// un-exclude the test dirs), so a one-sided op change reds CI as a real test. KEEP the runtime
// `TAGLESS_OP_NAMES` in `tagless-final.ts` — only the `_*` proofs move here.

import { describe, expectTypeOf, test } from "vitest";
import { TAGLESS_OP_NAMES, type TaglessOp } from "../values/tagless-final.js";

type ListMember = (typeof TAGLESS_OP_NAMES)[number];

describe("tagless-final — runtime op-name list ⇔ type-derived op set", () => {
  test("the runtime list COVERS the type-derived algebra (no op missing from TAGLESS_OP_NAMES)", () => {
    // Every `TaglessOp` (derived from AValue's tagless members) must appear in the runtime list.
    // Drop an op from `TAGLESS_OP_NAMES` while it still lives on AValue → this reds.
    expectTypeOf<TaglessOp>().toExtend<ListMember>();
  });

  test("the type-derived algebra COVERS the runtime list (no STALE op in TAGLESS_OP_NAMES)", () => {
    // Every runtime list member must be a real `TaglessOp`. A typo'd or removed-from-AValue
    // name in `TAGLESS_OP_NAMES` → this reds.
    expectTypeOf<ListMember>().toExtend<TaglessOp>();
  });

  test("the two sets are mutually exhaustive — the list IS exactly the algebra", () => {
    // The conjunction of the two coverage proofs: bidirectional `extends` collapses to equality.
    expectTypeOf<ListMember>().toEqualTypeOf<TaglessOp>();
  });
});

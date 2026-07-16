import type { ExpectedOutcome } from "../../index.js";

/**
 * Alist-lowering ruling (2026-07-17), the miss half: `(:missing e)` over an alist
 * with no `missing` entry. The interpreter's own accessor
 * (`AKeywordSymbol.apply` → `APair#get`,
 * foundations/arrival/arrival/src/values/primitives/APair.ts) falls through the
 * whole chain and returns `nil` — the membrane's JS face for `nil` is the empty
 * array `[]`, NOT `undefined`. The compiled `.find(...)` naturally yields
 * `undefined` on a miss (`Array.prototype.find` itself); the emit rule coerces
 * it to `[]` to agree — pinned here so that coercion can never regress silently.
 */
export const expected: ExpectedOutcome = { value: [] };

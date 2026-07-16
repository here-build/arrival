import type { ExpectedOutcome } from "../../index.js";

/**
 * The compound cxr family over real lists (rules/phase1.ts's `compoundCxrRules`
 * — the representation-collapse law extended past car/cdr): `cadr`/`caddr`
 * fold to a plain index (`xs[1]`/`xs[2]`), `cddr` to a slice (`xs.slice(2)`),
 * and `cadar` — a genuine multi-level COMPOSITION, not just a run of one
 * letter — folds to the nested `xs[0][1]` chain the derivation is built to
 * produce (car of (10 20 30), then cdr, then car → the second element of the
 * first sublist).
 */
export const expected: ExpectedOutcome = {
  value: [2, 3, [3, 4, 5], 20],
};

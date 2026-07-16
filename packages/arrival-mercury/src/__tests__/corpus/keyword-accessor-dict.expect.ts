import type { ExpectedOutcome } from "../../index.js";

/**
 * Regression guard (alist-lowering ruling, 2026-07-17): a native `dict` accessor
 * must keep narrowing to `e["guilty"]` — the recommended shape (engine-walker.md
 * §5) — never fall into the alist `.find` branch a Dict target never proves. A
 * Dict carries no `list`/`pair`/`nonEmptyList` TypeFacts (typefacts/facts.ts's own
 * doc: a plain dict object is a type the closed vocabulary has nothing to say
 * about), so the accessor's fact gate must decline it exactly as before.
 */
export const expected: ExpectedOutcome = { value: 42 };

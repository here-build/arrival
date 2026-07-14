import type { ExpectedOutcome } from "../../index.js";

/**
 * Divergence-by-design (representation collapse, constitution §2.1 + the
 * stage-0 header's catalogued consequence): `eq?` is IDENTITY, and
 * boxed-string identity is unobservable post-collapse. The interpreter's
 * strings are boxed — a freshly-appended string is a distinct object from the
 * literal, so `(eq? "ab" (string-append "a" "b"))` → `#f`. The compiled
 * world's strings are JS primitives — the stage-0 `eqP` (`Object.is`) sees two
 * equal primitives → `#t`. No later phase changes this: the collapse IS the
 * representation law; per-side assertions, permanently. (`equal?` agrees on
 * both sides — the eq-vs-equal-string-equal twin stays a plain value row.)
 */
export const expected: ExpectedOutcome = {
  divergent: {
    interpreter: { value: false },
    compiled: { value: true },
  },
};

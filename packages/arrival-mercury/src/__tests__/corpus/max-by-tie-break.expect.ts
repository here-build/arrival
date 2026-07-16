import type { ExpectedOutcome } from "../../index.js";

/**
 * `max-by` — argmax by key function (not Contract-backed anywhere; the
 * interpreter binds it via a scheme-string preamble, `arrival-run`'s
 * `BUILTIN_PREAMBLE` — see rules/phase1.ts's `"max-by"` row and
 * runtime/stage0.ts's `maxBy`). First case: plain argmax, no tie. Second case
 * PINS the tie behavior: two entries share the max key (5); the reference
 * (`(reduce (lambda (x best) (if (> (f x) (f best)) x best)) (car xs) (cdr
 * xs))`, a strict `>` fold seeded on the first element) never lets a later
 * tie displace an earlier max, so the FIRST entry carrying the max wins —
 * `[5, "first"]`, not `[5, "second"]`.
 */
export const expected: ExpectedOutcome = {
  value: [9, [5, "first"]],
};

import type { ExpectedOutcome } from "../../index.js";

/** The classic transpose idiom: `(apply map list '((1 2) (3 4)))` → `((1 3) (2 4))`. */
export const expected: ExpectedOutcome = {
  value: [
    [1, 3],
    [2, 4],
  ],
};

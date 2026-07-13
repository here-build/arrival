import type { ExpectedOutcome } from "../../index.js";

/** Law T: `""` is Scheme-truthy (only `#f` is false) — JS falsiness of `""` must not leak. */
export const expected: ExpectedOutcome = { value: "a" };

import type { ExpectedOutcome } from "../../index.js";

/** Multi-list `map` — the index-zip bridge: `(map + '(1 2) '(10 20))` → `(11 22)`. */
export const expected: ExpectedOutcome = { value: [11, 22] };

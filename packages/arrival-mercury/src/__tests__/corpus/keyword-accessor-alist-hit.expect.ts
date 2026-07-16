import type { ExpectedOutcome } from "../../index.js";

/**
 * Alist-lowering ruling (2026-07-17): `(:key e)` over an `e` PROVEN array-backed
 * (a quoted dotted-pair alist — `list`/`pair`/`nonEmptyList` TypeFacts) reads
 * Object.entries-shaped: find the `[k, v]` entry whose key matches, take its
 * value — never `e["guilty"]` (silently `undefined` on a real array). `guilty`'s
 * entry sits behind an unrelated `other` entry, so this also pins that `.find`
 * locates the right pair rather than reading whichever comes first.
 */
export const expected: ExpectedOutcome = { value: 42 };

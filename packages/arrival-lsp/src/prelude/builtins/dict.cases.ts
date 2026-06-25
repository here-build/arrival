// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the `dict` leaf (dict.d.ts) — THE MOAT's record constructor.
// expect-type assertions over the ambient `__arr`, against `as const` entry-tuples
// (the shape the lens emits), so `(dict :name "a" :age 30)` infers a PRECISE
// `Dict<Pairs>` whose values are LITERALS (`"alice"`, `30`). Each positive is
// pinned by a PAIR — `.toExtend<{…}>()` (the inferred record must extend the
// branded shape) and `.not.toBeAny()` (the explicit return→any guard, since
// `toExtend` is blind to `any`). Negatives use `// @ts-expect-error`: a wrong value
// type or a claimed-but-absent key bites at the assignment.
// Base vocab (`Dict`/`string`/`number`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// precise inference: keyword entries → precise object shape (literals extend brands)
expectTypeOf(__arr.dict([["name", "alice"], ["age", 30]] as const)).toExtend<{ name: string; age: number }>();
expectTypeOf(__arr.dict([["name", "alice"], ["age", 30]] as const)).not.toBeAny();
// single-entry dict
expectTypeOf(__arr.dict([["ok", true]] as const)).toExtend<{ ok: boolean }>();
expectTypeOf(__arr.dict([["ok", true]] as const)).not.toBeAny();

// @ts-expect-error wrong value type for a known key — age is number, not string
const row: { name: string; age: string } = __arr.dict([["name", "alice"], ["age", 30]] as const);
// @ts-expect-error claiming a key the dict does not have (missing property)
const row2: { name: string; age: number; extra: boolean } = __arr.dict([["name", "alice"], ["age", 30]] as const);

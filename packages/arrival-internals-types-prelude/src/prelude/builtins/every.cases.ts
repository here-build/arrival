// Bite cases for `every` — `every<T>(pred, xs): boolean`.
import { expectTypeOf } from "vitest";

expectTypeOf(every((x: number): boolean => x > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
expectTypeOf(every((s: string): boolean => s.length > 0, ["a", "b"])).toEqualTypeOf<boolean>();

// @ts-expect-error predicate element type mismatches the list element type
every((s: string): boolean => s.length > 0, [1, 2, 3] as List<number>);
// @ts-expect-error result is boolean, not assignable to number
const n: number = every((x: number): boolean => x > 0, [1, 2, 3]);

// Bite cases for `some`.
import { expectTypeOf } from "vitest";

expectTypeOf(some((x: number): boolean => x > 0, [1, 2, 3])).toEqualTypeOf<boolean>();
expectTypeOf(some((s: string): boolean => s.length > 0, ["a", "b"])).toEqualTypeOf<boolean>();

// @ts-expect-error predicate param mismatches list element type
some((s: string): boolean => s.length > 0, [1, 2, 3]);
// @ts-expect-error second arg is not a list
some((x: number): boolean => x > 0, 123);
// @ts-expect-error result is boolean, not number
const n: number = some((x: number): boolean => x > 0, [1, 2, 3]);

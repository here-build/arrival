// Bite cases for the `map` builtin signature.
import { expectTypeOf } from "vitest";

expectTypeOf(map((n: number): number => n, [1, 2, 3])).toEqualTypeOf<List<number>>();
expectTypeOf(map((x: number): string => `${x}`, [1, 2, 3])).toEqualTypeOf<List<string>>();

// @ts-expect-error callback param type mismatches the list element type
map((x: string): string => x, [1, 2, 3]);
// @ts-expect-error second arg is not a list
map((n: number): number => n, 123);

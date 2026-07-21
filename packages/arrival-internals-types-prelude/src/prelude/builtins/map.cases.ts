// Bite cases for the `map` builtin signature. Positives pin the EXACT result type
// with `expectTypeOf`; negatives use `// @ts-expect-error`. Reference the builtin
// via the ambient `__arr` (typed by the merged `ArrShape`); `List`/`number`/`string`
// are ambient from ../types.d.ts.
import { expectTypeOf } from "vitest";

// unary map: number list → number list via a number→number callback
expectTypeOf(__arr.map((n: number): number => n)).toEqualTypeOf<List<number>>();
// element type drives callback param + output element type
expectTypeOf(__arr.map((x: number): string => `${x}`)).toEqualTypeOf<List<string>>();

// @ts-expect-error callback param type mismatches the list element type (string param over number list)
__arr.map((x: string): string => x);
// @ts-expect-error second arg is not a list
__arr.map((n: number): number => n);

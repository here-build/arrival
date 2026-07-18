// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for the string-symbol-ops family (string-symbol-ops.d.ts). expect-type
// assertions over the ambient `__arr`; inputs are WIDENED string literals so the
// results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite). Negatives use `// @ts-expect-error`: a wrong-typed
// arg bites at the call (2345), a wrong-typed threaded result at the assignment
// (2322); if the signature rots to `any` the line stops erroring and the unused
// directive becomes the failure.
//
// ★ Precedence corrections baked into the asserted return types:
//   • `search` returns number (LIPS string `.search` index, NOT ramda `R.find`).
//   • `split`/`replace`/`match` take (sep|pat) FIRST then the string; `split`/`match`
//     return Scheme LISTS. `match` honestly returns `List<string> | boolean` (#f on no
//     match) so a downstream list use SHOULD bite.
//   • `string-ref` returns `string | Nil` (nil on out-of-range index).
// Base vocab (`string`/`number`/`boolean`/`List`/`Nil`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// symbol->string returns string (threading string->symbol's symbol back out)
expectTypeOf(__arr["symbol->string"](__arr["string->symbol"]("x"))).toEqualTypeOf<string>();
// string-ref: string | Nil — absence accounted for downstream
expectTypeOf(__arr["string-ref"]("hello", 0)).toEqualTypeOf<string | Nil>();
// substring with optional end → string
expectTypeOf(__arr.substring("hello", 1)).toEqualTypeOf<string>();
expectTypeOf(__arr.substring("hello", 1, 3)).toEqualTypeOf<string>();
// split → list of strings (sep first)
expectTypeOf(__arr.split(",", "a,b,c")).toEqualTypeOf<List<string>>();
// join collapses a list to one string
expectTypeOf(__arr.join(", ", ["a", "b"])).toEqualTypeOf<string>();
// replace pattern/replacement/string → string
expectTypeOf(__arr.replace("a", "b", "banana")).toEqualTypeOf<string>();
// search → an index (number)
expectTypeOf(__arr.search("an", "banana")).toEqualTypeOf<number>();
// match → list of groups OR #f
expectTypeOf(__arr.match("a", "banana")).toEqualTypeOf<List<string> | boolean>();
// escape-regex → string
expectTypeOf(__arr["escape-regex"]("a.b")).toEqualTypeOf<string>();

// @ts-expect-error substring needs numeric start, not a string
__arr.substring("hello", "x");
// @ts-expect-error split separator/string both strings — number as string arg bites
__arr.split(",", 42);
// @ts-expect-error search returns number, not string
const x: string = __arr.search("an", "banana");
// @ts-expect-error string-ref index must be number
__arr["string-ref"]("hello", "x");
// @ts-expect-error match may return #f — not silently a precise list
const y: List<string> = __arr.match("a", "banana");
// @ts-expect-error join wants a string separator, not a number
__arr.join(42, ["a", "b"]);

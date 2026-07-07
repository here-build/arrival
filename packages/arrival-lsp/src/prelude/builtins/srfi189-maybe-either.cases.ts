// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for SRFI-189 Maybe & Either (srfi189-maybe-either.d.ts) — expect-type
// assertions over the ambient `__arr`. Maybe/Either are the FAITHFUL tagged-list
// unions  ['just',T]|['nothing']  and  ['left',L]|['right',R]  (written INLINE —
// PRE forbids a top-level Maybe/Either alias). Constructors over WIDENED literal
// inputs thread a LITERAL through their type var, so the literal-returning
// positives are pinned by the PAIR `.toExtend<Brand>()` + `.not.toBeAny()`; where
// the result is an exact brand (callback-typed map results, number-param binds,
// explicit-type-arg swaps, boolean predicates) a single `.toEqualTypeOf<T>()` holds.
//
// ★ Leaf caveats (carried, do not "fix"):
//   • maybe-map / either-map are function-FIRST (f m) / (f e); maybe-bind /
//     either-bind are container-FIRST (m f) / (e f) — impl arg order.
//   • maybe-bind unions the bound result with the passed-through Nothing.
//   • maybe-ref/default and either-ref/default honestly union value | default.
//   • either-swap flips the sides — explicit <L,R> args make the swap observable.
// Base vocab (`List`/`number`/`string`/`boolean`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// constructors keep the tag + payload type (literal through the type var)
expectTypeOf(__arr.just(1)).toExtend<readonly ["just", number]>();
expectTypeOf(__arr.just(1)).not.toBeAny();
expectTypeOf(__arr.nothing()).toEqualTypeOf<readonly ["nothing"]>();
expectTypeOf(__arr.left("err")).toExtend<readonly ["left", string]>();
expectTypeOf(__arr.left("err")).not.toBeAny();
expectTypeOf(__arr.right(42)).toExtend<readonly ["right", number]>();
expectTypeOf(__arr.right(42)).not.toBeAny();

// tag predicates accept any value, return boolean
expectTypeOf(__arr["just?"](__arr.just(1))).toEqualTypeOf<boolean>();
expectTypeOf(__arr["maybe?"]("anything")).toEqualTypeOf<boolean>();
expectTypeOf(__arr["right?"](__arr.right(1))).toEqualTypeOf<boolean>();

// maybe-map threads the wrapped type through the callback (T → B) → exact brand
expectTypeOf(__arr["maybe-map"]((x: number): string => `${x}`, __arr.just(1))).toEqualTypeOf<
  readonly ["just", string] | readonly ["nothing"]
>();
// maybe-bind: function returns a Maybe; result unions with Nothing (number bind → exact)
expectTypeOf(__arr["maybe-bind"](__arr.just(1), (x: number) => __arr.just(x))).toEqualTypeOf<
  readonly ["just", number] | readonly ["nothing"]
>();
// maybe-ref unwraps to the wrapped value type (literal through T)
expectTypeOf(__arr["maybe-ref"](__arr.just(7))).toExtend<number>();
expectTypeOf(__arr["maybe-ref"](__arr.just(7))).not.toBeAny();
// maybe-ref/default honest union of value | default
expectTypeOf(__arr["maybe-ref/default"](__arr.just(7), "fallback")).toExtend<number | string>();
expectTypeOf(__arr["maybe-ref/default"](__arr.just(7), "fallback")).not.toBeAny();
// maybe->either flips into Either with payload preserved
expectTypeOf(__arr["maybe->either"](__arr.just(1), "no")).toExtend<
  readonly ["right", number] | readonly ["left", string]
>();
expectTypeOf(__arr["maybe->either"](__arr.just(1), "no")).not.toBeAny();
// maybe->list collects to a list of the wrapped type
expectTypeOf(__arr["maybe->list"](__arr.just(1))).toExtend<List<number>>();
expectTypeOf(__arr["maybe->list"](__arr.just(1))).not.toBeAny();
// list->maybe wraps the element type (widened list → exact brand)
expectTypeOf(__arr["list->maybe"]([1, 2, 3])).toEqualTypeOf<readonly ["just", number] | readonly ["nothing"]>();
// either-map threads the Right payload through (R → B), Left preserved → exact brand
expectTypeOf(
  __arr["either-map"](
    (x: number): boolean => x > 0,
    __arr.right(1) as readonly ["left", string] | readonly ["right", number],
  ),
).toEqualTypeOf<readonly ["left", string] | readonly ["right", boolean]>();
// either-ref unwraps the Right value type (literal through R)
expectTypeOf(__arr["either-ref"](__arr.right(5))).toExtend<number>();
expectTypeOf(__arr["either-ref"](__arr.right(5))).not.toBeAny();
// either-swap swaps the sides (explicit type args pin L/R so the swap is observable)
expectTypeOf(__arr["either-swap"]<string, number>(__arr.left("x"))).toEqualTypeOf<
  readonly ["right", string] | readonly ["left", number]
>();
// either->list collects the Right payload (literal through R)
expectTypeOf(__arr["either->list"](__arr.right(9))).toExtend<List<number>>();
expectTypeOf(__arr["either->list"](__arr.right(9))).not.toBeAny();

// @ts-expect-error just's payload type is captured: a Just<number> is not assignable to Just<string>
const bad: readonly ["just", string] = __arr.just(1);
// @ts-expect-error maybe-map callback param must match the wrapped element type (string param over Just<number>)
__arr["maybe-map"]((x: string): string => x, __arr.just(1));
// @ts-expect-error maybe-ref result is the wrapped number, not assignable to string
const w: string = __arr["maybe-ref"](__arr.just(7));
// @ts-expect-error either-map callback must consume the Right payload type (string param over Right<number>)
__arr["either-map"]((x: string): string => x, __arr.right(1) as readonly ["left", string] | readonly ["right", number]);
// @ts-expect-error maybe->list returns a list of the wrapped type, not List<string>
const wl: List<string> = __arr["maybe->list"](__arr.just(1));

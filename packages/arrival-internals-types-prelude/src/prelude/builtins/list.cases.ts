// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `list` — fixed-arity → tuple; homogeneous rest → List<T>.
// // ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// Homogeneous 3-arg still List via rest when all same? Fixed overload wins:
// list(1,2,3) is [number, number, number] which is fine for apply.
expectTypeOf(list(1, 2, 3)).toEqualTypeOf<[number, number, number]>();
// Empty → []
expectTypeOf(list()).toEqualTypeOf<[]>();
// Heterogeneous fixed-arity is intentional (apply product / zip pairs).
expectTypeOf(list(1, "a")).toEqualTypeOf<[number, string]>();
expectTypeOf(list(1, "a", true, null, 5)).toEqualTypeOf<
  [number, string, boolean, null, number]
>();

// @ts-expect-error assigning a fixed product to a scalar bites
const n: number = list(1, 2, 3);

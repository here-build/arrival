// carriers.test-d.ts — bite-guard for the R3 carrier model (the committed spike).
// Runs via `vitest --typecheck`. Proves the 3-way slot probes, empty-list covariance,
// list ≠ vector, deep algebra composition, dict → object — and that wrong programs bite.
import type { List, SlotKind, ElemOf, AcceptsBareWord, IsStringTyped } from "../carriers.js";
import { car, cons, filter, list, map, reduce } from "../carriers.js";

type Assert<T extends true> = T;
type Eq<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;

// harvested tools (what schema-to-ts emits)
declare function set_timer(seconds: number): void;
declare function get_weather(city: string, unit: "celsius" | "fahrenheit"): void;
declare function get_route(stops: List<string>, mode: "fast" | "scenic"): void;
declare function sum_readings(readings: readonly number[]): number;
declare function note(text: string): void;
declare function configure(opts: { name: string; age: number }): void;

// lowered programs (must type-check)
set_timer(600);
get_weather("NYC", "celsius");
get_route(list("A", "B", "C"), "fast");
get_route(cons("Z", list("A", "B")), "scenic"); // cons-prepend → List<string>
sum_readings([1, 2, 3]);
get_route(map((n: number) => String(n), list(1, 2)), "fast"); // map → List<string> into a list slot
const _r1: number = car(list(1, 2, 3));
const _comp: number = reduce(
  (a: number, x: number) => a + x,
  0,
  map((s: string) => s.length, filter((s: string) => s.length > 0, list("a", "bb"))),
);
configure({ name: "a", age: 30 }); // (dict :name "a" :age 30) → object literal

// probe assertions (the 3-way slot verdict)
type _k_list = Assert<Eq<SlotKind<Parameters<typeof get_route>[0]>, "list">>;
type _e_list = Assert<Eq<ElemOf<Parameters<typeof get_route>[0]>, string>>;
type _k_vec = Assert<Eq<SlotKind<Parameters<typeof sum_readings>[0]>, "vector">>;
type _e_vec = Assert<Eq<ElemOf<Parameters<typeof sum_readings>[0]>, number>>;
type _k_enum = Assert<Eq<SlotKind<Parameters<typeof get_weather>[1]>, "string">>;
type _k_scalar = Assert<Eq<SlotKind<Parameters<typeof set_timer>[0]>, "scalar">>;
type _bare_str = Assert<Eq<AcceptsBareWord<Parameters<typeof note>[0]>, true>>;
type _bare_lst = Assert<Eq<AcceptsBareWord<Parameters<typeof get_route>[0]>, false>>;
type _str_enum = Assert<Eq<IsStringTyped<Parameters<typeof get_weather>[1]>, true>>;
type _elem_lol = Assert<Eq<ElemOf<List<List<number>>>, List<number>>>;

// bites — wrong programs that MUST error
// @ts-expect-error scalar where list expected
get_route("A", "fast");
// @ts-expect-error number element where string list expected
get_route(list(1, 2), "fast");
// @ts-expect-error wrong enum member
get_weather("NYC", "kelvin");
// @ts-expect-error vector where list expected (vector ≠ list)
get_route([1, 2, 3], "fast");
// @ts-expect-error wrong dict field type
configure({ name: "a", age: "old" });
// @ts-expect-error missing dict field
configure({ name: "a" });

// reachability.test-d.ts — bite-guard for the list-slot reachability gate (the committed spike).
// At a List slot, admit a head iff its return COULD be a list — mask only PROVABLY non-list.
// `CouldBeList` (on a resolved return type) is the gate's core logic; the `[unknown] extends [R]`
// nuke-guard keeps `if` / `car` / generic returns admissible so `(if …)` is never blocked.
import type { CouldBeList, List } from "../carriers.js";
import { car, cdr, list, map } from "../carriers.js";

type Assert<T extends true> = T;
type Eq<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;

// CouldBeList on RESOLVED return types — the gate's verdict
// INVARIANT: CouldBeList is true for a resolved List<T> type.
type _cbl_list = Assert<Eq<CouldBeList<List<string>>, true>>;
// INVARIANT: CouldBeList is true for a union of List types (models an (if …) branch union).
type _cbl_union = Assert<Eq<CouldBeList<List<string> | List<number>>, true>>; // (if …) branch union
type _cbl_unknown = Assert<Eq<CouldBeList<unknown>, true>>; // the nuke-guard (generic / if / car)
type _cbl_vector = Assert<Eq<CouldBeList<readonly number[]>, false>>; // vector ≠ list (disjoint) → mask
// INVARIANT: CouldBeList is false for scalar types (number, string).
type _cbl_number = Assert<Eq<CouldBeList<number>, false>>; // provably non-list → mask
type _cbl_string = Assert<Eq<CouldBeList<string>, false>>;

// call-site reachability — list-returning expressions fill a list slot; non-list ones bite
declare function ifList<A, B>(cond: unknown, a: A, b: B): A | B; // models (if cond a b) → A | B
declare function append<T>(a: List<T>, b: List<T>): List<T>;
declare function add(...n: number[]): number;
declare function upcase(s: string): string;
declare function get_route(stops: List<string>, mode: string): void;
declare const listOne: List<string>;
declare const listTwo: List<string>;

// INVARIANT: an (if cond a b)-shaped call, an append call, and deep nested list-returning
// expressions all fill a list slot without error.
get_route(ifList(true, listOne, listTwo), "fast"); // (if c lo lt) → List<string> — NOT blocked
get_route(append(listOne, listTwo), "fast");
get_route(ifList(true, list("a"), cdr(map((s: string) => s, listOne))), "fast"); // deep recursion (depth 3)

declare const listOfLists: List<List<string>>;
get_route(car(listOfLists), "fast"); // car of list-of-lists → List<string>

// bites — provably-non-list heads cannot fill a list slot
// @ts-expect-error add → number, not a list
get_route(add(1, 2, 3), "fast");
// @ts-expect-error bare string is not a list
get_route(upcase("x"), "fast");
// @ts-expect-error car of list-of-strings → string, not a list
get_route(car(listOne), "fast");

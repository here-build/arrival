// kwargs.test-d.ts — bite-guard for the kwargs encoding: an object input → the forceable
// `:key value` pair sequence. Required pairs are mandatory + canonical; optional pairs are a
// flexible all-or-nothing variadic tail; a `:key` with no value is rejected (the value is
// structurally mandatory). Keyword slots are one-member literals (the lens forces them); value
// slots carry their type (the lens narrows them) — both via the existing per-element slot probe.
import type { Kwarg, ObjectToKwargs, OnlyOptional, OnlyRequired } from "../carriers.js";

type Assert<T extends true> = T;
type Eq<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;

// ── the pieces ──
type _pair = Assert<Eq<Kwarg<"name", string>, [":name", string]>>;
type _onlyReq = Assert<Eq<OnlyRequired<{ a: string; b?: number }>, { a: string }>>;
type _onlyOpt = Assert<Eq<OnlyOptional<{ a: string; b?: number }>, { b?: number }>>;

// ── the assembled tuple (single required key → deterministic order; multi-required order is
// the compiler's, hence untested for position, only for membership/mandatoriness) ──
type UserKwargs = ObjectToKwargs<{ name: string; mode?: "fast" | "scenic" }>;
type _required_head = Assert<Eq<UserKwargs[0], [":name", string]>>;

// ── call-site behavior: required mandatory, value-typed, all-or-nothing pairs ──
declare function create_user(...args: ObjectToKwargs<{ name: string; mode?: "fast" | "scenic" }>): void;

create_user([":name", "Ada"]); // required only — ok
create_user([":name", "Ada"], [":mode", "fast"]); // + an optional pair — ok

// @ts-expect-error — missing the required :name pair
create_user([":mode", "fast"]);
// @ts-expect-error — :name with no value (length-1 pair) — the all-or-nothing ban
create_user([":name"]);
// @ts-expect-error — :mode with no value
create_user([":name", "Ada"], [":mode"]);
// @ts-expect-error — wrong value type for :name
create_user([":name", 42]);
// @ts-expect-error — a value outside the enum domain for :mode
create_user([":name", "Ada"], [":mode", "teleport"]);
// @ts-expect-error — an unknown keyword
create_user([":name", "Ada"], [":nope", 1]);

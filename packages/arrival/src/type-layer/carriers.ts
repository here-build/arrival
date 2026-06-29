// carriers — the type-layer's carrier vocabulary (R3, spike-proven; see
// docs/working-proposals/arrival-type-layer-rework.md §3).
//
// "Scheme is a TS subset except lists and pairs." These are the *only* hand-written
// generic types — the closed tagless algebra zod cannot express. The harvested tool
// signatures and the lowered program reference this vocabulary; the lens prepends an
// ambient projection of it to its virtual compile. nil = null; vector = readonly T[]
// (native TS array); scalars/dict project to plain TS directly.
//
// Authored as an `export declare` module (types-only — the lens never RUNS these; the
// emitted TS is inference-only) so the bite-guards under __tests__/ import the same
// vocabulary the harvest emits against — one source of truth, no drift.

declare const LIST_BRAND: unique symbol;

/** Opaque proper-list cons cell — the element type rides the phantom brand; the cons
 *  structure is hidden so a list is disjoint from a vector (`readonly T[]`), which is
 *  what makes the 3-way slot verdict clean. */
export interface Cons<out T> {
  readonly [LIST_BRAND]: T;
}

/** A proper list: a chain of `Cons` ending in nil. The empty list IS `null`. */
export type List<T> = Cons<T> | null;

/** The empty list / nil. */
export type Nil = null;

/** Dotted/improper pair — `car`/`cdr` are field reads. Disjoint from `List`. */
export interface Pair<out H, out T> {
  readonly car: H;
  readonly cdr: T;
}

// ── constructors (lowering targets for '(…), (list …), (cons …)) ──────────────
export declare function list<T>(...xs: T[]): List<T>;
export declare function cons<H, T>(h: H, t: List<T>): List<H | T>; // prepend → List
export declare function cons<H, T>(h: H, t: T): Pair<H, T>; //          dotted  → Pair

// ── accessors — serve BOTH a proper List and a dotted Pair (disjoint → overloads) ──
export declare function car<T>(xs: List<T>): T;
export declare function car<H>(p: Pair<H, unknown>): H;
export declare function cdr<T>(xs: List<T>): List<T>;
export declare function cdr<T>(p: Pair<unknown, T>): T;

// ── the closed tagless algebra — generic globals over List AND vector ─────────
export declare function map<T, B>(f: (x: T) => B, xs: List<T>): List<B>;
export declare function map<T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[];
export declare function filter<T>(p: (x: T) => unknown, xs: List<T>): List<T>;
export declare function filter<T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[];
export declare function reduce<T, A>(f: (acc: A, x: T) => A, init: A, xs: List<T> | readonly T[]): A;
export declare function length(xs: List<unknown> | readonly unknown[] | string): number;

// ── the slot probes (the lens's narrowing queries; see §7) ────────────────────
// `NonNullable<S>` strips the empty-list null AND optional null/undefined before classifying.

/** 3-way slot verdict: list / vector / string / scalar. */
export type SlotKind<S> =
  [NonNullable<S>] extends [Cons<unknown>] ? "list"
  : [NonNullable<S>] extends [readonly unknown[]] ? "vector"
  : [NonNullable<S>] extends [string] ? "string"
  : "scalar";

/** Element type inside a list or vector slot. */
export type ElemOf<S> =
  NonNullable<S> extends Cons<infer E> ? E
  : NonNullable<S> extends readonly (infer E)[] ? E
  : never;

/** Does a value of type `S` admit a bare word as a string (free-form string slot)? */
export type AcceptsBareWord<S> =
  [NonNullable<S>] extends [readonly unknown[]] ? false
  : [NonNullable<S>] extends [Cons<unknown>] ? false
  : [string] extends [NonNullable<S>] ? true
  : false;

/** Is the slot string-typed (a string subtype — free-form or a closed string-literal enum), not an array? */
export type IsStringTyped<S> =
  [NonNullable<S>] extends [readonly unknown[]] ? false
  : [NonNullable<S>] extends [Cons<unknown>] ? false
  : [NonNullable<S>] extends [string] ? true
  : false;

// ── the reachability query (the list-slot gate; see §7) ───────────────────────
// At a List slot after `(`, admit a head iff its return COULD be a list — mask only
// PROVABLY non-list. The `[unknown] extends [R]` arm is the nuke-guard: a generic / `if`
// / union return resolves to `unknown` and ADMITS, so we never block `(if …)`/`car`/etc.

// Operates on a RESOLVED return type. Head-level admissibility before args (and the
// overload-aware / call-site-contextual resolution of an in-progress `(head …)`) is the
// gate's Phase-4 job — it types the actual call in context rather than this abstraction.
export type CouldBeList<R> =
  [unknown] extends [R] ? true
  : [Extract<R, Cons<unknown> | null>] extends [never] ? false
  : true;

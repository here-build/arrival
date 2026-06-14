/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-empty-interface, sonarjs/redundant-type-aliases --
   This is an ambient prelude `.d.ts` whose CONTRACT depends on the patterns these
   rules flag:
   • `interface ArrShape {}` MUST be empty here — it is the declaration-merge
     target the 34 builtin leaves extend; the emptiness is the seam, not an
     accident.
   • `SNum`/`SStr`/`SBool`/`Unit` are DELIBERATE named-vocabulary aliases, not
     redundant ones: leaf signatures are authored against `SNum` (never `number`)
     so the deferred numeric tower (NUM) can re-point one alias and upgrade every
     leaf for free. Inlining the primitives would dissolve that seam. */
// ─────────────────────────────────────────────────────────────────────────────
// PRE — the SHARED PRELUDE for the Scheme→TS type lens.
//
// This is the ONE upstream node the 34 builtin `.d.ts` leaves
// (`prelude/builtins/<slug>.d.ts`) declaration-merge into. It declares:
//   1. the branded base types every leaf signature is written in terms of,
//   2. the `Dict<Pairs>` homoiconic-dict → precise-object mapped type,
//   3. the keyword-accessor helper types (`@` / `@?` / `:k`),
//   4. the typed-apply HOF fallback `sexpr<F>`,
//   5. THE LEAF MERGE CONTRACT — the empty `interface ArrShape {}` + the
//      `declare const __arr: ArrShape` that every leaf extends.
//
// Promoted + restructured from the proven probe (`/tmp/scheme-ts-probe/
// arrival-stdlib.d.ts`), which already type-checks and bites under tsc.
//
// CONSUMABILITY: this is a pure ambient `.d.ts` (no `import`/`export`), so it is
// consumable both by the leaf `.d.ts` files (sharing the same global scope under
// declaration-merging) AND by emitted virtual TS (the lens prepends this text
// unmapped, then references `__arr`, `Dict`, `sexpr`, and the base types).
// ─────────────────────────────────────────────────────────────────────────────

// ── Branded base types ───────────────────────────────────────────────────────
// A Scheme list is modeled as a readonly array. v1: no pair/improper-list brand;
// `readonly T[]` is precise enough to make car/cdr/map/filter bite.
type List<T> = readonly T[];

// A cons cell / pair. v1 representation: a 2-tuple [head, tail]. Proper lists are
// `List<T>` (above); `Pair<H, T>` is the explicit dotted-pair representation for
// the few primitives that traffic in improper pairs. The tail is `unknown` rather
// than `List<…>` so an improper/dotted tail (`(cons 1 2)`) is representable.
type Pair<H, T = unknown> = readonly [head: H, tail: T];

// The empty list / nil. Distinct alias kept so leaf signatures can name the
// terminal explicitly (e.g. a `(cdr)` of a singleton); structurally an empty
// readonly tuple, assignable to `List<never>`.
type Nil = readonly [];

// Unit / the "no useful value" return (Scheme's unspecified value). Modeled as
// `void` so a statement-position form that yields nothing doesn't pollute types.
type Unit = void;

// NUM re-points this. v1 = plain `number`. The deferred numeric tower (NUM node)
// later re-points `SNum` to a branded Exact/Inexact algebra; every leaf written
// against `SNum` upgrades for free when that lands. Do NOT inline `number` in a
// leaf — always write `SNum`.
type SNum = number;

type SStr = string;
type SBool = boolean;

// ── Dict: homoiconic-dict → precise-object mapped type ───────────────────────
// PROVEN in the probe. Maps a tuple of [key, value] entry-tuples into a precise
// object type whose keys are the literal key strings and whose value types are
// the corresponding value types. `(dict :name "a" :age 30)` lowers to
// `dict([["name","a"],["age",30]] as const)` → `{ name: string; age: number }`.
type Dict<Pairs extends readonly [key: string, value: unknown][]> = {
  [P in Pairs[number] as P[0]]: P[1];
};

// ── Keyword accessor types (`@` / `@?` / `:k`) ───────────────────────────────
// The sift moat. `(:Field row)` / `(@ row :Field)` → a precise field read.
//
// Field<O, K>          — `(@ obj key)` / `(:key obj)` → the value at K, precise.
//                        Mis-keying (`(:naem row)`) bites with 2345; wrong-typing
//                        the result (`(string-upcase (:age row))`) bites with 2322.
// HasField<O, K>       — `(@? obj key)` → a boolean presence check (open key).
// FieldKeys<O>         — `(@keys obj)` → the literal key union as a string[].
type Field<O, K extends keyof O> = O[K];
// v1: `@?` is an OPEN presence check (any string key) → plain boolean; the type
// params name the accessor's shape for the contract but are not yet narrowed.
type HasField<_O extends object, _K extends string> = boolean;
type FieldKeys<O extends object> = (keyof O & string)[];

// ── Nested path lookup (`path` / `get-in` / `dig` / `navigate`) ───────────────
// The DEPTH half of the accessor moat. Where `Field<O, K>` is one hop, `PathValue`
// threads a whole key SEQUENCE through nested objects, so a precise `Dict` (or any
// object literal the lens captured) round-trips to its precise leaf value at
// ARBITRARY depth: `(path '(:a :b) {a:{b:30}})` → `SNum`, not `any`.
//
//   PathValue<O, Ks>  — recurse one key at a time:
//     • [K, ...Rest]  and K is a key of O   → descend into PathValue<O[K], Rest>
//     • [K, ...Rest]  and K is NOT a key    → `undefined` (R.path's miss value —
//        faithful: a downstream use of the result must account for absence)
//     • []  (path exhausted)                → the object reached so far, O
// `const Ks` capture on the leaf binds the literal key tuple the lens emits
// (`["a","b"] as const`); a typo'd interior key collapses that branch to
// `undefined` and bites at the use site, exactly like the one-hop `@` accessor.
type PathValue<O, Ks extends readonly PropertyKey[]> = Ks extends readonly [
  infer K,
  ...infer Rest extends readonly PropertyKey[],
]
  ? K extends keyof O
    ? PathValue<O[K], Rest>
    : undefined
  : O;

// ── Typed-apply HOF fallback ─────────────────────────────────────────────────
// `sexpr<F>(f, ...args)` is the fallback for higher-order / indirect application
// heads — when the head of a form is a *computed* function value rather than a
// statically-resolvable builtin (e.g. a `(map (lambda …) …)` callback bound to a
// variable, or `((car fns) x)`). It threads the callee's parameter & return types
// so the indirect call still bites.
//
// WHEN TO USE WHICH (the probe found direct calls cleaner — keep BOTH):
//   • DIRECT call — preferred whenever the head resolves to a known builtin or a
//     statically-typed binding. The emitter lowers `(car xs)` → `__arr.car(xs)`
//     and `(f x)` (f a typed local) → `f(x)`. TS checks these natively; no helper.
//   • sexpr<F> — only when the head is an opaque/computed function value the
//     emitter cannot name directly, so a plain call expression would not preserve
//     argument↔parameter checking. `((nth fns i) a b)` → `sexpr(nth(fns, i), a, b)`.
declare function sexpr<F extends (...a: any[]) => any>(f: F, ...args: Parameters<F>): ReturnType<F>;

// ── THE LEAF MERGE CONTRACT ──────────────────────────────────────────────────
// Every one of the 34 builtin leaves (`prelude/builtins/<slug>.d.ts`) augments
// `__arr` by re-declaring this interface with its own ONE member, e.g.
//
//     // builtins/car.d.ts
//     interface ArrShape { car<T>(xs: List<T>): T; }
//
// TypeScript merges all `interface ArrShape` declarations across files in the
// same compilation into a single shape; `__arr` is typed by the merged union of
// every leaf's member. Operator-named builtins (`+`, `<`, `string-append`) are
// bracketed string-key members — legal inside an interface body, so no identifier
// cleaning is ever needed. Two leaves in different files cannot collide: they add
// different members to the same interface, and the compiler unions them.
//
// (This interface-merge mechanism — verified empirically — supersedes the
// `declare const __arr: { … }` object-literal-merge sketch in the DAG doc:
// object type literals on a `const` do NOT merge across files, interfaces DO.)
interface ArrShape {}

declare const __arr: ArrShape;

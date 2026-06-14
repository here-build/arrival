// ─────────────────────────────────────────────────────────────────────────────
// L — the OBJECT-ACCESSOR moat — the typed CONSUMERS of a precise record.
//
// `dict` (dict.d.ts) and `@`/`@keys` (accessors.d.ts) already CONSTRUCT and one-hop
// READ a precise `Dict`. This leaf closes the loop: the Ramda-backed accessor family
// that reads objects in depth, so a precise record round-trips through every read
// instead of collapsing to `any`. WITHOUT these, `(prop :name row)` / `(path …)`
// fall straight off a precise `Dict` into `any`, and every downstream form is
// poisoned — the "valuesOf returns List<any>" symptom.
//
// Runtime truth (the `any` impls these SHARPEN — do NOT import them):
//   ramda-functions.ts:247-278 — prop/get/access/fetch = R.prop ·
//     path/get-in/navigate/dig = R.path · prop-or = R.propOr · path-or = R.pathOr ·
//     safe-prop/safe-path = R.prop/R.path over `obj || {}` ·
//     has/contains/exists?/present? = R.has · has-path = R.hasPath ·
//     props = R.props · paths = R.paths · pick = R.pick · omit = R.omit ·
//     keys = R.keys · toPairs = R.toPairs · fromPairs = R.fromPairs
//
// FAITHFULNESS NOTES (verified against the env precedence
// inline > safeWrappedOps > SAFE_BUILTINS > RAMDA_FUNCTIONS, sandbox-env.ts:186-212):
//   • `contains` / `exists?` / `present?` are ALIASES OF `R.has` — a KEY-EXISTENCE
//     check on an object, NOT list membership. Typing them `(elem, list) → SBool`
//     would be WRONG. They take `(key, obj)`.
//   • `values` is NOT here: SAFE_BUILTINS' R7RS multiple-values `values` SHADOWS
//     Ramda's `R.values` (object-values reader is dead under that name). The way to
//     read a record's values is `(map (lambda (k) (prop k row)) (keys row))`.
//   • All Ramda heads are key/path-FIRST, object-LAST (R.prop(key, obj)). The lens
//     lowers keyword args (`:name`) to string literals and quoted key lists
//     (`'(:a :b)`) to `["a","b"] as const`, so `K extends keyof O` and the `const Ks`
//     path captures bite on a typo'd key exactly like the one-hop `@` accessor.
//
// Mis-keying bites (2345); wrong-typing a precise read bites (2322) — the A4 moat,
// now in depth. Base types (`List`, `SStr`, `SBool`) and `PathValue<O, Ks>` come
// from PRE (../types.d.ts).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  // One-hop property read (4 mental models, same impl R.prop). Mis-key bites.
  prop<O, K extends keyof O>(key: K, obj: O): O[K];
  get<O, K extends keyof O>(key: K, obj: O): O[K];
  access<O, K extends keyof O>(key: K, obj: O): O[K];
  fetch<O, K extends keyof O>(key: K, obj: O): O[K];

  // Nested path read (4 mental models, same impl R.path). Recursive-precise via PRE.
  path<O, const Ks extends readonly PropertyKey[]>(keys: Ks, obj: O): PathValue<O, Ks>;
  "get-in"<O, const Ks extends readonly PropertyKey[]>(keys: Ks, obj: O): PathValue<O, Ks>;
  navigate<O, const Ks extends readonly PropertyKey[]>(keys: Ks, obj: O): PathValue<O, Ks>;
  dig<O, const Ks extends readonly PropertyKey[]>(keys: Ks, obj: O): PathValue<O, Ks>;

  // Defaulted reads (R.propOr / R.pathOr): precise value when the key resolves,
  // else the default type D. The union is honest — R returns `default` on a miss.
  "prop-or"<O, K extends PropertyKey, D>(dflt: D, key: K, obj: O): (K extends keyof O ? O[K] : never) | D;
  "path-or"<O, const Ks extends readonly PropertyKey[], D>(dflt: D, keys: Ks, obj: O): PathValue<O, Ks> | D;

  // Nil-safe reads (R.prop/R.path over `obj || {}`): the object may be nil, so the
  // result is `… | undefined`. Key/path still bites on a typo against the known shape.
  "safe-prop"<O, K extends keyof O>(key: K, obj: O): O[K] | undefined;
  "safe-path"<O, const Ks extends readonly PropertyKey[]>(keys: Ks, obj: O): PathValue<O, Ks> | undefined;

  // Existence (R.has / R.hasPath) — KEY-existence on an object, OPEN key → SBool.
  has<O>(key: PropertyKey, obj: O): SBool;
  contains<O>(key: PropertyKey, obj: O): SBool;
  "exists?"<O>(key: PropertyKey, obj: O): SBool;
  "present?"<O>(key: PropertyKey, obj: O): SBool;
  "has-path"<O>(keys: readonly PropertyKey[], obj: O): SBool;

  // Multi-read (R.props / R.paths): positional tuple of the read values, precise.
  props<O, const Ks extends readonly (keyof O)[]>(keys: Ks, obj: O): { readonly [I in keyof Ks]: O[Ks[I] & keyof O] };
  paths<O, const Ps extends readonly (readonly PropertyKey[])[]>(
    paths: Ps,
    obj: O,
  ): { readonly [I in keyof Ps]: PathValue<O, Ps[I] extends readonly PropertyKey[] ? Ps[I] : readonly []> };

  // Sub-record selection (R.pick / R.omit): precise narrowed object shape.
  pick<O, const Ks extends readonly (keyof O)[]>(keys: Ks, obj: O): Pick<O, Ks[number]>;
  omit<O, const Ks extends readonly (keyof O)[]>(keys: Ks, obj: O): Omit<O, Ks[number]>;

  // Key list (R.keys) — sharper than `@keys`: the literal key union, not bare SStr.
  keys<O extends object>(obj: O): List<keyof O & string>;

  // Object ⇄ entry-list (R.toPairs / R.fromPairs). `fromPairs` mirrors `dict`'s
  // entry→record mapped type; `toPairs` is its inverse union of [key, value] pairs.
  toPairs<O extends object>(obj: O): List<{ [K in keyof O]: readonly [K & string, O[K]] }[keyof O]>;
  fromPairs<const Ps extends readonly (readonly [PropertyKey, unknown])[]>(pairs: Ps): {
    [P in Ps[number] as P[0] & PropertyKey]: P[1];
  };
}

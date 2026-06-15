// ─────────────────────────────────────────────────────────────────────────────
// L — `@` / `@?` / `@keys` — the keyword/field accessor family (the sift moat).
//
// Scheme semantics:
//   (@ obj key)    → the value at `key`, PRECISE (mis-keying bites — A4 keystone).
//   (@? obj key)   → boolean presence check (open key).
//   (@keys obj)    → the object's own key strings, as a list.
//
// Runtime truth (the `any` impls these SHARPEN — do NOT import them):
//   inference-env.ts:229 (@) · inference-env.ts:284 (@?) · inference-env.ts:302 (@keys)
//
// `@` is generic over the object O and the key K (`K extends keyof O`) so a typo'd
// key (`(@ row :badkey)`) bites with 2345, and the result carries the precise
// `Field<O, K>` type so wrong-typing it downstream bites with 2322. Cohesive
// family — one file, three members in the same `interface ArrShape` block.
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  "@"<O, K extends keyof O>(obj: O, key: K): Field<O, K>;
  "@?"<O extends object, K extends string>(obj: O, key: K): HasField<O, K>;
  "@keys"<O extends object>(obj: O): List<SStr>;
}

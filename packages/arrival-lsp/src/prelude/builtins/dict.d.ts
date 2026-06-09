// ─────────────────────────────────────────────────────────────────────────────
// L — `dict` — the homoiconic record constructor (THE MOAT).
//
// Scheme semantics: (dict :a 1 :b "x") → a record { a: 1, b: "x" } whose keys are
// the keyword keys and whose values are the paired values. The emitter lowers a
// `(dict …)` form to an object literal; the LENS lowers it to a typed
// `__arr.dict([[key, value], …] as const)` so each entry's value type is captured
// precisely and reflected into PRE's `Dict<Pairs>` mapped type.
//
// Runtime truth (the impl this SHARPENS — do NOT import it):
//   stdlib.ts:312 (the `dict:` emitter — emits `{ k: v, … }`)
//
// Pattern: re-declare `interface ArrShape` with this ONE member, written in terms
// of PRE's `Dict<Pairs>` (../types.d.ts). The `Pairs` type param is captured from
// the `as const` entry-tuple the lens emits, so `(dict :name "a" :age 30)` infers
// `{ name: SStr; age: SNum }` precisely (mis-keyed/mis-typed reads then bite via
// the `Field`/accessor leaves).
// ─────────────────────────────────────────────────────────────────────────────
interface ArrShape {
  dict<const Pairs extends readonly [key: string, value: unknown][]>(entries: Pairs): Dict<Pairs>;
}

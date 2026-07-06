// scheme-zod — zod (v4) re-exported, plus the scheme-value VOCABULARY the
// `arrival.symbol*` API is built on. One import (`import * as z from "./scheme-zod.js"`)
// gives the whole zod surface AND the scheme primitives/codecs, so a symbol contract
// reads `{ input: [z.string], output: [z.number] }` with no second import.
//
// ─────────────────────────────────────────────────────────────────────────────
// NUMBER REPRESENTATION — the resolution (V's refinement, 2026-06-24)
// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: SchemeExact is a bigint rational (num/denom) — arbitrary precision, the
// settled internal representation. SchemeInexact is a boxed IEEE-754 double (`.real`).
//
// BOUNDARY: the JS-side representation is NOT guessed by a single number codec; it is
// the CONSUMER'S DECLARATION via WHICH codec they pick. The family below lets the
// contract author state exactness + range + JS-type ONCE, at the schema, with no
// encode-policy heuristics:
//
//   • `number`  ↔ JS `number`  — decode lowers to a JS number (DOORS if the exact value
//                                 can't be a faithful JS number: out of safe-integer range,
//                                 or a non-integer rational — no silent precision loss).
//                                 encode of a JS number → SchemeInexact (you chose float).
//   • `integer` ↔ JS `number`  — decode validates a SAFE INTEGER (DOORS otherwise).
//                                 encode → SchemeExact (exact, fits a JS number).
//   • `bigint`  ↔ JS `bigint`  — decode → bigint (exact, arbitrary precision, always faithful).
//                                 encode → SchemeExact.
//   • the `schemeExact` IDENTITY primitive (below) hands the rational TERM itself to a
//     native impl — full fidelity, no codec.
//
// So the chosen codec fully declares the boundary; there is no ambiguity about how a
// returned JS number re-enters scheme. (`z.codec` requires zod 4 — pinned 4.3.6, verified.)
import * as z from "zod";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

import { APair } from "../values/primitives/APair.js";
import { ANil } from "../values/primitives/ANil.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { AVector } from "../values/primitives/AVector.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AString } from "../values/primitives/AString.js";
import { ABool } from "../values/primitives/ABool.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import type { SchemeValue } from "../values/types.js";
import { AVoid } from "../values/primitives/AVoid.js";
import { R7RSError } from "../errors.js";

export { tuple, union, record, array, enum, decode, encode } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEME-IDENTITY PRIMITIVES — for `arrival.symbol` (native).
// The schema's output IS the scheme term: a native impl works on scheme values
// (`Pair`, `SchemeString`, …), exactly like today's `{ value: fn }` ops. No codec,
// no decode — `z.output<typeof pair> = Pair`.
// ─────────────────────────────────────────────────────────────────────────────

/** The representation-BLIND scheme-value identity primitive: any value the interpreter
 *  can hold, with `z.output<typeof value> = SchemeValue` (the honest union of every
 *  AValue subclass + the live orphans + a JS procedure). This is the typed replacement
 *  for `z.unknown()` at a native scheme-value slot — a slot that takes/returns "any scheme
 *  value" by design (the searched object, a copied/returned cell, a polymorphic accessor's
 *  operand). `z.custom<SchemeValue>()` with no refinement accepts anything at runtime
 *  (byte-identical to `z.unknown()` — and native ops run NO validation anyway), but its
 *  STATIC output is `SchemeValue`, so a native impl declaring `(x: SchemeValue)` matches the
 *  decoded-arg type instead of fighting `unknown`. Use `z.unknown()` only where the slot is
 *  GENUINELY representation-blind beyond scheme (a predicate that classifies host JS too —
 *  `eq?`, `bytevector?`), where the impl really wants `unknown`. */
export const value = z.custom<SchemeValue>();
export const pair = z.instanceof(APair);
export const symbol = z.instanceof(ASymbol);
// A vector by PROTOCOL, not class: anything answering `arrival/tagless-final/vector?` — a boxed
// AVector OR a borrowed AJSArray (which IS a vector). Checking the method's PRESENCE (not calling
// it) avoids materializing a borrowed view during decode. `z.custom<AVector>` keeps the harvested
// type AVector; the impls extract the payload via `asVector`, which handles both forms.
export const svector = z.custom<AVector>(
  (x) => typeof (x as Record<string, unknown> | null | undefined)?.["arrival/tagless-final/vector?"] === "function",
);
export const sbytevector = z.instanceof(ABytevector);
export const nil = z.instanceof(ANil);
export const undefinedResult = z.instanceof(AVoid);
export const error = z.instanceof(R7RSError);

/** A callable scheme value — a JS function, whether a user `(lambda …)` (carries the
 *  well-known LAMBDA brand) or a bare native/rosetta reference (see eval/guards.ts's
 *  `is_callable`/`is_function`: "a Scheme lambda carries the LAMBDA brand; native
 *  builtins/rosettas are bare functions" — either way, callable reduces to `typeof ===
 *  "function"`). The canonical replacement for the dozen ad-hoc
 *  `z.custom<(...args: unknown[]) => T>()` one-offs this codebase had accumulated
 *  (map/filter/find/sort/curry/vector-map/string-map/…) — unlike `z.value`, this carries
 *  a REAL predicate (existing ad-hoc call sites had none), so it discriminates correctly
 *  even in a rosetta context that actually validates. Migrating those call sites to this
 *  export is a deferred follow-up, not part of this change. */
export const lambda = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");

// ── kwargs — an object input the model fills as `:key value` pairs ─────────────
// A kwargs tool takes ONE object input; the model calls it `(tool :k v :k2 v2)`, which lowers to
// the `[":k", v]` pair sequence the harvest types via `ObjectToKwargs<T>` (type-layer/carriers).
// `kwargs(shape)` is a z.object BRANDED so the harvest recognizes it (`isKwargs`) and emits the
// pair-tuple signature `(...args: ObjectToKwargs<{…}>)` instead of a single object arg.
const KWARGS = new WeakSet<object>();
/** Declare a kwargs (object) input: `kwargs({ name: z.string, age: number.optional() })`. */
export function kwargs<S extends z.ZodRawShape>(shape: S) {
  const schema = z.object(shape);
  KWARGS.add(schema);
  return schema;
}
/** Is `schema` a `kwargs(...)` object-input marker? (→ the harvest emits an ObjectToKwargs tuple.)
 *  A real type predicate (not just `boolean`) so a caller narrows `VectorSpec`'s `z.ZodTypeAny`
 *  member down to the branded object schema — e.g. `bakeRosetta`'s runtime kwargs decode reads
 *  the narrowed schema with no `as`/cast at the call site. */
export function isKwargs(schema: unknown): schema is z.ZodObject<z.ZodRawShape> {
  return typeof schema === "object" && schema !== null && KWARGS.has(schema);
}

// ─────────────────────────────────────────────────────────────────────────────
// CODECS — for `arrival.rosetta` (JS-land). Each codec IS the per-arg membrane:
// `z.output<codec>` is the DECODED JS value the impl sees; `encode` rebuilds the
// scheme value on return. (`z.codec(in_, out, { decode, encode })`: decode maps the
// stored A side → the B side; encode maps B → A. `z.output<ZodCodec<A,B>> = output<B>`.)
// ─────────────────────────────────────────────────────────────────────────────

/** SchemeString ↔ JS `string`. */
export const string = z.codec(z.instanceof(AString), z.string(), {
  decode: (s) => s.toJs(),
  encode: (s) => new AString(CONSTANT_CTX, s),
});

/** SchemeBool ↔ JS `boolean`. */
export const boolean = z.codec(z.instanceof(ABool), z.boolean(), {
  decode: (b) => b.value,
  encode: (b) => new ABool(CONSTANT_CTX, b),
});
export const booleanFalse = z.codec(
  z.instanceof(ABool).refine(({ value }) => !value),
  z.boolean().refine((value) => value === false),
  {
    decode: (b) => b.value,
    encode: (b) => new ABool(CONSTANT_CTX, b),
  },
);

/** SchemeCharacter ↔ JS `string` (single grapheme). `.length(1)` makes the JS side
 *  actually ENFORCE "single grapheme" (the doc comment's own claim) instead of merely
 *  asserting it in prose — an encode of a multi-char or empty string DOORS. */
export const char = z.codec(z.instanceof(ACharacter), z.string().length(1), {
  decode: (c) => c.valueOf(),
  encode: (c) => new ACharacter(CONSTANT_CTX, c),
});

// ── the NUMBER CODEC FAMILY ───────────────────────────────────────────────────
// The boundary number-representation is declared by WHICH of these the author picks.

/** SchemeExact ↔ JS `bigint`. decode DOORS on a non-integer rational (e.g. 1/3 has no
 *  faithful bigint form) — same door `bigint`'s own decode already has for its exact
 *  branch, narrowed here to a single class instead of a union member check. encode is
 *  total (any bigint IS an exact integer). */
export const exact = z.codec(z.instanceof(AExact), z.bigint(), {
  decode: (n) => {
    Error.invariant(n.denom === 1n, `exact codec: exact rational ${n.toString()} has no integer bigint form`);
    return n.num;
  },
  encode: (n) => new AExact(CONSTANT_CTX, n),
});

/** SchemeInexact ↔ JS `number`. Total — `.real` is always a valid JS number, so unlike
 *  `exact` this codec never doors. encode is total too (any JS number IS a valid inexact). */
export const inexact = z.codec(z.instanceof(AInexact), z.number(), {
  decode: (n) => n.real,
  encode: (n) => new AInexact(CONSTANT_CTX, n),
});

/** Either numeric tower class — the ONE identity term for a native numeric op, reused
 *  (not re-spelled) as the shared `.in` side of every number codec below (number/integer/
 *  bigint/numberOrBigint all lower the exact same scheme value; they differ only in which
 *  JS shape they decode it TO, never in what they accept FROM scheme). Built from
 *  `schemeExact`/`schemeInexact` — themselves now codec-derived (`exact.in`/`inexact.in`)
 *  rather than fresh `z.instanceof(...)` calls, so this union is codec-driven BY
 *  COMPOSITION with no fifth standalone codec needed. identity-based lookups (`lookupName`,
 *  below) need the union's OWN members to be the exact same objects those names are
 *  registered against, not mere same-class clones. */
export const schemeNumber = z.union([exact, inexact]);

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);

/** A scheme number that fits in a JS `number` without loss; SchemeExact integers in
 *  safe range and SchemeInexact reals decode directly. Anything that would lose
 *  precision DOORS — a teaching error, never a silent narrowing. */
function exactToJsNumberOrDoor(n: AExact): number {
  // A non-integer rational can't be a faithful JS number (e.g. 1/3). The door tells
  // the author to choose `z.bigint` / the `schemeExact` identity term for full fidelity.
  Error.invariant(
    n.denom === 1n,
    `number codec: exact rational ${n.toString()} cannot be a faithful JS number — use z.bigint or the schemeExact identity primitive`,
  );
  Error.invariant(
    n.num <= SAFE_MAX && n.num >= SAFE_MIN,
    `number codec: exact integer ${n.toString()} is outside JS safe-integer range — use z.bigint for arbitrary precision`,
  );
  return Number(n.num);
}

/** SchemeExact|SchemeInexact ↔ JS `number`. decode lowers (DOORS on precision loss);
 *  encode of a JS number → SchemeInexact (the float type the consumer chose). */
export const number = z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.number(), {
  decode: (n) => (n instanceof AInexact ? n.real : exactToJsNumberOrDoor(n)),
  encode: (n) => new AInexact(CONSTANT_CTX, n),
});

/** SchemeExact|SchemeInexact ↔ JS `number` constrained to SAFE INTEGERS. decode
 *  validates it IS a safe integer (DOORS otherwise); encode → SchemeExact (exact). */
export const integer = z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.number().int(), {
  decode: (n) => {
    if (n instanceof AInexact) {
      TypeError.invariant(Number.isSafeInteger(n.real), `integer codec: inexact ${n.toString()} is not a safe integer`);
      return n.real;
    }
    return exactToJsNumberOrDoor(n); // exactToJsNumberOrDoor already rejects rationals + out-of-range
  },
  encode: (n) => {
    TypeError.invariant(Number.isSafeInteger(n), `integer codec: ${n} is not a safe integer`);
    return new AExact(CONSTANT_CTX, BigInt(n));
  },
});

/** SchemeExact|SchemeInexact ↔ JS `bigint` (exact, arbitrary precision — always faithful
 *  for an integer term). decode → bigint; encode → SchemeExact. A non-integer rational
 *  or a non-integral inexact DOORS (a bigint has no fractional part). */
export const bigint = z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.bigint(), {
  decode: (n) => {
    if (n instanceof AInexact) {
      TypeError.invariant(Number.isInteger(n.real), `bigint codec: inexact ${n.toString()} has a fractional part`);
      return BigInt(n.real);
    } else {
      TypeError.invariant(n.denom === 1n, `bigint codec: exact rational ${n.toString()} has no integer bigint form`);
      return n.num;
    }
  },
  encode: (n) => new AExact(CONSTANT_CTX, n),
});

/** SchemeExact|SchemeInexact ↔ JS `number | bigint` — the TOTAL, never-doors sibling of
 *  `number`/`integer` above, for a call site that would rather preserve exactness as a
 *  bigint than door on precision loss: an inexact decodes to `number`; an exact integer
 *  decodes to `number` when it fits a JS safe integer, else `bigint` (arbitrary precision
 *  kept rather than doored); a non-integer exact rational decodes LOSSILY to `number`
 *  (float division) rather than throwing. This is the numeric pack's own `AnyNum` NCodec
 *  (env/r7rs/numeric.ts) promoted here so its shape has a name other codec authors can
 *  reuse — decode/encode reproduce `AnyNum.toJS`/`.fromJS` exactly. */
export const numberOrBigint = z.codec(
  z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
  z.union([z.number(), z.bigint()]),
  {
    decode: (n) => {
      if (n instanceof AInexact) return n.real;
      if (n.isInteger && n.num >= SAFE_MIN && n.num <= SAFE_MAX) return Number(n.num);
      if (n.isInteger) return n.num;
      return Number(n.num) / Number(n.denom);
    },
    encode: (n) => {
      if (typeof n === "bigint") return new AExact(CONSTANT_CTX, n);
      if (Number.isSafeInteger(n)) return new AExact(CONSTANT_CTX, BigInt(n));
      return new AInexact(CONSTANT_CTX, n);
    },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// lookupName — the harvest printer's naming seam.
//
// scheme-zod.ts is the ONE place that actually knows every vocabulary item's identity
// (it declared them) — so it owns the canonical schema→name mapping, rather than a
// CONSUMER (the harvest printer, schema-to-ts.ts) maintaining a second, hand-authored
// table (keyed by class-name-string OR schema-object-identity, split two ways) that can
// silently drift out of sync every time a new primitive is added here (exactly what
// happened to `z.lambda` — it shipped with no printer entry at all until this fix).
//
// By IDENTITY, not by class name or duck-typing: every scheme-identity primitive is
// registered once, at its own declaration site (below, after everything is bound), so
// the mapping is always exactly as current as this file itself.
// ─────────────────────────────────────────────────────────────────────────────
const NAMES = new Map<unknown, string>([
  [value, "value"],
  [pair, "pair"],
  [symbol, "symbol"],
  [svector, "svector"],
  [sbytevector, "sbytevector"],
  [nil, "nil"],
  [exact, "exact"],
  [inexact, "inexact"],
  [schemeNumber, "schemeNumber"],
  [lambda, "lambda"],
  [string, "string"],
  [boolean, "boolean"],
  [char, "char"],
]);

/** The canonical NAME of a scheme-zod vocabulary schema, by identity — `undefined` if
 *  `schema` isn't one of ours (a bare zod primitive/compound the printer should defer to
 *  zod-to-ts for). Codecs (`string`/`boolean`/`char`/`exact`/`inexact`/`number`/`integer`/
 *  `bigint`/`numberOrBigint`) are deliberately NOT registered here — they already print
 *  correctly through zod-to-ts's native codec handling (`io:"output"`), so this seam only
 *  needs to cover the IDENTITY-flavored primitives zod-to-ts can't represent on its own. */
export function lookupName(schema: unknown): string | undefined {
  return NAMES.get(schema);
}

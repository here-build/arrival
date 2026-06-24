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

export * from "zod";
import * as z from "zod";

import { Pair } from "../values/primitives/Pair.js";
import { Nil } from "../values/primitives/Nil.js";
import { SchemeSymbol } from "../values/primitives/SchemeSymbol.js";
import { SchemeVector } from "../values/primitives/SchemeVector.js";
import { SchemeBytevector } from "../values/primitives/SchemeBytevector.js";
import { SchemeString } from "../values/primitives/SchemeString.js";
import { SchemeBool } from "../values/primitives/SchemeBool.js";
import { SchemeCharacter } from "../values/primitives/SchemeCharacter.js";
import { SchemeExact, SchemeInexact } from "../values/numbers.js";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEME-IDENTITY PRIMITIVES — for `arrival.symbol` (native).
// The schema's output IS the scheme term: a native impl works on scheme values
// (`Pair`, `SchemeString`, …), exactly like today's `{ value: fn }` ops. No codec,
// no decode — `z.output<typeof pair> = Pair`.
// ─────────────────────────────────────────────────────────────────────────────
export const pair = z.instanceof(Pair);
export const symbol = z.instanceof(SchemeSymbol);
export const svector = z.instanceof(SchemeVector);
export const sbytevector = z.instanceof(SchemeBytevector);
export const nil = z.instanceof(Nil);
export const schemeString = z.instanceof(SchemeString);
export const schemeBool = z.instanceof(SchemeBool);
export const schemeChar = z.instanceof(SchemeCharacter);
export const schemeExact = z.instanceof(SchemeExact);
export const schemeInexact = z.instanceof(SchemeInexact);
/** Either numeric tower class — the identity term for a native numeric op. */
export const schemeNumber = z.union([z.instanceof(SchemeExact), z.instanceof(SchemeInexact)]);

// ─────────────────────────────────────────────────────────────────────────────
// CODECS — for `arrival.rosetta` (JS-land). Each codec IS the per-arg membrane:
// `z.output<codec>` is the DECODED JS value the impl sees; `encode` rebuilds the
// scheme value on return. (`z.codec(in_, out, { decode, encode })`: decode maps the
// stored A side → the B side; encode maps B → A. `z.output<ZodCodec<A,B>> = output<B>`.)
// ─────────────────────────────────────────────────────────────────────────────

/** SchemeString ↔ JS `string`. */
export const string = z.codec(z.instanceof(SchemeString), z.string(), {
  decode: (s) => s.toJs(),
  encode: (s) => new SchemeString(s),
});

/** SchemeBool ↔ JS `boolean`. */
export const boolean = z.codec(z.instanceof(SchemeBool), z.boolean(), {
  decode: (b) => b.value,
  encode: (b) => new SchemeBool(b),
});

/** SchemeCharacter ↔ JS `string` (single grapheme). */
export const char = z.codec(z.instanceof(SchemeCharacter), z.string(), {
  decode: (c) => c.valueOf(),
  encode: (c) => new SchemeCharacter(c),
});

// ── the NUMBER CODEC FAMILY ───────────────────────────────────────────────────
// The boundary number-representation is declared by WHICH of these the author picks.

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);

/** A scheme number that fits in a JS `number` without loss; SchemeExact integers in
 *  safe range and SchemeInexact reals decode directly. Anything that would lose
 *  precision DOORS — a teaching error, never a silent narrowing. */
function exactToJsNumberOrDoor(n: SchemeExact): number {
  if (n.denom !== 1n) {
    // A non-integer rational can't be a faithful JS number (e.g. 1/3). The door tells
    // the author to choose `z.bigint` / the `schemeExact` identity term for full fidelity.
    throw new Error(
      `number codec: exact rational ${n.toString()} cannot be a faithful JS number — use z.bigint or the schemeExact identity primitive`,
    );
  }
  if (n.num > SAFE_MAX || n.num < SAFE_MIN) {
    throw new Error(
      `number codec: exact integer ${n.toString()} is outside JS safe-integer range — use z.bigint for arbitrary precision`,
    );
  }
  return Number(n.num);
}

/** SchemeExact|SchemeInexact ↔ JS `number`. decode lowers (DOORS on precision loss);
 *  encode of a JS number → SchemeInexact (the float type the consumer chose). */
export const number = z.codec(z.union([z.instanceof(SchemeExact), z.instanceof(SchemeInexact)]), z.number(), {
  decode: (n) => (n instanceof SchemeInexact ? n.real : exactToJsNumberOrDoor(n)),
  encode: (n) => new SchemeInexact(n),
});

/** SchemeExact|SchemeInexact ↔ JS `number` constrained to SAFE INTEGERS. decode
 *  validates it IS a safe integer (DOORS otherwise); encode → SchemeExact (exact). */
export const integer = z.codec(z.union([z.instanceof(SchemeExact), z.instanceof(SchemeInexact)]), z.number().int(), {
  decode: (n) => {
    if (n instanceof SchemeInexact) {
      if (!Number.isSafeInteger(n.real)) {
        throw new Error(`integer codec: inexact ${n.toString()} is not a safe integer`);
      }
      return n.real;
    }
    return exactToJsNumberOrDoor(n); // exactToJsNumberOrDoor already rejects rationals + out-of-range
  },
  encode: (n) => {
    if (!Number.isSafeInteger(n)) {
      throw new Error(`integer codec: ${n} is not a safe integer`);
    }
    return new SchemeExact(BigInt(n));
  },
});

/** SchemeExact|SchemeInexact ↔ JS `bigint` (exact, arbitrary precision — always faithful
 *  for an integer term). decode → bigint; encode → SchemeExact. A non-integer rational
 *  or a non-integral inexact DOORS (a bigint has no fractional part). */
export const bigint = z.codec(z.union([z.instanceof(SchemeExact), z.instanceof(SchemeInexact)]), z.bigint(), {
  decode: (n) => {
    if (n instanceof SchemeInexact) {
      if (!Number.isInteger(n.real)) {
        throw new Error(`bigint codec: inexact ${n.toString()} has a fractional part`);
      }
      return BigInt(n.real);
    }
    if (n.denom !== 1n) {
      throw new Error(`bigint codec: exact rational ${n.toString()} has no integer bigint form`);
    }
    return n.num;
  },
  encode: (n) => new SchemeExact(n),
});

import * as z from "zod";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

import { APair } from "../values/primitives/APair.js";
import { ANil } from "../values/primitives/ANil.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AVector } from "../values/primitives/AVector.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AString } from "../values/primitives/AString.js";
import { ABool } from "../values/primitives/ABool.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import type { SchemeValue } from "../values/types.js";
import { AVoid } from "../values/primitives/AVoid.js";
import { R7RSError } from "../errors.js";
import { ADict } from "../values/primitives/ADict.js";
import { type ACallable, ANativeProcedure, applyCallback } from "../values/primitives/ACallable.js";
import { is_callable_value } from "../values/value-guards.js";
import { tf } from "../values/tagless-final.js";

/**
 * Every primitive has a scheme-side (always) and maybe a JS-side codec. That "maybe" is the whole design.
 * Ambigulous names are chosen specifically as different from both environments to highlight that they are not
 * related to specific ontology.
 *
 * ┌────────────┬────────────────────┬──────────────────────────┬─────────────────────────┐
 * │ primitive  │    scheme value   │  JS image (codec side)  │     rosetta-usable?    │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ value      │ any SchemeVlue    │ — (opaque, no transform) │ passthrough only       │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ boolean    │ ABool             │ boolean                  │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ integer    │ AExact            │ bigint                   │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ rational   │ AInexact          │ number                   │ ✅ (lossy acknowledged)│
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ char       │ ACharacter        │ string (len 1)           │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ string     │ AString           │ string                   │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ symbol     │ ASymbol           │ opaque brand             │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ nil        │ ANil              │ null                    │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ void       │ AVoid             │ undefined                │ ✅ (output)            │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ list       │ APair|ANil        │ array                    │ ✅ (input)             │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ vector     │ AVector           │ array                    │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ bytevector │ ABytevector       │ Uint8Array               │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ dict       │ record            │ object                   │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ error      │ R7RSError         │ Error                    │ ✅                     │
 * ├────────────┼────────────────────┼──────────────────────────┼─────────────────────────┤
 * │ procedure  │ ACallable / lambda │ bound function         │ ✅ (input)             │
 * └────────────┴────────────────────┴──────────────────────────┴─────────────────────────┘
 *
 * Symbol - as the core primitive of Scheme - is tilted towards it;
 * Rosetta is able to provide the types as opaque-branded; this allows struct manipulation without access
 * to the underlying container.
 *
 * Procedure returning from rosetta is banned since it makes the provenance impossible.
 * Procedures as arguments are passed inside the Rosetta in wrapped state.
 * Native procedures get rosetta inverse-wrapped on both inputs and outputs.
 *
 * Additional types are available for rosetta specifically as type-casting; target domain used intentionally.
 * Scheme -> JS
 * bigint: AExact and AInexact type-casted to bigint, with invariants
 * number: AExact and AInexact type-casted to number, with invariants; for native procedures, pass-through both types
 * array: List, Nil, and Vector type-casted to array
 *
 * JS -> Scheme
 * exact: bigint and number type-casted to AExact, with invariants
 * inexact: bigint and number type-casted to AInxact (no invariants needed, but math is on the table)
 *
 */

export {
  tuple,
  union,
  record,
  array,
  enum,
  decode,
  encode,
  custom,
  object,
  literal,
  codec,
  config,
  toJSONSchema,
  fromJSONSchema,
} from "zod";
export type { input, output, infer, ZodType, ZodTypeAny, ZodObject, ZodCustom, ZodRawShape } from "zod";

export const pair = z.instanceof(APair);
export const symbol = z.instanceof(ASymbol);
export const svector = z.custom<AVector>(
  (x) => typeof (x as Record<string, unknown> | null | undefined)?.[tf("vector?")] === "function",
);
export const sbytevector = z.instanceof(ABytevector);
export const nil = z.instanceof(ANil);
export const undefinedResult = z.instanceof(AVoid);
export const error = z.instanceof(R7RSError);

export const lambda = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");

const KWARGS = new WeakSet<object>();
export function kwargs<S extends z.ZodRawShape>(shape: S) {
  const schema = z.object(shape);
  KWARGS.add(schema);
  return schema;
}
export function isKwargs(schema: unknown): schema is z.ZodObject<z.ZodRawShape> {
  return typeof schema === "object" && schema !== null && KWARGS.has(schema);
}

export function listOf<E extends z.ZodType>(element: E) {
  return z.codec(
    z.custom<APair | ANil>((x) => x instanceof APair || x instanceof ANil),
    z.array(element),
    {
      decode: (l) => {
        const out: unknown[] = [];
        let node: unknown = l;
        while (node instanceof APair) {
          if (node.have_cycles("cdr")) throw new TypeError("list codec: cannot decode a circular list");
          out.push(node.car);
          node = node.cdr;
        }
        if (!(node instanceof ANil)) throw new TypeError("list codec: cannot decode an improper list");
        // The out-side `z.array(element)` parse runs element.decode per slot after this.
        return out as z.input<E>[];
      },
      encode: (arr) => APair.fromArray(CONSTANT_CTX, arr, false) as APair | ANil,
    },
  );
}

export const list = listOf(z.custom<SchemeValue>());

export function vectorOf<E extends z.ZodType>(element: E) {
  return z.codec(
    z.custom<AVector>((x) => typeof (x as Record<string, unknown> | null | undefined)?.[tf("vector?")] === "function"),
    z.array(element),
    {
      decode: (v) => {
        // The protocol admits AVector (payload on __vector__) and AJSArray (borrowed
        // source) — read whichever payload the answering value carries.
        const payload =
          (v as { __vector__?: SchemeValue[]; source?: unknown[] }).__vector__ ?? (v as { source?: unknown[] }).source;
        if (!Array.isArray(payload))
          throw new TypeError("vector codec: the operand answers vector? but carries no array payload");
        return payload as z.input<E>[];
      },
      encode: (arr) => new AVector(CONSTANT_CTX, arr as SchemeValue[]),
    },
  );
}

export const vector = vectorOf(z.custom<SchemeValue>());

// Native dict values are ADict instances (native-dict-provenance.md) — a real
// SchemeValue kind, not a codec: no JS-side transform here, matching `pair`
// above. AJSObject is no longer part of the dict role at all.
export const dict = z.instanceof(ADict);

export const procedure = z.codec(
  z.custom<ACallable | ((...args: unknown[]) => unknown)>((x) => typeof x === "function" || is_callable_value(x)),
  z.custom<(...args: unknown[]) => unknown>((x) => typeof x === "function"),
  {
    decode: (fn) => {
      return (...args: unknown[]) => applyCallback(fn, args);
    },
    encode: (fn) =>
      new ANativeProcedure({
        name: "<host-procedure>",
        arity: { min: 0, max: null },
        contract: undefined,
        impl: (args) => fn(...args) as SchemeValue,
      }),
  },
);

export const string = z.codec(z.instanceof(AString), z.string(), {
  decode: (s) => s["arrival/toJS"](),
  encode: (s) => new AString(CONSTANT_CTX, s),
});

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

export const char = z.codec(z.instanceof(ACharacter), z.string().length(1), {
  decode: (c) => c.valueOf(),
  encode: (c) => new ACharacter(CONSTANT_CTX, c),
});

export const exact = z.codec(z.instanceof(AExact), z.bigint(), {
  decode: (n) => {
    Error.invariant(n.denom === 1n, `exact codec: exact rational ${n.toString()} has no integer bigint form`);
    return n.num;
  },
  encode: (n) => new AExact(CONSTANT_CTX, n),
});

export const inexact = z.codec(z.instanceof(AInexact), z.number(), {
  decode: (n) => n.real,
  encode: (n) => new AInexact(CONSTANT_CTX, n),
});

export const schemeNumber = z.union([exact, inexact]);

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);

function exactToJsNumberOrDoor(n: AExact): number {
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

export const number = z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.number(), {
  decode: (n) => (n instanceof AInexact ? n.real : exactToJsNumberOrDoor(n)),
  encode: (n) => new AInexact(CONSTANT_CTX, n),
});

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

export const value = z.union([number, bigint, integer, ]);

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
  [undefinedResult, "undefinedResult"],
  [error, "error"],
]);

export function lookupName(schema: unknown): string | undefined {
  return NAMES.get(schema);
}

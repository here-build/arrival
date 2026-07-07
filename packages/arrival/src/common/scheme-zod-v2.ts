import * as z from "zod";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { DefaultedWeakMap } from "@here.build/collections";

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
import { AJSObject } from "../values/primitives/AJSObject.js";
import { ALambda, ANativeProcedure, ARosettaProcedure, applyCallback } from "../values/primitives/ACallable.js";
import { AJSArray } from "../values/primitives/AJSArray.js";

/**
 * Every primitive has a scheme-side value (always) and maybe a JS-side codec. That "maybe" is
 * the whole design. Primitive names below are chosen to be ambiguous — deliberately different
 * from both the Scheme vocabulary (`AExact`) and the JS vocabulary (`bigint`) — to highlight
 * that they aren't tied to either ontology.
 *
 * | primitive     | scheme value        | JS image (codec side)     | rosetta-usable?         |
 * |---------------|----------------------|----------------------------|--------------------------|
 * | `value`       | any `SchemeValue`    | — (opaque, no transform)   | passthrough only         |
 * | `boolean`     | `ABool`              | `boolean`                  | ✅                        |
 * | `integer`     | `AExact`             | `bigint`                   | ✅                        |
 * | `rational`    | `AInexact`           | `number`                   | ✅ (lossy acknowledged)  |
 * | `char`        | `ACharacter`         | `string` (len 1)           | ✅                        |
 * | `string`      | `AString`            | `string`                   | ✅                        |
 * | `symbol`      | `ASymbol`            | opaque brand                | ✅                        |
 * | `nil`         | `ANil`               | `null`                     | ✅                        |
 * | `void`        | `AVoid`              | `undefined`                 | ✅ (output)               |
 * | `list`        | `APair` / `ANil`    | `array`                     | ✅ (input)                |
 * | `vector`      | `AVector`            | `array`                     | ✅                        |
 * | `bytevector`  | `ABytevector`        | `Uint8Array`                | ✅                        |
 * | `dict`        | record               | `object`                    | ✅                        |
 * | `error`       | `R7RSError`          | `Error`                     | ✅                        |
 * | `procedure`   | `ACallable` / lambda | bound function              | ✅ (input)                |
 *
 * `symbol` — as the core primitive of Scheme — is tilted toward it: rosetta exposes it as an
 * opaque-branded value, which lets host code carry/compare symbols without unwrapping the
 * underlying container.
 *
 * A procedure returning *from* rosetta is banned — it would make provenance untraceable.
 * Procedures passed *as arguments* travel wrapped inside the rosetta boundary. Native
 * procedures get rosetta's inverse wrapping on both inputs and outputs.
 *
 * ## Additional casting types
 *
 * These exist for rosetta specifically as type-casting conveniences. Unlike the primitive
 * table above, their names intentionally match the target domain.
 *
 * **Scheme → JS**
 * - `bigint` — `AExact`/`AInexact` type-cast to `bigint`, with invariants.
 * - `number` — `AExact`/`AInexact` type-cast to `number`, with invariants; for native
 *   procedures, both types pass through unchanged.
 * - `array` — `list` (`APair`/`ANil`) or `vector` type-cast to `array`.
 *
 * **JS → Scheme**
 * - `exact` — `bigint`/`number` type-cast to `AExact`, with invariants.
 * - `inexact` — `bigint`/`number` type-cast to `AInexact` (no invariants needed — lossy
 *   conversion is accepted; the math is on the table).
 */

export {
  tuple,
  union,
  record,
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

// ---------------------------------------------------------------------------
// :: Primitive table (ambiguous names — see the class doc above)
// ---------------------------------------------------------------------------

export const boolean = z.codec(z.instanceof(ABool), z.boolean(), {
  decode: (b) => b.value,
  encode: (b) => new ABool(CONSTANT_CTX, b),
});

export const booleanTrue = boolean.refine((value): value is true => value === true);
export const booleanFalse = boolean.refine((value): value is false => value === false);

export const integer = z.codec(z.instanceof(AExact), z.bigint(), {
  decode: (n) => {
    Error.invariant(n.denom === 1n, `integer codec: exact rational ${n.toString()} has no integer bigint form`);
    return n.num;
  },
  encode: (n) => new AExact(CONSTANT_CTX, n),
});

export const rational = z.codec(z.instanceof(AInexact), z.number(), {
  decode: (n) => n.real,
  encode: (n) => new AInexact(CONSTANT_CTX, n),
});

export const schemeNumber = z.union([integer, rational]);

export const char = z.codec(z.instanceof(ACharacter), z.string().length(1), {
  decode: (c) => c.valueOf(),
  encode: (c) => new ACharacter(CONSTANT_CTX, c),
});

export const string = z.codec(z.instanceof(AString), z.string(), {
  decode: (s) => s.valueOf(),
  encode: (s) => new AString(CONSTANT_CTX, s),
});

// `symbolJsToSchemeCache` is a plain Map (not WeakMap — a fresh unique `Symbol()` isn't a
// useful WeakMap key across engines this codebase targets) keyed by the minted jsSymbol,
// so it needs its OWN cleanup: a FinalizationRegistry deletes the entry once the underlying
// ASymbol is collected, mirroring the DefaultedWeakMap's weak hold on the scheme side. Without
// this, every distinct ASymbol ever decoded would leak one entry here forever (module-level,
// no run-scoping) — unlike this package's per-RunContext ASymbol interning.
const symbolJsToSchemeCache = new Map<symbol, WeakRef<ASymbol>>();
const symbolFinalizer = new FinalizationRegistry<symbol>((jsSymbol) => {
  symbolJsToSchemeCache.delete(jsSymbol);
});
const symbolSchemeToJsCache = new DefaultedWeakMap<ASymbol, symbol>((schemeSymbol) => {
  const jsSymbol = Symbol(`arrival scheme membrane-wrapped symbol: ${schemeSymbol.__name__}`);
  symbolJsToSchemeCache.set(jsSymbol, new WeakRef<ASymbol>(schemeSymbol));
  symbolFinalizer.register(schemeSymbol, jsSymbol);
  return jsSymbol;
});
/** Opaque brand — no JS-side transform, deliberately (see class doc above). */
export const symbol = z.codec(z.instanceof(ASymbol), z.symbol(), {
  decode: (value) => symbolSchemeToJsCache.get(value),
  encode: (value) => {
    const ref = symbolJsToSchemeCache.get(value);
    const schemeSymbol = ref?.deref();
    Error.invariant(schemeSymbol !== undefined, "symbol codec: encode received a jsSymbol never minted by decode (or its ASymbol was already collected)");
    return schemeSymbol;
  },
});

export const nil = z.codec(z.instanceof(ANil), z.null(), {
  decode: () => null,
  encode: () => new ANil(CONSTANT_CTX),
});

/** Table calls this `void`, but that's a reserved word — exported as `undefinedResult`. */
export const undefinedResult = z.codec(z.instanceof(AVoid), z.undefined(), {
  decode: () => undefined,
  encode: () => new AVoid(CONSTANT_CTX),
});

// list / vector / array are now *functions* (Zod style). See design notes in the
// module header + user request for z.list(z.char, z.union(z.nil, z.boolean)) etc.
//
// We keep the old listOf/vectorOf names during transition as thin wrappers (they
// will be removed when v2 becomes the active scheme-zod).

const anyScheme = z.custom<SchemeValue>(() => true);

function makeHomogeneousList<E extends z.ZodTypeAny>(element: E) {
  const container = z.union([
    z.instanceof(APair) as z.ZodCustom<
      InstanceType<new (...args: ConstructorParameters<typeof APair>) => APair<any, any>>,
      InstanceType<new (...args: ConstructorParameters<typeof APair>) => APair<any, any>>
    >,
    z.instanceof(ANil),
  ]);
  return z.codec(container, z.array(element), {
    decode: (l: any) => {
      const out: unknown[] = [];
      let node: any = l;
      while (node instanceof APair) {
        if (node.have_cycles && node.have_cycles("cdr")) {
          throw new TypeError("list codec: cannot decode a circular list");
        }
        out.push(node.car);
        node = node.cdr;
      }
      if (!(node instanceof ANil)) {
        throw new TypeError("list codec: cannot decode an improper list");
      }
      return out;
    },
    encode: (arr: unknown[]) => APair.fromArray(CONSTANT_CTX, arr, false) as APair<any, any> | ANil,
  });
}

// EXACTLY one cons cell: car must match carE, cdr must match cdrE DIRECTLY (not
// "eventually cdrE after more carE-typed elements"). This is `cons`, not a recursive
// list — `z.list(z.char, z.nil)` accepts ONLY a single-char list, never 2+ chars,
// because the second cdr is itself a Pair (not ANil). See the `list()` 2-arg branch
// below for where this gets called from, and the regression test in
// scheme-zod-v2.test.ts ("2-arg cons form is exactly one cons cell") that pins this
// boundary — it looks like it should generalize to N elements-then-tail, it does not.
function makeTypedCons<E1 extends z.ZodTypeAny, E2 extends z.ZodTypeAny>(carE: E1, cdrE: E2) {
  return z.codec(z.instanceof(APair), z.tuple([carE, cdrE]), {
    decode: (p: APair<any, any>) => [p.car, p.cdr],
    encode: ([c, d]: unknown[]) => new APair(CONSTANT_CTX, c as any, d as any),
  });
}

/**
 * Three DIFFERENT shapes depending on arity — not one generalized pattern:
 * - 0 args: any proper list of any scheme value (unbounded length).
 * - 1 arg `list(E)`: a homogeneous proper list of E (unbounded length, nil-terminated).
 * - 2 args `list(carE, cdrE)`: `cons` — EXACTLY one pair, car matches carE, cdr
 *   matches cdrE DIRECTLY (not "eventually cdrE"). `list(char, nil)` accepts a
 *   1-char list only, never 2+ chars — see makeTypedCons's doc comment.
 * - 3+ args `list(A, B, C, ...)`: a FIXED-length proper list, one element per arg
 *   in order, nil-terminated (heterogeneous tuple-as-list).
 */
export function list(...elements: z.ZodTypeAny[]) {
  if (elements.length === 0) return makeHomogeneousList(anyScheme as any);
  if (elements.length === 1) return makeHomogeneousList(elements[0]);
  if (elements.length === 2) return makeTypedCons(elements[0], elements[1]);
  // >2: build nested cons ending in nil (fixed-shape list)
  let acc: any = nil;
  for (let i = elements.length - 1; i >= 0; i--) {
    acc = makeTypedCons(elements[i], acc);
  }
  return acc;
}

// Legacy names for partial compat while we port contracts. They delegate to the new form.
export function listOf<E extends z.ZodTypeAny>(element: E, length?: number) {
  const base = list(element);
  if (length === undefined) return base;
  return base.refine((arr: any): arr is any[] => arr.length === length);
}

// vector is now a function. Legacy vectorOf kept as compat wrapper.
export function vector<E extends z.ZodTypeAny>(element: E = anyScheme as any) {
  // Two branches, encode canonically produces AVector (first branch).
  return z.union([
    z.codec(z.instanceof(AVector), z.array(element), {
      decode: (v: AVector) => v.__vector__,
      encode: (arr) => new AVector(CONSTANT_CTX, arr as SchemeValue[]),
    }),
    z.codec(z.instanceof(AJSArray), z.array(element), {
      decode: (v: AJSArray) => v.source as any,
      encode: (arr) => new AJSArray(CONSTANT_CTX, arr as SchemeValue[]),
    }),
  ]);
}

export function vectorOf<E extends z.ZodTypeAny>(element: E, length?: number) {
  const base = vector(element);
  if (length === undefined) return base;
  return base.refine((arr: any): arr is any[] => arr.length === length);
}

export const bytevector = z.codec(z.instanceof(ABytevector), z.instanceof(Uint8Array), {
  decode: (b) => b.__bytevector__ as Uint8Array<ArrayBuffer>,
  encode: (b) => new ABytevector(CONSTANT_CTX, b),
});

// Same shape as `vector`: no instanceof-in-decode, and encode canonically produces a plain
// record (first branch) rather than a boxed AJSObject.
// note that we do not have native scheme dict class; instead, we offload its behavior to AJSObject
export const dict = z.codec(z.instanceof(AJSObject), z.record(z.string(), anyScheme), {
  decode: (d) => d.source as Record<string, SchemeValue>,
  encode: (rec) => new AJSObject(CONSTANT_CTX, rec),
});

export const error = z.codec(z.instanceof(R7RSError), z.instanceof(Error), {
  decode: (e) => new Error(e.message, { cause: e.irritants.length > 0 ? e.irritants : undefined }),
  encode: (e) =>
    new R7RSError(e.message, ...(Array.isArray(e.cause) ? e.cause : e.cause === undefined ? [] : [e.cause])),
});

// `Function` has no call signature in TS's own lib types, so the callable-shaped half
// stays a custom predicate — everything else here converts cleanly to instanceof.
/** Raw predicate for a plain JS function — the "lambda" half of the `procedure` scheme side. */
export const lambda = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");

export const procedure = z.codec(
  z.union([lambda, z.instanceof(ALambda), z.instanceof(ANativeProcedure), z.instanceof(ARosettaProcedure)]),
  lambda,
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

export const pair = z.instanceof(APair);

// AExact listed first so encode canonically produces AExact (matches `integer`, not
// the fractional-part-constrained AInexact half).
export const bigint = z.union([
  z.codec(z.instanceof(AExact), z.bigint(), {
    decode: (n) => {
      TypeError.invariant(n.denom === 1n, `bigint codec: exact rational ${n.toString()} has no integer bigint form`);
      return n.num;
    },
    encode: (n) => new AExact(CONSTANT_CTX, n),
  }),
  z.codec(z.instanceof(AInexact), z.bigint(), {
    decode: (n) => {
      TypeError.invariant(Number.isInteger(n.real), `bigint codec: inexact ${n.toString()} has a fractional part`);
      return BigInt(n.real);
    },
    encode: (n) => new AInexact(CONSTANT_CTX, Number(n)),
  }),
]);

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);

function exactToJsNumberOrDoor(n: AExact): number {
  Error.invariant(
    n.denom === 1n,
    `number codec: exact rational ${n.toString()} cannot be a faithful JS number — use z.bigint or the integer codec`,
  );
  Error.invariant(
    n.num <= SAFE_MAX && n.num >= SAFE_MIN,
    `number codec: exact integer ${n.toString()} is outside JS safe-integer range — use z.bigint for arbitrary precision`,
  );
  return Number(n.num);
}

// AInexact listed first so encode canonically produces AInexact (matches `rational`,
// not the safe-integer-constrained `exact` half).
export const number = z.union([
  z.codec(z.instanceof(AInexact), z.number(), {
    decode: (n) => n.real,
    encode: (n) => new AInexact(CONSTANT_CTX, n),
  }),
  z.codec(z.instanceof(AExact), z.number(), {
    decode: (n) => exactToJsNumberOrDoor(n),
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `number codec: ${n} is not a safe integer`);
      return new AExact(CONSTANT_CTX, BigInt(n));
    },
  }),
]);

/** Scheme array (list or vector of the element). */
export function array<E extends z.ZodTypeAny>(element: E = anyScheme as any) {
  return z.union([list(element as any), vector(element as any)]);
}

export const exact = z.codec(z.instanceof(AExact), z.union([z.bigint(), z.number()]), {
  decode: (n) => {
    Error.invariant(n.denom === 1n, `exact codec: exact rational ${n.toString()} has no integer form`);
    return n.num;
  },
  encode: (n) => {
    if (typeof n === "bigint") return new AExact(CONSTANT_CTX, n);
    TypeError.invariant(Number.isSafeInteger(n), `exact codec: ${n} is not a safe integer`);
    return new AExact(CONSTANT_CTX, BigInt(n));
  },
});

export const inexact = z.codec(z.instanceof(AInexact), z.union([z.bigint(), z.number()]), {
  decode: (n) => n.real,
  encode: (n) => new AInexact(CONSTANT_CTX, typeof n === "bigint" ? Number(n) : n),
});

export const value = z.union([
  exact,
  inexact,
  list(anyScheme),
  vector(anyScheme),
  pair,
  procedure,
  lambda,
  error,
  dict,
  bytevector,
]);

// --- lookup for harvest / printing (modeled on active scheme-zod) ---
const NAMES = new Map<unknown, string>([
  [pair, "pair"],
  [symbol, "symbol"],
  // list/vector/array are functions — specific instances registered below when built
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
  if (NAMES.has(schema)) return NAMES.get(schema);
  // For constructed list/vector etc we can tag them at creation time.
  // For now fall back to structural sniff for the common case the printer cares about.
  return undefined;
}

// Helper to tag constructed collection schemas (future: printer can use name + elem)
function tagCollection(name: string, s: unknown) {
  NAMES.set(s, name);
  return s;
}

// Re-tag the any- versions created at module load (and encourage callers of list(E) etc to tag if needed)
tagCollection("list", list(anyScheme));
tagCollection("vector", vector(anyScheme));
tagCollection("array", array(anyScheme));

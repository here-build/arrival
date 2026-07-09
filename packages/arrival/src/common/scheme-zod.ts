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
import { AVoid } from "../values/primitives/AVoid.js";
import { AValue } from "../values/primitives/AValue.js";
import { ADict, isDictShaped, type DictKey } from "../values/primitives/ADict.js";
import { AJSObject } from "../values/primitives/AJSObject.js";
import { AJSArray } from "../values/primitives/AJSArray.js";
import { R7RSError } from "../errors.js";
import { ALambda, ANativeProcedure, ARosettaProcedure, applyCallback } from "../values/primitives/ACallable.js";
import { currentRegionScope, DETACHED_SCOPE, withRegionCall } from "../values/primitives/region-scope.js";
// Leaf with ZERO own imports (see header) — safe from scheme-zod.ts's cycles, same rationale as rosetta.ts.
import { withDynamicCallSite } from "../eval/dynamic-call-site.js";
import type { AList, AListAlike, SchemeValue } from "../values/types.js";

/**
 * Every primitive has a scheme value (always) and maybe a JS codec. That "maybe" is
 * the whole design. Primitive names are deliberately ambiguous — different from both
 * Scheme (`AExact`) and JS (`bigint`) — to highlight they aren't tied to either ontology.
 *
 * | primitive     | scheme value         | JS image (codec side)     | rosetta-usable?         |
 * |---------------|----------------------|---------------------------|-------------------------|
 * | `value`       | any `SchemeValue`    | — (opaque, no transform)  | passthrough only        |
 * | `boolean`     | `ABool`              | `boolean`                 | ✅                      |
 * | `integer`     | `AExact`/`AInexact`  | `number` (int)            | ✅                      |
 * | `inexact`     | `AInexact`           | `number`                  | ✅ (lossy acknowledged) |
 * | `char`        | `ACharacter`         | `string` (len 1)          | ✅                      |
 * | `string`      | `AString`            | `string`                  | ✅                      |
 * | `symbol`      | `ASymbol`            | opaque brand (JS symbol)  | ✅                      |
 * | `nil`         | `ANil`               | `null`                    | ✅                      |
 * | `void`        | `AVoid`              | `undefined`               | ✅ (output)             |
 * | `list`        | `APair` / `ANil`     | `array`                   | ✅ (input)              |
 * | `cons`        | `APair`              | `[car, cdr]`              | ✅                      |
 * | `vector`      | `AVector`/`AJSArray` | `array`                   | ✅                      |
 * | `bytevector`  | `ABytevector`        | `Uint8Array`              | ✅                      |
 * | `dict`        | `ADict`              | `object`                  | ✅                      |
 * | `box`         | `AJSObject`          | `object` (unwrapped)      | ✅                      |
 * | `error`       | `R7RSError`          | `Error`                   | ✅                      |
 * | `procedure`   | `ACallable`          | bound function            | ✅ (input)              |
 *
 * Returning a procedure *from* rosetta is banned — provenance untraceable.
 * Procedures as arguments travel wrapped inside the rosetta boundary.
 *
 * ## Casting types (rosetta conveniences; names match target domain)
 *
 * Scheme → JS: `bigint` (AExact/AInexact → bigint), `number` (→ number), `array` (list|vector → array).
 * JS → Scheme: `exact` (bigint/number → AExact), `inexact` (bigint/number → AInexact, lossy accepted).
 */

// `array` is zod's own array (the variadic arg-vector spec native contracts use).
// No scheme-collection `array()` — list/vector cast uses `list`/`vector` directly.
export {
  array,
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
// :: Name registry — one `named()` + `WeakMap` chokepoint (called at every export site)
// ---------------------------------------------------------------------------

const NAMES = new WeakMap<z.ZodType, string>();

// Element schema(s) for a NAMED, PARAMETERIZED collection — one schema for a homogeneous
// `list`, `[car, cdr]` for `cons` — so the type-lens prints `List<T>`/`Pair<Car,Cdr>` by
// NAME instead of decomposing structurally. Keyed on the SAME core object NAMES is.
// ONLY `list`/`cons` register here — vector/dict print adequately via structural output.
const COLLECTION_ELEMENT = new WeakMap<z.ZodType, z.ZodTypeAny | readonly [z.ZodTypeAny, z.ZodTypeAny]>();

/** Register `schema` under `name`, return it. Keyed by object identity — a fresh
 *  function-built schema (`list(char)`) registers each instance it mints. */
function named<S extends z.ZodType>(name: string, schema: S): S {
  NAMES.set(schema, name);
  return schema;
}

// Walk to the registered core. Check registry at EACH hop (a registered codec IS a pipe;
// carries its own `def.in` — unwrapping unconditionally walks PAST it, loses registration).
// At each level: registered? that's the core. Else `_zod.parent` set ONLY by `.refine()`/
// `.check()` (via `core.clone(inst, def, {parent:true})`, back-linking pre-refine instance),
// NOT `.extend()` (clones with no parent — dead end, no registered schema is `.extend()`ed) —
// walk it. Else unwrap `.optional()`/`.default()` (`def.innerType`) or unregistered wrapper's
// `def.in`. Verified against zod 4.3.6. Shared by `lookupName` + `lookupCollectionElement`.
function resolveCore(schema: unknown): z.ZodType | undefined {
  let s = schema as { _zod?: { parent?: unknown; def?: { innerType?: unknown; in?: unknown } } } | undefined;
  while (s) {
    if (NAMES.has(s as z.ZodType)) return s as z.ZodType;
    if (s._zod?.parent) {
      s = s._zod.parent as typeof s;
      continue;
    }
    const inner = s._zod?.def?.innerType ?? s._zod?.def?.in;
    if (inner) {
      s = inner as typeof s;
      continue;
    }
    break;
  }
  return undefined;
}

export function lookupName(schema: unknown): string | undefined {
  const core = resolveCore(schema);
  return core ? NAMES.get(core) : undefined;
}

/** Element schema(s) a `list`/`cons` was built with, for named-generic printing — single
 *  schema for `list`, `[car, cdr]` for `cons`, `undefined` else (incl. fixed-heads
 *  `list([A,B])`, prints structurally). Resolves through same core walk `lookupName` uses. */
export function lookupCollectionElement(
  schema: unknown,
): z.ZodTypeAny | readonly [z.ZodTypeAny, z.ZodTypeAny] | undefined {
  const core = resolveCore(schema);
  return core ? COLLECTION_ELEMENT.get(core) : undefined;
}

// ---------------------------------------------------------------------------
// :: value — the untransforming passthrough (defined early: `list` defaults its element to it)
// ---------------------------------------------------------------------------

// `value` stays a PREDICATE, never a union: a union makes `z.decode(value, x)` match a
// branch and TRANSFORM x (collapse AExact → bare bigint) — wrong for a slot whose whole
// meaning is "hand back this scheme value untouched" (identity on both faces). Predicate
// covers every concrete `A*` kind via `instanceof AValue` — closing v1's gap where
// symbol/dict/vector/bytevector couldn't validate — plus a JS fn used as a procedure.
function isSchemeValue(x: unknown): x is SchemeValue {
  return x instanceof AValue || typeof x === "function";
}
// Rosetta escape hatch: `value` in a rosetta slot means "no automatic transform — impl
// receives/returns raw scheme value, does its own schemeToJs/jsToScheme" (single legitimate
// rosetta use: env/overridable.ts's dynamic `overridable/resolve`).
export const value = named("value", z.custom<SchemeValue>(isSchemeValue));

// ---------------------------------------------------------------------------
// :: Scalar primitives
// ---------------------------------------------------------------------------

export const boolean = named(
  "boolean",
  z.codec(z.instanceof(ABool), z.boolean(), {
    decode: (b) => b.value,
    encode: (b) => new ABool(CONSTANT_CTX, b),
  }),
);

export const booleanTrue = boolean.refine((v): v is true => v === true);
export const booleanFalse = boolean.refine((v): v is false => v === false);

export const char = named(
  "char",
  z.codec(z.instanceof(ACharacter), z.string().length(1), {
    decode: (c) => c.valueOf(),
    encode: (c) => new ACharacter(CONSTANT_CTX, c),
  }),
);

export const string = named(
  "string",
  z.codec(z.instanceof(AString), z.string(), {
    decode: (s) => s.valueOf(),
    encode: (s) => new AString(CONSTANT_CTX, s),
  }),
);

// --- symbol: ASymbol ↔ JS Symbol, with the corrected GC direction ---

// dedup on scheme side (weak key = ASymbol, collectable with it).
const symbolSchemeToJs = new WeakMap<ASymbol, symbol>();
// STRONG value, WEAK key (the minted jsSymbol) — inverse of draft's
// `Map<symbol, WeakRef<ASymbol>>`+FinalizationRegistry, which held ASymbol WEAKLY and could
// collect it out from under a live jsSymbol, making `encode` throw nondeterministically.
// Here `encode` is TOTAL: ASymbol lives exactly as long as its jsSymbol. Valid only for
// UNREGISTERED symbols (`Symbol(desc)`, what decode mints) — `Symbol.for(...)` is not a
// legal WeakMap key, but this codec never mints those.
const symbolJsToScheme = new WeakMap<symbol, ASymbol>();
export const symbol = named(
  "symbol",
  z.codec(z.instanceof(ASymbol), z.symbol(), {
    decode: (s) => {
      const existing = symbolSchemeToJs.get(s);
      if (existing) return existing;
      const js = Symbol(`arrival membrane symbol: ${String(s.__name__)}`);
      symbolSchemeToJs.set(s, js);
      symbolJsToScheme.set(js, s);
      return js;
    },
    encode: (js) => {
      const s = symbolJsToScheme.get(js);
      Error.invariant(s !== undefined, "symbol codec: encode received a jsSymbol never minted by decode");
      return s;
    },
  }),
);

// --- nil / undefinedResult / error: real codecs (bare instanceof decodes to raw scheme
//     instance while a sibling union branch decodes to a real JS value, breaking the
//     union-uniformity every rosetta consumer depends on) ---

// `nil` covers ONLY the null-value role; empty-LIST role absorbed by `list`'s own
// decode (proper list terminating in ANil decodes to `[]`, no separate schema needed).
export const nil = named(
  "nil",
  z.codec(z.instanceof(ANil), z.null(), {
    decode: () => null,
    encode: () => new ANil(CONSTANT_CTX),
  }),
);

/** Table calls this `void`, but that's a reserved word — exported as `undefinedResult`. */
export const undefinedResult = named(
  "undefinedResult",
  z.codec(z.instanceof(AVoid), z.undefined(), {
    decode: () => undefined,
    encode: () => new AVoid(CONSTANT_CTX),
  }),
);

export const error = named(
  "error",
  z.codec(z.instanceof(R7RSError), z.instanceof(Error), {
    decode: (e) => new Error(e.message, { cause: e.irritants.length > 0 ? e.irritants : undefined }),
    encode: (e) =>
      new R7RSError(e.message, ...(Array.isArray(e.cause) ? e.cause : e.cause === undefined ? [] : [e.cause])),
  }),
);

// --- numbers ---

export const exact = named(
  "exact",
  z.codec(z.instanceof(AExact), z.union([z.bigint(), z.number()]), {
    decode: (n) => {
      Error.invariant(n.denom === 1n, `exact codec: exact rational ${n.toString()} has no integer form`);
      return n.num;
    },
    encode: (n) => {
      if (typeof n === "bigint") return new AExact(CONSTANT_CTX, n);
      TypeError.invariant(Number.isSafeInteger(n), `exact codec: ${n} is not a safe integer`);
      return new AExact(CONSTANT_CTX, BigInt(n));
    },
  }),
);

// `rational` folded into `inexact`: this codec is the superset (accepts bigint|number on
// encode), so a separate AInexact→number codec bought nothing.
export const inexact = named(
  "inexact",
  z.codec(z.instanceof(AInexact), z.union([z.bigint(), z.number()]), {
    decode: (n) => n.real,
    encode: (n) => new AInexact(CONSTANT_CTX, typeof n === "bigint" ? Number(n) : n),
  }),
);

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

// `integer` — accepts either exact-domain kind, JS image is `number().int()`, canonicalizes
// `encode` to AExact (integer's home representation).
export const integer = named(
  "integer",
  z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.number().int(), {
    decode: (n) => {
      if (n instanceof AInexact) {
        TypeError.invariant(
          Number.isSafeInteger(n.real),
          `integer codec: inexact ${n.toString()} is not a safe integer`,
        );
        return n.real;
      }
      return exactToJsNumberOrDoor(n); // rejects rationals + out-of-range
    },
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `integer codec: ${n} is not a safe integer`);
      return new AExact(CONSTANT_CTX, BigInt(n));
    },
  }),
);

export const schemeNumber = named("schemeNumber", z.union([exact, inexact]));

// AInexact listed first so encode canonically produces AInexact (not safe-integer-
// constrained AExact half).
export const number = named(
  "number",
  z.union([
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
  ]),
);

// AExact listed first so encode canonically produces AExact (matches `integer`).
export const bigint = named(
  "bigint",
  z.union([
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
  ]),
);

// --- loose JS-number-land conversions (permissive — arithmetic/math-builtin domain) ---
//
// [ADDED 2026-07-09, numeric.ts NCodec dissolution] `number`/`bigint` above are the
// STRICT rosetta-boundary casts: they DOOR on precision loss (non-integer exact rational,
// out-of-safe-range integer) and reject IEEE non-finite values (`z.number()` excludes
// NaN/±Infinity — confirmed zod 4.3.6). Correct for a value crossing the membrane to a JS
// caller who didn't ask for silent precision loss.
//
// WRONG for `env/r7rs/numeric.ts`'s internal math builtins (`round`/`floor`/`ceiling`/
// `truncate`/`sqrt`/`sin`/…/`abs`/`zero?`/`positive?`/`negative?`), which need to (a) accept
// `+nan.0`/`+inf.0`/`-inf.0` — ordinary R7RS inexact reals, tested directly by the R7RS
// conformance corpus — and (b) LOSSILY convert a non-integer exact rational to a JS float
// (`(round 7/2)` — input IS a non-integer rational; that's the point), never door on it.
// Discovered via real conformance regression: routing those ops through strict `number`/
// `bigint` caused 10 R7RS test failures (6 positive?/negative? on non-finite reals, 4 round
// on exact rationals).
//
// These two codecs are the missing PERMISSIVE half — byte-for-byte the old (pre-dissolution)
// `Num`/`AnyNum` NCodec behavior from numeric.ts, now named and public.

/** Any scheme number ↔ JS `number`, LOSSY (non-integer exact rational divides; out-of-safe-
 *  range exact integers divide too — no invariant, no door) and permissive of non-finite
 *  values (`+nan.0`/`+inf.0`/`-inf.0` pass through AInexact's `.real` unchanged). Encode
 *  canonicalizes safe-integer JS number to AExact, else AInexact — same rule `number`'s
 *  AExact branch uses, without `number`'s finite-only guard. */
export const looseNumber = named(
  "looseNumber",
  z.codec(
    z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
    z.custom<number>((v) => typeof v === "number"),
    {
      decode: (n) => (n instanceof AExact ? Number(n.num) / Number(n.denom) : n.real),
      encode: (n) => (Number.isSafeInteger(n) ? new AExact(CONSTANT_CTX, BigInt(n)) : new AInexact(CONSTANT_CTX, n)),
    },
  ),
);

/** Any scheme number ↔ JS `number | bigint` — `looseNumber`'s domain, PLUS an out-of-safe-
 *  range exact integer decodes to `bigint` instead of lossy float (preserving magnitude,
 *  the one case `looseNumber` alone would corrupt). Used by `abs`/`zero?`/`positive?`/
 *  `negative?` — ops whose `fn` branches on `typeof x === "bigint"` to stay exact. */
export const looseAnyNumber = named(
  "looseAnyNumber",
  z.codec(
    z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
    z.union([z.custom<number>((v) => typeof v === "number"), z.bigint()]),
    {
      decode: (n) => {
        if (n instanceof AExact) {
          if (n.isInteger && n.num >= SAFE_MIN && n.num <= SAFE_MAX) return Number(n.num);
          if (n.isInteger) return n.num;
          return Number(n.num) / Number(n.denom);
        }
        return n.real;
      },
      encode: (v) =>
        typeof v === "bigint"
          ? new AExact(CONSTANT_CTX, v)
          : Number.isSafeInteger(v)
            ? new AExact(CONSTANT_CTX, BigInt(v))
            : new AInexact(CONSTANT_CTX, v),
    },
  ),
);

export const bytevector = named(
  "bytevector",
  z.codec(z.instanceof(ABytevector), z.instanceof(Uint8Array), {
    decode: (b) => b.__bytevector__ as Uint8Array<ArrayBuffer>,
    encode: (b) => new ABytevector(CONSTANT_CTX, b),
  }),
);

/** Raw predicate for a callable — callable VALUE (ALambda/ANativeProcedure/
 *  ARosettaProcedure, post-B2 shape every builtin binds as) or plain JS function.
 *  [RETAGGED 2026-07-09] B4 audited with THREE independent live bare-fn producers;
 *  reverse-membrane-for-callables.md §3 "Step 1" (named-let → ALambda) and "Step 2"
 *  (curry → prelude + `procedure-min-arity` native) landed same day, retiring two. One
 *  survivor: `env.defineRosetta`'s legacy form / McpEnvCapability's inline-annotation
 *  authoring shape (gate: McpEnvCapability annotation-lifting, undone — separate migration).
 *  Narrows to ACallable union alone only once that lands. */
export const lambda = named(
  "lambda",
  z.custom<(...args: unknown[]) => unknown>(
    (v) =>
      typeof v === "function" ||
      v instanceof ALambda ||
      v instanceof ANativeProcedure ||
      v instanceof ARosettaProcedure,
  ),
);

// ---------------------------------------------------------------------------
// :: Collections — head-tuple + optional tail (mirrors _bake.ts's Contract.input/inputRest)
// ---------------------------------------------------------------------------

// The list container: `APair | ANil` (proper-list spine or empty list).
const listContainer = z.custom<AListAlike>((x) => x instanceof APair || x instanceof ANil);

// Walk pair spine into raw car array — rejecting cycles and improper (non-ANil-terminated)
// lists. OUT schema (`z.array`/`z.tuple`) validates elements/arity.
function spineToArray(l: AListAlike): unknown[] {
  const out: unknown[] = [];
  let node: unknown = l;
  while (node instanceof APair) {
    if (node.have_cycles("cdr")) throw new TypeError("list codec: cannot decode a circular list");
    out.push(node.car);
    node = node.cdr;
  }
  if (!(node instanceof ANil)) throw new TypeError("list codec: cannot decode an improper list");
  return out;
}

/**
 * A proper list, printed as `List<T>` (see `list([A,B])` for fixed-heterogeneous form):
 * - `list()` / `list(E)` — homogeneous unbounded list of E (E defaults to `value`).
 * - `list([A, B])` — exactly A then B, nil-terminated (no tail).
 * - `list([A, B], E)` — fixed heads A, B, then zero-or-more E, nil-terminated.
 *
 * NOT `cons`: `list([carE])` is proper list `(a)` = `(a . ())`, whereas `cons(a, b)` is a
 * dotted pair whose cdr need not be nil-terminated.
 */
export function list<E extends z.ZodTypeAny = typeof value>(
  element?: E,
): z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodArray<E>>;
export function list(
  heads: readonly z.ZodTypeAny[],
  tail?: z.ZodTypeAny,
): z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodType>;
export function list(headsOrElement: z.ZodTypeAny | readonly z.ZodTypeAny[] = value, tail?: z.ZodTypeAny) {
  const heads = Array.isArray(headsOrElement) ? (headsOrElement as readonly z.ZodTypeAny[]) : [];
  // Bare / single-arg form: lone schema is homogeneous tail, not a head.
  const effectiveTail = Array.isArray(headsOrElement) ? tail : (tail ?? (headsOrElement as z.ZodTypeAny));
  const out: z.ZodType =
    heads.length === 0
      ? z.array(effectiveTail ?? value)
      : effectiveTail
        ? z.tuple(heads as [z.ZodTypeAny, ...z.ZodTypeAny[]], effectiveTail)
        : z.tuple(heads as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
  const schema = named(
    "list",
    z.codec(listContainer, out as z.ZodArray<z.ZodTypeAny>, {
      decode: (l) => spineToArray(l) as never,
      encode: (arr) => APair.fromArray(CONSTANT_CTX, arr as SchemeValue[], false) as AListAlike,
    }),
  );
  // Homogeneous form carries single element schema → prints `List<E>`. Fixed-heads
  // `list([A,B])` has NO single element, registers nothing, falls through to structural
  // tuple print — honest for heterogeneous fixed-length list.
  if (heads.length === 0) COLLECTION_ELEMENT.set(schema, effectiveTail ?? value);
  return schema as z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodType>;
}

// `cons` stays its OWN function, not subsumed by `list`'s tuple form: exactly one pair, car
// matches carE and cdr matches cdrE DIRECTLY (not "eventually cdrE after more carE elements").
// `cons(char, nil)` accepts a 1-char list only, never 2+ — second cdr would be a Pair, not
// ANil. Prints as `Pair<Car, Cdr>`, a dotted pair, not a 2-tuple.
export function cons<C extends z.ZodTypeAny, D extends z.ZodTypeAny>(carE: C, cdrE: D) {
  const schema = named(
    "cons",
    z.codec(z.instanceof(APair), z.tuple([carE, cdrE]), {
      // `as never`: zod's tuple input type is a variadic conditional it can't reconcile with
      // a plain 2-array here (generic-boundary cast, same shape as v1's `as z.input<E>[]`).
      decode: (p) => [p.car, p.cdr] as never,
      encode: ([c, d]) => new APair(CONSTANT_CTX, c as SchemeValue, d as SchemeValue),
    }),
  );
  // Two element schemas → prints `Pair<Car, Cdr>` (dotted pair), NOT structural `[A, B]`.
  COLLECTION_ELEMENT.set(schema, [carE, cdrE]);
  return schema;
}

// `pair` is `cons(value, value)`, not hand-rolled bare instanceof — every OTHER primitive in
// this vocabulary is a real codec; a bare `z.instanceof(APair)` never decodes, so a rosetta
// contract typed `z.pair` would still hand its impl, a raw APair (the exact "impl touches
// interpreter internals" failure the whole codec vocabulary exists to prevent). Scheme face
// (z.input) is byte-identical to old bare form (still z.instanceof(APair)), so every current
// native/sequence consumer (25 sites, all scheme-face, verified) unaffected; only a future
// rosetta contract's decoded shape changes, from raw APair to a real [car, cdr] tuple.
export const pair = cons(value, value);

// `vector` — representation-blind `AVector | AJSArray` union codec; encode canonically
// produces AVector (first union branch).
export function vector<E extends z.ZodTypeAny = typeof value>(element: E = value as unknown as E) {
  return named(
    "vector",
    z.union([
      z.codec(z.instanceof(AVector), z.array(element), {
        decode: (v) => v.__vector__ as z.input<E>[],
        encode: (arr) => new AVector(CONSTANT_CTX, arr as SchemeValue[]),
      }),
      z.codec(z.instanceof(AJSArray), z.array(element), {
        decode: (v) => v.source as z.input<E>[],
        encode: (arr) => new AJSArray(CONSTANT_CTX, arr as SchemeValue[]),
      }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// :: dict / box — two exports, both real codecs, keyed on the `dict?` protocol
// ---------------------------------------------------------------------------

/**
 * `dict` — native k/v map. Keyed shape (`dict({a: integer()})`) drives per-key codec
 * (TS-precise, feeds type-lens); bare `dict()` is open/homogeneous `Record<string,
 * SchemeValue>` case, matching `ADict["arrival/toJS"]()` unmodified.
 */
export function dict<S extends Record<string, z.ZodTypeAny>>(shape: S = {} as S) {
  const keys = Object.keys(shape);
  return named(
    "dict",
    z.codec(
      // dict codecs a UNION, not bare `z.instanceof(ADict)`: a dict-SHAPED AJSObject (a tool
      // result with no prior Scheme lineage) must decode as a dict too — using ADict's own
      // `isDictShaped` helper, same one `dict?`/print cross-cut on. `encode` never touches
      // AJSObject's re-boxing path (builds ADict directly from encoded pairs), so the
      // provenance bug that path had cannot recur here.
      z.union([z.instanceof(ADict), z.instanceof(AJSObject).refine((o) => isDictShaped(o.source))]),
      keys.length ? z.object(shape) : z.record(z.string(), value),
      {
        // Transform ONLY crosses container boundary (ADict ↔ raw-scheme record) — out-schema
        // (`z.object(shape)`/`z.record`) owns per-field marshaling, exactly like `list`/
        // `vector` delegate element marshaling to their `z.array` out-schema. Decoding fields
        // here too would DOUBLE-decode (out-schema re-parses transform's result).
        // `as never`: record shape is generic, zod can't tie it to out-schema input.
        decode: (d) => {
          const src = d as ADict | AJSObject;
          // Both arms build shallow BOXED record here (out-schema owns per-field marshaling)
          // — `arrival/toJS` no longer usable: it egresses an R9 lazy proxy with values
          // already unwrapped to plain JS (egress-proxy.ts), the membrane exit shape, not
          // the inside-the-sandbox record this codec feeds its out-schema.
          const names = keys.length ? keys : src.keys();
          return Object.fromEntries(names.map((k) => [k, src.get(k)])) as never;
        },
        encode: (rec: Record<string, unknown>) =>
          new ADict(
            CONSTANT_CTX,
            Object.entries(rec).map(
              ([k, v]) => [new ASymbol(CONSTANT_CTX, k), v as SchemeValue] as [DictKey, SchemeValue],
            ),
          ),
      },
    ),
  );
}

// `box` — whole-object UNWRAP, not decomposition (unlike `dict`). "Behaves like Dict inside
// Scheme, but rosetta simply unwraps the box instead of decomposing" — preserves class
// identity/methods for genuinely-foreign values.
export const box = named(
  "box",
  z.codec(z.instanceof(AJSObject), z.custom<object>(), {
    decode: (o) => o.source,
    encode: (o) => new AJSObject(CONSTANT_CTX, o),
  }),
);

// ---------------------------------------------------------------------------
// :: procedure — contract-aware marshaling (parametrized), not just reference-wrapping
// ---------------------------------------------------------------------------

/**
 * A callable crossing the membrane. When `input`/`output` supplied, each call marshals
 * per-argument (encode inward, decode outward) instead of passing raw values through — near
 * free at declaration site. Untyped HOF callbacks (`map`/`filter`) omit both, keep honest
 * untransformed passthrough (nothing to marshal against).
 *
 * Return-direction ban stays: rosetta result is never a bare JS function (provenance
 * untraceable) — `encode` only legitimate for an argument marshalled inward.
 *
 * `decode` is the TYPED half of reverse-membrane crossing (docs/working-proposals/
 * reverse-membrane-for-callables.md §7c row 7: "z.procedure decode adopts same scope
 * token — one discipline, typed and untyped paths"): reads SAME ambient region scope
 * `rosetta.ts`'s `schemeToJs` reads (`currentRegionScope()`), falls back to shared
 * `DETACHED_SCOPE` when decoded with no crossing live (unit test calling `.parse(...)`
 * directly) — pre-region-discipline behavior, unchanged.
 */
export function procedure<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(input?: I, output?: O) {
  return named(
    "procedure",
    z.codec(
      z.union([z.instanceof(ALambda), z.instanceof(ANativeProcedure), z.instanceof(ARosettaProcedure)]),
      z.custom<(...a: unknown[]) => unknown>((v) => typeof v === "function"),
      {
        // `as never` at each marshaling call: input/output are generic ZodTypeAny, so zod's
        // encode/decode in/out param types are opaque conditionals here (generic boundary).
        decode: (callable) => {
          const scope = currentRegionScope() ?? DETACHED_SCOPE;
          const cached = scope.cache.get(callable);
          if (cached) return cached;
          // Wrapper CLOSES OVER `scope` (minted here, at decode time) — never re-reads
          // ambient holder, so a call arriving after the exporting symbol invocation returned
          // still sees the (by then closed) scope it was minted against. `withRegionCall`
          // owns escape/pending/abort bookkeeping (§7c rules 1/3/4); this closure owns only
          // marshaling.
          const wrapper = (...jsArgs: unknown[]) =>
            withRegionCall(scope, async () => {
              const schemeArgs = input ? jsArgs.map((a) => z.encode(input, a as never)) : jsArgs;
              // Re-entry nests under exporting invocation via SAME ambient mechanism the
              // untyped path uses — never through callable's `this` (§9's ruling).
              // `scope.runCtx` also carries the call itself (strict mode, abort signal) even
              // though per-field zod codecs above stay CONSTANT_CTX by design (unrelated to
              // region discipline — see scheme-zod.ts's own primitive encoders, e.g.
              // `bytevector`'s `encode`).
              const r = await withDynamicCallSite(scope.dynSite, () =>
                applyCallback(callable, schemeArgs as SchemeValue[], scope.runCtx),
              );
              return output ? z.decode(output, r as never) : r;
            });
          scope.cache.set(callable, wrapper);
          return wrapper;
        },
        encode: (jsFn) =>
          new ANativeProcedure({
            name: "<host-procedure>",
            arity: { min: input ? 1 : 0, max: null },
            contract: undefined,
            impl: async (schemeArgs) => {
              const jsArgs = input ? schemeArgs.map((a) => z.decode(input, a as never)) : schemeArgs;
              const r = await jsFn(...jsArgs);
              return (output ? z.encode(output, r as never) : r) as SchemeValue;
            },
          }),
      },
    ),
  );
}

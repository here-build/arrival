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
// A leaf with ZERO imports of its own (see its header) — safe from any of
// scheme-zod.ts's own cycles, same rationale as rosetta.ts's identical import.
import { withDynamicCallSite } from "../eval/dynamic-call-site.js";
import type { AList, AListAlike, SchemeValue } from "../values/types.js";

/**
 * Every primitive has a scheme-side value (always) and maybe a JS-side codec. That "maybe" is
 * the whole design. Primitive names are chosen to be ambiguous — deliberately different from
 * both the Scheme vocabulary (`AExact`) and the JS vocabulary (`bigint`) — to highlight that
 * they aren't tied to either ontology.
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
 * A procedure returning *from* rosetta is banned — it would make provenance untraceable.
 * Procedures passed *as arguments* travel wrapped inside the rosetta boundary.
 *
 * ## Additional casting types (rosetta type-casting conveniences; names match the target domain)
 *
 * Scheme → JS: `bigint` (AExact/AInexact → bigint), `number` (→ number), `array` (list|vector → array).
 * JS → Scheme: `exact` (bigint/number → AExact), `inexact` (bigint/number → AInexact, lossy accepted).
 */

// `array` is zod's OWN array (the variadic arg-vector spec every native contract's
// `z.array(z.value)` input/output slot uses). There is no scheme-collection `array()`
// function — a scheme list/vector cast to an array uses `list`/`vector` directly.
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
// `list`, `[car, cdr]` for a `cons` — so the type-lens can print `List<T>`/`Pair<Car,Cdr>` by
// NAME instead of decomposing the codec structurally. Keyed on the SAME core object NAMES is
// (resolved through the same unwrap walk). ONLY `list`/`cons` register here — nothing else
// needs named-generic printing (vector/dict already print adequately via structural output).
const COLLECTION_ELEMENT = new WeakMap<z.ZodType, z.ZodTypeAny | readonly [z.ZodTypeAny, z.ZodTypeAny]>();

/** Register `schema` under `name` and return it, for inline use at the definition site.
 *  Keyed by object identity — a fresh function-built schema (`list(char)`) registers each
 *  instance it mints. */
function named<S extends z.ZodType>(name: string, schema: S): S {
  NAMES.set(schema, name);
  return schema;
}

// Walk to the registered core. Check the registry at EACH hop (a registered codec IS a pipe and
// carries its own `def.in` — unwrapping unconditionally would walk PAST it into its input schema
// and lose the registration). At each level: registered? that IS the core. Else `_zod.parent` is
// set ONLY by `.refine()`/`.check()` (they go through `core.clone(inst, def, {parent:true})`,
// back-linking the pre-refine instance), NOT by `.extend()` (clones with no parent — a confirmed
// dead end, no registered schema is `.extend()`ed today) — walk it. Else unwrap
// `.optional()`/`.default()` (`def.innerType`) or an unregistered wrapper's `def.in`. Verified
// against zod 4.3.6 source. Shared by `lookupName` + `lookupCollectionElement` so both resolve to
// the identical core key.
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

/** The element schema(s) a `list`/`cons` was built with, for named-generic printing — a single
 *  schema for `list`, `[car, cdr]` for `cons`, `undefined` for anything else (incl. a
 *  fixed-heads `list([A,B])`, which has no single element and prints structurally). Resolves
 *  through the same core walk `lookupName` uses. */
export function lookupCollectionElement(
  schema: unknown,
): z.ZodTypeAny | readonly [z.ZodTypeAny, z.ZodTypeAny] | undefined {
  const core = resolveCore(schema);
  return core ? COLLECTION_ELEMENT.get(core) : undefined;
}

// ---------------------------------------------------------------------------
// :: value — the untransforming passthrough (defined early: `list` defaults its element to it)
// ---------------------------------------------------------------------------

// `value` stays a PREDICATE, never a union of codecs: a union would make `z.decode(value, x)`
// match a branch and TRANSFORM x (e.g. collapse AExact → bare bigint) — wrong for a slot whose
// entire meaning is "hand back this scheme value untouched" (identity on both faces). The
// predicate covers every concrete `A*` kind via `instanceof AValue` — closing v1's gap where
// symbol/dict/vector/bytevector could not validate at all — plus a JS fn used as a procedure.
function isSchemeValue(x: unknown): x is SchemeValue {
  return x instanceof AValue || typeof x === "function";
}
// Rosetta escape hatch: `value` in a rosetta slot means "no automatic transform — the impl
// receives/returns the raw scheme value and does its own schemeToJs/jsToScheme" (the single
// legitimate rosetta use, env/overridable.ts's dynamic `overridable/resolve`).
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

// dedup on the scheme side (weak key = the ASymbol, collectable with it).
const symbolSchemeToJs = new WeakMap<ASymbol, symbol>();
// STRONG value, WEAK key (the minted jsSymbol) — the inverse of the draft's
// `Map<symbol, WeakRef<ASymbol>>`+FinalizationRegistry, which held the ASymbol WEAKLY and so
// could collect it out from under a live jsSymbol, making `encode` throw nondeterministically
// on a legit round-trip. Here `encode` is TOTAL: the ASymbol lives exactly as long as its
// jsSymbol. Valid only for UNREGISTERED symbols (`Symbol(desc)`, what decode mints) — a
// `Symbol.for(...)` symbol is not a legal WeakMap key, but this codec never mints those.
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

// --- nil / undefinedResult / error: real codecs (a bare instanceof would decode to the raw
//     scheme instance while a sibling union branch decodes to a real JS value, breaking the
//     union-uniformity every rosetta consumer depends on) ---

// `nil` covers ONLY the null-value role; the empty-LIST role is absorbed by `list`'s own
// decode (a proper list terminating in ANil decodes to `[]`, no separate schema needed).
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

// `integer` — v1's real logic: accepts either exact-domain kind, JS image is `number().int()`,
// canonicalizes `encode` to AExact (the integer's home representation).
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
      return exactToJsNumberOrDoor(n); // already rejects rationals + out-of-range
    },
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `integer codec: ${n} is not a safe integer`);
      return new AExact(CONSTANT_CTX, BigInt(n));
    },
  }),
);

export const schemeNumber = named("schemeNumber", z.union([exact, inexact]));

// AInexact listed first so encode canonically produces AInexact (not the safe-integer-
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

export const bytevector = named(
  "bytevector",
  z.codec(z.instanceof(ABytevector), z.instanceof(Uint8Array), {
    decode: (b) => b.__bytevector__ as Uint8Array<ArrayBuffer>,
    encode: (b) => new ABytevector(CONSTANT_CTX, b),
  }),
);

/** Raw predicate for a callable — a callable VALUE (ALambda/ANativeProcedure/
 *  ARosettaProcedure, the post-B2 shape every builtin binds as) or a plain JS function.
 *  [RETAGGED 2026-07-09] B4 (2026-07-09) audited this with THREE independent live bare-fn
 *  producers; reverse-membrane-for-callables.md §3 "Step 1" (named-let → ALambda) and "Step 2"
 *  (curry → prelude + `procedure-min-arity` native) both landed the same day, retiring two of
 *  the three. The one survivor is `env.defineRosetta`'s legacy form / McpEnvCapability's whole
 *  inline-annotation authoring shape (gate: McpEnvCapability annotation-lifting, undone —
 *  a separate migration, not part of this proposal). Narrows to the ACallable union alone only
 *  once that lands too. */
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

// The list container: `APair | ANil` (a proper-list spine or the empty list).
const listContainer = z.custom<AListAlike>((x) => x instanceof APair || x instanceof ANil);

// Walk the pair spine into a raw car array — rejecting cycles and improper (non-ANil-
// terminated) lists. The OUT schema (`z.array`/`z.tuple`) validates the elements/arity.
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
 * A proper list, printed as `List<T>` (see `list([A,B])` for the fixed-heterogeneous form):
 * - `list()` / `list(E)` — homogeneous unbounded list of E (E defaults to `value`).
 * - `list([A, B])` — exactly A then B, nil-terminated (no tail).
 * - `list([A, B], E)` — fixed heads A, B, then zero-or-more E, nil-terminated.
 *
 * NOT the same as `cons`: `list([carE])` is the proper list `(a)` = `(a . ())`, whereas
 * `cons(a, b)` is a dotted pair whose cdr need not be nil-terminated at all.
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
  // Bare / single-arg form: the lone schema is the homogeneous tail, not a head.
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
  // Homogeneous form only carries a single element schema → prints `List<E>`. A fixed-heads
  // `list([A,B])` has NO single element, so it registers nothing here and falls through to the
  // structural tuple print — honest for a heterogeneous fixed-length list.
  if (heads.length === 0) COLLECTION_ELEMENT.set(schema, effectiveTail ?? value);
  return schema as z.ZodCodec<z.ZodCustom<AListAlike, AListAlike>, z.ZodType>;
}

// `cons` stays its OWN function, not subsumed by `list`'s tuple form: exactly one pair, car
// matches carE and cdr matches cdrE DIRECTLY (not "eventually cdrE after more carE elements").
// `cons(char, nil)` accepts a 1-char list only, never 2+ — the second cdr would itself be a
// Pair, not ANil. Prints as `Pair<Car, Cdr>`, a dotted pair, not a 2-tuple.
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
  // Two element schemas → prints `Pair<Car, Cdr>` (a dotted pair), NOT the structural `[A, B]`.
  COLLECTION_ELEMENT.set(schema, [carE, cdrE]);
  return schema;
}

// `pair` is `cons(value, value)`, not a hand-rolled bare instanceof — every OTHER primitive in
// this vocabulary is a real codec; a bare `z.instanceof(APair)` never decodes, so a rosetta
// contract typed `z.pair` would still hand its impl a raw APair (the exact "impl touches
// interpreter internals" failure the whole codec vocabulary exists to prevent). The scheme
// face (z.input) is byte-identical to the old bare form (still z.instanceof(APair)), so every
// current native/sequence consumer (25 sites, all scheme-face, verified) is unaffected; only a
// future rosetta contract's decoded shape changes, from raw APair to a real [car, cdr] tuple.
export const pair = cons(value, value);

// `vector` — representation-blind `AVector | AJSArray` union codec; encode canonically produces
// AVector (the first union branch).
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
 * `dict` — the native k/v map. Keyed shape (`dict({a: integer()})`) drives a per-key codec
 * (TS-precise, feeds the type-lens); bare `dict()` is the open/homogeneous `Record<string,
 * SchemeValue>` case, matching `ADict["arrival/toJS"]()` unmodified.
 */
export function dict<S extends Record<string, z.ZodTypeAny>>(shape: S = {} as S) {
  const keys = Object.keys(shape);
  return named(
    "dict",
    z.codec(
      // dict codecs a UNION, not bare `z.instanceof(ADict)`: a dict-SHAPED AJSObject (a tool
      // result with no prior Scheme lineage) must decode as a dict too — using ADict's own
      // `isDictShaped` helper, the same one `dict?`/print cross-cut on. The `encode` never
      // touches AJSObject's re-boxing path (it builds an ADict directly from encoded pairs),
      // so the provenance bug that path had cannot recur here.
      z.union([z.instanceof(ADict), z.instanceof(AJSObject).refine((o) => isDictShaped(o.source))]),
      keys.length ? z.object(shape) : z.record(z.string(), value),
      {
        // The transform ONLY crosses the container boundary (ADict ↔ raw-scheme record) — the
        // out-schema (`z.object(shape)`/`z.record`) owns per-field marshaling, exactly like
        // `list`/`vector` delegate element marshaling to their `z.array` out-schema. Decoding
        // fields here too would DOUBLE-decode (out-schema re-parses the transform's result).
        // `as never`: the record shape is generic, so zod can't tie it to the out-schema input.
        decode: (d) => {
          const src = d as ADict | AJSObject;
          // Both arms build the shallow BOXED record here (the out-schema owns per-field
          // marshaling) — `arrival/toJS` is no longer usable for this: it egresses an R9
          // lazy proxy with the values already unwrapped to plain JS (egress-proxy.ts),
          // the membrane exit shape, not the inside-the-sandbox record this codec feeds
          // its out-schema.
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
 * A callable crossing the membrane. When `input`/`output` are supplied, each call marshals
 * per-argument (encode inward, decode outward) instead of passing raw values through — near
 * free at the declaration site. Untyped HOF callbacks (`map`/`filter`) omit both and keep the
 * honest untransformed passthrough (nothing to marshal against).
 *
 * The return-direction ban stays: a rosetta result is never a bare JS function (provenance
 * would be untraceable) — `encode` is only legitimate for an argument marshalled inward.
 *
 * `decode` is the TYPED half of the reverse-membrane crossing (docs/working-proposals/
 * reverse-membrane-for-callables.md §7c row 7: "z.procedure decode adopts the same scope
 * token — one discipline, typed and untyped paths"): it reads the SAME ambient region scope
 * `rosetta.ts`'s `schemeToJs` reads (`currentRegionScope()`), falling back to the shared
 * `DETACHED_SCOPE` when decoded with no crossing live (a unit test calling `.parse(...)`
 * directly) — the pre-region-discipline behavior, unchanged.
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
          // The wrapper CLOSES OVER `scope` (minted here, at decode time) — it never
          // re-reads the ambient holder, so a call arriving after the exporting symbol
          // invocation returned still sees the (by then closed) scope it was minted
          // against. `withRegionCall` owns the escape/pending/abort bookkeeping (§7c
          // rules 1/3/4); this closure owns only the marshaling.
          const wrapper = (...jsArgs: unknown[]) =>
            withRegionCall(scope, async () => {
              const schemeArgs = input ? jsArgs.map((a) => z.encode(input, a as never)) : jsArgs;
              // Re-entry nests under the exporting invocation via the SAME ambient
              // mechanism the untyped path uses — never through the callable's `this`
              // (§9's ruling). `scope.runCtx` also carries the call itself (strict mode,
              // abort signal) even though the per-field zod codecs above stay CONSTANT_CTX
              // by design (unrelated to region discipline — see scheme-zod.ts's own
              // primitive encoders, e.g. `bytevector`'s `encode`).
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

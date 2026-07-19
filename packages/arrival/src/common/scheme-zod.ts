import * as z from "zod";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";

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
import { AValue, ctxOf } from "../values/primitives/AValue.js";
import { ADict, isDictShaped, type DictKey } from "../values/primitives/ADict.js";
import { AJSObject } from "../values/primitives/AJSObject.js";
import { AJSArray } from "../values/primitives/AJSArray.js";
import { markSpineAdopting } from "./spine-adoption.js";
import { Values } from "../values/primitives/Values.js";
import { ArrivalError, CodecFidelityError, R7RSError } from "../errors.js";
import { chargeHeap, heapBudgetMessage } from "../heap-budget.js";
import {
  ALambda,
  ANativeProcedure,
  ARosettaProcedure,
  DoorProcedure,
  applyCallback,
} from "../values/primitives/ACallable.js";
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
  strictObject,
  literal,
  codec,
  config,
  toJSONSchema,
  fromJSONSchema,
} from "zod";
export type { input, output, infer, ZodType, ZodTypeAny, ZodCustom, ZodRawShape } from "zod";

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
// :: Marshal ctx — what a codec mints under when no boxed operand exists
// ---------------------------------------------------------------------------
//
// A scalar codec's `encode` receives a bare JS primitive (a `number`, a `string`,
// a `Uint8Array`, …) — there is no `AValue` operand to `ctxOf()` for the live run
// (CONSTANT_CTX-audit §2.2's "THREADING GAP" verdict on every scalar codec below).
// Minting under CONSTANT_CTX drops the crossing off the run's heap
// meter/cache/effects/reads/signal silently — everything built FROM that value
// (`ctxOf`, `internTableFor`, `chargeHeap`) inherits the wrong run.
//
// The channel, in priority order:
//
//   1. `_marshalRunCtx` — an ambient THIS FILE installs and reads (below). Its one
//      caller today is `procedure()`'s own encode/decode arms, which — unlike every
//      OTHER codec here — genuinely hold a live RunContext directly (the `impl`'s
//      own `runCtx` parameter, ACallable.ts's `CallableImpl` contract; or the
//      closed-over `scope.runCtx`), not a re-read of ambient state. Installing it
//      for the synchronous window of a nested z.decode/z.encode call is strictly
//      more honest than letting those nested codecs guess from (2) — this ctx is
//      the actual invocation's, not whatever happens to be ambient right now.
//   2. `currentRegionScope()?.runCtx` (values/primitives/region-scope.ts) — the
//      SAME ambient `z.procedure`'s reverse-crossing decode reads for its wrapper
//      identity cache. Populated for exactly the crossings `common/symbols/
//      rosetta.ts`'s `carriesCallable` gate opens a scope for (a contract whose
//      input can hand the impl a live callable) — every OTHER rosetta call reaches
//      this file with no scope live. Widening that gate is `rosetta.ts`'s call,
//      outside this cluster's file territory (it sits above this module in the
//      call graph); reading it here is a strict improvement over unconditional
//      CONSTANT_CTX at zero cost when no scope is open.
//   3. CONSTANT_CTX — no live invocation reachable by any channel above (e.g. a
//      unit test calling `.parse()`/`.encode()` directly with nothing installed).
let _marshalRunCtx: RunContext | undefined;

/** Install `ctx` as the ambient marshal ctx for the duration of a SYNCHRONOUS
 *  `fn` — save/restore, the same idiom `region-scope.ts`'s `withRegionScope` uses
 *  (single-threaded JS + save/restore makes a module holder safe; nesting works by
 *  construction, an inner install restoring the outer's ctx on the way out). */
function withMarshalCtx<T>(ctx: RunContext, fn: () => T): T {
  const saved = _marshalRunCtx;
  _marshalRunCtx = ctx;
  try {
    return fn();
  } finally {
    _marshalRunCtx = saved;
  }
}

function marshalCtx(): RunContext {
  return _marshalRunCtx ?? currentRegionScope()?.runCtx ?? CONSTANT_CTX;
}

/** The ctx a freshly-minted CONTAINER (list/vector/dict) inherits: the first
 *  already-boxed element's own run ctx. By the time a container's own `encode`
 *  runs, every element has already been through the ELEMENT schema's own codec
 *  (see the `dict` codec's comment below for why the container transform never
 *  re-decodes a field) — so a `value`-element container holds real AValues minted
 *  elsewhere in the live run, and a codec-element container (e.g. `list(integer)`)
 *  holds values THIS FILE just minted via {@link marshalCtx}. Either way, the
 *  first element's ctx is the container's own live run. Falls to
 *  {@link marshalCtx} only when there is no element to inherit from (an empty
 *  container). */
function firstCtx(elements: readonly SchemeValue[]): RunContext {
  for (const e of elements) {
    const c = ctxOf(e);
    if (c !== CONSTANT_CTX) return c;
  }
  return marshalCtx();
}

// ---------------------------------------------------------------------------
// :: Scalar primitives
// ---------------------------------------------------------------------------

export const boolean = named(
  "boolean",
  z.codec(z.instanceof(ABool), z.boolean(), {
    decode: (b) => b.value,
    encode: (b) => new ABool(marshalCtx(), b),
  }),
);

export const booleanTrue = boolean.refine((v): v is true => v === true);
export const booleanFalse = boolean.refine((v): v is false => v === false);

export const char = named(
  "char",
  z.codec(z.instanceof(ACharacter), z.string().length(1), {
    decode: (c) => c.valueOf(),
    encode: (c) => new ACharacter(marshalCtx(), c),
  }),
);

export const string = named(
  "string",
  z.codec(z.instanceof(AString), z.string(), {
    decode: (s) => s.valueOf(),
    encode: (s) => new AString(marshalCtx(), s),
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
    encode: () => new ANil(marshalCtx()),
  }),
);

/** Table calls this `void`, but that's a reserved word — exported as `undefinedResult`. */
export const undefinedResult = named(
  "undefinedResult",
  z.codec(z.instanceof(AVoid), z.undefined(), {
    decode: () => undefined,
    encode: () => new AVoid(marshalCtx()),
  }),
);

/** A `(values a b …)` multiple-values carrier (≥2 values — `Values.from` unwraps 0/1).
 *  A PLAIN predicate schema like `value` itself, not a codec: multi-values are a
 *  scheme-plane construct that never crosses the membrane as a JS shape. Needed
 *  because `Values` is a non-AValue orphan (types.ts's own words) that `value`'s
 *  `instanceof AValue` predicate rejects at runtime despite `SchemeValue` declaring
 *  it — the same orphan gap `error` (below) closes for `R7RSError` (exceptions.ts's
 *  header): a dedicated named schema, never a silent widening of `value`'s predicate. */
export const values = named(
  "values",
  z.custom<Values>((x) => x instanceof Values),
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

// `exact`'s JS face is now plain `number` (§2.3 — `z.bigint` retired): every AExact
// field is safe-int `number` by construction (arrival-one-number-rework.md §0.2), so
// there is no longer a magnitude class that needs `bigint` to carry faithfully. A raw
// host `bigint` is a SEPARATE opaque pass-through value post-rework (never a scheme
// number) — this codec's `encode` no longer auto-adopts one; a caller holding a host
// bigint should convert explicitly (the "host-API break, said loudly" of §2.3).
export const exact = named(
  "exact",
  z.codec(z.instanceof(AExact), z.number(), {
    decode: (n) => {
      // MODEL-REACHABLE door (a program's own exact rational reaching a native's arg
      // decode) — plain throw, never `invariant`: the "Invariant failed: " prefix
      // reads like an engine bug rather than a program mistake. Same rule at every
      // decode site below; the encode sites (host JS → scheme boxing) stay
      // `invariant` — a bad host value IS an internal contract breach.
      if (n.denom !== 1) throw new CodecFidelityError("exact", `exact rational ${n.toString()} has no integer form`);
      return n.num;
    },
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `exact codec: ${n} is not a safe integer`);
      return new AExact(marshalCtx(), n);
    },
  }),
);

// `rational` folded into `inexact`: this codec is the superset (accepted bigint|number on
// encode pre-rework; now plain `number` — AInexact's `.real` was always a bare `number`,
// never bigint, so retiring the bigint arm here is a pure simplification, not a behavior
// change for the AInexact side).
export const inexact = named(
  "inexact",
  z.codec(z.instanceof(AInexact), z.number(), {
    decode: (n) => n.real,
    encode: (n) => new AInexact(marshalCtx(), n),
  }),
);

function exactToJsNumberOrDoor(n: AExact): number {
  // Door, not invariant — model-reachable (see the `exact` decode note above).
  if (n.denom !== 1) {
    throw new CodecFidelityError(
      "number",
      `exact rational ${n.toString()} cannot be a faithful JS number — use the integer codec, or looseNumber to accept the projected (divided) value`,
    );
  }
  // No safe-range check needed: every AExact.num is ALREADY safe-int by construction
  // (§0.2's invariant, enforced at every mint site) — a value that violates it can't
  // exist as a live AExact to begin with.
  return n.num;
}

// `integer` — accepts either exact-domain kind, JS image is `number().int()`, canonicalizes
// `encode` to AExact (integer's home representation).
export const integer = named(
  "integer",
  z.codec(z.union([z.instanceof(AExact), z.instanceof(AInexact)]), z.number().int(), {
    decode: (n) => {
      if (n instanceof AInexact) {
        // Door, not invariant — model-reachable (see the `exact` decode note above).
        if (!Number.isSafeInteger(n.real)) {
          throw new CodecFidelityError("integer", `inexact ${n.toString()} is not a safe integer`);
        }
        return n.real;
      }
      return exactToJsNumberOrDoor(n); // rejects rationals + out-of-range
    },
    encode: (n) => {
      TypeError.invariant(Number.isSafeInteger(n), `integer codec: ${n} is not a safe integer`);
      return new AExact(marshalCtx(), n);
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
      encode: (n) => new AInexact(marshalCtx(), n),
    }),
    z.codec(z.instanceof(AExact), z.number(), {
      decode: (n) => exactToJsNumberOrDoor(n),
      encode: (n) => {
        TypeError.invariant(Number.isSafeInteger(n), `number codec: ${n} is not a safe integer`);
        return new AExact(marshalCtx(), n);
      },
    }),
  ]),
);

// `bigint` — legacy numeric cast, superseded by `schemeNumber`/`integer`. Kept,
// mechanically ported to the new AExact shape (`number`-backed `num`/`denom`), so
// consumers that still declare it keep a real, compiling export to flip away from
// at their own pace rather than hitting a missing-export break. New code should
// reach for `integer` (safe-int `number`, doors on a non-integer/out-of-range
// operand) instead.
export const bigint = named(
  "bigint",
  z.union([
    z.codec(z.instanceof(AExact), z.bigint(), {
      decode: (n) => {
        // Door, not invariant — model-reachable (see the `exact` decode note above).
        if (n.denom !== 1) {
          throw new CodecFidelityError("bigint", `exact rational ${n.toString()} has no integer bigint form`);
        }
        return BigInt(n.num);
      },
      encode: (n) => {
        const num = Number(n);
        TypeError.invariant(
          Number.isSafeInteger(num),
          `bigint codec: ${n} exceeds safe-integer range — exact numbers are safe-integer-only post-rework`,
        );
        return new AExact(marshalCtx(), num);
      },
    }),
    z.codec(z.instanceof(AInexact), z.bigint(), {
      decode: (n) => {
        // Door, not invariant — model-reachable (see the `exact` decode note above).
        if (!Number.isInteger(n.real)) {
          throw new CodecFidelityError("bigint", `inexact ${n.toString()} has a fractional part`);
        }
        return BigInt(n.real);
      },
      encode: (n) => new AInexact(marshalCtx(), Number(n)),
    }),
  ]),
);

// --- loose JS-number-land conversions (permissive — arithmetic/math-builtin domain) ---
//
// `number`/`bigint` above are the STRICT rosetta-boundary casts: they DOOR on precision loss
// (non-integer exact rational, out-of-safe-range integer) and reject IEEE non-finite values
// (`z.number()` excludes NaN/±Infinity — confirmed zod 4.3.6). Correct for a value crossing
// the membrane to a JS caller who didn't ask for silent precision loss.
//
// WRONG for `env/r7rs/numeric.ts`'s internal math builtins (`round`/`floor`/`ceiling`/
// `truncate`/`sqrt`/`sin`/…/`abs`/`zero?`/`positive?`/`negative?`), which need to (a) accept
// `+nan.0`/`+inf.0`/`-inf.0` — ordinary R7RS inexact reals, tested directly by the R7RS
// conformance corpus — and (b) LOSSILY convert a non-integer exact rational to a JS float
// (`(round 7/2)` — input IS a non-integer rational; that's the point), never door on it.
//
// These two codecs are the missing PERMISSIVE half of the numeric vocabulary.

/** Any scheme number ↔ JS `number`, LOSSY (non-integer exact rational divides — no
 *  invariant, no door; out-of-safe-range exact integers can no longer exist at all,
 *  §0.2) and permissive of non-finite values (`+nan.0`/`+inf.0`/`-inf.0` pass through
 *  AInexact's `.real` unchanged). Encode canonicalizes safe-integer JS number to
 *  AExact, else AInexact — same rule `number`'s AExact branch uses, without
 *  `number`'s finite-only guard. */
export const looseNumber = named(
  "looseNumber",
  z.codec(
    z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
    z.custom<number>((v) => typeof v === "number"),
    {
      decode: (n) => (n instanceof AExact ? n.num / n.denom : n.real),
      encode: (n) => (Number.isSafeInteger(n) ? new AExact(marshalCtx(), n) : new AInexact(marshalCtx(), n)),
    },
  ),
);

/** Any scheme number ↔ JS `number | bigint`. Pre-rework this distinguished an
 *  out-of-safe-range exact integer (→ `bigint`, preserving magnitude) from everything
 *  else (→ `looseNumber`'s lossy float); post-rework NO live AExact can be
 *  out-of-safe-range (§0.2's construction invariant), so the `bigint` decode arm below
 *  is unreachable dead code kept only so this codec's declared JS-face union stays a
 *  strict superset of `looseNumber`'s for callers still keyed on the wider type
 *  (type-layer/schema-to-ts.ts's `IMAGE_BY_NAME` table — outside this sweep's file
 *  scope). No live caller in `env/r7rs/numeric.ts` uses this codec anymore (every op
 *  that used to needed it went box-native instead, per the encode-edge law, §2.2). */
export const looseAnyNumber = named(
  "looseAnyNumber",
  z.codec(
    z.union([z.instanceof(AExact), z.instanceof(AInexact)]),
    z.union([z.custom<number>((v) => typeof v === "number"), z.bigint()]),
    {
      decode: (n) => (n instanceof AExact ? n.num / n.denom : n.real),
      encode: (v) => {
        if (typeof v === "bigint") {
          const num = Number(v);
          TypeError.invariant(Number.isSafeInteger(num), `looseAnyNumber: ${v} exceeds safe-integer range`);
          return new AExact(marshalCtx(), num);
        }
        return Number.isSafeInteger(v) ? new AExact(marshalCtx(), v) : new AInexact(marshalCtx(), v);
      },
    },
  ),
);

export const bytevector = named(
  "bytevector",
  z.codec(z.instanceof(ABytevector), z.instanceof(Uint8Array), {
    decode: (b) => b.__bytevector__ as Uint8Array<ArrayBuffer>,
    encode: (b) => new ABytevector(marshalCtx(), b),
  }),
);

/** Raw predicate for a callable — callable VALUE (`ALambda`/`ANativeProcedure`/
 *  `ARosettaProcedure`/`DoorProcedure`, the four members every builtin binds as) or a
 *  plain JS function. The bare-JS-function arm is a narrow survivor: `env.defineRosetta`'s
 *  legacy form / McpEnvCapability's inline-annotation authoring shape — everything else
 *  routes through the four callable kinds. `DoorProcedure` is a first-class callable value
 *  (`common/capability.ts`'s door bind arm), not a bare closure; passing one where a
 *  `z.lambda` is expected still type-checks and still throws its teaching `PurityError`
 *  the moment it's actually invoked. */
export const lambda = named(
  "lambda",
  z.custom<(...args: unknown[]) => unknown>(
    (v) =>
      typeof v === "function" ||
      v instanceof ALambda ||
      v instanceof ANativeProcedure ||
      v instanceof ARosettaProcedure ||
      v instanceof DoorProcedure,
  ),
);

// ---------------------------------------------------------------------------
// :: Collections — head-tuple + optional tail (mirrors _bake.ts's Contract.input/inputRest)
// ---------------------------------------------------------------------------

// The list container: `APair | ANil` (proper-list spine or empty list).
const listContainer = z.custom<AListAlike>((x) => x instanceof APair || x instanceof ANil);

// Walk pair spine into raw car array — rejecting cycles and improper (non-ANil-terminated)
// lists. OUT schema (`z.array`/`z.tuple`) validates elements/arity.
//
// HEAP-METERED (CONSTANT_CTX-audit §2.2 "worst by blast radius" #2): this is the SAME
// unbounded synchronous walk `env/pack-helpers.ts`'s `to_array` charges for — a
// `list(...)`-typed rosetta/procedure input arg is a second, independent path to
// materialize an arbitrary-length scheme list into one JS array, and before this charge
// it was invisible to every sandboxed run's heap budget. Charges off the OPERAND's own
// ctx (`ctxOf(l)`, never CONSTANT_CTX) — a run-built list carries the run's RunContext;
// a quoted literal carries CONSTANT_CTX (no meter, parse-bounded anyway), matching
// `to_array`'s own rule exactly. This walk and a later `list(...)` ENCODE of a fresh
// array are independent allocations on independent objects — charging both is not a
// double-charge of one value.
function spineToArray(l: AListAlike): unknown[] {
  const meter = ctxOf(l).heapMeter;
  const out: unknown[] = [];
  let node: unknown = l;
  while (node instanceof APair) {
    if (node.have_cycles("cdr")) throw new CodecFidelityError("list", "cannot decode a circular list");
    out.push(node.car);
    if (meter !== undefined && ++meter.used > meter.max) {
      throw new ArrivalError(heapBudgetMessage(meter.max), []);
    }
    node = node.cdr;
  }
  if (!(node instanceof ANil)) throw new CodecFidelityError("list", "cannot decode an improper list");
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
      // MINT-time charge (CONSTANT_CTX-audit §2.2 #2): the spine `APair.fromArray`
      // builds is a fresh, independent allocation from the walk `spineToArray` above
      // charges — charging both is not a double-charge of one value. `firstCtx`
      // inherits the run off the array's own already-boxed elements (post-element-
      // codec — see the function's own doc); empty array has nothing to charge.
      encode: (arr) => {
        const ctx = firstCtx(arr as SchemeValue[]);
        chargeHeap(ctx, arr.length);
        return APair.fromArray(ctx, arr as SchemeValue[], false) as AListAlike;
      },
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
      // Fixed 2-arity — not a spine of arbitrary length, so no heap charge (unlike
      // `list`/`vector`/`dict`'s unbounded containers); still inherits the live run
      // off whichever of car/cdr is already boxed (`firstCtx`), never a bare CONSTANT_CTX.
      encode: ([c, d]) => {
        const carValue = c as SchemeValue;
        const cdrValue = d as SchemeValue;
        return new APair(firstCtx([carValue, cdrValue]), carValue, cdrValue);
      },
    }),
  );
  // Two element schemas → prints `Pair<Car, Cdr>` (dotted pair), NOT structural `[A, B]`.
  COLLECTION_ELEMENT.set(schema, [carE, cdrE]);
  return schema;
}

// `pair` is `cons(value, value)`, not hand-rolled bare instanceof — every OTHER primitive in
// this vocabulary is a real codec; a bare `z.instanceof(APair)` never decodes, so a rosetta
// contract typed `z.pair` would still hand its impl a raw APair (the exact "impl touches
// interpreter internals" failure the whole codec vocabulary exists to prevent). The scheme
// face (z.input) stays `z.instanceof(APair)`, so a scheme-face consumer is unaffected; only a
// rosetta contract's decoded shape changes, from raw APair to a real [car, cdr] tuple.
// Spine-adopting, for the same reason `listAlike` is: a slot declared `z.pair` means "a NON-EMPTY
// spine", and a borrowed JS array read as a spine is one. Adoption runs BEFORE validation
// (define-bake.ts), so the gate judges the projected view — a non-empty array passes, and an empty
// one adopts to `nil` and is correctly rejected. Without the mark, `(last (some-tool …))` died on a
// ZodError against a list it could have walked.
export const pair = markSpineAdopting(cons(value, value));

/**
 * `listAlike` — the LIST IDENTITY of an argument: "I read this as a SPINE."
 *
 * The exact twin of `vector` below. `vector` is the representation-blind *indexed* reading
 * (`AVector | AJSArray`); this is the representation-blind *spine* reading. One backing value, two
 * charts, and the CONTRACT is what picks which one the body sees — that is the whole design (see
 * `values/primitives/AJSArrayList.ts`).
 *
 * Marked spine-adopting, so the bake layer projects a matching argument onto its list chart before
 * the impl runs: a borrowed `AJSArray` becomes an `AJSArrayList` view over the SAME array with the
 * SAME provenance (O(1), no copy), and an EMPTY array becomes `nil` — which is the only thing that
 * can make `(null? xs)` honest, since `null?` is `instanceof ANil` and not a term.
 *
 * USE IT ON INPUTS ONLY. An output slot that produces a fresh list is a genuine `APair` and should
 * keep declaring `z.union([z.pair, z.nil])` — widening an output to `listAlike` would claim the verb
 * might return a borrowed view when it never does.
 *
 * The predecessor of this schema was `z.union([z.pair, z.nil])`, spelled out ~14 times across
 * lists/strings/vectors/srfi. `symbol.native` contracts are type-only (never validated at runtime),
 * so a tool-returned array sailed straight past those unenforced unions into impls that field-read
 * `.car`/`.cdr` — and `member` answered `#f` about lists that contained the element, `list->vector`
 * answered `[]`, `find` threw on void. That the old union's own comment already called it "SHALLOW
 * pair-or-nil (listAlike)" is the tell: the two had been the same idea in prose long before they
 * diverged in the code.
 */
/**
 * The type face is deliberately ASYMMETRIC, and it is the adoption guarantee written down:
 *
 *   • the RUNTIME predicate ADMITS a borrowed array (`AJSArray`) — it must, or the gate rejects
 *     every tool result before adoption can ever run;
 *   • the TYPESCRIPT type is `AListAlike` (`APair | ANil`) — NARROW — because by the time any impl
 *     or scheme body sees the argument, adoption has already projected it onto its spine chart. An
 *     impl typed `AListAlike` is therefore telling the truth, not being cast into it.
 *
 * That asymmetry is exactly what a `z.union([pair, nil, AJSArray])` could NOT express: the union's
 * `z.input` would be the wide type, and every list impl in the tree would have to widen its
 * signature to a case it can never actually receive — importing the borrowed-array case into ~14
 * impls that adoption exists to keep it out of. The `z.custom` says the honest thing once, here.
 *
 * SCHEME FACE ONLY — no codec, so do not put this on a `symbol.rosetta` contract (which decodes to
 * JS). Its consumers are `symbol.native` (no decode) and `symbol.define` (decode discarded).
 */
export const listAlike = markSpineAdopting(
  named(
    "listAlike",
    z.custom<AListAlike>((v) => v instanceof APair || v instanceof ANil || v instanceof AJSArray),
  ),
);

// `vector` — representation-blind `AVector | AJSArray` union codec; encode canonically
// produces AVector (first union branch).
export function vector<E extends z.ZodTypeAny = typeof value>(element: E = value as unknown as E) {
  return named(
    "vector",
    z.union([
      z.codec(z.instanceof(AVector), z.array(element), {
        decode: (v) => v.__vector__ as z.input<E>[],
        // MINT-time charge — same rule as `list`'s encode above (§2.2 #2): a
        // fresh AVector spine is an independent allocation, charged off the
        // array's own already-boxed elements via `firstCtx`.
        encode: (arr) => {
          const ctx = firstCtx(arr as SchemeValue[]);
          chargeHeap(ctx, arr.length);
          return new AVector(ctx, arr as SchemeValue[]);
        },
      }),
      // The borrowed arm is DECODE-ONLY, and its `encode` is a door rather than a mint.
      //
      // A borrowed array is minted by the MEMBRANE, from a real JS array that already lives in the
      // JS world (rosetta's inbound `array → borrowed AJSArray` claim). Encoding one FROM scheme
      // values is the crossing backwards: it would push boxed AValues into a store whose contract
      // (V's hygiene law — see AJSArray's `boxElement`) is JS-world values ONLY, and the flip would
      // go unobserved. `firstCtx(arr)` in the old body is the tell — it was reading a RunContext off
      // the very scheme values it was about to bury in a JS store.
      //
      // Unreachable in practice (a union encodes through its FIRST matching arm, which is the
      // AVector codec above — the canonical encode target, as its comment says), so this was a
      // loaded gun rather than a live bug. It stays a door so it cannot be re-aimed.
      z.codec(z.instanceof(AJSArray), z.array(element), {
        // Decodes to the BOXED elements (`__vector__`), NOT the raw `.source` — so both arms of this
        // union present the SAME scheme face, which is the only way it is actually
        // representation-blind rather than merely claiming to be.
        //
        // The raw-`source` form was a live bug, and a loud one: the element schema is a SCHEME-face
        // codec (`z.value` demands an AValue; `z.number` demands an AExact), so raw JSON elements
        // failed validation every single time. Every `symbol.define` verb contracted on `z.vector`
        // — SRFI-43's `vector-fold` / `vector-fold-right` / `vector-count` / `vector-index` /
        // `vector-any` / `vector-binary-search` — therefore threw a raw ZodError on ANY tool-returned
        // JSON array, while working fine on a `#(1 2 3)` literal. (`symbol.define` decodes for its
        // throw side-effect; `symbol.native` never validates, which is why the vector NATIVES —
        // vector-ref/vector-length/vector-map — kept working and hid the split.)
        //
        // It stayed green because the law fixture put boxed AStrings in a borrowed `source` — a value
        // production cannot construct (V's hygiene law). The illegal fixture was masking the bug: the
        // ONE arrangement under which this decode succeeds is the one arrangement that cannot exist.
        //
        // Cost, named: this materializes the borrowed array (`vec()`, cached) at decode. That is the
        // declared crossing, and only `symbol.define`'s validation walks it — a native still never
        // boxes. Any verb that decodes a vector is about to fold over every element anyway.
        decode: (v) => v.__vector__ as z.input<E>[],
        encode: () => {
          throw new CodecFidelityError(
            "vector",
            "cannot ENCODE a borrowed AJSArray — a borrowed array is minted by the MEMBRANE from a JS-world " +
              "array (with the crossing's ctx + provenance), never assembled from scheme values. A codec's " +
              "`encode` has neither, which is exactly why this direction cannot carry lineage. Encode produces " +
              "an AVector (the canonical first arm of this union).",
          );
        },
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
          // HEAP-METERED (CONSTANT_CTX-audit §2.2 #2, same rationale as `spineToArray`
          // above): walking every key of an open-key dict is the same unbounded
          // synchronous materialization `to_array` charges for lists — charge off the
          // SOURCE dict's own ctx (never CONSTANT_CTX) before building the record.
          chargeHeap(ctxOf(src), names.length);
          return Object.fromEntries(names.map((k) => [k, src.get(k)])) as never;
        },
        encode: (rec: Record<string, unknown>) => {
          const entries = Object.entries(rec);
          // MINT-time charge — same rule as `list`/`vector`'s encode above (§2.2 #2):
          // a fresh ADict is an independent allocation, charged off the record's own
          // already-boxed VALUES via `firstCtx` (a keyed-shape dict's per-field codecs
          // already ran, so a value here is an AValue unless the record is empty).
          // The ctx also mints every key's ASymbol (the "dict-key ASymbol" gap the
          // audit calls out by name) — a key must ride the SAME run as its value.
          const ctx = firstCtx(entries.map(([, v]) => v as SchemeValue));
          chargeHeap(ctx, entries.length);
          return new ADict(
            ctx,
            entries.map(([k, v]) => [new ASymbol(ctx, k), v as SchemeValue] as [DictKey, SchemeValue]),
          );
        },
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
    encode: (o) => new AJSObject(marshalCtx(), o),
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
 * `decode` is the TYPED half of reverse-membrane crossing — one discipline shared with the
 * untyped path: it reads the SAME ambient region scope `rosetta.ts`'s `schemeToJs` reads
 * (`currentRegionScope()`), falling back to the shared `DETACHED_SCOPE` when decoded with no
 * crossing live (e.g. a unit test calling `.parse(...)` directly).
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
          // `"typed"` = this factory family's slot in the two-level wrapper cache (see
          // RegionScope.cache's doc): rosetta's untyped `callableToHostFn` keys by
          // EgressMode; the pre-split single-keyed idiom let whichever family crossed
          // a callable FIRST serve its wrapper to the other (typed marshalling lost,
          // or gained where not asked for).
          let byKey = scope.cache.get(callable);
          if (byKey === undefined) {
            byKey = new Map();
            scope.cache.set(callable, byKey);
          }
          const cached = byKey.get("typed");
          if (cached) return cached;
          // Wrapper CLOSES OVER `scope` (minted here, at decode time) — never re-reads
          // ambient holder, so a call arriving after the exporting symbol invocation returned
          // still sees the (by then closed) scope it was minted against. `withRegionCall`
          // owns escape/pending/abort bookkeeping; this closure owns only marshaling.
          const wrapper = (...jsArgs: unknown[]) =>
            withRegionCall(scope, async () => {
              // `withMarshalCtx(scope.runCtx, …)` — NOT a bare `marshalCtx()` read: this
              // wrapper CLOSES OVER `scope` at decode time but may be INVOKED much later,
              // when `currentRegionScope()` is whatever's ambient at THAT call (possibly
              // unrelated, possibly `undefined`) — `scope.runCtx` is the one ctx this
              // invocation is actually chartered under, so every per-arg scalar/container
              // codec `input`'s marshaling reaches for (via `marshalCtx()`) must see IT,
              // not an incidental ambient guess.
              const schemeArgs = input
                ? withMarshalCtx(scope.runCtx, () => jsArgs.map((a) => z.encode(input, a as never)))
                : jsArgs;
              // Re-entry nests under exporting invocation via SAME ambient mechanism the
              // untyped path uses — never through callable's `this`.
              const r = await withDynamicCallSite(scope.dynSite, () =>
                applyCallback(callable, schemeArgs as SchemeValue[], scope.runCtx),
              );
              return output ? withMarshalCtx(scope.runCtx, () => z.decode(output, r as never)) : r;
            });
          byKey.set("typed", wrapper);
          return wrapper;
        },
        encode: (jsFn) =>
          new ANativeProcedure({
            name: "<host-procedure>",
            arity: { min: input ? 1 : 0, max: null },
            contract: undefined,
            // `runCtx` is THIS invocation's live context — `ACallable.ts`'s `CallableImpl`
            // contract hands it as `impl`'s own second parameter (`this.#impl(args,
            // runCtx)`), the most direct channel anywhere in this file: no ambient guess
            // needed. Installed as the marshal ctx for the synchronous decode/encode
            // calls below, so every per-arg/per-result scalar+container codec
            // (`marshalCtx()`) mints under THIS run.
            impl: async (schemeArgs, runCtx) => {
              const jsArgs = withMarshalCtx(runCtx, () =>
                input ? schemeArgs.map((a) => z.decode(input, a as never)) : schemeArgs,
              );
              const r = await jsFn(...jsArgs);
              return withMarshalCtx(runCtx, () => (output ? z.encode(output, r as never) : r)) as SchemeValue;
            },
          }),
      },
    ),
  );
}

/**
 * Membrane — typed boundary crossing for Scheme ↔ JS interop.
 *
 * - fromJS/toJS: general JS↔Scheme value crossing. Thin wrappers (cljs-bean style)
 *   for objects/functions; WeakMap identity cache (Miller/Van Cutsem); primitives
 *   pass through unwrapped.
 * - Member access (`@`/`@?`/`@keys`, `:key`) lives on the values themselves
 *   (`arrival/tagless-final/get|has|keys`) — env/polyglot verbs dispatch directly;
 *   the membrane has no member-read face.
 *
 * Lineage: object-capability membranes (Miller 2006; Van Cutsem & Miller 2013).
 * Member-read protocol mirrors GraalVM Truffle InteropLibrary — see interop-access.ts.
 * Full map: `docs/membrane.md`.
 *
 * VALUE-IMPORTS `env/AmbientRuntime.ts` (hermeticity audit D4, `docs/strata.md` §2's
 * `membrane → env` edge): `AmbientRuntime`/`isAmbientRuntime` join `BoxedSchemeValue`
 * and `isSchemeValue`'s recognition switch because an env is a CONTROL form the
 * membrane must recognize as "already scheme, don't re-wrap" (a host function can bind
 * INTO an env, so the env itself crosses this boundary) — see `BoxedSchemeValue`'s own
 * doc comment below for the full closed-union rationale.
 */

import { CONSTANT_CTX } from "../run/RunContext.js";
import { DefaultedWeakMap } from "@here.build/collections";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { ABool } from "../values/primitives/ABool.js";
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AVector } from "../values/primitives/AVector.js";
import { AmbientRuntime, isAmbientRuntime } from "../env/AmbientRuntime.js";
import { LambdaContext } from "../eval/LambdaContext.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Macro } from "../eval/Macro.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { APair } from "../values/primitives/APair.js";
import { jsToScheme } from "./rosetta.js";
import { RedundantCrossingError, NoLensError } from "../errors.js";
import { isMarkedInteropPrivate } from "./interop-access.js";
import { AOpaqueHandle } from "../values/primitives/AOpaqueHandle.js";
import { Syntax } from "../eval/Syntax.js";
import { type ACallable } from "../values/primitives/ACallable.js";
import { ANil } from "../values/primitives/ANil.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
// AJSArray/AJSObject import jsToScheme from rosetta — benign runtime cycle
// (jsToScheme is a hoisted export function; see AJSArray/AJSObject headers).
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";
import { ADict } from "../values/primitives/ADict.js";
import { ACharacter } from "../values/primitives/ACharacter.js";

// Wrapper unwrap protocol key: `"arrival/toJS"` — global convention written as a
// literal at each use site (like arrival/tagless-final/* / arrival/print).

/**
 * Closed union of "already scheme, don't re-wrap": every wrapper class, native scheme
 * type, special-form head (Macro/Syntax/AKernelKeyword), env, promise, and bare
 * Function (env may still bind a host function into value space). SUPERSET of
 * value-intent SchemeValue — the JS→Scheme boundary admits CONTROL forms that are
 * never values (Macro/Syntax/LambdaContext/AmbientRuntime, bare Function). That is
 * why BoxedSchemeValue isn't assignable to SchemeValue, and why the membrane keeps
 * its own boundary type. Scheme lambdas are real ALambda, caught by instanceof AValue.
 */
export type BoxedSchemeValue =
  | ANil
  | AJSObject
  | AJSArray
  | ADict
  | APair<any, any>
  | ASymbol
  | AString
  | ABytevector
  | AVector
  | ACharacter
  | AExact
  | AInexact
  | ABool
  | AOpaqueHandle
  | Macro
  | Syntax
  | LambdaContext
  | AmbientRuntime
  | AKernelKeyword
  | ACallable
  | Function;

/**
 * Honest return of `fromJS` — NAMED, bounded superset of SchemeValue: the boundary
 * returns more than value-intent because some crossings stay as materialization rather
 * than boxing:
 *   • BoxedSchemeValue — already-scheme input passes through un-rewrapped
 *   • Uint8Array/ArrayBuffer/DataView — raw FFI binary stays raw (identity-
 *     preserving; membrane.spec pins "preserves Uint8Array identity")
 *   • Promise<unknown> — stays raw for the evaluator trampoline to await
 * Host bigint is NOT in this union: it DOORS (NoLensError `"bigint"`) — convert
 * with Number/bigintToNumber in safe range before re-crossing. Codecs that speak
 * bigint (`z.bigint`) encode to AExact BEFORE the membrane.
 * These carriers stay out of SchemeValue (values/types.ts) — this type is the seam.
 */
type FromJSResult = BoxedSchemeValue | Uint8Array | ArrayBuffer | DataView | Promise<unknown>;

/**
 * Already a Scheme value? Prevents double-wrapping.
 * `instanceof ANil`, not `=== nil`: nil.withProvenance mints fresh Nil clones, so
 * reference-equality would miss provenance-bearing list terminators.
 */
export function isSchemeValue(value: unknown): value is BoxedSchemeValue {
  switch (true) {
    // Recognition is `instanceof AValue` (RULINGS.md) — structural, not enumerative:
    // a new AValue subclass is recognized free (no hand-maintained case-list gap).
    case value instanceof AValue:

    // Non-AValue control forms that legitimately cross as "already scheme"
    // (BoxedSchemeValue is a SchemeValue superset for these — see type doc).
    case value instanceof Macro:
    case value instanceof Syntax:
    case value instanceof LambdaContext:
    case isAmbientRuntime(value):
      return true;

    default:
      return false;
  }
}

/** Bytevector-like binary — pass through unwrapped; polymorphic bytevector ops accept them. */
export function isBytevectorLike(value: unknown): value is Uint8Array | ArrayBuffer | DataView {
  switch (true) {
    case value instanceof Uint8Array:
    case value instanceof ArrayBuffer:
    case value instanceof DataView:
    case typeof Buffer !== "undefined" && value instanceof Buffer:
      return true;
    default:
      return false;
  }
}

/**
 * DefaultedWeakMap: same JS object always → same wrapper (AJSArray for arrays,
 * AJSObject for plain objects). Single factory on Array.isArray; fromJS's two call
 * sites are a single `.get(key)`.
 */
const jsToWrapper = new DefaultedWeakMap<object, AJSArray | AJSObject>((key) =>
  Array.isArray(key) ? new AJSArray(key) : new AJSObject(key),
);

// A JS object/array crossing here becomes an AJSObject/AJSArray whose get/has/keys
// route through the interop read policy over the WRAPPED `source`. Wrapper classes
// are themselves interop boundaries (interop-access family rule), so a sandbox
// prototype walk stops at the wrapper — only sandbox-safe own members of source flow.

/** Entry point for JS → Scheme boundary crossing. STRICT one-way door: an already-boxed
 *  scheme value reaching here means the caller is confused about which side it stands
 *  on — refuse loudly. Type-level: an AValue-typed argument resolves to `never`. */
export function fromJS<T>(value: [T] extends [AValue] ? never : T): FromJSResult {
  if (isSchemeValue(value)) throw new RedundantCrossingError("fromJS");

  // Host bigint DOORS — early throw keeps the teaching door on fromJS itself as well
  // as the leaf jsToScheme registry path.
  if (typeof value === "bigint") throw new NoLensError("bigint");

  // Containers: array → borrowed AJSArray (JS array IS R7RS vector); binary stays raw
  // (FFI identity); Promise stays raw (evaluator awaits); plain object → lazy AJSObject.
  if (Array.isArray(value)) {
    // Cached: same JS array → same wrapper (eq? stability).
    return jsToWrapper.get(value);
  }
  if (isBytevectorLike(value)) return value;
  if (value instanceof Promise) return value;
  if (value !== null && typeof value === "object") {
    // Binary membrane (docs/membrane.md §INBOUND): branded `@arrival.private` instance
    // has an explicit lens (AOpaqueHandle, run-scoped). Plain-prototype object is the
    // other lens (borrowed, identity-cached). Anything else (Date/Map/Set/unbranded class)
    // is EXPLICITLY INCOMPATIBLE — NoLensError, same as rosetta's registry.
    if (isMarkedInteropPrivate(value)) {
      return AOpaqueHandle.for(CONSTANT_CTX, value as object, EMPTY_PROVENANCE);
    }
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return jsToWrapper.get(value as object);
    }
    throw new NoLensError("unbranded-class", (value as object).constructor?.name ?? "<anonymous object>");
  }

  // `as FromJSResult` exists because TS cannot thread `AWrap<T>` through the
  // `[T] extends [AValue] ? never` if-chain.
  return jsToScheme(CONSTANT_CTX, value, {}, EMPTY_PROVENANCE) as FromJSResult;
}

/** Public Scheme → JS exit. Implementation lives next to the private element
 *  walker in rosetta.ts so mixed-world recursion stays membrane-private.
 *  Re-exported here so the barrel path (`membrane.js`) stays the public door. */
export { toJS } from "./rosetta.js";

// Polyglot member access lives ON the values (tagless algebra):
// arrival/tagless-final/get|has|keys — ADict structurally, AJSObject/AJSArray through
// the interop read policy over their borrowed source. Membrane has no member-read face;
// env/polyglot verbs normalize the key and invoke the value terms directly.

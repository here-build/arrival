/**
 * Membrane — typed boundary crossing for Scheme ↔ JS interop.
 *
 * - fromJS/toJS: general JS↔Scheme value crossing. Thin wrappers (cljs-bean style)
 *   for objects/functions; WeakMap identity cache (Miller/Van Cutsem); primitives
 *   pass through unwrapped.
 * - Member access (`@`/`@?`/`@keys`, the `:key` accessor) lives on the values
 *   themselves (`arrival/tagless-final/get|has|keys`) — env/polyglot.ts's verbs
 *   dispatch directly; no membrane face remains.
 *
 * (The former Codec/Operator FFI layer is dissolved; numeric marshalling now lives
 * in the `scheme/numeric` pack via `symbol.native`.)
 *
 * Lineage: object-capability membranes (Miller 2006; Van Cutsem & Miller 2013).
 * The member-read protocol mirrors GraalVM Truffle's InteropLibrary (Würthinger
 * et al. 2013/2017) — see interop-access.ts.
 */

import { CLASS } from "./well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./values/primitives/RunContext.js";
import { DefaultedWeakMap } from "@here.build/collections";
import { AValue, EMPTY_PROVENANCE } from "./values/primitives/AValue.js";
import { Values } from "./values/primitives/Values.js";
import { fromJs } from "./values/primitives/boxing.js";
import { ABool } from "./values/primitives/ABool.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AVector } from "./values/primitives/AVector.js";
import { AmbientRuntime, isAmbientRuntime } from "./AmbientRuntime.js";
import { LambdaContext } from "./eval/LambdaContext.js";
import { AString } from "./values/primitives/AString.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { Macro } from "./eval/Macro.js";
import { AExact } from "./values/primitives/AExact.js";
import { AInexact } from "./values/primitives/AInexact.js";
import { APair } from "./values/primitives/APair.js";
// Intentional runtime cycle with rosetta.ts (which imports SchemeJSObject from
// here). ESM resolves it: both fns are declared before any call site fires.
import { jsToScheme, callableToHostFn, egressAValue } from "./rosetta.js";
import { RedundantCrossingError } from "./errors.js";
import { is_callable_value } from "./values/value-guards.js";
import { Syntax } from "./eval/Syntax.js";
import { type SchemeValue } from "./values/types.js";
import { type ACallable } from "./values/primitives/ACallable.js";
import { ANil } from "./values/primitives/ANil.js";
import { Keyword } from "./values/Keyword.js";
// AJSObject/AJSArray live in primitives/ with the rest of the term family; they
// import fromJS/jsToScheme directly (benign cycle, hoisted fn decls) — see
// AJSArray.ts / AJSObject.ts.
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { ADict } from "./values/primitives/ADict.js";
import { ACharacter } from "./values/primitives/ACharacter.js";

// (The interop-access re-export block died with the accessor faces: the read
// policy's imports live only in the borrowed classes now, and the public
// surface — arrival/markInteropPrivate/markInteropBoundary — ships from the
// index barrel directly off interop-access.js.)


// ============================================================================
// WRAPPER LAYER: General JS↔Scheme Value Crossing
// ============================================================================

// Wrapper unwrap protocol key: `"arrival/toJS"`, a global convention (like
// `arrival/tagless-final/*`/`arrival/print`) written as a literal at each use
// site, not declared. PyO3-style: each class implements its own unwrap.

/**
 * The closed union of "already scheme, don't re-wrap" types: every wrapper class,
 * native scheme type, special-form head (Macro/Syntax/Keyword), env, promise, and
 * a bare `Function` (the quarantined `env.defineRosetta` legacy authoring arm — see
 * capability.ts — still binds a bare host function into value space). A SUPERSET of
 * the value-intent `SchemeValue` union — the JS→Scheme boundary legitimately
 * admits CONTROL forms that are never values (Macro/Syntax/LambdaContext/
 * AmbientRuntime, a bare `Function`). That's why `BoxedSchemeValue`
 * isn't assignable to `SchemeValue`, and why the membrane keeps its own boundary
 * type instead of widening the value union.
 *
 * (Every scheme lambda is a real `ALambda`, caught by the `instanceof AValue` case
 * below — there is no separate `[LAMBDA]`-branded case.)
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
  | Macro
  | Syntax
  | LambdaContext
  | AmbientRuntime
  | Keyword
  | ACallable
  | Function;

/**
 * The honest return of `fromJS` — a NAMED, bounded superset of `SchemeValue`: the
 * boundary returns more than value-intent because some crossings stay as
 * materialization/plumbing rather than boxing into a value:
 *   • `BoxedSchemeValue` — an already-scheme input passes through un-rewrapped
 *     (incl. the control forms / branded Function above);
 *   • `Uint8Array`/`ArrayBuffer`/`DataView` — raw FFI binary stays raw (identity-
 *     preserving; membrane.spec pins "preserves Uint8Array identity"), for the
 *     polymorphic bytevector ops rather than an owned `ABytevector` copy;
 *   • `Promise<unknown>` — stays raw for the evaluator trampoline to await.
 *   • `bigint` — an opaque HOST value (docs/working-proposals/
 *     arrival-one-number-rework.md §2.3), NOT a scheme number: never boxed into an
 *     `AExact` (arithmetic on it doors — op-helpers.ts's `coerceNumeric` — and
 *     `number?` answers #f), rides the same raw identity lane as the binary FFI row
 *     above. `bigintToNumber` (rosetta.ts) is the explicit, safe-range-checked door
 *     out of this opacity.
 * These carriers are NOT value-intent, so they stay out of `SchemeValue`
 * (values/types.ts) — this boundary type is the seam that holds them.
 */
type FromJSResult = BoxedSchemeValue | Uint8Array | ArrayBuffer | DataView | Promise<unknown> | bigint;

/**
 * Check if a value is already a Scheme value (prevents double-wrapping).
 *
 * `instanceof ANil`, not `=== nil`: `nil.withProvenance(p)` mints fresh Nil clones,
 * so reference-equality misses provenance-bearing list terminators and would
 * double-wrap them.
 */
export function isSchemeValue(value: unknown): value is BoxedSchemeValue {
  switch (true) {
    // Recognition is `instanceof AValue` (RULINGS.md) — every wrapper/native
    // Scheme term, including ANil, Keyword, AVoid, and the callable
    // primitives, derives from AValue. This is structural, not enumerative: a new
    // AValue subclass is recognized for free, closing the class of "omitted from
    // the switch" gaps (AVoid was one) that a hand-maintained case list invites.
    case value instanceof AValue:

    // The few non-AValue control forms that legitimately cross as
    // "already scheme, don't re-wrap" (BoxedSchemeValue is a superset of
    // SchemeValue precisely for these — see the type's doc comment above).
    case value instanceof Macro:
    case value instanceof Syntax:
    case value instanceof LambdaContext:
    case isAmbientRuntime(value):
      return true;

    default:
      return false;
  }
}

/**
 * Check if a value is a bytevector-like binary data type.
 * These pass through without wrapping and work with polymorphic bytevector ops.
 */
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
 * DefaultedWeakMap (@here.build/collections): same JS object always → same wrapper
 * (AJSArray for arrays, AJSObject for plain objects) — a single homogeneous factory
 * dispatching purely on `Array.isArray(key)`, so `fromJS`'s two call sites collapse
 * the old get-check-set dance into one `.get(key)`. Typed to that pair so the cached
 * read returns a `FromJSResult` member honestly, no cast.
 */
const jsToWrapper = new DefaultedWeakMap<object, AJSArray | AJSObject>((key) =>
  Array.isArray(key) ? new AJSArray(CONSTANT_CTX, key) : new AJSObject(CONSTANT_CTX, key),
);

// ============================================================================
// SANDBOX BOUNDARIES — SchemeJSObject, SchemeJSFunction
// ============================================================================
// Every JS value crossing into the sandbox becomes one of these wrappers. Their
// own get/set/has/delete/keys route through accessMember for the WRAPPED value,
// but the WRAPPER's own prototype is still reachable via symbol-to-field
// auto-resolution — without a boundary marker, sandbox code could read the
// wrapper's `apply`/`call`/`toString` to reach the underlying `source` Function
// or Object (running the source with sandbox-controlled args via `apply` is the
// escape shape). Marking the wrapper classes stops the prototype walk here —
// only own sandbox-safe properties on the wrapped value flow through.
// ============================================================================
/** Entry point for JS → Scheme boundary crossing. STRICT one-way door: an
 *  already-boxed scheme value reaching this entry means the caller is confused
 *  about which side of the membrane it stands on — refuse loudly instead of
 *  passing through. Type-level: an `AValue`-typed argument resolves to `never`. */
export function fromJS<T>(value: [T] extends [AValue] ? never : T): FromJSResult {
  if (isSchemeValue(value)) throw new RedundantCrossingError("fromJS");

  // Opaque host value (§2.3) — not a scheme number, never boxed into an AExact. Same
  // raw-identity treatment as the binary/Promise arms below, checked first since a
  // bigint is a JS primitive (would otherwise fall to the leaf jsToScheme call, which
  // already agrees via INBOUND_CLAIMS's own "bigint → raw passthrough" row — this
  // early return is for clarity/perf, not a different law).
  if (typeof value === "bigint") return value;

  // Containers get membrane-specific handling: array → borrowed AJSArray vector (JS array IS an
  // R7RS vector); binary stays raw (FFI identity, membrane.spec pins it); Promise stays raw (the
  // evaluator trampoline awaits it); plain object → lazy AJSObject materializing fields on access.
  if (Array.isArray(value)) {
    // Cached so the same JS array → same wrapper (`eq?` stability). Both arms of
    // `jsToWrapper`'s union satisfy `FromJSResult`, so no narrowing is needed here —
    // the factory's own `Array.isArray` dispatch is what actually picks the class.
    return jsToWrapper.get(value);
  }
  if (isBytevectorLike(value)) return value;
  if (value instanceof Promise) return value;
  if (value !== null && typeof value === "object") {
    return jsToWrapper.get(value as object);
  }

  // Leaves go through jsToScheme: primitives box, null→nil, undefined/function/unique-symbol→
  // #void+warn, Symbol.for→:keyword. A borrowed JS function is #void, not callable — not portable.
  // Cast, not a narrowing gap: jsToScheme's honest `AWrap<T>` (values/types.ts) is exactly
  // this leaf case (the array/bytevector/Promise/object arms above already returned), but TS
  // can't thread that proof through the `[T] extends [AValue] ? never : T` conditional
  // parameter across the if-chain above. `FromJSResult` (this file's own doc comment) is
  // already the named, bounded superset of `AWrap<T>`'s leaf outputs — the widen is this
  // boundary's own seam, not a hidden unsoundness.
  return jsToScheme(CONSTANT_CTX, value, {}, EMPTY_PROVENANCE) as FromJSResult;
}

/** Exit point for Scheme → JS boundary crossing. STRICT: only interpreter-minted
 *  boxed values cross — a raw JS value reaching here means the caller is already
 *  on the JS side and there is nothing to convert.
 *
 *  Native containers (AVector/APair/ADict) egress as lazy ref-tracking proxies. The
 *  same-box→same-proxy WeakMap pre-check lives in values/egress-proxy.ts's single
 *  chokepoint (which every container's own `arrival/toJS` calls), NOT here —
 *  protocol dispatch lands in that cache whether the exit came through this function
 *  or a direct protocol call, so a second membrane-side check would be redundant. */
export function toJS(value: SchemeValue) {
  // Multiple values exit as a JS ARRAY of unwrapped elements — the same convention
  // the baked rosetta encoder uses ("the multiple-values case is a RAW JS ARRAY").
  // Values sits outside the AValue hierarchy, so without this arm exec() on any
  // values-returning program ((partition …), (exact-integer-sqrt …)) would die on
  // the strict-exit invariant below.
  if (value instanceof Values) return value.__values__.map((v) => toJS(v));
  if (!isSchemeValue(value)) throw new RedundantCrossingError("toJS");
  // A scheme callable exits as its reverse-membrane region wrapper (so exec()'s
  // simple tier can return an ALambda/AProcedure as a callable host fn), NOT its
  // print-string `arrival/toJS`. Special-cased here rather than in ACallable's
  // own term because that class must not import rosetta.ts (scheme-zod init
  // cycle — see ACallable's makeCallCtx note); membrane already carries the
  // rosetta cycle safely (jsToScheme above). schemeToJs applies the same
  // is_callable_value check before its own protocol dispatch.
  if (is_callable_value(value)) return callableToHostFn(value, {});
  // Containers cross via the membrane protocol under default options — egressAValue
  // shares rosetta's default-mode slots, so `toJS(v) === schemeToJs(v)` holds and a
  // NESTED callable gets the same host-fn face a bare top-level one gets right above
  // (it used to degrade to its print string). Non-container AValues fall through to
  // their serialization protocol inside egressAValue; non-AValue scheme orphans keep
  // the direct protocol call — both byte-identical to the old single dispatch.
  if (value instanceof AValue) return egressAValue(value, {});
  return value["arrival/toJS"]();
}

// Polyglot member access lives ON the values (tagless algebra, AValue.ts):
// `arrival/tagless-final/get|has|keys` — ADict structurally, AJSObject/AJSArray
// through the interop read policy (interop-access.ts) over their borrowed
// source. The former membrane faces (readMember/hasMember/memberKeys) are
// dissolved: env/polyglot.ts's `@`/`@?`/`@keys` verbs — their only production
// consumer — normalize the key and invoke the terms directly. Absence IS the
// semantics; nothing membrane-level remains of the read protocol.

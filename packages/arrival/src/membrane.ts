/**
 * Membrane — typed boundary crossing for Scheme ↔ JS interop.
 *
 * - fromJS/toJS: general JS↔Scheme value crossing. Thin wrappers (cljs-bean style)
 *   for objects/functions; WeakMap identity cache (Miller/Van Cutsem); primitives
 *   pass through unwrapped.
 * - readMember/hasMember/memberKeys: the interop read protocol backing `@`/`@?`/
 *   `@keys` and the `:key` accessor.
 *
 * (The former Codec/Operator FFI layer is dissolved; numeric marshalling now lives
 * in the `scheme/numeric` pack via `symbol.native`.)
 *
 * See docs/membrane-design.md for full design rationale.
 *
 * Lineage: object-capability membranes (Miller 2006; Van Cutsem & Miller 2013).
 * The member-read protocol mirrors GraalVM Truffle's InteropLibrary (Würthinger
 * et al. 2013/2017) — see interop-access.ts.
 */

import { CLASS } from "./well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./values/primitives/RunContext.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./values/primitives/AValue.js";
import { fromJs } from "./values/primitives/boxing.js";
import { ABool } from "./values/primitives/ABool.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AVector } from "./values/primitives/AVector.js";
import { Environment as SchemeEnvironment } from "./Environment.js";
import { SchemePromise } from "./eval/evaluator.js";
import { LambdaContext } from "./eval/LambdaContext.js";
import { AString } from "./values/primitives/AString.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { Macro } from "./eval/Macro.js";
import { AExact } from "./values/primitives/AExact.js";
import { AInexact } from "./values/primitives/AInexact.js";
import { APair } from "./values/primitives/APair.js";
// Intentional runtime cycle with rosetta.ts (which imports SchemeJSObject from
// here). ESM resolves it: both fns are declared before any call site fires.
import { jsToScheme } from "./rosetta.js";
import {
  accessHas,
  accessKeys,
  accessMember,
  markInteropBoundary,
  NOT_FOUND,
} from "./interop-access.js";
import { InteropAccessError } from "./errors.js";
import { Syntax } from "./eval/Syntax.js";
import { type SchemeValue } from "./values/types.js";
import { type ACallable } from "./values/primitives/ACallable.js";
import { ANil, nil } from "./values/primitives/ANil.js";
import { Keyword } from "./values/Keyword.js";
// AJSObject/AJSArray live in primitives/ with the rest of the term family; they
// import fromJS/jsToScheme directly (benign cycle, hoisted fn decls) — see
// AJSArray.ts / AJSObject.ts.
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { ADict } from "./values/primitives/ADict.js";
import { ACharacter } from "./values/primitives/ACharacter.js";

export {
  INTEROP_BOUNDARY,
  accessMember,
  accessHas,
  accessSet,
  NOT_FOUND,
  markInteropBoundary,
} from "./interop-access.js";
export { InteropAccessError } from "./errors.js";
// Deprecated pre-rename alias, kept until stdlib importers codemod off the
// sandbox→interop naming.
export { markInteropBoundary as markAsSandboxBoundary } from "./interop-access.js";


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
 * SchemeEnvironment, a bare `Function`). That's why `BoxedSchemeValue`
 * isn't assignable to `SchemeValue`, and why the membrane keeps its own boundary
 * type instead of widening the value union.
 *
 * (The `[LAMBDA]`-branded scheme-lambda case this union/predicate once carried is
 * RETIRED — reverse-membrane-for-callables.md §3 step 1: every scheme lambda is a
 * real `ALambda` now, caught by the `instanceof AValue` case below.)
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
  | SchemePromise
  | Macro
  | Syntax
  | LambdaContext
  | SchemeEnvironment
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
 * These carriers are NOT value-intent, so they stay out of `SchemeValue`
 * (values/types.ts) — this boundary type is the seam that holds them.
 */
export type FromJSResult = BoxedSchemeValue | Uint8Array | ArrayBuffer | DataView | Promise<unknown>;

/**
 * Check if a value is already a Scheme value (prevents double-wrapping).
 *
 * `instanceof ANil`, not `=== nil`: `nil.withProvenance(p)` mints fresh Nil clones,
 * so reference-equality misses provenance-bearing list terminators and would
 * double-wrap them.
 */
export function isSchemeValue(value: unknown): value is BoxedSchemeValue {
  switch (true) {
    // R3 (RULINGS.md): recognition is `instanceof AValue` — every wrapper/native
    // Scheme term, including ANil, Keyword, AVoid, and the callable
    // primitives, derives from AValue. This is structural, not enumerative: a new
    // AValue subclass is recognized for free, closing the class of "omitted from
    // the switch" gaps (AVoid was one) that a hand-maintained case list invites.
    case value instanceof AValue:

    // The few non-AValue control forms that legitimately cross as
    // "already scheme, don't re-wrap" (BoxedSchemeValue is a superset of
    // SchemeValue precisely for these — see the type's doc comment above).
    case value instanceof SchemePromise:
    case value instanceof Macro:
    case value instanceof Syntax:
    case value instanceof LambdaContext:
    case value instanceof SchemeEnvironment:
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
 * WeakMap cache: same JS object always → same wrapper (AJSArray for arrays,
 * AJSObject for plain objects). Typed to that pair so the cached read returns a
 * `FromJSResult` member honestly, no cast.
 */
const jsToWrapper = new WeakMap<object, AJSArray | AJSObject>();

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
  invariant(
    !isSchemeValue(value),
    "fromJS: received an already-boxed scheme value — fromJS is the JS→Scheme membrane entry; an interpreter-minted value never crosses it. Use the value directly.",
  );

  // Containers get membrane-specific handling: array → borrowed AJSArray vector (JS array IS an
  // R7RS vector); binary stays raw (FFI identity, membrane.spec pins it); Promise stays raw (the
  // evaluator trampoline awaits it); plain object → lazy AJSObject materializing fields on access.
  if (Array.isArray(value)) {
    // Cached so the same JS array → same wrapper (`eq?` stability).
    const cached = jsToWrapper.get(value);
    if (cached) return cached;
    const wrapper: AJSArray = new AJSArray(CONSTANT_CTX, value);
    jsToWrapper.set(value, wrapper);
    return wrapper;
  }
  if (isBytevectorLike(value)) return value;
  if (value instanceof Promise) return value;
  if (value !== null && typeof value === "object") {
    const cached = jsToWrapper.get(value as object);
    if (cached) return cached;
    const wrapper: AJSObject = new AJSObject(CONSTANT_CTX, value as object);
    jsToWrapper.set(value as object, wrapper);
    return wrapper;
  }

  // Leaves go through jsToScheme: primitives box, null→nil, undefined/function/unique-symbol→
  // #void+warn, Symbol.for→:keyword. A borrowed JS function is #void, not callable — not portable.
  return jsToScheme(CONSTANT_CTX, value, {}, EMPTY_PROVENANCE);
}

/** Exit point for Scheme → JS boundary crossing. STRICT: only interpreter-minted
 *  boxed values cross — a raw JS value reaching here means the caller is already
 *  on the JS side and there is nothing to convert.
 *
 *  R9 (two-tier-exec-api.md §5): native containers (AVector/APair/ADict) egress as
 *  lazy ref-tracking proxies. The same-box→same-proxy WeakMap pre-check lives in
 *  values/egress-proxy.ts's single chokepoint (which every container's own
 *  `arrival/toJS` calls), NOT here — protocol dispatch lands in that cache whether
 *  the exit came through this function or a direct protocol call, so a second
 *  membrane-side check would be redundant. */
export function toJS(value: SchemeValue) {
  invariant(
    isSchemeValue(value),
    "toJS: received a non-scheme value — toJS is the Scheme→JS membrane exit; a raw JS value is already JS. Pass it through directly.",
  );
  return value["arrival/toJS"]();
}

// ─────────────────────────────────────────────────────────────────────────────
// Polyglot member access — the interop read protocol (Graal InteropLibrary).
//
// arrival is a polyglot runtime, not a host with a fenced guest: a value is a
// value whichever language minted it. readMember/hasMember/memberKeys are
// origin-agnostic — they define what counts as a *readable member*, not a host
// defense. Back the `@`/`@?`/`@keys` surface and the `:key` accessor — one
// protocol, two syntaxes.
//
//   • meta-members (constructor/__proto__/prototype, blocked in accessMember)
//     and anything marked `@arrival.private` are not members — reading yields
//     nil, same as Graal hides a value's meta-object from a peer language.
//     (Privacy is `@arrival.private`'s job; a leading `_` is an ordinary
//     member, no convention.)
//   • only two kinds expose members: a foreign value routes through its
//     `SchemeJSObject.get` (provenance-cached); a native dict reads
//     structurally. A scheme LEAF value (string/number/symbol/nil/pair), a
//     primitive, or a function has no members — reading one yields nil, never
//     the AValue's internal provenance/kind.

/** `readMember(obj, key)` — read a member off any polyglot value. Missing/blocked → nil. */
export function readMember(obj: unknown, key: unknown): SchemeValue {
  if (obj == null) return nil;
  const rawKey = (key as { valueOf?: () => unknown })?.valueOf?.() ?? key;
  if (rawKey == null || rawKey instanceof ANil) return nil;
  // keyword-style member: a leading `:` is the accessor sigil, not part of the name.
  let keyStr = String(rawKey);
  if (keyStr.startsWith(":")) keyStr = keyStr.slice(1);
  // membrane-exposed foreign value (lazy proxy) → provenance-cached read.
  if (obj instanceof AJSObject) return obj.get(keyStr);
  // native dict — entries are already real SchemeValues with their own provenance,
  // so (unlike AJSObject.get above) there is nothing to box through jsToScheme.
  if (obj instanceof ADict) return obj.get(keyStr);
  try {
    const source = obj instanceof AJSArray ? obj.source : obj;
    // Only a dict or array exposes members; a scheme leaf/primitive/function has
    // none — reading one would leak an AValue's own `provenance`/`kind` fields
    // (the boundary's prototype-walk guard doesn't stop own-field reads).
    if (!Array.isArray(source)) {
      const proto = typeof source === "object" && source !== null ? Object.getPrototypeOf(source) : false;
      if (proto !== Object.prototype && proto !== null) return nil;
    }
    const result = accessMember(source, keyStr);
    if (result === NOT_FOUND) return nil;
    // readMember is ctx-free; derive ctx from the container (native dict falls
    // back to CONSTANT_CTX).
    const ctx = obj instanceof AValue ? obj.ctx : CONSTANT_CTX;
    // re-present a JS array as a polyglot array so car/cdr work on the result.
    if (Array.isArray(result)) {
      return new AJSArray(ctx, result);
    }
    // A member read is a VALUE read — box via jsToScheme (faithful value path), not
    // fromJS (whose wider boundary return carries raw FFI/control plumbing).
    // jsToScheme is typed `any` (rosetta debt); annotate to the honest union so
    // this needs no cast.
    const boxed: SchemeValue = jsToScheme(ctx, result, {}, EMPTY_PROVENANCE);
    return boxed;
  } catch (e) {
    if (e instanceof InteropAccessError) return nil;
    throw e;
  }
}

/** `hasMember(obj, key)` — does the polyglot value expose this member? */
export function hasMember(obj: unknown, key: unknown): boolean {
  if (obj == null) return false;
  const rawKey = (key as { valueOf?: () => unknown })?.valueOf?.() ?? key;
  if (rawKey == null || rawKey instanceof ANil) return false;
  let keyStr = String(rawKey);
  if (keyStr.startsWith(":")) keyStr = keyStr.slice(1);
  if (obj instanceof ADict) return obj.has(keyStr);
  const source = obj instanceof AJSObject ? obj.source : obj;
  return accessHas(source, keyStr);
}

/** `memberKeys(obj)` — the polyglot value's own member names. */
export function memberKeys(obj: unknown): string[] {
  if (obj == null) return [];
  if (obj instanceof ADict) return obj.keys();
  const source = obj instanceof AJSObject ? obj.source : obj;
  return accessKeys(source);
}

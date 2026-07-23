/**
 * Core Scheme value-type contracts.
 * Concrete value classes live in ./primitives/*; this file keeps the pure
 * type/interface/guard surface they share.
 */

// SchemeValue is the honest union of every value the interpreter can hold:
// every concrete AValue subclass, the live non-AValue orphans (EOF, Values),
// and a JS function used as a Scheme procedure. Excludes DatumReference
// (reader-internal).
import type { AExact } from "./primitives/AExact.js";
import type { AInexact } from "./primitives/AInexact.js";
import type { APair } from "./primitives/APair.js";
import type { ANil } from "./primitives/ANil.js";
import type { AString } from "./primitives/AString.js";
import type { ASymbol } from "./primitives/ASymbol.js";
import type { ABool } from "./primitives/ABool.js";
import type { AVector } from "./primitives/AVector.js";
import type { ABytevector } from "./primitives/ABytevector.js";
import type { ACharacter } from "./primitives/ACharacter.js";
import type { AVoid } from "./primitives/AVoid.js";
import type { AJSArray } from "../membrane/AJSArray.js";
import type { AJSObject } from "../membrane/AJSObject.js";
import type { ADict } from "./primitives/ADict.js";
import type { AOpaqueHandle } from "./primitives/AOpaqueHandle.js";
import type { EOF } from "./primitives/EOF.js";
import type { Values } from "./primitives/Values.js";
import type { AKernelKeyword } from "./AKernelKeyword.js";
// A caught condition reaching `(catch (e) …)` is an R7RS error object —
// `error-object?` is exactly `obj instanceof R7RSError` (env/r7rs/error-objects.ts).
// `import type` keeps this erased at runtime, so the mutual edge with errors.ts
// (which `import type`s SchemeValue from here) is a pure compile-time cycle.
import type { R7RSError } from "../errors.js";
// `AProcedure` is a JS function used as a Scheme procedure with optional
// `__name__`/`__code__` metadata — a first-class *value* (unlike Macro/Syntax/AmbientRuntime, which are
// env bindings, never values). No runtime brand distinguishes it from a plain
// procedure, so a value resolved from the env arrives typed as one. `import
// type` keeps the mutual edge with AmbientRuntime.ts a pure compile-time cycle.
import type { CallCtx } from "../run/CallCtx.js";
import type { ACallable } from "./primitives/ACallable.js";
import type { ARosettaProcedure } from "./primitives/ACallable.js";
import { AValue } from "./primitives/AValue.js";

/**
 * Opaque marker for the trampoline's bounce sentinel. The real `Bounce`
 * (`{ __bounce: true; generator }`, declared in eval/evaluator.ts) can't be
 * imported here without a value cycle, and the value channel never needs its
 * `generator` field — only its brand. A `LambdaFunction`'s call may return one,
 * so the lambda-as-value arm of the union admits it; the call boundary narrows
 * it out (`is_bounce`) before any value use, so it never reaches a value slot.
 */
export interface SchemeBounceMarker {
  readonly __bounce: true;
}

// `[T] extends [...]` (tuple-wrapped) on purpose: a naked `T extends ...` conditional
// DISTRIBUTES over the ~23-member SchemeValue union when `AListAlike` is used
// unparameterized, exploding into a union of concrete APair<X, …> shapes that
// unifies with no open generic (and trips TS2589 in deep spines).
//
// The maximal-T short-circuit (`[SchemeValue] extends [T]` arm) is load-bearing:
// when T is the whole union, the recursive cdr constraint adds no information —
// every element is already admissible — but it DOES make the alias strictly
// narrower than a plain `APair<SchemeValue, SchemeValue>` (whose cdr is not
// provably the recursive shape), so every real pair in the interpreter would
// fail to assign into the type that's supposed to describe it. Collapse the
// default to the honest `APair<SchemeValue, SchemeValue> | ANil` spine and keep
// the recursive precision only for genuinely narrowed element types.
type AArrayListAlike<T extends SchemeValue> = [SchemeValue] extends [T]
  ? APair<SchemeValue, SchemeValue> | ANil
  : APair<T, [T] extends [APair<any, any> | ANil] ? T : AArrayListAlike<T>> | ANil;
type ATupleListAlike<T extends [...SchemeValue[]]> = T extends [
  infer Car extends SchemeValue,
  ...infer Cdr extends SchemeValue[],
]
  ? APair<Car, ATupleListAlike<Cdr>>
  : ANil;

export type AListAlike<T extends SchemeValue | [...SchemeValue[]] = SchemeValue> = [T] extends [[...SchemeValue[]]]
  ? ATupleListAlike<T>
  : [T] extends [SchemeValue]
    ? AArrayListAlike<T>
    : never;

export type AListAlikeValue<T extends AListAlike> = T extends AListAlike<infer V> ? V : never;
export type APairAsListValue<Car extends SchemeValue, Cdr extends SchemeValue> =
  | Car
  | (Cdr extends AListAlike ? AListAlikeValue<Cdr> : never);

export type SchemeValue =
  | AExact
  | AInexact
  | APair<any, any>
  | ANil
  | AString
  | ASymbol
  | ABool
  | AVector
  | ABytevector
  | ACharacter
  | AVoid
  | AJSArray
  | AJSObject
  | ADict
  | AOpaqueHandle
  | AKernelKeyword
  | EOF
  | Values
  // A caught R7RS condition object, bound as the catch variable.
  | R7RSError
  // A JS function used as a Scheme procedure, with optional `__name__`/`__code__` metadata.
  | AProcedure
  // A callable-as-value (stage 0 of the callable-as-value rework): ALambda /
  // ANativeProcedure / ARosettaProcedure. Additive alongside the legacy `AProcedure` fn arm
  // until the migration replaces it. `import type` keeps the edge to primitives/ACallable.ts
  // (which type-imports SchemeValue from here) a pure compile-time cycle.
  | ACallable;

// ─────────────────────────────────────────────────────────────────────────────
// AWrap<T> / AUnwrap<T> — the honest jsToScheme/schemeToJs membrane types
// (rosetta.ts). Same tuple-wrapped conditional discipline as AListAlike above
// (the AListAlike TS2589 lesson): a NAKED `T extends X ? A : B` DISTRIBUTES
// over a union T, so wrapping every test as `[T] extends [X]` keeps T opaque
// through the whole chain instead of exploding into a union of per-member
// results when T is itself wide. Both directions short-circuit on the WIDEST
// possible input first — AWrap's JS-side maximal is `unknown` (an untyped/
// effectively-`any` caller); AUnwrap's Scheme-side maximal is `SchemeValue`
// itself (a caller holding the full union, e.g. a generic recursive helper) —
// collapsing to the honest wide answer (`SchemeValue` / `unknown`) rather than
// letting the chain distribute into an unreadable union of every arm.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// JSWorldValue / JSWorldArray — the JS side of the membrane, AT THE TYPE LEVEL.
//
// THE HYGIENE LAW (docs/membrane.md §HYGIENE) enforced as a TYPE: a borrowed store holds
// JS-world values only. Stated as a type, not (only) a runtime invariant, on purpose — a throw
// catches the one path someone runs, a type catches EVERY violator at once in tsc, including the
// ones no test covers (the breakage IS the audit). The limit is honest: a bare `unknown[]` still
// passes (nothing better is knowable there); what fails to compile is the caller that statically
// knows it holds scheme values and buries them in a JS store (`arr as SchemeValue[]`). The
// penetration-point invariant is AJSArray.boxElement.
// ─────────────────────────────────────────────────────────────────────────────

/** `any` detector (the `0 extends (1 & T)` idiom): `any` absorbs every `Extract`, so without
 *  this an `any[]` — an honest untyped JSON payload — would collapse to `never` and lock out the
 *  membrane's real callers. `any` means "origin unknown", which is a claim we cannot refute. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** `never` iff T is known to carry a boxed scheme value; T otherwise. Tuple-wrapped so a union T
 *  stays opaque instead of distributing (the AListAlike TS2589 lesson, above). */
export type JSWorldValue<T> =
  IsAny<T> extends true ? T : [Extract<T, AValue>] extends [never] ? T : never;

/** A store that may back a borrowed container: an array whose ELEMENT type carries no boxed scheme
 *  value. `unknown[]` / `any[]` pass (nothing better is knowable at that site); `SchemeValue[]` /
 *  `AValue[]` collapse to `never`, so the call site FAILS TO COMPILE. Those are the real violators:
 *  a caller that statically knows it holds scheme values and buries them in a JS store anyway. */
export type JSWorldArray<T extends readonly unknown[]> =
  IsAny<T[number]> extends true ? T : [Extract<T[number], AValue>] extends [never] ? T : never;

/**
 * `jsToScheme<T>(ctx, value: T, …)`'s honest return type — the AValue shape a
 * JS value of static type T boxes into. Mirrors jsToScheme's INBOUND_CLAIMS
 * registry arm-for-arm (rosetta.ts) — a new claim in one must gain the other,
 * or the type stops telling the truth about the impl (P3).
 */
export type AWrap<T> = [unknown] extends [T]
  ? SchemeValue
  : [T] extends [AValue]
    ? T
    : [T] extends [null]
      ? ANil
      : [T] extends [undefined]
        ? AVoid
        : [T] extends [boolean]
          ? ABool
          : [T] extends [bigint]
            ? bigint // opaque host value (§2.3, docs/design-history/arrival-one-number-rework.md) — never boxed, identity (same law as the binary FFI arm below).
            : [T] extends [number]
              ? AExact | AInexact
              : [T] extends [string]
                ? AString
                : [T] extends [EOF | Values | R7RSError]
                  ? T // non-AValue scheme orphans — the declared identity claim.
                  : [T] extends [Uint8Array | ArrayBuffer | DataView]
                    ? T // binary FFI passthrough (declared named superset) — never boxed, identity.
                    : [T] extends [Promise<unknown>]
                      ? never // a bare Promise DOORS at the crossing (jsToSchemeAsyncDoor) — settle it first.
                      : [T] extends [readonly unknown[]]
                        ? AJSArray // AJSArray isn't element-generic — this is as deep as it compiles.
                        : [T] extends [symbol]
                          ? ASymbol | AVoid // registered (Symbol.for) → ASymbol; unique → AVoid, jsToScheme's own split.
                          : [T] extends [Function]
                            ? ARosettaProcedure // reverse-membrane lens (V's 2026-07-24 ruling): mints/reuses a genuine scheme callable — see ACallable.ts's `hostFnToCallable`.
                            : [T] extends [object]
                              ? AJSObject // plain objects AND residual exotics — both borrow as AJSObject (exotics warn).
                              : SchemeValue;

/**
 * `schemeToJs<T>(value: T, …)`'s honest return type — the JS shape a Scheme
 * value of static type T unwraps into. Mirrors schemeToJs's own instanceof
 * chain arm-for-arm (rosetta.ts) — a new arm in one must gain the other.
 */
export type AUnwrap<T extends SchemeValue> = [SchemeValue] extends [T]
  ? unknown
  : [T] extends [ABool]
    ? boolean
    : [T] extends [AExact]
      ? number // plain number ALWAYS (§2.3): AExact's payload is safe-int by construction, so the out-of-range-bigint face is dead — egress divides (toJS(1/3) = 0.333…), never a bigint.
      : [T] extends [AInexact]
        ? number
        : [T] extends [AString]
          ? string
          : [T] extends [ACharacter]
            ? string
            : [T] extends [ANil]
              ? null
              : [T] extends [AVoid]
                ? undefined
                : [T] extends [AVector<infer E extends SchemeValue>]
                  ? AUnwrap<E>[]
                  : [T] extends [APair<any, any>]
                    ? unknown[] // one-way list→array projection (P9) — never a recursive element type.
                    : [T] extends [ADict]
                      ? Record<string, unknown>
                      : [T] extends [AJSArray]
                        ? readonly unknown[] // AJSArray's own `.source` type.
                        : [T] extends [AJSObject]
                          ? object // AJSObject's own `.source` type.
                          : [T] extends [ACallable]
                            ? (...args: unknown[]) => Promise<unknown> // the reverse-membrane region wrapper.
                            : unknown;

// A Scheme lambda value: its body may return a value synchronously, a bounce
// token (under the trampoline's bounce protocol), or a Promise (JS-host entry
// path). The trampolined/async return is the honest truth of a lambda's call;
// the non-value returns are narrowed out at the call boundary before any use.
export type AProcedure<Args extends [...SchemeValue[]] = [...any[]], Result extends SchemeValue = any> = ((
  this: CallCtx,
  ...args: Args
) => Result | SchemeBounceMarker | Promise<Result>) & {
  __name__?: string | symbol;
  __code__?: unknown;
};

// Duck-typing interface for SchemeString, placed first because other types reference it.
export interface SchemeStringLike {
  __string__: string | string[];
  valueOf(): string;
  toString(): string;
}

export function isSchemeString(x: unknown): x is SchemeStringLike {
  return typeof x === "object" && x !== null && "__string__" in x;
}

export function isString(x: unknown): x is SchemeStringLike | string {
  return typeof x === "string" || isSchemeString(x);
}

// AList: the "APair | ANil" scheme-list spine spelled out ~50x across the codebase.
// Deliberately NOT recursive (type AList<T> = APair<T, AList<T>|ANil>) -- APair's own
// method shapes are already self-referential through Cdr (see AConcatPair in APair.ts),
// and a prior "type instantiation excessively deep" error on APair itself was fixed by
// falling back to APair<any,any>. A second layer of alias recursion risks the same wall.
// Car/Cdr default to `any`, matching the inline union verbatim -- no call site in this
// codebase threads a real element type through the Cdr slot today. The `extends SchemeValue`
// bound (mirroring APair's own class signature) is load-bearing, not decoration --
// APair<Car, Cdr>'s own params require it, so a bare unconstrained `Car = any` fails to
// satisfy APair's constraint at the alias's own declaration site.
export type AList<Car extends SchemeValue = any, Cdr extends Car extends ANil ? ANil : SchemeValue = any> =
  | APair<Car, Cdr>
  | ANil;

// ── Egress projection modes + the membrane element exit ───────────────────────────
// (docs/design-history/arrival-egress-membrane-exit.md — ONE crossing protocol
// `arrival/toJS(exit?)`: no exit = serialization projection, exit present = membrane exit.)

/** The egress projection modes. `bare` = serialization (no options, callables
 *  stringify). `mem` = membrane crossing — the ONE non-bare mode: no RosettaOptions
 *  field affects element projection (`forceBigInt`, the only one that ever did, is
 *  retired per docs/design-history/arrival-one-number-rework.md §2.3 — bigint is an
 *  opaque host value, not a scheme number, so there is no numeric-projection option to
 *  key on). `returnEither`/`argProvenance` remain wrapper-call concerns read only
 *  inside createRosettaWrapper, never by schemeToJsImpl or inbound jsToScheme. Adding a
 *  FUTURE projection-affecting RosettaOptions field still REQUIRES a new member here —
 *  rosetta.ts's `_modeKeyExhaustive` type guard makes forgetting it a compile error. */
export type EgressMode = "bare" | "mem";
export const BARE_MODE: EgressMode = "bare";

/** The region wrapper cache's inner key — NOT EgressMode: `"typed"` is scheme-zod's
 *  `z.procedure` factory family (its own marshalling, options-less), not an egress
 *  mode, and `"bare"` never mints wrappers, so the live domain is
 *  {"mem","typed"}. See region-scope.ts's cache doc. */
export type WrapperKey = EgressMode | "typed";

/**
 * The membrane's element exit, handed to any `arrival/toJS(exit?)` implementor — the native
 * containers (ADict/APair/AVector, threading it for full recursive projection) AND ACallable
 * (whose reverse-membrane wrapper reuses `exit.element` verbatim for its result leg — see
 * ACallable.ts's `hostProjectionOf`). Built exclusively by rosetta.ts's `egressAValue`;
 * egress-proxy consumes the container half.
 */
export interface MembraneExit {
  /** Full recursive membrane crossing for one element, running under the PINNED
   *  exporting region scope — closes over `withRegionScope(pinned, () =>
   *  schemeToJsImpl(el, options))`. Handles nested callables (schemeToJsImpl's `instanceof
   *  AValue` dispatch re-enters `egressAValue`, which hands the SAME protocol to ACallable's
   *  own `arrival/toJS(exit)`, minting under the pinned scope), nested containers (the
   *  recursion re-enters `arrival/toJS(exit)` with the same options, so the same modeKey falls
   *  out). */
  element(el: unknown): unknown;
  /** Branded cache-mode discriminator — derived from options CONTENT by rosetta's
   *  `modeKeyOf`; closure identity is irrelevant. Never `"bare"` in practice (bare
   *  egress carries no MembraneExit at all). */
  modeKey: EgressMode;
  /** The pinned scope's OWN membrane-proxy cache (`RegionScope.egressProxies` —
   *  the law: membrane proxy identity = (box, mode, SCOPE)). Handed in as a plain
   *  WeakMap so egress-proxy needs zero new imports. Without this, a
   *  (box, mode)-forever cache would resurrect wrappers pinned to a CLOSED scope for
   *  a later invocation (spurious escape doors), or serve DETACHED-pinned wrappers to
   *  a live rosetta crossing (discipline bypass by cache pollution). */
  cache: WeakMap<AValue, Map<EgressMode, object>>;
}

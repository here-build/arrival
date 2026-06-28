/**
 * Membrane - Typed boundary crossing for Scheme ↔ JS interop
 *
 * This module provides two layers of interop:
 *
 * 1. WRAPPER LAYER (fromJS/toJS): General JS↔Scheme value crossing
 *    - Thin wrappers (cljs-bean style) for objects/functions
 *    - WeakMap identity cache (Miller/Van Cutsem pattern)
 *    - Primitives pass through without wrapping
 *
 * 2. CODEC LAYER (Codec/Operator): Typed bidirectional conversion at FFI boundaries
 *    - Bidirectional type converters at the boundary
 *    - Type-safe FFI between Scheme and JavaScript
 *
 * See docs/membrane-design.md for full design rationale.
 *
 * Lineage: object-capability membranes (Miller, "Robust Composition", 2006; Van
 * Cutsem & Miller, "Trustworthy Proxies — Membranes", 2013); the CODEC layer is
 * foreign-function-interface marshalling. The member-read protocol mirrors GraalVM
 * Truffle's InteropLibrary (Würthinger et al. 2013/2017) — see interop-access.ts.
 */

import { CLASS } from "./well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./values/primitives/RunContext.js";
import invariant from "tiny-invariant";
import { AValue, EMPTY_PROVENANCE } from "./values/primitives/AValue.js";
import { fromJs } from "./values/primitives/boxing.js";
import { ABool } from "./values/primitives/ABool.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AVector } from "./values/primitives/AVector.js";
import { Environment as SchemeEnvironment, KEYWORD_ACCESSOR_FIELD } from "./Environment.js";
import type { ResolverSpec } from "./common/scheme-env.js";
import { SchemePromise } from "./eval/evaluator.js";
import { LambdaContext } from "./eval/LambdaContext.js";
import { AString } from "./values/primitives/AString.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { Macro } from "./eval/Macro.js";
import { AExact, AInexact, type ANumeric } from "./values/numbers.js";
import { APair } from "./values/primitives/APair.js";
import { LAMBDA } from "./well-known-symbols.js";
// `jsToScheme` import is intentionally a runtime cycle with rosetta.ts —
// rosetta.ts statically imports `SchemeJSObject` from this file. ES module
// resolution lets the cycle close at definition time (both functions are
// declared before any call site fires); the lazy `.get` body below only
// reads `jsToScheme` when actually invoked.
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
import { ANil, nil } from "./values/primitives/ANil.js";
import { Keyword } from "./values/Keyword.js";
// The JS membrane value-wrappers (AJSObject for borrowed objects, AJSArray for
// borrowed arrays-as-vectors) live in primitives/ with the rest of the term
// family. They import fromJS/jsToScheme directly (a benign runtime cycle, both
// hoisted function declarations) — see AJSArray.ts / AJSObject.ts.
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { ACharacter } from "./values/primitives/ACharacter.js";

// Re-export the interop-access primitives for consumers.
export {
  INTEROP_BOUNDARY,
  accessMember,
  accessHas,
  accessSet,
  NOT_FOUND,
  markInteropBoundary,
} from "./interop-access.js";
export { InteropAccessError } from "./errors.js";
// Deprecated pre-rename aliases — kept so existing importers (stdlib) keep working
// through the sandbox→interop migration window; removed once they codemod over.
export {
  accessMember as sandboxedAccess,
  accessHas as sandboxedHas,
  accessSet as sandboxedSet,
  INTEROP_BOUNDARY as SANDBOX_BOUNDARY,
  markInteropBoundary as markAsSandboxBoundary,
} from "./interop-access.js";
export { InteropAccessError as SandboxViolationError } from "./errors.js";


// ============================================================================
// WRAPPER LAYER: General JS↔Scheme Value Crossing
// ============================================================================

/**
 * Symbol used by wrapper classes to implement unwrapping.
 * Any object with this symbol can be unwrapped via toJS().
 * Following PyO3's trait pattern - each class implements its own unwrap.
 */
export const TO_JS = Symbol.for("scheme.toJS");

/**
 * Check if a value is already a Scheme value (prevents double-wrapping).
 *
 * `instanceof Nil` not `=== nil`: after the AValue refactor, `nil.withProvenance(p)`
 * mints fresh Nil clones (types.ts:87) — reference-equality misses them, and the
 * boundary would then double-wrap a provenance-bearing list-terminator since
 * downstream checks (SchemeString / SchemeJSObject / Pair) won't catch a Nil
 * subclass either. This was the bug flagged in the Tier-1 cross-package audit
 * and the canonical example for guards.ts:is_nil (fix in 5f7f9e46a).
 */
export function isSchemeValue(value: unknown): boolean {
  switch (true) {
    case value instanceof ANil:
      return true;
    case value === null || value === undefined:
    case typeof value !== "object" && typeof value !== "function":
      return false;

    // Wrapper classes first — AJSArray (a borrowed array re-presented as a vector) sits
    // beside AJSObject; omitting it mis-routes a borrowed array back through fromJS into an
    // AJSObject wrap (the "any subtype not listed mis-routes" hazard the symmetry test pins).
    case value instanceof AJSObject:
    case value instanceof AJSArray:

    // Native Scheme types
    case value instanceof APair:
    case value instanceof ASymbol:
    case value instanceof AString:
    case value instanceof ABytevector:
    case value instanceof AVector:
    case value instanceof ACharacter:
    case value instanceof AExact:
    case value instanceof AInexact:
    case value instanceof ABool:
    case value instanceof SchemePromise:
    case value instanceof Macro:
    case value instanceof Syntax:
    case value instanceof LambdaContext:
    case value instanceof SchemeEnvironment:

    // Kernel keyword marker — a first-class special form (lambda/define/let/…),
    // bound + resolved like any value so the form is aliasable; never wrapped.
    case value instanceof Keyword:

    // Scheme lambda: a function carrying the well-known LAMBDA brand (set by the evaluator).
    case typeof value === "function" && LAMBDA in value:
      return true;

    default:
      return false;
  }
}

/**
 * Check if a value is a bytevector-like binary data type.
 * These pass through without wrapping and work with polymorphic bytevector ops.
 */
export function isBytevectorLike(value: unknown): boolean {
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

/** WeakMap cache ensuring same JS object always produces same wrapper. */
const jsToWrapper = new WeakMap<object, SchemeValue>();

// ============================================================================
// SANDBOX BOUNDARIES — SchemeJSObject, SchemeJSFunction
// ============================================================================
// War story (2026-05-28 audit): these two wrappers are explicitly the
// JS↔Scheme membrane — every JS value crossing into the sandbox becomes one
// of them. Their own `get/set/has/delete/keys` already route through
// `accessMember` for the WRAPPED value, but the WRAPPER's prototype
// itself is reachable via symbol-to-field auto-resolution. Without a boundary
// marker, sandbox code could read the wrapper's `apply`, `call`, or
// `toString` to reach the underlying `source` Function or Object. (`apply`
// taking the wrapped source and running it with sandbox-controlled args is
// the canonical escape shape.) Marking the wrapper classes ensures the
// prototype chain stops here — only own sandbox-safe properties on the
// wrapped value flow through.
// ============================================================================
/**
 * Convert a JavaScript value to a Scheme value.
 * Entry point for JS → Scheme boundary crossing.
 */
export function fromJS(value: unknown): SchemeValue {
  // Already a Scheme value? Pass through (prevents double-wrapping).
  if (isSchemeValue(value)) return value;

  // CONTAINERS keep their membrane-specific handling. An array becomes a borrowed AJSArray vector
  // (the Array.isArray branch below — a JS array IS an R7RS vector); binary stays raw (FFI identity
  // — membrane.spec.ts pins "preserves Uint8Array identity"); Promises stay raw (the evaluator
  // trampoline awaits them); a plain object becomes a lazy AJSObject whose fields materialize
  // faithfully on access.
  if (Array.isArray(value)) {
    // A JS array IS an R7RS vector → a borrowed AJSArray (lazy view; keeps `.source` so the
    // round-trip back out preserves identity). Cached so the same JS array → the same wrapper
    // (`eq?` stability), matching the AJSObject path below.
    const cached = jsToWrapper.get(value);
    if (cached) return cached;
    const wrapper: SchemeValue = new AJSArray(CONSTANT_CTX, value);
    jsToWrapper.set(value, wrapper);
    return wrapper;
  }
  if (isBytevectorLike(value)) return value;
  if (value instanceof Promise) return value;
  if (value !== null && typeof value === "object") {
    const cached = jsToWrapper.get(value as object);
    if (cached) return cached;
    const wrapper: SchemeValue = new AJSObject(CONSTANT_CTX, value as object);
    jsToWrapper.set(value as object, wrapper);
    return wrapper;
  }

  // LEAVES — null/undefined/boolean/number/string/bigint/symbol/function — go through the SINGLE
  // faithful materialization (jsToScheme): primitives box (no raw leak), null→nil, undefined/
  // function/unique-symbol→#void+warn, Symbol.for→:keyword. Generalized rosetta behavior — a
  // borrowed JS function is no longer a callable AJSFunction (it is not portable; it is #void).
  return jsToScheme(CONSTANT_CTX, value, {}, EMPTY_PROVENANCE);
}

/**
 * Convert a Scheme value to a JavaScript value.
 * Exit point for Scheme → JS boundary crossing.
 */
export function toJS(value: unknown): unknown {
  // Check for wrapper protocol first
  if (value && typeof value === "object" && TO_JS in value) {
    return (value as Record<symbol, () => unknown>)[TO_JS]!();
  }

  // nil → null
  // `instanceof Nil`: see isSchemeValue above — provenance-bearing Nil clones must
  // also project to JS null at the boundary, otherwise they leak into the JS caller
  // as opaque Scheme objects.
  if (value instanceof ANil) return null;

  // Native Scheme types with valueOf
  if (value instanceof AString) return value.valueOf();
  if (value instanceof ACharacter) return value.valueOf();
  if (value instanceof AExact) return value.valueOf();
  if (value instanceof AInexact) return value.valueOf();

  // SchemeSymbol stays as-is (JS can call .toString() if needed)
  // Pair stays as-is (JS can work with car/cdr)

  // Everything else passes through
  return value;
}

// ============================================================================
// CODEC LAYER: Typed Bidirectional Conversion at FFI Boundaries
// ============================================================================

/**
 * Bidirectional type codec for FFI boundaries.
 *
 * Each codec co-locates three concerns at the definition site:
 * - match: runtime type guard (which values does this codec handle?)
 * - toJS: forward conversion (Scheme → JS)
 * - fromJS: backward conversion (JS → Scheme)
 *
 * @template S - Scheme side type
 * @template J - JavaScript side type
 */
export interface Codec<S, J> {
  /** Type guard: can this codec handle this value? */
  match(value: unknown): value is S;

  /** Forward: Scheme → JS */
  toJS(value: S): J;

  /** Backward: JS → Scheme */
  fromJS(value: J): S;
}

// ============================================================================
// Number Codecs
// ============================================================================

/** Any Scheme number ↔ JS number/bigint */
export const AnyNum: Codec<ANumeric, number | bigint> = {
  match(v): v is ANumeric {
    return v instanceof AExact || v instanceof AInexact;
  },

  toJS(v) {
    if (v instanceof AExact) {
      if (v.isInteger && v.num >= BigInt(Number.MIN_SAFE_INTEGER) && v.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(v.num);
      }
      if (v.isInteger) return v.num;
      return Number(v.num) / Number(v.denom);
    }
    return v.real;
  },

  fromJS(v) {
    if (typeof v === "bigint") {
      return new AExact(CONSTANT_CTX, v);
    }
    if (Number.isSafeInteger(v)) {
      return new AExact(CONSTANT_CTX, BigInt(v));
    }
    return new AInexact(CONSTANT_CTX, v);
  },
};

/** Exact integers ↔ JS bigint */
export const Int: Codec<AExact, bigint> = {
  match(v): v is AExact {
    return v instanceof AExact && v.isInteger;
  },
  toJS: (v) => v.num,
  fromJS: (v) => new AExact(CONSTANT_CTX, v),
};

/** Safe integers ↔ JS number (for bitwise ops etc.) */
export const SafeInt: Codec<AExact, number> = {
  match(v): v is AExact {
    return (
      v instanceof AExact &&
      v.isInteger &&
      v.num >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v.num <= BigInt(Number.MAX_SAFE_INTEGER)
    );
  },
  toJS: (v) => Number(v.num),
  fromJS: (v) => new AExact(CONSTANT_CTX, BigInt(v)),
};

/** Inexact reals ↔ JS number */
export const Real: Codec<AInexact, number> = {
  match(v): v is AInexact {
    return v instanceof AInexact && v.isReal;
  },
  toJS: (v) => v.real,
  fromJS: (v) => new AInexact(CONSTANT_CTX, v),
};

/** Any number as JS number (lossy for bigints and rationals) */
export const Num: Codec<ANumeric, number> = {
  match(v): v is ANumeric {
    return v instanceof AExact || v instanceof AInexact;
  },
  toJS(v) {
    if (v instanceof AExact) {
      return Number(v.num) / Number(v.denom);
    }
    return v.real;
  },
  fromJS(v) {
    if (Number.isSafeInteger(v)) {
      return new AExact(CONSTANT_CTX, BigInt(v));
    }
    return new AInexact(CONSTANT_CTX, v);
  },
};

// ============================================================================
// Boolean Profunctor
// ============================================================================

/** Scheme boolean ↔ JS boolean */
export const Bool: Codec<boolean, boolean> = {
  match(v): v is boolean {
    return typeof v === "boolean";
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

// ============================================================================
// String Profunctor
// ============================================================================

/** Scheme string ↔ JS string */
export const Str: Codec<string, string> = {
  match(v): v is string {
    return typeof v === "string";
  },
  toJS: (v) => v,
  fromJS: (v) => v,
};

// ============================================================================
// Void Profunctor (for side-effect functions)
// ============================================================================

/** Void/undefined ↔ undefined */
export const Void: Codec<undefined, undefined> = {
  match(v): v is undefined {
    return v === undefined;
  },
  toJS: () => {},
  fromJS: () => {},
};

// ============================================================================
// Type Utilities
// ============================================================================

type ExtractJS<P extends Codec<any, any>[]> = {
  [K in keyof P]: P[K] extends Codec<any, infer J> ? J : never;
};

type ExtractScheme<P extends Codec<any, any>> = P extends Codec<infer S, any> ? S : never;

type OperatorArgs<In extends Codec<any, any>[], InRest extends Codec<any, any> | undefined> =
  InRest extends Codec<any, infer J> ? [...ExtractJS<In>, ...J[]] : ExtractJS<In>;

// ============================================================================
// Operator Class
// ============================================================================

export interface OperatorConfig<
  In extends Codec<any, any>[],
  InRest extends Codec<any, any> | undefined,
  Out extends Codec<any, any>,
> {
  in: In;
  inRest?: InRest;
  out: Out;
  fn: (...args: OperatorArgs<In, InRest>) => ExtractJS<[Out]>[0];
}

export class Operator<
  In extends Codec<any, any>[] = Codec<any, any>[],
  InRest extends Codec<any, any> | undefined = undefined,
  Out extends Codec<any, any> = Codec<any, any>,
> {
  readonly in: In;
  readonly inRest?: InRest;
  readonly out: Out;
  readonly fn: (...args: OperatorArgs<In, InRest>) => ExtractJS<[Out]>[0];

  constructor(
    readonly name: string,
    config: OperatorConfig<In, InRest, Out>,
  ) {
    this.in = config.in;
    this.inRest = config.inRest;
    this.out = config.out;
    this.fn = config.fn;
  }

  /** Arity info for documentation/introspection */
  get arity(): { min: number; max: number | null } {
    return {
      min: this.in.length,
      max: this.inRest ? null : this.in.length,
    };
  }

  /** Factory with better generic inference */
  static create<
    const In extends Codec<any, any>[],
    const InRest extends Codec<any, any> | undefined,
    const Out extends Codec<any, any>,
  >(name: string, config: OperatorConfig<In, InRest, Out>): Operator<In, InRest, Out> {
    return new Operator(name, config);
  }

  call(args: unknown[]): ExtractScheme<Out> {
    const minArgs = this.in.length;

    TypeError.invariant(args.length >= minArgs, `${this.name}: expected at least ${minArgs} args, got ${args.length}`);
    TypeError.invariant(
      this.inRest || args.length <= minArgs,
      `${this.name}: expected ${minArgs} args, got ${args.length}`,
    );

    const jsArgs = args.map((arg, i) => {
      const prof = i < this.in.length ? this.in[i] : this.inRest!;
      TypeError.invariant(prof.match(arg), `${this.name}: argument ${i} type mismatch`);
      return prof.toJS(arg as any);
    });

    const jsResult = this.fn(...(jsArgs as any));
    return this.out.fromJS(jsResult);
  }
}

// ============================================================================
// Operator Registry
// ============================================================================

export class OperatorRegistry {
  private readonly operators = new Map<string, Operator<any, any, any>>();

  constructor(readonly name: string = "default") {}

  /** Register an operator */
  register(op: Operator<any, any, any>): this {
    this.operators.set(op.name, op);
    return this;
  }

  /** Register multiple operators */
  registerAll(...ops: Operator<any, any, any>[]): this {
    for (const op of ops) {
      this.register(op);
    }
    return this;
  }

  /** Get an operator by name */
  get(name: string): Operator<any, any, any> | undefined {
    return this.operators.get(name);
  }

  /** Check if operator exists */
  has(name: string): boolean {
    return this.operators.has(name);
  }

  /** Call an operator by name */
  call(name: string, args: unknown[]): unknown {
    const op = this.get(name);
    invariant(op, `${this.name}: unknown operator '${name}'`);
    return op.call(args);
  }

  /** List all operator names */
  keys(): string[] {
    return [...this.operators.keys()];
  }

  /** Create a child environment that inherits from this one */
  extend(name: string): OperatorRegistry {
    const child = new OperatorRegistry(name);
    // Copy all operators from parent
    for (const [key, op] of this.operators) {
      child.operators.set(key, op);
    }
    return child;
  }

  /** Create a restricted environment with only specified operators */
  restrict(name: string, allowList: string[]): OperatorRegistry {
    const restricted = new OperatorRegistry(name);
    for (const key of allowList) {
      const op = this.operators.get(key);
      if (op) {
        restricted.operators.set(key, op);
      }
    }
    return restricted;
  }
}

// (The "object" boxer — array→AJSArray / plain-object→AJSObject — and the "function" boxer
// — function→#void+warn — moved into fromJs's direct switch when the boxer registry dissolved.)

// ─────────────────────────────────────────────────────────────────────────────
// Polyglot member access — the interop read protocol (Graal `InteropLibrary`).
//
// arrival is a polyglot runtime, not a host with a fenced guest: a value is a
// value whichever language minted it. `readMember`/`hasMember`/`memberKeys` are
// the uniform `readMember`/`hasMember`/`getMembers` over any polyglot value —
// a native dict (a plain record of members), a membrane-exposed foreign value
// (`SchemeJSObject`, carrying provenance), or an array. Origin-agnostic by
// design: the rules below define what counts as a *readable member*, not a host
// defense. These back the `@`/`@?`/`@keys` surface (polyglot pack) and the
// `:key` keyword accessor — one protocol, two syntaxes.
//
//   • meta-members (`constructor`/`__proto__`/`prototype`, blocked inside
//     `accessMember`) and anything marked `@arrival.private` are not members of
//     the interop value — reading them yields nil, same as Graal hides a value's
//     meta-object from a peer language. (Privacy is `@arrival.private`'s job; there
//     is no `_`-prefix convention — a leading underscore is an ordinary member.)
//   • ONLY two kinds expose members: a foreign value (lazy proxy) routes through its
//     `SchemeJSObject.get` (provenance-cached), and a native dict (a plain record)
//     reads structurally. A scheme LEAF value (string / number / symbol / nil / pair),
//     a primitive, or a function is not a record — it has no members, so reading one
//     yields nil (never the AValue's internal `provenance`/`kind`). The dispatch
//     differs by value kind; the access logic is one.

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
  try {
    const source = obj instanceof AJSArray ? obj.source : obj;
    // Only a native dict (a plain record) or an array exposes members. A scheme
    // leaf value (string / number / symbol / nil / pair — a class instance), a
    // primitive, or a function is NOT a record: it has no members, and reading
    // one would expose interpreter internals (an AValue's `provenance`/`kind` are
    // OWN fields, which the boundary's prototype-walk guard does not stop). nil.
    if (!Array.isArray(source)) {
      const proto = typeof source === "object" && source !== null ? Object.getPrototypeOf(source) : false;
      if (proto !== Object.prototype && proto !== null) return nil;
    }
    const result = accessMember(source, keyStr);
    if (result === NOT_FOUND) return nil;
    // re-present a JS array as a polyglot array so car/cdr work on the result.
    if (Array.isArray(result)) {
      // ctx-threading rough edge (readMember is ctx-free): derive the run ctx from the
      // container being read; a non-AValue container (a native dict) falls back to CONSTANT_CTX.
      const ctx = obj instanceof AValue ? obj.ctx : CONSTANT_CTX;
      return new AJSArray(ctx, result);
    }
    return fromJS(result);
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
  const source = obj instanceof AJSObject ? obj.source : obj;
  return accessHas(source, keyStr);
}

/** `memberKeys(obj)` — the polyglot value's own member names. */
export function memberKeys(obj: unknown): string[] {
  if (obj == null) return [];
  const source = obj instanceof AJSObject ? obj.source : obj;
  return accessKeys(source);
}

/**
 * The `:key` keyword-accessor resolver — the catchall that makes any `:`-prefixed
 * symbol a member accessor. `:foo` resolves to `(lambda (arg) (@ arg :foo))` — the
 * SAME polyglot read as `@` (`readMember`), differing ONLY by the accessor-as-value
 * contract: applied to nothing the pluck returns itself, so it composes
 * (`(compose :a :b)`, `(->> p :versions last :state)`). A `:keyword` is thus a symbol
 * AND an `@`-alias at once. The pluck carries `KEYWORD_ACCESSOR_FIELD` so `dict` can
 * use a keyword as a literal key.
 *
 * Owned by the polyglot capability (env/polyglot.ts lists it in `resolvers`); also
 * registered imperatively on the hand-built bases (global_env / sandboxedEnv) until
 * they are pack-assembled. A catchall resolver, sibling to the `c[ad]+r` family.
 */
export const keywordAccessorResolver: ResolverSpec = {
  id: "keyword-accessor",
  resolve(name: string) {
    if (!name.startsWith(":")) return undefined;
    const key = name.slice(1);
    const pluck = Object.assign((obj: unknown) => (obj == null ? pluck : readMember(obj, key)), {
      valueOf: () => name,
      [KEYWORD_ACCESSOR_FIELD]: key,
    });
    return pluck;
  },
};

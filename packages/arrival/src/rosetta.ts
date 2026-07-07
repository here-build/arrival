/**
 * Scheme<->JS membrane: schemeToJs/jsToScheme marshal values at the FFI boundary,
 * round-tripping to identity in both directions (bifunctor framing — see
 * docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md).
 * Environment.defineRosetta() wraps a JS fn as a Scheme-callable rosetta.
 */

import { AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./values/primitives/AValue.js";
import { fromJs } from "./values/primitives/boxing.js";
import { CONSTANT_CTX, type RunContext } from "./values/primitives/RunContext.js";
import { deepProvenance } from "./values/deep-provenance.js";
import { ABool } from "./values/primitives/ABool.js";
import { ABytevector } from "./values/primitives/ABytevector.js";
import { AVector } from "./values/primitives/AVector.js";
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { ADict } from "./values/primitives/ADict.js";
import { AExact } from "./values/primitives/AExact.js";
import { AInexact } from "./values/primitives/AInexact.js";
import { APair } from "./values/primitives/APair.js";
import { ANil, nil } from "./values/primitives/ANil.js";
import { theVoid } from "./values/primitives/AVoid.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { LAMBDA } from "./well-known-symbols.js";
import { is_lambda } from "./values/value-guards.js";

// warnMembrane lives in the leaf membrane-warn.ts, shared with boxing.ts's `function`
// boxer, so the value layer needn't import this evaluator-heavy module just to warn.
// A non-portable JS value (function/undefined/unique symbol) crossing into Scheme has
// no faithful representation and materializes to #void — warnMembrane makes that edge visible.
import { warnMembrane } from "./membrane-warn.js";
import type { CallCtx } from "./values/primitives/CallCtx.js";
import { tf } from "./values/tagless-final.js";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
  /**
   * When true, attaches `ctx.argProvenance` — one DEEP provenance set per scheme
   * arg (union of every AValue reachable inside it). Needed because a `(list a b c)`
   * carries no provenance on its own spine, only its elements do — a shallow
   * `arg.provenance` read would miss per-element origins. Computed before
   * schemeToJs strips AValue identity.
   */
  argProvenance?: boolean;
}

type Fn = (...args: any[]) => any;

export interface RosettaFunction {
  fn: Fn;
  options?: RosettaOptions;
  /**
   * TS signature as an ambient `.d.ts` fragment, e.g. `"(ip: SchemeIP): SBool"`.
   * INERT at runtime — never read here; harvested by the node-only type-lens to
   * assemble `ArrShape` leaves, keeping type knowledge colocated with `fn` instead
   * of a parallel `.d.ts` that drifts. An author assertion over the `any` impl,
   * not mechanically derived. Base types come from the lens prelude; host types
   * (`SchemeIP`, row shapes) from the env's type-preamble.
   */
  type?: string;
  /**
   * Provenance role. Default (`pure` unset): the rosetta is a Rosetta-IN SOURCE —
   * it introduces external data, so its result MINTS a fresh provenance leaf
   * (conservative: never silently lose an origin). Set `pure: true` to declare
   * the fn only TRANSFORMS its args (e.g. `string-append`, `dedent`): its result
   * PROPAGATES the inputs' provenance instead of minting. An author assertion
   * over the `any` impl (JS purity is undecidable here), same trust model as
   * `type`. LIVE at runtime — gates `mintsPoint = pure !== true` in
   * createRosettaWrapper — and drives the static lineage classifier
   * (`isRosettaIn === !pure`, docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md §5).
   * Note: control/declaration forms (expose/approval/…) are effectful-but-not-
   * sourcing and also take `pure: true` for the no-mint behavior — a richer
   * source/pure/effectful taxonomy is deferred.
   */
  pure?: boolean;
}

/**
 * Duck-typed shape of EvalContext.currentInvocation — avoids a circular import
 * to arrival-chain/trace.ts (the real Invocation type; evaluator treats it as
 * `unknown`). Exported so common/symbol.ts reuses the same shape for its
 * provenance mint instead of re-spelling the cast.
 */
export interface InvocationLike {
  id: number;
  isProvenancePoint?: boolean;
  /**
   * MobX-action setter for isProvenancePoint (arrival-chain's real Invocation
   * provides it; a plain test POJO doesn't). Preferred over a raw field write —
   * MobX strict-mode, on in the studio, forbids that.
   */
  markProvenancePoint?(): void;
  /**
   * Binds node metadata (e.g. a `.prompt`'s file/model/inputs), called by the
   * rosetta fn at call time. Trace-side only — read by the render, never crosses
   * back into scheme. Same action-vs-POJO story as markProvenancePoint.
   */
  setMetadata?(meta: unknown): void;
}

export interface CtxWithInvocation {
  currentInvocation?: InvocationLike;
}

const isLipsPair = (x: unknown): x is { car: unknown; cdr: unknown } =>
  x != null && typeof x === "object" && "car" in x && "cdr" in x;

export function schemeToJs(value: any, options: RosettaOptions = {}): any {
  // `instanceof ANil` not `=== nil`: `nil.withProvenance(p)` mints fresh Nil
  // clones — reference equality would miss them and leak the clone to the caller.
  if (value == null || value instanceof ANil) return value;

  if (Array.isArray(value)) {
    return value.map((record) => schemeToJs(record, options));
  }

  // Unwrap to raw JS shapes — otherwise a boxed value leaks its internal
  // {kind,__vector__/__bytevector__,provenance} shape to JS callers (MCP/trace
  // serialization path).
  if (value instanceof AVector) {
    return value.__vector__.map((record) => schemeToJs(record, options));
  }
  if (value instanceof ABytevector) {
    return value.__bytevector__;
  }

  if (value instanceof AExact) {
    const val = value.valueOf();
    if (options.forceBigInt) {
      return typeof val === "bigint" ? val : BigInt(Math.round(val as number));
    }
    if (value.denom === 1n) {
      if (value.num >= BigInt(Number.MIN_SAFE_INTEGER) && value.num <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value.num);
      }
      return value.num;
    }
    return val;
  }

  if (value instanceof AInexact) {
    // Always a JS float — reals-only, complex axis omitted.
    return value.real;
  }

  if (value instanceof AJSObject) {
    return schemeToJs(value.source, options);
  }

  // ADict's own toJs stays shallow; this is the one place owning the recursive
  // JS-primitive projection for every boxed type.
  if (value instanceof ADict) {
    const out: Record<string, unknown> = {};
    for (const k of value.keys()) out[k] = schemeToJs(value.get(k), options);
    return out;
  }

  if (value instanceof AJSArray) {
    return value.source.map((el: any) => schemeToJs(el, options));
  }

  if (value instanceof ABool) {
    return value.value;
  }

  if (value && typeof value === "object") {
    if ("__string__" in value && typeof value.__string__ === "string") {
      return value.__string__;
    }
    // Lisp treats empty-list and nil as the same entity: if cdr eventually
    // resolves to nil while materializing an array, that's the array's tail.
    if (isLipsPair(value)) {
      const head = schemeToJs(value.car, options);
      const tail = schemeToJs(value.cdr, options) ?? [];
      if (Array.isArray(tail)) {
        return [head, ...tail];
      } else if (tail instanceof ANil) {
        // Class check, not `=== nil`: a provenance-bearing Nil clone must still
        // terminate the list, or the tail leaks as `[head, <Nil-clone>]`.
        return [head];
      } else {
        return [head, tail];
      }
    }
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      // `Object.entries` drops symbol-keyed properties (opaque/private backing data
      // crossing the membrane) — enumerate string keys then own symbols so both survive.
      const out: Record<string | symbol, unknown> = {};
      for (const key of Object.keys(value)) out[key] = schemeToJs((value as Record<string, unknown>)[key], options);
      for (const sym of Object.getOwnPropertySymbols(value)) {
        out[sym] = schemeToJs((value as Record<symbol, unknown>)[sym], options);
      }
      return out;
    }
    // Check for sequence-op terms before converting to a plain object — a value
    // carrying its own map/filter/reduce is a structure to preserve, not unwrap.
    if (value[tf("map")] !== undefined || value[tf("filter")] !== undefined || value[tf("reduce")] !== undefined) {
      return value;
    }

    // todo traverse enumerable fields?
  }

  if (typeof value === "number" && options.forceBigInt) {
    return BigInt(value);
  }

  return value;
}

/**
 * JS → Scheme deep-stamping membrane. Single pass: every AValue constructed on
 * the way down inherits the supplied `provenance` set, so downstream extractors
 * (`car`, `cdr`, `dict-ref`, `@`) see element-only lineage carrying the rosetta's
 * origin id (spec §5.3 Interpretation A) without a separate re-stamp per builtin.
 *
 * Plain JS objects become `SchemeJSObject`, entries boxed lazily on `.get(key)`
 * so the wrapper's cache amortizes the cost instead of paying full traversal
 * up front.
 *
 * `seen: WeakSet` terminates cycles on the JS-input side: a cyclic reference is
 * returned as-is, since the caller's outer Pair/SchemeJSObject already carries
 * the provenance and the cycle re-enters that wrapper rather than allocating an
 * infinite spine.
 */
export function jsToScheme(
  ctx: RunContext,
  value: any,
  options: RosettaOptions = {},
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  seen: WeakSet<object> = new WeakSet(),
): any {
  // null → nil. undefined has no portable Scheme value (host-agnostic interpreter),
  // so it materializes to the unspecified value, loudly.
  if (value === null) {
    return provenance === EMPTY_PROVENANCE ? nil : new ANil(ctx, provenance);
  }
  if (value === undefined) {
    warnMembrane("a JS `undefined`");
    return theVoid;
  }

  // Cycle in JS-side input — return as-is; the caller's outer wrapper already
  // carries the stamp, so this just stops infinite recursion.
  if (typeof value === "object" && seen.has(value)) return value;
  if (typeof value === "object") seen.add(value);

  // Already-AValue: same-provenance fast path preserves identity. Pair/AVector
  // recurse so children inherit the new lineage; other leaves go through
  // `withProvenance` (SchemeJSObject entries stay lazy via `.get`).
  if (value instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === value.provenance) return value;
    if (value instanceof APair) {
      return new APair(
        ctx,
        jsToScheme(ctx, value.car, options, provenance, seen),
        jsToScheme(ctx, value.cdr, options, provenance, seen),
        provenance,
      );
    }
    if (value instanceof AVector) {
      return new AVector(
        ctx,
        value.__vector__.map((el) => jsToScheme(ctx, el, options, provenance, seen)),
        provenance,
      );
    }
    return value.withProvenance(provenance);
  }

  // JS array → borrowed VECTOR: a JS array IS an R7RS vector, the faithful mapping.
  // AJSArray keeps the source reference and boxes elements lazily on access.
  if (Array.isArray(value)) {
    return new AJSArray(ctx, value, provenance);
  }

  // Lazy entries via .get cache.
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return new AJSObject(ctx, value as object, provenance);
  }

  // JS primitives → the boxer registry (number/bigint→exact/inexact, boolean→ABool,
  // string→AString) — never raw, so the sandbox only ever holds boxed AValues.
  const tag = typeof value;
  if (tag === "string" || tag === "number" || tag === "boolean" || tag === "bigint") {
    return fromJs(ctx, value, provenance);
  }

  // A REGISTERED JS symbol (`Symbol.for('x')`) has a portable string key → the keyword `:x`.
  // A UNIQUE symbol (`Symbol('x')`) has no portable identity → #void + warn (like a function).
  if (tag === "symbol") {
    const key = Symbol.keyFor(value as symbol);
    if (key !== undefined) return new ASymbol(ctx, `:${key}`, provenance);
    warnMembrane("a unique JS symbol");
    return theVoid;
  }

  // A Scheme LAMBDA is a plain JS function carrying the well-known LAMBDA brand
  // (set by the evaluator on every closure — well-known-symbols.ts). It's already
  // a scheme value, not host data, so it passes through untouched. Without this
  // check, a `require`d `.prompt`/`.hbs` CALLABLE-RULE lambda gets voided the
  // moment it flows back through `require`'s own rosetta wrapper.
  if ((tag === "function" && LAMBDA in value) || is_lambda(value)) {
    return value;
  }

  // A borrowed JS function is not a Scheme value — exposing it as callable would
  // let Scheme escape the sandbox into uncontrolled JS — so it voids, loudly.
  if (tag === "function") {
    warnMembrane("a JS function");
    return theVoid;
  }

  // Exotic objects (Promise, Buffer, …): the caller's responsibility.
  return value;
}

/**
 * Duck-types the evaluator-appended trailing arg as an EvalContext.
 *
 * Every rosetta wrapper receives ctx from the evaluator and must strip it —
 * but direct test calls (no evaluator) may pass a real scheme value as the
 * last arg, and stripping unconditionally would eat it. So strip only when
 * the trailing arg LOOKS like a context.
 *
 * Unambiguous because: by the time a wrapper runs under the evaluator, scheme
 * DATA args are already evaluated (AValue subclasses, SchemeJSObject, raw
 * arrays/primitives) — a genuine EvalContext is the only raw plain object
 * carrying `resolver`/`currentInvocation`/`tap`/`signal` that reaches here.
 * `resolver` alone suffices (set on every EvalContext the evaluator threads);
 * the others are a belt-and-braces OR for future ctx shapes.
 */
export const looksLikeEvalContext = (x: unknown): x is Record<string, unknown> & Partial<CtxWithInvocation> =>
  x != null &&
  typeof x === "object" &&
  !(x instanceof AValue) &&
  !Array.isArray(x) &&
  ("resolver" in x || "currentInvocation" in x || "tap" in x || "signal" in x);

export const createRosettaWrapper = ({ fn, options = {}, pure = false }: RosettaFunction) => {
  // `pure: true` propagates inputs' provenance and mints nothing — sound only if the
  // rosetta doesn't mutate its inputs. Enforced by construction: borrowed JS inputs
  // (AJSObject/AJSArray) freeze their source on first read, so a pure rosetta
  // physically cannot mutate them. See `freezeSource` / `freezeRosettaReturns`.
  const mintsPoint = pure !== true;

  return async function rosettaWrapper(this: CallCtx, ...schemeArgs: any[]) {
    // Collect provenance from AValue inputs before schemeToJs strips AValue
    // identity (and the provenance field with it) down to JS primitives.
    const inputAValues = schemeArgs.filter((a): a is AValue => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

    // Per-arg deep provenance (opt-in), aligned to schemeArgs — lets a consumer fn
    // (e.g. a `.prompt` building `inputsProvenance[field]`) attribute each input to
    // its producer, recovering per-field origins the union can no longer distinguish.
    const argProvenance = options.argProvenance === true ? schemeArgs.map(deepProvenance) : undefined;

    // `this?.` throughout: tests call the wrapper directly via `.call({ ctx: {} }, …)`,
    // not only through `makeCallCtx` dispatch, so `this` may be any object or absent.
    const runCtx = this?.runCtx ?? CONSTANT_CTX;
    try {
      const rawResult = await fn.apply(
        { ctx: { runCtx, currentInvocation: this?.invocation?.currentInvocation, argProvenance } },
        schemeArgs.map((arg) => schemeToJs(arg, options)),
      );

      const inv = this?.invocation?.currentInvocation as InvocationLike | undefined;

      // Decide output provenance before jsToScheme so the deep-stamp reaches every
      // constructed AValue in one pass (spec §5.3) — the mint overrides inputs.
      // No invocation in ctx (e.g. direct JS calls in tests): fall back to input
      // provenance, silently. Node metadata is bound separately via
      // `ctx.currentInvocation.setMetadata(…)` — known up front, doesn't ride the result.
      let resultProvenance = inputProvenance;
      if (mintsPoint && inv && typeof inv.id === "number") {
        // MobX observable — flip via its own action for strict-mode safety.
        // A plain POJO (direct-JS tests) has no method, so set directly.
        if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
        else inv.isProvenancePoint = true;
        resultProvenance = pointProvenance(inv.id);
      }

      const result = jsToScheme(runCtx, rawResult, options, resultProvenance);
      return options.returnEither ? [result, nil] : result;
    } catch (error) {
      console.error("Rosetta function error:", error);
      if (options.returnEither) {
        return [nil, error];
      } else {
        throw error;
      }
    }
  };
};

declare module "@here.build/arrival" {
  interface Environment {
    defineRosetta(name: string, config: RosettaFunction): void;
  }
}

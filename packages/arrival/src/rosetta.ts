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
import { is_callable_value } from "./values/value-guards.js";
import { applyCallback, type ACallable } from "./values/primitives/ACallable.js";
import {
  closeRegionScope,
  currentRegionScope,
  DETACHED_SCOPE,
  openRegionScope,
  withRegionCall,
  withRegionScope,
} from "./values/primitives/region-scope.js";
// A leaf with ZERO imports of its own — see that file's header for why the
// ambient dynamic-call-site holder lives there rather than in eval/evaluator.ts
// (which this module cannot import without closing a cycle: evaluator.ts →
// Environment.ts → rosetta.ts already).
import { withDynamicCallSite } from "./eval/dynamic-call-site.js";

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

/**
 * The reverse-membrane wrapper (docs/working-proposals/
 * reverse-membrane-for-callables.md §4/§7c): a scheme callable crossing
 * scheme→JS becomes a region-scoped async JS function. Reads whichever
 * `RegionScope` is AMBIENT right now (`currentRegionScope()` — see
 * `region-scope.ts`'s header for why it's ambient) and CLOSES OVER it: the
 * wrapper never re-reads the holder, so a call arriving after the exporting
 * symbol invocation returned still sees the (by-then closed) scope it was
 * minted against — that's what makes the escape door detectable at all.
 *
 * Per-(callable, scope) identity: `scope.cache` is a WeakMap owned by the
 * scope itself, so the SAME callable exported twice through the SAME scope
 * gets back the SAME wrapper (eq?-stability), while two DIFFERENT scopes
 * (two invocations) each mint their own.
 */
function callableToHostFn(value: ACallable, options: RosettaOptions): (...args: unknown[]) => unknown {
  const scope = currentRegionScope() ?? DETACHED_SCOPE;
  const cached = scope.cache.get(value);
  if (cached) return cached;
  const wrapper = (...jsArgs: unknown[]): Promise<unknown> =>
    withRegionCall(scope, async () => {
      // Args mint under the ENCLOSING invocation's runCtx, never CONSTANT_CTX
      // (§7b) — `scope.runCtx` is exactly that (or CONSTANT_CTX itself, for the
      // detached fallback, which never claimed otherwise).
      const schemeArgs = jsArgs.map((a) => jsToScheme(scope.runCtx, a, options));
      // The re-entry's trace nests under the exporting invocation (§7b's "child
      // scope"), via the SAME ambient mechanism the evaluator's own HOF-boundary
      // wrappers use — never through the callable's `this` (§9's ruling).
      const raw = await withDynamicCallSite(scope.dynSite, () => applyCallback(value, schemeArgs, scope.runCtx));
      // A nested callable inside the result crosses under the SAME scope — one
      // discipline for the whole re-entry, not just its top-level return value.
      return withRegionScope(scope, () => schemeToJs(raw, options));
    });
  scope.cache.set(value, wrapper);
  return wrapper;
}

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

  // A scheme callable crossing OUT becomes a region-scoped JS wrapper — the
  // reverse-membrane crossing (§4/§7c). One branch before generic object
  // handling: an ACallable would otherwise fall through as an uncallable
  // opaque object (the exact bug this migration fixes — see the working
  // proposal's "New finding" on an ALambda reaching host impls uncallable).
  if (is_callable_value(value)) {
    return callableToHostFn(value, options);
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

  // A Scheme lambda is an ALambda VALUE (reverse-membrane-for-callables.md §3 step 1: the
  // legacy `[LAMBDA]`-branded bare-fn producer, named-let's loopFn, is gone — every scheme
  // lambda is an ALambda now, an `AValue` subclass caught by the `instanceof AValue` branch
  // above, which returns before reaching this point). A `require`d `.prompt`/`.hbs`
  // CALLABLE-RULE lambda round-trips through that branch, not this one.

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
    const inv = this?.invocation?.currentInvocation as InvocationLike | undefined;
    // Region discipline (§7c): this ONE call — from here to `fn.apply` settling —
    // is the "symbol invocation" any scheme callable among `schemeArgs` gets
    // region-bound to. Opened before marshaling (a callable arg's wrapper is
    // minted DURING `schemeToJs`, which reads the ambient scope), closed the
    // moment `fn` settles (rule 2: throws if a reverse call is still pending).
    const scope = openRegionScope({ runCtx, dynSite: inv });
    try {
      let rawResult: unknown;
      try {
        rawResult = await fn.apply(
          { ctx: { runCtx, currentInvocation: inv, argProvenance } },
          withRegionScope(scope, () => schemeArgs.map((arg) => schemeToJs(arg, options))),
        );
      } finally {
        closeRegionScope(scope);
      }

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

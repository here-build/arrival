/**
 * Scheme<->JS membrane: schemeToJs/jsToScheme marshal values at the FFI boundary,
 * round-tripping to identity in both directions (bifunctor framing — see
 * docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md).
 * Environment.defineRosetta() wraps a JS fn as a Scheme-callable rosetta.
 */

import { AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./values/primitives/AValue.js";
import { fromJs } from "./values/primitives/boxing.js";
import { type RunContext } from "./values/primitives/RunContext.js";
import { deepProvenance } from "./values/deep-provenance.js";
import { AVector } from "./values/primitives/AVector.js";
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { AExact } from "./values/primitives/AExact.js";
import { APair } from "./values/primitives/APair.js";
import { ANil, nil } from "./values/primitives/ANil.js";
import { theVoid } from "./values/primitives/AVoid.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { AString } from "./values/primitives/AString.js";
import { is_callable_value } from "./values/value-guards.js";
import { applyCallback, type ACallable } from "./values/primitives/ACallable.js";
import { type AUnwrap, type AWrap, type SchemeBounceMarker, type SchemeValue } from "./values/types.js";
import invariant from "tiny-invariant";
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
import { makeCallCtx, missingCallCtxDoor, type CallCtx } from "./values/primitives/CallCtx.js";
import { tf } from "./values/tagless-final.js";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
  /**
   * When true, attaches `this.argProvenance` (flat `CallCtx`, not a nested `ctx.…`) —
   * one DEEP provenance set per scheme arg (union of every AValue reachable inside it).
   * Needed because a `(list a b c)` carries no provenance on its own spine, only its
   * elements do — a shallow `arg.provenance` read would miss per-element origins.
   * Computed before schemeToJs strips AValue identity.
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
/** `applyCallback`'s `CallResult` structurally admits a trampoline bounce token
 *  (`SchemeBounceMarker`) alongside `SchemeValue` — types.ts's own doc names the
 *  invariant this narrows: a bounce "never reaches a value slot," the call
 *  boundary always narrows it out first. `callableToHostFn` is exactly that
 *  boundary for a reverse-membrane re-entry's result, so it asserts the
 *  invariant explicitly rather than widening `schemeToJs`'s honest input type
 *  to tolerate a shape that should be structurally impossible here. */
function isBounceMarker(x: unknown): x is SchemeBounceMarker {
  return typeof x === "object" && x !== null && (x as Partial<SchemeBounceMarker>).__bounce === true;
}

/** A callable's JS projection IS the region wrapper (not a print string).
 *  Called from schemeToJsImpl's own is_callable_value branch AND exported for
 *  membrane.toJS()'s matching special-case (which is where a plain `toJS`/exec
 *  simple-tier exit routes a callable) — kept out of ACallable's `arrival/toJS`
 *  so that class need not import rosetta.ts (scheme-zod init cycle). */
export function callableToHostFn(value: ACallable, options: RosettaOptions): (...args: unknown[]) => unknown {
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
      invariant(!isBounceMarker(raw), "callableToHostFn: a reverse-membrane call resolved to a bounce token");
      // A nested callable inside the result crosses under the SAME scope — one
      // discipline for the whole re-entry, not just its top-level return value.
      return withRegionScope(scope, () => schemeToJs(raw, options));
    });
  scope.cache.set(value, wrapper);
  return wrapper;
}

/** Terminal-passthrough door (P5): every AValue subclass (or other boxed shape)
 *  needs an explicit branch in schemeToJsImpl's instanceof chain — silently
 *  returning an unrecognized one would leak its internal representation
 *  (kind/provenance/…) to a JS caller expecting a plain value. Fail loudly at
 *  the crossing instead of three calls later as a weird problem (P5's own
 *  words, docs/PRINCIPLES.md). Named + exported so a caller can `instanceof`
 *  it in a catch, same shape as region-scope.ts's door functions. */
export function schemeToJsUnrecognizedDoor(value: object): Error {
  return new Error(
    `schemeToJs: no conversion for ${value.constructor?.name ?? "<anonymous object>"} — every boxed ` +
      "shape needs an explicit branch in schemeToJs's instanceof chain (rosetta.ts). Silently " +
      "returning it would leak the value's internal representation to a JS caller expecting a " +
      "plain value; the membrane fails loudly at the crossing instead (P5, docs/PRINCIPLES.md).",
  );
}

/**
 * The recursive body behind `schemeToJs`. `unknown`-typed, not `any`: the
 * recursion crosses through raw JS intermediates a single generic parameter
 * can't describe end-to-end (a raw arg array's element, a plain object's own
 * field) — see `schemeToJs`'s doc for the one narrowing this buys back at the
 * public boundary.
 *
 * LAZY, not materializing: every boxed shape delegates to its own
 * `arrival/toJS` term (one protocol, class-owned — P7). Containers therefore
 * egress as the R9 lazy readonly proxies (AVector/APair → readonly array,
 * ADict → readonly recursive object proxy; egress-proxy.ts), borrowed
 * AJSObject/AJSArray unwrap to their `source` IDENTITY (the A3 borrowed-
 * identity law: boxes a fixture planted in a borrowed source are JS-side
 * data the membrane must not rewrite), and callables become inverse-rosetta
 * region wrappers. The former ~90-line eager `instanceof` chain — a second,
 * parallel statement of the toJS protocol that deep-copied every container —
 * is dissolved. What remains HERE is only the rosetta-specific surface the
 * protocol doesn't know: the `forceBigInt` option, elementwise crossing of
 * RAW JS containers (rosetta arg/result marshalling can hand a raw array or
 * plain object whose ELEMENTS are boxed — trace/MCP serialization included),
 * the sequence-op-term preserve, the FFI allow-list, and the P5 door.
 */
function schemeToJsImpl(value: unknown, options: RosettaOptions): unknown {
  // null/undefined echo back unchanged (matching AUnwrap's non-SchemeValue arm).
  if (value == null) return value;

  // Rosetta-only numeric option — decided BEFORE protocol dispatch, because it
  // overrides AExact's own `arrival/toJS` (safe-range number-else-bigint) and
  // applies to raw numbers too.
  if (options.forceBigInt) {
    if (value instanceof AExact) {
      const val = value.valueOf();
      return typeof val === "bigint" ? val : BigInt(Math.round(val as number));
    }
    if (typeof value === "number") return BigInt(value);
  }

  // A scheme callable crossing OUT becomes a region-scoped JS wrapper — the
  // reverse-membrane crossing (§4/§7c). Checked BEFORE the generic protocol
  // dispatch (a callable IS an AValue) so this rosetta face threads its
  // OPTIONS into the wrapper's re-entry marshalling; the protocol's own
  // `arrival/toJS` on ACallable (options-less, used by plain `toJS`/exec)
  // builds the same wrapper with defaults.
  if (is_callable_value(value)) {
    return callableToHostFn(value, options);
  }

  // Every other boxed shape: ONE protocol dispatch via the class's own
  // `arrival/toJS` term (NOT membrane.toJS — that would close a module-init
  // cycle rosetta→membrane→evaluator that leaves scheme-zod's z.instanceof
  // codecs capturing undefined classes). Scalars unwrap (ABool → boolean,
  // AString → string, ACharacter → char, AExact/AInexact → number/bigint,
  // ANil → null), containers egress as the R9 lazy readonly proxies
  // (egress-proxy.ts's chokepoint keeps same-box → same-proxy), borrowed
  // wrappers return their source identity, ABytevector its raw Uint8Array.
  // (Callables were already handled above; a control form like Macro/Syntax
  // is never a value and cannot reach schemeToJs.)
  if (value instanceof AValue) {
    return value["arrival/toJS"]();
  }

  // RAW containers (never boxed): rosetta arg/result marshalling and the
  // trace/MCP serialization path hand raw arrays/objects whose ELEMENTS may be
  // boxed — cross elementwise so no AValue leaks into JSON.
  if (Array.isArray(value)) {
    return value.map((record) => schemeToJsImpl(record, options));
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      // `Object.entries` drops symbol-keyed properties (opaque/private backing data
      // crossing the membrane) — enumerate string keys then own symbols so both survive.
      const out: Record<string | symbol, unknown> = {};
      for (const key of Object.keys(value))
        out[key] = schemeToJsImpl((value as Record<string, unknown>)[key], options);
      for (const sym of Object.getOwnPropertySymbols(value)) {
        out[sym] = schemeToJsImpl((value as Record<symbol, unknown>)[sym], options);
      }
      return out;
    }
    // A raw value carrying its own map/filter/reduce terms is a structure to
    // preserve, not unwrap (sequence-op contract objects).
    if (
      (value as Record<PropertyKey, unknown>)[tf("map")] !== undefined ||
      (value as Record<PropertyKey, unknown>)[tf("filter")] !== undefined ||
      (value as Record<PropertyKey, unknown>)[tf("reduce")] !== undefined
    ) {
      return value;
    }
    // Raw FFI passthrough — never boxed, caller's responsibility (mirrors
    // jsToScheme's own "Exotic objects (Promise, Buffer, …)" carve-out on the
    // inbound side): binary/async values that cross without ever having been
    // a scheme value aren't a membrane violation to throw on.
    if (
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer ||
      value instanceof DataView ||
      value instanceof Promise ||
      (typeof Buffer !== "undefined" && value instanceof Buffer)
    ) {
      return value;
    }
    throw schemeToJsUnrecognizedDoor(value);
  }

  // A bare scalar (string/number/boolean/bigint under !forceBigInt) that was
  // never boxed in the first place — already JS, correctly returned as-is.
  return value;
}

/**
 * Scheme → JS membrane exit. Honestly typed via `AUnwrap<T>` (values/types.ts):
 * `T extends SchemeValue` returns the exact JS shape that scheme value
 * unwraps into; `null`/`undefined` (accepted the same as every scheme value,
 * `value == null` short-circuits above) echo back unchanged, matching runtime.
 * `schemeToJsImpl` carries the real recursion (see its own doc for why it's
 * `unknown`-typed) — this wrapper is the ONE sanctioned narrowing (P3): the
 * cast target is the exact conditional type this function's contract
 * promises, never `as any`/`as unknown`.
 */
export function schemeToJs<T extends SchemeValue | null | undefined>(
  value: T,
  options: RosettaOptions = {},
): T extends SchemeValue ? AUnwrap<T> : T {
  return schemeToJsImpl(value, options) as T extends SchemeValue ? AUnwrap<T> : T;
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
/**
 * The recursive body behind `jsToScheme`. `unknown`-typed, not `any`: each
 * recursive call descends into a DIFFERENT static shape than its caller (an
 * array element, a Pair's car/cdr) that no single generic parameter can
 * describe across the whole recursion — see `jsToScheme`'s doc for the one
 * narrowing this buys back at the public boundary.
 */
function jsToSchemeImpl(
  ctx: RunContext,
  value: unknown,
  options: RosettaOptions,
  provenance: ReadonlySet<number>,
  seen: WeakSet<object>,
): unknown {
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
      // ONE well-commented internal narrowing (P3), same limit as the public wrapper's own
      // cast: jsToSchemeImpl's honest return is `unknown` (two branches — the cycle
      // shortcut above and the exotic-object passthrough below — genuinely don't produce a
      // SchemeValue), but a Pair's car/cdr always ARE one on every OTHER path, and
      // APair<Car, Cdr>'s constructor requires it. Recursive conditional generics can't
      // re-verify that fact through the recursion (the AWrap/AUnwrap tuple-wrap lesson).
      return new APair(
        ctx,
        jsToSchemeImpl(ctx, value.car, options, provenance, seen) as SchemeValue,
        jsToSchemeImpl(ctx, value.cdr, options, provenance, seen) as SchemeValue,
        provenance,
      );
    }
    if (value instanceof AVector) {
      // Same narrowing as the APair arm above — a vector's own elements are always
      // SchemeValue-shaped on every path but the two documented exceptions.
      return new AVector(
        ctx,
        value.__vector__.map((el) => jsToSchemeImpl(ctx, el, options, provenance, seen) as SchemeValue),
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
 *
 * Honestly typed via `AWrap<T>` (values/types.ts): the caller's static JS
 * input type determines the exact AValue shape returned. `jsToSchemeImpl`
 * carries the real recursion (see its own doc for why it's `unknown`-typed) —
 * this wrapper is the ONE sanctioned narrowing (P3): the cast target is the
 * exact conditional type this function's contract promises, never
 * `as any`/`as unknown`.
 */
export function jsToScheme<T>(
  ctx: RunContext,
  value: T,
  options: RosettaOptions = {},
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  seen: WeakSet<object> = new WeakSet(),
): AWrap<T> {
  return jsToSchemeImpl(ctx, value, options, provenance, seen) as AWrap<T>;
}

export const createRosettaWrapper = ({ fn, options = {}, pure = false }: RosettaFunction) => {
  // `pure: true` propagates inputs' provenance and mints nothing — sound only if the
  // rosetta doesn't mutate its inputs. Enforced by construction: borrowed JS inputs
  // (AJSObject/AJSArray) freeze their source on first read, so a pure rosetta
  // physically cannot mutate them. See `freezeSource` / `freezeRosettaReturns`.
  const mintsPoint = pure !== true;

  return async function rosettaWrapper(this: CallCtx, ...schemeArgs: SchemeValue[]) {
    // Collect provenance from AValue inputs before schemeToJs strips AValue
    // identity (and the provenance field with it) down to JS primitives.
    // `Extract<SchemeValue, AValue>`, not the abstract `AValue` base: SchemeValue's few
    // non-AValue members (EOF/Values/R7RSError/the bare-fn AProcedure arm) fail the
    // reverse assignability TS's `filter` predicate needs, and `AValue` itself is missing
    // fields some concrete members (e.g. ARosettaProcedure's arity/contract) require —
    // Extract picks exactly the union members `instanceof AValue` actually recognizes.
    const inputAValues = schemeArgs.filter((a): a is Extract<SchemeValue, AValue> => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

    // Per-arg deep provenance (opt-in), aligned to schemeArgs — lets a consumer fn
    // (e.g. a `.prompt` building `inputsProvenance[field]`) attribute each input to
    // its producer, recovering per-field origins the union can no longer distinguish.
    const argProvenance = options.argProvenance === true ? schemeArgs.map(deepProvenance) : undefined;

    // R-CTX-3 (rosetta-ctx-single-channel.md): `this` is mandatory — every real dispatch
    // path (evaluator apply, the four binder adapters) constructs a real CallCtx via
    // makeCallCtx; a direct call must too (the sanctioned `testCallCtx()` idiom, R-CTX-4).
    // A missing/malformed `this` hits the taught door below instead of silently degrading
    // to CONSTANT_CTX — that silent fallback is exactly what hid the B2-rosetta mint
    // regression until conservation.law caught it.
    if (this == null || this.runCtx == null || this.invocation == null) throw missingCallCtxDoor("rosettaWrapper");
    const runCtx = this.runCtx;
    const inv = this.invocation.currentInvocation as InvocationLike | undefined;
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
          makeCallCtx(runCtx, inv, argProvenance),
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

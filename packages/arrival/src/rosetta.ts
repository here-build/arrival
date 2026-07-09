/**
 * Scheme<->JS membrane: schemeToJs/jsToScheme marshal at FFI boundary, round-trip to identity both directions (bifunctor framing — see docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md).
 * Environment.defineRosetta() wraps JS fn as Scheme-callable rosetta.
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
// Leaf, ZERO own imports — see dynamic-call-site.ts header: ambient holder lives there, not eval/evaluator.ts (would close cycle: evaluator.ts → Environment.ts → rosetta.ts).
import { withDynamicCallSite } from "./eval/dynamic-call-site.js";

// warnMembrane lives in leaf membrane-warn.ts, shared with boxing.ts `function` boxer — value layer needn't import evaluator-heavy module just to warn.
// Non-portable JS value (function/undefined/unique symbol) crossing to Scheme: no faithful repr → #void; warnMembrane makes edge visible.
import { warnMembrane } from "./membrane-warn.js";
import { makeCallCtx, missingCallCtxDoor, type CallCtx } from "./values/primitives/CallCtx.js";
import { tf } from "./values/tagless-final.js";

interface RosettaOptions {
  forceBigInt?: boolean;
  returnEither?: boolean;
  /**
   * When true, attaches `this.argProvenance` (flat `CallCtx`, not nested `ctx.…`) — one DEEP provenance set per scheme arg (union of every reachable AValue). Needed: `(list a b c)` carries no spine provenance, only elements — shallow `arg.provenance` misses per-element origins. Computed before schemeToJs strips AValue identity.
   */
  argProvenance?: boolean;
}

type Fn = (...args: any[]) => any;

export interface RosettaFunction {
  fn: Fn;
  options?: RosettaOptions;
  /**
   * TS signature as ambient `.d.ts` fragment, e.g. `"(ip: SchemeIP): SBool"`. INERT at runtime — never read here; harvested by node-only type-lens to assemble `ArrShape` leaves, colocated with `fn` (not a parallel `.d.ts` that drifts). Author assertion over `any` impl, not mechanically derived. Base types from lens prelude; host types (`SchemeIP`, row shapes) from env type-preamble.
   */
  type?: string;
  /**
   * Provenance role. Default (`pure` unset): Rosetta-IN SOURCE — introduces external data, result MINTS fresh provenance leaf (conservative: never silently lose origin). `pure: true`: fn only TRANSFORMS args (e.g. `string-append`, `dedent`), result PROPAGATES inputs' provenance. Author assertion over `any` impl (JS purity undecidable), same trust model as `type`. LIVE — gates `mintsPoint = pure !== true` in createRosettaWrapper, drives static lineage classifier (`isRosettaIn === !pure`, docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md §5). Control/declaration forms (expose/approval/…) take `pure: true` for no-mint — richer taxonomy deferred.
   */
  pure?: boolean;
}

/**
 * Duck-typed EvalContext.currentInvocation — avoids circular import to arrival-chain/trace.ts (real Invocation type; evaluator treats as `unknown`). Exported so common/symbol.ts reuses shape for provenance mint, not re-spelling cast.
 */
export interface InvocationLike {
  id: number;
  isProvenancePoint?: boolean;
  /**
   * MobX-action setter for isProvenancePoint (arrival-chain Invocation provides it; plain test POJO doesn't). Preferred over raw field write — MobX strict-mode (on in studio) forbids.
   */
  markProvenancePoint?(): void;
  /**
   * Binds node metadata (e.g. `.prompt`'s file/model/inputs), called by rosetta fn at call time. Trace-side only — read by render, never crosses to scheme. Same action-vs-POJO as markProvenancePoint.
   */
  setMetadata?(meta: unknown): void;
}

/**
 * Reverse-membrane wrapper (docs/working-proposals/reverse-membrane-for-callables.md §4/§7c): scheme callable crossing scheme→JS becomes region-scoped async JS fn. Reads AMBIENT `RegionScope` (`currentRegionScope()` — see region-scope.ts header) and CLOSES OVER it: wrapper never re-reads, so a call arriving after exporting invocation returns still sees (closed) scope minted against — that makes escape door detectable.
 * Per-(callable, scope) identity: `scope.cache` is scope-owned WeakMap — SAME callable exported twice through SAME scope gets SAME wrapper (eq?-stability); two scopes (two invocations) each mint own.
 */
/** `applyCallback`'s `CallResult` admits trampoline bounce token (`SchemeBounceMarker`) alongside `SchemeValue` — types.ts doc names invariant: bounce "never reaches a value slot," call boundary narrows it out first. `callableToHostFn` is that boundary for reverse-membrane re-entry result, asserts invariant explicitly vs widening `schemeToJs` input type to tolerate structurally impossible shape. */
function isBounceMarker(x: unknown): x is SchemeBounceMarker {
  return typeof x === "object" && x !== null && (x as Partial<SchemeBounceMarker>).__bounce === true;
}

/** Callable's JS projection IS region wrapper (not print string). Called from schemeToJsImpl is_callable_value branch AND exported for membrane.toJS() matching special-case (where plain `toJS`/exec simple-tier exit routes callable) — kept out of ACallable `arrival/toJS` so class need not import rosetta.ts (scheme-zod init cycle). */
export function callableToHostFn(value: ACallable, options: RosettaOptions): (...args: unknown[]) => unknown {
  const scope = currentRegionScope() ?? DETACHED_SCOPE;
  const cached = scope.cache.get(value);
  if (cached) return cached;
  const wrapper = (...jsArgs: unknown[]): Promise<unknown> =>
    withRegionCall(scope, async () => {
      // Args mint under ENCLOSING invocation's runCtx, never CONSTANT_CTX (§7b) — `scope.runCtx` is exactly that (or CONSTANT_CTX for detached fallback).
      const schemeArgs = jsArgs.map((a) => jsToScheme(scope.runCtx, a, options));
      // Re-entry trace nests under exporting invocation (§7b "child scope"), via SAME ambient mechanism evaluator HOF-boundary wrappers use — never through callable `this` (§9).
      const raw = await withDynamicCallSite(scope.dynSite, () => applyCallback(value, schemeArgs, scope.runCtx));
      invariant(!isBounceMarker(raw), "callableToHostFn: a reverse-membrane call resolved to a bounce token");
      // Nested callable in result crosses under SAME scope — one discipline for whole re-entry, not just top-level return.
      return withRegionScope(scope, () => schemeToJs(raw, options));
    });
  scope.cache.set(value, wrapper);
  return wrapper;
}

/** Terminal-passthrough door (P5): every AValue subclass needs explicit branch in schemeToJsImpl instanceof chain — silent return would leak internal repr (kind/provenance/…) to JS caller expecting plain value. Fail loudly at crossing, not three calls later (P5, docs/PRINCIPLES.md). Named + exported for `instanceof` in catch, same shape as region-scope.ts door fns. */
export function schemeToJsUnrecognizedDoor(value: object): Error {
  return new Error(
    `schemeToJs: no conversion for ${value.constructor?.name ?? "<anonymous object>"} — every boxed ` +
      "shape needs an explicit branch in schemeToJs's instanceof chain (rosetta.ts). Silently " +
      "returning it would leak the value's internal representation to a JS caller expecting a " +
      "plain value; the membrane fails loudly at the crossing instead (P5, docs/PRINCIPLES.md).",
  );
}

/**
 * Recursive body behind `schemeToJs`. `unknown`-typed, not `any`: recursion crosses raw JS intermediates no single generic can describe (raw array element, plain object field) — see `schemeToJs` doc for narrowing at public boundary.
 * LAZY: every boxed shape delegates to own `arrival/toJS` (one protocol, class-owned — P7). Containers egress as R9 lazy readonly proxies (egress-proxy.ts); borrowed AJSObject/AJSArray unwrap to `source` IDENTITY (A3 borrowed-identity law); callables become inverse-rosetta region wrappers. Former ~90-line eager instanceof chain dissolved. HERE: only rosetta-specific surface protocol doesn't know: `forceBigInt`, elementwise crossing of RAW JS containers (elements may be boxed), sequence-op-term preserve, FFI allow-list, P5 door.
 */
function schemeToJsImpl(value: unknown, options: RosettaOptions): unknown {
  // null/undefined echo back unchanged (matches AUnwrap non-SchemeValue arm).
  if (value == null) return value;

  // Rosetta-only numeric option — decided BEFORE protocol dispatch: overrides AExact `arrival/toJS` (safe-range number-else-bigint), applies to raw numbers too.
  if (options.forceBigInt) {
    if (value instanceof AExact) {
      const val = value.valueOf();
      return typeof val === "bigint" ? val : BigInt(Math.round(val as number));
    }
    if (typeof value === "number") return BigInt(value);
  }

  // Scheme callable crossing OUT → region-scoped JS wrapper (reverse-membrane §4/§7c). Checked BEFORE protocol dispatch (callable IS AValue) so rosetta face threads OPTIONS into wrapper re-entry marshalling; protocol `arrival/toJS` on ACallable (options-less, plain `toJS`/exec) builds same wrapper with defaults.
  if (is_callable_value(value)) {
    return callableToHostFn(value, options);
  }

  // Other boxed shapes: ONE protocol dispatch via class `arrival/toJS` (NOT membrane.toJS — would close module-init cycle rosetta→membrane→evaluator, scheme-zod z.instanceof codecs capture undefined classes). Scalars unwrap, containers egress as R9 lazy readonly proxies (egress-proxy.ts chokepoint keeps same-box → same-proxy), borrowed wrappers return source identity, ABytevector → raw Uint8Array. (Callables handled above; Macro/Syntax never a value, can't reach schemeToJs.)
  if (value instanceof AValue) {
    return value["arrival/toJS"]();
  }

  // RAW containers (never boxed): rosetta marshalling + trace/MCP serialization hand raw arrays/objects whose ELEMENTS may be boxed — cross elementwise so no AValue leaks into JSON.
  if (Array.isArray(value)) {
    return value.map((record) => schemeToJsImpl(record, options));
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) === Object.getPrototypeOf({}) || Object.getPrototypeOf(value) === null) {
      // `Object.entries` drops symbol-keyed props (opaque/private backing data crossing membrane) — enumerate string keys then own symbols so both survive.
      const out: Record<string | symbol, unknown> = {};
      for (const key of Object.keys(value))
        out[key] = schemeToJsImpl((value as Record<string, unknown>)[key], options);
      for (const sym of Object.getOwnPropertySymbols(value)) {
        out[sym] = schemeToJsImpl((value as Record<symbol, unknown>)[sym], options);
      }
      return out;
    }
    // Raw value with own map/filter/reduce terms: structure to preserve, not unwrap (sequence-op contract objects).
    if (
      (value as Record<PropertyKey, unknown>)[tf("map")] !== undefined ||
      (value as Record<PropertyKey, unknown>)[tf("filter")] !== undefined ||
      (value as Record<PropertyKey, unknown>)[tf("reduce")] !== undefined
    ) {
      return value;
    }
    // Raw FFI passthrough — never boxed, caller's responsibility (mirrors jsToScheme "Exotic objects (Promise, Buffer, …)" inbound carve-out): binary/async values that cross without being a scheme value aren't a membrane violation.
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

  // Bare scalar (string/number/boolean/bigint under !forceBigInt) never boxed — already JS, returned as-is.
  return value;
}

/**
 * Scheme → JS membrane exit. Honestly typed via `AUnwrap<T>` (values/types.ts): `T extends SchemeValue` returns exact JS shape; `null`/`undefined` echo back unchanged (matches runtime). `schemeToJsImpl` carries recursion (see its doc) — this wrapper is ONE sanctioned narrowing (P3): cast target is exact conditional type contract promises, never `as any`/`as unknown`.
 */
export function schemeToJs<T extends SchemeValue | null | undefined>(
  value: T,
  options: RosettaOptions = {},
): T extends SchemeValue ? AUnwrap<T> : T {
  return schemeToJsImpl(value, options) as T extends SchemeValue ? AUnwrap<T> : T;
}

/**
 * JS → Scheme deep-stamping membrane. Single pass: every AValue constructed inherits `provenance`, so downstream extractors (`car`, `cdr`, `dict-ref`, `@`) see element-only lineage carrying rosetta origin id (spec §5.3 Interpretation A) without separate re-stamp per builtin.
 * Plain JS objects → `SchemeJSObject`, entries boxed lazily on `.get(key)` (cache amortizes cost vs full traversal).
 * `seen: WeakSet` terminates JS-side cycles: cyclic ref returned as-is (caller outer Pair/SchemeJSObject already carries provenance, cycle re-enters that wrapper, not infinite spine).
 */
/**
 * Recursive body behind `jsToScheme`. `unknown`-typed, not `any`: each call descends into DIFFERENT static shape (array element, Pair car/cdr) no single generic describes across recursion — see `jsToScheme` doc for narrowing at public boundary.
 */
function jsToSchemeImpl(
  ctx: RunContext,
  value: unknown,
  options: RosettaOptions,
  provenance: ReadonlySet<number>,
  seen: WeakSet<object>,
): unknown {
  // null → nil. undefined has no portable Scheme value (host-agnostic interpreter) → unspecified value, loudly.
  if (value === null) {
    return provenance === EMPTY_PROVENANCE ? nil : new ANil(ctx, provenance);
  }
  if (value === undefined) {
    warnMembrane("a JS `undefined`");
    return theVoid;
  }

  // Cycle in JS-side input — return as-is; caller outer wrapper already carries stamp, stops infinite recursion.
  if (typeof value === "object" && seen.has(value)) return value;
  if (typeof value === "object") seen.add(value);

  // Already-AValue: same-provenance fast path preserves identity. Pair/AVector recurse so children inherit new lineage; other leaves → `withProvenance` (SchemeJSObject entries stay lazy via `.get`).
  if (value instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === value.provenance) return value;
    if (value instanceof APair) {
      // ONE internal narrowing (P3), same limit as public wrapper cast: jsToSchemeImpl return is `unknown` (cycle shortcut + exotic passthrough don't produce SchemeValue), but Pair car/cdr always SchemeValue on every other path, APair<Car,Cdr> ctor requires it. Recursive conditional generics can't re-verify through recursion (AWrap/AUnwrap tuple-wrap lesson).
      return new APair(
        ctx,
        jsToSchemeImpl(ctx, value.car, options, provenance, seen) as SchemeValue,
        jsToSchemeImpl(ctx, value.cdr, options, provenance, seen) as SchemeValue,
        provenance,
      );
    }
    if (value instanceof AVector) {
      // Same narrowing as APair arm — vector elements always SchemeValue on every path but two documented exceptions.
      return new AVector(
        ctx,
        value.__vector__.map((el) => jsToSchemeImpl(ctx, el, options, provenance, seen) as SchemeValue),
        provenance,
      );
    }
    return value.withProvenance(provenance);
  }

  // JS array → borrowed VECTOR: JS array IS R7RS vector, faithful mapping. AJSArray keeps source ref, boxes elements lazily on access.
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

  // JS primitives → boxer registry (number/bigint→exact/inexact, boolean→ABool, string→AString) — never raw, sandbox only holds boxed AValues.
  const tag = typeof value;
  if (tag === "string" || tag === "number" || tag === "boolean" || tag === "bigint") {
    return fromJs(ctx, value, provenance);
  }

  // Registered JS symbol (`Symbol.for('x')`) has portable string key → keyword `:x`. Unique symbol (`Symbol('x')`) has no portable identity → #void + warn (like function).
  if (tag === "symbol") {
    const key = Symbol.keyFor(value as symbol);
    if (key !== undefined) return new ASymbol(ctx, `:${key}`, provenance);
    warnMembrane("a unique JS symbol");
    return theVoid;
  }

  // Scheme lambda is ALambda VALUE (reverse-membrane-for-callables.md §3 step 1: legacy `[LAMBDA]`-branded bare-fn producer + named-let loopFn gone — every scheme lambda is ALambda, `AValue` subclass caught by `instanceof AValue` branch above, returns before here). `require`d `.prompt`/`.hbs` CALLABLE-RULE lambda round-trips through that branch.

  // Borrowed JS function not a Scheme value — exposing as callable would let Scheme escape sandbox into uncontrolled JS — voids, loudly.
  if (tag === "function") {
    warnMembrane("a JS function");
    return theVoid;
  }

  // Exotic objects (Promise, Buffer, …): caller's responsibility.
  return value;
}

/**
 * JS → Scheme deep-stamping membrane. Single pass: every AValue constructed inherits `provenance`, so downstream extractors (`car`, `cdr`, `dict-ref`, `@`) see element-only lineage carrying rosetta origin id (spec §5.3 Interpretation A) without separate re-stamp per builtin.
 * Plain JS objects → `SchemeJSObject`, entries boxed lazily on `.get(key)` (cache amortizes cost vs full traversal).
 * `seen: WeakSet` terminates JS-side cycles: cyclic ref returned as-is (caller outer Pair/SchemeJSObject already carries provenance, cycle re-enters that wrapper, not infinite spine).
 * Honestly typed via `AWrap<T>` (values/types.ts): caller static JS input type determines exact AValue shape returned. `jsToSchemeImpl` carries recursion (see its doc) — this wrapper is ONE sanctioned narrowing (P3): cast target is exact conditional type contract promises, never `as any`/`as unknown`.
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
  // `pure: true` propagates inputs' provenance, mints nothing — sound only if rosetta doesn't mutate inputs. Enforced: borrowed JS inputs (AJSObject/AJSArray) freeze source on first read, so pure rosetta physically cannot mutate. See `freezeSource` / `freezeRosettaReturns`.
  const mintsPoint = pure !== true;

  return async function rosettaWrapper(this: CallCtx, ...schemeArgs: SchemeValue[]) {
    // Collect provenance from AValue inputs before schemeToJs strips AValue identity (and provenance field) to JS primitives.
    // `Extract<SchemeValue, AValue>`, not abstract `AValue` base: SchemeValue's non-AValue members (EOF/Values/R7RSError/bare-fn AProcedure arm) fail reverse assignability TS `filter` predicate; `AValue` itself missing fields some concrete members (e.g. ARosettaProcedure arity/contract) require — Extract picks exactly union members `instanceof AValue` recognizes.
    const inputAValues = schemeArgs.filter((a): a is Extract<SchemeValue, AValue> => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

    // Per-arg deep provenance (opt-in), aligned to schemeArgs — lets consumer fn (e.g. `.prompt` building `inputsProvenance[field]`) attribute each input to producer, recovering per-field origins union can't distinguish.
    const argProvenance = options.argProvenance === true ? schemeArgs.map(deepProvenance) : undefined;

    // R-CTX-3 (rosetta-ctx-single-channel.md): `this` mandatory — every real dispatch path (evaluator apply, four binder adapters) constructs real CallCtx via makeCallCtx; direct call must too (sanctioned `testCallCtx()` idiom, R-CTX-4). Missing/malformed `this` hits taught door below vs silently degrading to CONSTANT_CTX — that silent fallback hid B2-rosetta mint regression until conservation.law caught it.
    if (this == null || this.runCtx == null || this.invocation == null) throw missingCallCtxDoor("rosettaWrapper");
    const runCtx = this.runCtx;
    const inv = this.invocation.currentInvocation as InvocationLike | undefined;
    // Region discipline (§7c): this ONE call — here to `fn.apply` settling — is "symbol invocation" any scheme callable among `schemeArgs` region-binds to. Opened before marshaling (callable arg wrapper minted DURING `schemeToJs`, reads ambient scope), closed when `fn` settles (rule 2: throws if reverse call still pending).
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

      // Decide output provenance before jsToScheme so deep-stamp reaches every constructed AValue in one pass (spec §5.3) — mint overrides inputs. No invocation in ctx (e.g. direct JS calls in tests): fall back to input provenance, silently. Node metadata bound separately via `ctx.currentInvocation.setMetadata(…)` — known up front, doesn't ride result.
      let resultProvenance = inputProvenance;
      if (mintsPoint && inv && typeof inv.id === "number") {
        // MobX observable — flip via own action for strict-mode safety. Plain POJO (direct-JS tests) has no method, set directly.
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

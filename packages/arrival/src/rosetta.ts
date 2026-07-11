/**
 * Scheme<->JS membrane: schemeToJs/jsToScheme marshal at FFI boundary, round-trip to
 * identity both directions (bifunctor framing: schemeToJs∘jsToScheme = id and
 * jsToScheme∘schemeToJs = id on the values each side owns).
 * `createRosettaWrapper` wraps a JS fn as a Scheme-callable rosetta — the retired public
 * `AmbientRuntime.defineRosetta` used to be its one caller; `AmbientRuntime.ts`'s internal
 * `bindRosetta` is the surviving wiring (capability.ts's legacy arm + replay.ts's
 * playback frame are its only two producers now).
 */

import { AValue, EMPTY_PROVENANCE, pointProvenance, unionProvenance } from "./values/primitives/AValue.js";
import { fromJs } from "./values/primitives/boxing.js";
import { type RunContext } from "./values/primitives/RunContext.js";
import { deepProvenance } from "./values/deep-provenance.js";
import { AJSArray } from "./values/primitives/AJSArray.js";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { AExact } from "./values/primitives/AExact.js";
import { ANil, nil } from "./values/primitives/ANil.js";
import { theVoid } from "./values/primitives/AVoid.js";
import { ASymbol } from "./values/primitives/ASymbol.js";
import { EOF } from "./values/primitives/EOF.js";
import { Values } from "./values/primitives/Values.js";
import { R7RSError } from "./errors.js";
import { is_promise } from "./eval/guards.js";
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
// Leaf, ZERO own imports — see dynamic-call-site.ts header: ambient holder lives there, not eval/evaluator.ts (would close cycle: evaluator.ts → AmbientRuntime.ts → rosetta.ts).
import { withDynamicCallSite } from "./eval/dynamic-call-site.js";

// warnMembrane lives in leaf membrane-warn.ts, shared with boxing.ts `function` boxer — value layer needn't import evaluator-heavy module just to warn.
// Non-portable JS value (function/undefined/unique symbol) crossing to Scheme: no faithful repr → #void; warnMembrane makes edge visible.
import { warnMembrane } from "./membrane-warn.js";
import { makeCallCtx, type CallCtx } from "./values/primitives/CallCtx.js";
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
   * Provenance role. Default (`pure` unset): Rosetta-IN SOURCE — introduces external data, result MINTS fresh provenance leaf (conservative: never silently lose origin). `pure: true`: fn only TRANSFORMS args (e.g. `string-append`, `dedent`), result PROPAGATES inputs' provenance. Author assertion over `any` impl (JS purity undecidable), same trust model as `type`. LIVE — gates `mintsPoint = pure !== true` in createRosettaWrapper, drives static lineage classifier (`isRosettaIn === !pure`). Control/declaration forms (expose/approval/…) take `pure: true` for no-mint — richer taxonomy deferred.
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
 * Reverse-membrane wrapper: scheme callable crossing scheme→JS becomes region-scoped async JS fn. Reads AMBIENT `RegionScope` (`currentRegionScope()` — see region-scope.ts header) and CLOSES OVER it: wrapper never re-reads, so a call arriving after exporting invocation returns still sees (closed) scope minted against — that makes escape door detectable.
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
      // Args mint under ENCLOSING invocation's runCtx, never CONSTANT_CTX — `scope.runCtx` is exactly that (or CONSTANT_CTX for detached fallback).
      // A promise-valued arg settles BEFORE boxing (the reverse membrane is already
      // async) — the last inbound top-level Promise path, closed; a bare Promise
      // reaching jsToScheme now doors (jsToSchemeAsyncDoor).
      const schemeArgs = await Promise.all(jsArgs.map(async (a) => jsToScheme(scope.runCtx, await a, options)));
      // Re-entry trace nests under the exporting invocation (a "child scope"), via SAME ambient mechanism evaluator HOF-boundary wrappers use — never through callable `this`.
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
 * LAZY: every boxed shape delegates to own `arrival/toJS` (one protocol, class-owned — P7). Containers egress as lazy readonly proxies (egress-proxy.ts); borrowed AJSObject/AJSArray unwrap to `source` IDENTITY (the borrowed-identity law); callables become inverse-rosetta region wrappers. Former ~90-line eager instanceof chain dissolved. HERE: only rosetta-specific surface protocol doesn't know: `forceBigInt`, elementwise crossing of RAW JS containers (elements may be boxed), sequence-op-term preserve, FFI allow-list, P5 door.
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

  // Scheme callable crossing OUT → region-scoped JS wrapper (reverse-membrane). Checked BEFORE protocol dispatch (callable IS AValue) so rosetta face threads OPTIONS into wrapper re-entry marshalling; protocol `arrival/toJS` on ACallable (options-less, plain `toJS`/exec) builds same wrapper with defaults.
  if (is_callable_value(value)) {
    return callableToHostFn(value, options);
  }

  // Other boxed shapes: ONE protocol dispatch via class `arrival/toJS` (NOT membrane.toJS — would close module-init cycle rosetta→membrane→evaluator, scheme-zod z.instanceof codecs capture undefined classes). Scalars unwrap, containers egress as lazy readonly proxies (egress-proxy.ts chokepoint keeps same-box → same-proxy), borrowed wrappers return source identity, ABytevector → raw Uint8Array. (Callables handled above; Macro/Syntax never a value, can't reach schemeToJs.)
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
      for (const key of Object.keys(value)) out[key] = schemeToJsImpl((value as Record<string, unknown>)[key], options);
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
 * Scheme → JS membrane exit for UNTYPED crossings — the named contract for values whose
 * static type is unknowable at the call site: an untyped `z.procedure()` HOF-callback
 * return (the mcp/llm middleware convention), a duck-typed parse-tree walk, a value that
 * may be a raw JS reply, a registered sentinel symbol, or a boxed scheme value in the
 * same position. Runtime behavior is IDENTICAL to {@link schemeToJs} (one impl); only
 * the type contract differs: `unknown` in, `unknown` out — the caller narrows AFTER the
 * crossing, when the value is plain JS and narrowing is checkable. Reach for the typed
 * {@link schemeToJs} whenever a codec or contract names the shape; reaching for THIS to
 * silence a type error on a value you can honestly type is the smell this export exists
 * to make visible (`grep schemeToJsUntyped` = the audit list of untyped crossings).
 */
export function schemeToJsUntyped(value: unknown, options: RosettaOptions = {}): unknown {
  return schemeToJsImpl(value, options);
}

/** Teaching door (P5): a bare Promise reaching jsToScheme directly. Every sanctioned
 *  path settles first — rosetta wrappers await the fn result before crossing, the
 *  reverse-membrane wrapper settles promise-valued args, and a Promise INSIDE a
 *  structure never routes here at all (the holding container settles it lazily on
 *  entry read — pending-entry.ts). A raw Promise inside scheme space would be an
 *  opaque, unawaitable leak, so the membrane fails loudly at the crossing. Named +
 *  exported like `schemeToJsUnrecognizedDoor` (the outbound twin). */
export function jsToSchemeAsyncDoor(): Error {
  return new Error(
    "jsToScheme: a bare Promise cannot cross the membrane — await it before crossing " +
      "(rosetta wrappers already await their fn results), or hand the STRUCTURE holding it " +
      "to the sandbox and let the entry read settle it lazily (AJSObject/ADict entries and " +
      "AJSArray elements settle on first access, sync after settlement). A raw Promise in " +
      "scheme space would be an opaque leak (P5, docs/PRINCIPLES.md).",
  );
}

/**
 * One INBOUND claim — the static-side dual of the outbound `arrival/toJS` terms.
 * Outbound dispatches on OUR classes, so the term lives on the receiver; inbound
 * dispatches on JS shapes where no receiver exists yet, so each claim pairs a shape
 * predicate with its constructor and the router is a fold over the DECLARED list
 * below. `claims` narrows at runtime; `box` re-asserts the narrowing it needs
 * (invariant, honest — never a cast).
 */
export interface InboundClaim {
  /** Stable name — pinned by the inbound-registry law (membrane/inbound-registry.law.test.ts). */
  readonly name: string;
  readonly claims: (value: unknown) => boolean;
  readonly box: (ctx: RunContext, value: unknown, provenance: ReadonlySet<number>, seen: WeakSet<object>) => unknown;
}

/**
 * THE inbound claim registry — jsToScheme's whole value-kind algebra as one DECLARED,
 * ORDERED table (first claiming row wins; the order is semantic law, not import
 * accident, and the registry law test pins it):
 *
 *  1. the two host bottoms come first (null → nil; undefined → #void, loudly);
 *  2. an already-AValue passes by identity on the same/empty-provenance fast path and
 *     otherwise re-stamps through ITS OWN protocol (`arrival/withProvenanceDeep` on
 *     spine carriers, shallow `withProvenance` on every other class) — the per-class
 *     knowledge the old router leaked is back on the classes;
 *  3. arrays claim BEFORE plain objects (an array is `typeof "object"` too);
 *  4. a plain-prototype object claims BEFORE the promise row, so a plain THENABLE
 *     stays a dict-shaped borrow (the historical behavior);
 *  5. scalars route to the boxer table (boxing.ts — the primitives' claim table);
 *  6. non-AValue scheme orphans (EOF / Values / R7RSError) pass by identity — they
 *     ARE scheme values, formerly smuggled through the exotic passthrough;
 *  7. the binary FFI passthrough is the one DECLARED raw identity (named superset,
 *     mirrors the outbound allow-list's own raw-passthrough treatment in schemeToJsImpl);
 *  8. a bare Promise DOORS (see jsToSchemeAsyncDoor — container entries settle
 *     lazily instead);
 *  9. every remaining object (class instance, Map, Date, Error, …) re-presents as a
 *     borrowed AJSObject, LOUDLY — the old silent raw-exotic leak is closed; member
 *     reads keep working through the interop policy, and the wrapper round-trips to
 *     source identity on exit.
 *
 * NOTE the registry-vs-switch history in boxing.ts: what that header rejects is
 * SELF-REGISTRATION (order by import accident). This is the opposite construction —
 * one declared table whose order is written down and law-pinned; class knowledge stays
 * in closures/protocol methods, so no class binding is read at module-eval time (the
 * benign AJSObject/AJSArray ↔ rosetta cycles stay TDZ-safe).
 */
export const INBOUND_CLAIMS: readonly InboundClaim[] = [
  {
    // null → nil: the list-end bottom, provenance-stamped when supplied.
    name: "null → nil",
    claims: (v) => v === null,
    box: (ctx, _v, p) => (p === EMPTY_PROVENANCE ? nil : new ANil(ctx, p)),
  },
  {
    // undefined has no portable Scheme value (host-agnostic interpreter) → #void, loudly.
    name: "undefined → #void (warn)",
    claims: (v) => v === undefined,
    box: () => {
      warnMembrane("a JS `undefined`");
      return theVoid;
    },
  },
  {
    // Already-AValue: same/empty-provenance identity fast path; otherwise the class's
    // own re-stamp — deep on spine carriers (APair/AVector's arrival/withProvenanceDeep),
    // shallow withProvenance everywhere else (borrowed wrappers stay lazy; entries pick
    // the stamp up on access). Scheme lambdas are ALambda values and round-trip here.
    name: "AValue → identity / provenance re-stamp (class term)",
    claims: (v) => v instanceof AValue,
    box: (ctx, v, p, seen) => {
      invariant(v instanceof AValue, "inbound claim 'AValue': box called off its predicate");
      if (p === EMPTY_PROVENANCE || p === v.provenance) return v;
      const deep = v["arrival/withProvenanceDeep"];
      return deep === undefined ? v.withProvenance(p) : deep.call(v, ctx, p, seen);
    },
  },
  {
    // JS array IS an R7RS vector (faithful Rosetta mapping) → borrowed AJSArray, source
    // kept by reference, elements boxed lazily on access.
    name: "array → borrowed AJSArray",
    claims: (v) => Array.isArray(v),
    box: (ctx, v, p) => {
      invariant(Array.isArray(v), "inbound claim 'array': box called off its predicate");
      return new AJSArray(ctx, v, p);
    },
  },
  {
    // Plain-prototype object → borrowed AJSObject, entries boxed lazily via .get cache.
    // BEFORE the promise row on purpose: a plain thenable stays a dict-shaped borrow.
    name: "plain object → borrowed AJSObject",
    claims: (v) =>
      typeof v === "object" &&
      v !== null &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null),
    box: (ctx, v, p) => {
      invariant(typeof v === "object" && v !== null, "inbound claim 'plain object': box called off its predicate");
      return new AJSObject(ctx, v, p);
    },
  },
  {
    // JS primitives → the boxer table (boxing.ts): number/bigint → exact/inexact,
    // boolean → ABool flyweights, string → AString — never raw, the sandbox only holds
    // boxed AValues.
    name: "scalar → boxer table (fromJs)",
    claims: (v) => {
      const tag = typeof v;
      return tag === "string" || tag === "number" || tag === "boolean" || tag === "bigint";
    },
    box: (ctx, v, p) => fromJs(ctx, v, p),
  },
  {
    // Registered symbol (`Symbol.for('x')`) has a portable string key → keyword `:x`;
    // a unique symbol has no portable identity → #void + warn (like a function).
    name: "symbol → :keyword (registered) / #void (unique, warn)",
    claims: (v) => typeof v === "symbol",
    box: (ctx, v, p) => {
      invariant(typeof v === "symbol", "inbound claim 'symbol': box called off its predicate");
      const key = Symbol.keyFor(v);
      if (key !== undefined) return new ASymbol(ctx, `:${key}`, p);
      warnMembrane("a unique JS symbol");
      return theVoid;
    },
  },
  {
    // Borrowed JS function is not a Scheme value — exposing it as callable would let
    // the sandbox escape into uncontrolled JS — voids, loudly.
    name: "function → #void (warn)",
    claims: (v) => typeof v === "function",
    box: () => {
      warnMembrane("a JS function");
      return theVoid;
    },
  },
  {
    // Non-AValue scheme orphans: already scheme values (types.ts's SchemeValue union),
    // no provenance slot → identity. Formerly rode the silent exotic passthrough.
    name: "scheme orphan (EOF/Values/R7RSError) → identity",
    claims: (v) => v instanceof EOF || v instanceof Values || v instanceof R7RSError,
    box: (_ctx, v) => v,
  },
  {
    // The one DECLARED raw passthrough (named superset: FFI identity) — mirrors the
    // outbound allow-list's own raw-passthrough treatment in schemeToJsImpl.
    name: "binary (Uint8Array/ArrayBuffer/DataView/Buffer) → raw passthrough (declared)",
    claims: (v) =>
      v instanceof Uint8Array ||
      v instanceof ArrayBuffer ||
      v instanceof DataView ||
      (typeof Buffer !== "undefined" && v instanceof Buffer),
    box: (_ctx, v) => v,
  },
  {
    // A bare Promise (or non-plain thenable) doors — see jsToSchemeAsyncDoor. Promise
    // VALUES inside structures never reach this row: the holding container settles
    // them lazily on entry read (pending-entry.ts).
    name: "promise → door (settle first; container entries settle lazily)",
    claims: (v) => is_promise(v),
    box: () => {
      throw jsToSchemeAsyncDoor();
    },
  },
  {
    // Residual exotics (class instances, Map, Date, Error, …): re-presented as a
    // borrowed AJSObject, LOUDLY — closes the old silent raw leak. Member reads keep
    // working through the interop policy; exit round-trips to source identity.
    name: "exotic object → borrowed AJSObject (warn)",
    claims: (v) => typeof v === "object" && v !== null,
    box: (ctx, v, p) => {
      invariant(typeof v === "object" && v !== null, "inbound claim 'exotic object': box called off its predicate");
      warnMembrane(
        `a JS ${v.constructor?.name ?? "<null-proto>"} instance`,
        "was re-presented as a borrowed js-object wrapper — its members read through the interop policy, and it exits back to JS as the same instance",
      );
      return new AJSObject(ctx, v, p);
    },
  },
] as const;

/**
 * Recursive body behind `jsToScheme` — the ordered fold over INBOUND_CLAIMS (first
 * claiming row wins; the registry doc above is the law). `unknown`-typed, not `any`:
 * the fold's output spans boxed values AND the declared raw passthrough — see
 * `jsToScheme` for the ONE narrowing at the public boundary.
 *
 * The `seen` shortcut is router INFRASTRUCTURE, not a claim: a JS-side cycle (or
 * shared substructure re-encountered during a deep re-stamp) returns as-is — the
 * caller's outer wrapper already carries the stamp, stopping infinite recursion.
 */
function jsToSchemeImpl(
  ctx: RunContext,
  value: unknown,
  provenance: ReadonlySet<number>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  for (const claim of INBOUND_CLAIMS) {
    if (claim.claims(value)) return claim.box(ctx, value, provenance, seen);
  }
  // Total by construction: bottoms (rows 1-2) + AValue + object rows + scalar +
  // symbol + function cover every typeof tag; a miss is a programmer error.
  invariant(false, `jsToScheme: no inbound claim for typeof "${typeof value}" — the registry must stay total`);
}

/**
 * JS → Scheme deep-stamping membrane — the fold over INBOUND_CLAIMS (the declared,
 * ordered inbound algebra above; the registry doc is the law). Single pass: every AValue
 * constructed inherits `provenance`, so downstream extractors (`car`, `cdr`, `dict-ref`,
 * `@`) see element-only lineage carrying the rosetta origin id without a separate
 * re-stamp per builtin; an already-AValue with a fresh stamp
 * re-stamps through its OWN protocol (deep on spine carriers via
 * `arrival/withProvenanceDeep`, shallow elsewhere — borrowed wrappers' entries stay lazy
 * via `.get`).
 * `seen: WeakSet` terminates JS-side cycles: a cyclic ref returns as-is (the caller's
 * outer wrapper already carries the stamp, so the cycle re-enters that wrapper, not an
 * infinite spine).
 * `options` is accepted for signature stability but the INBOUND crossing reads none of
 * it (`forceBigInt` is an outbound concern — it always was; the old impl only threaded
 * it, never read it).
 * Honestly typed via `AWrap<T>` (values/types.ts): the caller's static JS input type
 * determines the exact AValue shape returned. This wrapper is the ONE sanctioned
 * narrowing (P3): the cast target is the exact conditional type the contract promises,
 * never `as any`/`as unknown`.
 */
export function jsToScheme<T>(
  ctx: RunContext,
  value: T,
  _options: RosettaOptions = {},
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  seen: WeakSet<object> = new WeakSet(),
): AWrap<T> {
  return jsToSchemeImpl(ctx, value, provenance, seen) as AWrap<T>;
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

    // `this` IS the CallCtx — the type parameter forces it at every call site (unbound
    // call = compile error); makeCallCtx/testCallCtx are the only constructors and
    // never yield nullable fields, so no runtime null-check is needed here.
    // Destructured ONCE; the body below is `this`-free.
    const { runCtx, invocation } = this;
    const inv = invocation.currentInvocation;
    // Region discipline: this ONE call — here to `fn.apply` settling — is "symbol invocation" any scheme callable among `schemeArgs` region-binds to. Opened before marshaling (callable arg wrapper minted DURING `schemeToJs`, reads ambient scope), closed when `fn` settles (throws if a reverse call is still pending).
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

      // Decide output provenance before jsToScheme so deep-stamp reaches every constructed AValue in one pass — mint overrides inputs. No invocation in ctx (e.g. direct JS calls in tests): fall back to input provenance, silently. Node metadata bound separately via `ctx.currentInvocation.setMetadata(…)` — known up front, doesn't ride result.
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

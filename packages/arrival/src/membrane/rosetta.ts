/**
 * Scheme<->JS membrane: schemeToJs/jsToScheme marshal at FFI boundary, round-trip to
 * identity both directions (bifunctor framing: schemeToJs∘jsToScheme = id and
 * jsToScheme∘schemeToJs = id on the values each side owns).
 * `createRosettaWrapper` wraps a JS fn as a Scheme-callable rosetta — wired through
 * `AmbientRuntime.ts`'s internal `bindRosetta`, whose sole producer is `provenance/
 * replay.ts`'s playback-frame op registration (capability.ts's legacy `{ fn }` bind
 * arm — the OTHER historical producer — died with `lower()`, Stage C Cut 4).
 */

import { AValue, EMPTY_PROVENANCE, mergeProvenance, pointProvenance, unionProvenance } from "../values/primitives/AValue.js";
import { fromJs } from "./boxing.js";
import { type RunContext } from "../run/RunContext.js";
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { EOF } from "../values/primitives/EOF.js";
import { Values } from "../values/primitives/Values.js";
import { AOpaqueHandle } from "../values/primitives/AOpaqueHandle.js";
import { isMarkedInteropPrivate } from "./interop-access.js";
import { R7RSError, UnrecognizedCrossingError, AsyncCrossingError, NoLensError } from "../errors.js";
import { is_promise } from "../eval/guards.js";
import { _installCallableMarshal, type ACallable } from "../values/primitives/ACallable.js";
import { type AUnwrap, type AWrap, type EgressMode, type SchemeValue } from "../values/types.js";
import invariant from "tiny-invariant";
import { closeRegionScope, currentRegionScope, DETACHED_SCOPE, openRegionScope, withRegionScope } from "./region-scope.js";
import { originalBoxOf } from "./egress-proxy.js";

// warnMembrane lives in leaf membrane-warn.ts, shared with boxing.ts `function` boxer — value layer needn't import evaluator-heavy module just to warn.
// Non-portable JS value → #void, loudly: docs/membrane.md §VOID-RULE.
import { warnMembrane } from "./membrane-warn.js";
import { makeCallCtx, type CallCtx } from "../run/CallCtx.js";
import { tf } from "../values/tagless-final.js";

interface RosettaOptions {
  // NOTE: a new field here must be classified in `modeKeyOf` below (projection-
  // affecting ⇒ new EgressMode member; wrapper-call-only ⇒ the Exclude list) — the
  // `_modeKeyExhaustive` type guard turns forgetting into a compile error.
  returnEither?: boolean;
  /**
   * When true, attaches `this.argProvenance` (flat `CallCtx`, not nested `ctx.…`) — one DEEP provenance set per scheme arg (union of every reachable AValue). Needed: `(list a b c)` carries no spine provenance, only elements — shallow `arg.provenance` misses per-element origins. Computed before schemeToJs strips AValue identity.
   */
  argProvenance?: boolean;
}

/** The membrane-crossing cache mode for `options` — every crossing resolves to the
 *  single non-bare mode; `returnEither`/`argProvenance` are read only inside
 *  createRosettaWrapper's call packaging, never by schemeToJsImpl or inbound
 *  jsToScheme. Feeds both the (box, mode, scope) container slots (egress-proxy) and
 *  the (callable, mode, scope) wrapper slots below.
 *  Kept as a function (not collapsed to the `EgressMode` constant `"mem"` at call
 *  sites) so a FUTURE projection-affecting option still has exactly one place to key
 *  from — see `_modeKeyExhaustive` below. */
export function modeKeyOf(_options: RosettaOptions): EgressMode {
  return "mem";
}

/** Type-level exhaustiveness: a NEW RosettaOptions field makes this `never` and the
 *  assignment a compile error, forcing the author to classify it (see modeKeyOf).
 *  (A destructure or `satisfies` does NOT do this — destructuring is never
 *  exhaustiveness-checked.) */
type _ModeKeyHandles = Exclude<keyof RosettaOptions, "returnEither" | "argProvenance"> extends never ? true : never;
const _modeKeyExhaustive: _ModeKeyHandles = true;
void _modeKeyExhaustive;

type Fn = (...args: any[]) => any;

/**
 * The sole producer left is `provenance/replay.ts`'s playback-frame op registration
 * (`bindRosetta(env, op, { fn })`) — TRAILS CLEANUP (Tier 1) confirmed it passes ONLY `fn`,
 * never `options`/`type`/`pure`, so `createRosettaWrapper` below is shrunk to that one live
 * shape: no options bag (a replay op crosses with default `RosettaOptions`, never
 * `returnEither`/`argProvenance`), no `.d.ts` type-lens fragment (playback ops aren't
 * lens-harvested), no `pure` (a playback op always MINTS a fresh provenance point — it's
 * answering from a recorded payload stream, not transforming its scheme args).
 */
export interface RosettaFunction {
  fn: Fn;
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
 * Reverse-membrane wrapper (scheme callable → region-scoped async JS fn): the discipline is
 * docs/membrane.md §REGION — the wrapper closes over the ambient `RegionScope`
 * (`currentRegionScope()`), never re-reads it (so a late call sees the closed scope, tripping the
 * escape door), and identity is per (callable, scope, FAMILY) on the scope-owned cache.
 *
 * THIN DELEGATE (toJS-protocol collapse): the whole reverse-membrane body — region discipline,
 * arg/result marshaling, the scope-owned cache — now lives on `ACallable` itself
 * (`values/primitives/ACallable.ts`'s `hostProjectionOf`, installed via `_installCallableMarshal`
 * below), reached through the SAME `arrival/toJS(exit?)` protocol every native container answers.
 * `egressAValue` already builds exactly the `MembraneExit` a callable's protocol method wants
 * (its `element` closure IS `schemeToJsImpl(el, options)` under the pinned scope) — so this
 * function is nothing more than that dispatch, kept as a named export because callers across the
 * codebase (and this file's own `schemeToJsImpl`) still spell the crossing as "get me this
 * callable's host fn," not "egress this AValue." One cache either way (crossing.law's "two-caches
 * split is dead" pin): `schemeToJs` of a dict holding a callable and a direct
 * `callableToHostFn`/`toJS` call on that SAME callable, under the SAME scope, answer the
 * identical wrapper.
 */
export function callableToHostFn(value: ACallable, options: RosettaOptions): (...args: unknown[]) => unknown {
  return egressAValue(value, options) as (...args: unknown[]) => unknown;
}

/**
 * Boxed-AValue egress: hands every AValue its `MembraneExit` through the ONE crossing
 * protocol `arrival/toJS(exit)`. A native container (ADict/APair/AVector) reads `exit`
 * and threads `exit.element` through each element's full recursive projection under the
 * PINNED exporting region scope; every other AValue ignores `exit` and returns its
 * serialization face (scalars unwrap; a callable — intercepted before this in
 * schemeToJsImpl/membrane.toJS — never reaches here). Shared by schemeToJsImpl's AValue
 * branch and membrane.ts#toJS, so the crossing cannot drift between them.
 *
 * The exporting scope is pinned ONCE here (both rosetta crossings run this inside the live
 * `withRegionScope` window) and every lazy element materialization re-enters it via
 * `withRegionScope(pinned, …)` — docs/membrane.md §EGRESS (scope-bound cache) and §REGION.
 * Unpinned, a nested callable would mint its wrapper at first proxy read under
 * DETACHED_SCOPE/CONSTANT_CTX, a discipline bypass. Paths with no ambient scope (exec's simple
 * tier, trace/display) pin DETACHED_SCOPE.
 */
export function egressAValue(value: AValue, options: RosettaOptions): unknown {
  const pinned = currentRegionScope() ?? DETACHED_SCOPE;
  return value["arrival/toJS"]({
    element: (el: unknown) => withRegionScope(pinned, () => schemeToJsImpl(el, options)),
    modeKey: modeKeyOf(options),
    cache: pinned.egressProxies,
  });
}

/** Terminal-passthrough door (P5): every AValue subclass needs explicit branch in schemeToJsImpl instanceof chain — silent return would leak internal repr (kind/provenance/…) to JS caller expecting plain value. Fail loudly at crossing, not three calls later (P5, docs/PRINCIPLES.md). Named + exported for `instanceof` in catch, same shape as region-scope.ts door fns. */
export function schemeToJsUnrecognizedDoor(value: object): Error {
  return new UnrecognizedCrossingError(value.constructor?.name ?? "<anonymous object>");
}

/**
 * R7RSError exit arm: an R7RS error object produced AS A VALUE (guard's `else`
 * returning it, `raise-continuable` resuming with it) exits as a same-class host
 * `Error` — message preserved, irritants crossed elementwise through the caller's own
 * exit fn, original stack carried over so the construction site survives the crossing.
 * A RAISED error never touches this arm — it reaches the host through the throw path.
 * R7RSError is deliberately a host `Error` subclass, NOT an AValue box (the
 * `z.error` codec exists precisely because it isn't one — env/r7rs/exceptions.ts's
 * `raisable` note), so the strict-exit invariant cannot carry it; this arm is its
 * crossing. Shared by schemeToJsImpl and membrane.toJS so the two exits cannot drift
 * (the egressAValue law).
 */
export function errorToHost(value: R7RSError, exitEl: (el: unknown) => unknown): R7RSError {
  const Ctor = value.constructor as new (message: string, ...irritants: unknown[]) => R7RSError;
  const crossed = new Ctor(value.message, ...value.irritants.map(exitEl));
  crossed.stack = value.stack;
  return crossed;
}

/**
 * Recursive body behind `schemeToJs`. `unknown`-typed, not `any`: recursion crosses raw JS intermediates no single generic can describe (raw array element, plain object field) — see `schemeToJs` doc for narrowing at public boundary.
 * LAZY: every boxed shape delegates to own `arrival/toJS` (one protocol, class-owned — P7). Containers egress as lazy readonly proxies (egress-proxy.ts); borrowed AJSObject/AJSArray unwrap to `source` IDENTITY (the borrowed-identity law); callables become inverse-rosetta region wrappers, through the SAME dispatch below (ACallable extends AValue — no separate special-case needed; see `egressAValue`'s doc). HERE: only rosetta-specific surface protocol doesn't know: elementwise crossing of RAW JS containers (elements may be boxed), sequence-op-term preserve, FFI allow-list, P5 door.
 */
function schemeToJsImpl(value: unknown, options: RosettaOptions): unknown {
  // null/undefined echo back unchanged (matches AUnwrap non-SchemeValue arm).
  if (value == null) return value;

  // Every boxed shape — including a callable (ACallable extends AValue) — dispatches through
  // `egressAValue` (shared with membrane.toJS so the two exits can't drift): it hands each
  // AValue its `MembraneExit` via the single `arrival/toJS(exit)` protocol. Containers thread it
  // for full recursive projection (nested callables/containers all honor `options`); a callable's
  // own protocol method (ACallable.ts) reads the SAME exit to cross its result out and mints its
  // region-scoped host wrapper; scalars ignore it and unwrap. Containers egress as lazy readonly
  // proxies (egress-proxy.ts — identity per (box, mode, scope) for membrane, per box for bare),
  // borrowed wrappers return source identity, ABytevector → raw Uint8Array. (Macro/Syntax never a
  // value, can't reach schemeToJs.)
  if (value instanceof AValue) {
    return egressAValue(value, options);
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
    // R7RSError AS A VALUE (guard's `else`, `raise-continuable`) exits through the
    // shared arm — a raised error never reaches here (it takes the throw path).
    if (value instanceof R7RSError) {
      return errorToHost(value, (el) => schemeToJsImpl(el, options));
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

  // Bare scalar (string/number/boolean/bigint) never boxed — already JS, returned as-is.
  // bigint specifically: an opaque host value (§2.3), never reinterpreted as a scheme
  // number — this fallthrough IS its identity pass-through, the same as the raw
  // Uint8Array/ArrayBuffer/DataView/Promise arm above.
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
  return new AsyncCrossingError();
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
  /** Stable name — pinned by the inbound-registry law (membrane/__tests__/inbound-registry.law.test.ts). */
  readonly name: string;
  readonly claims: (value: unknown) => boolean;
  readonly box: (ctx: RunContext, value: unknown, provenance: ReadonlySet<number>, seen: WeakSet<object>) => unknown;
}

/**
 * THE INBOUND ALGEBRA — V's ruling (2026-07-23, verbatim): "the js > scheme membrane
 * is pretty simple — it's always either having the proper lens or not, all the
 * concepts are either familiar or explicitly incompatible." BINARY: every inbound
 * value crosses through exactly one of three PHASES, run in order (the phases
 * concatenate into the one flat, DECLARED fold `jsToSchemeImpl` walks — the phase
 * split is a documented, law-pinned fact about {@link INBOUND_CLAIMS}'s structure,
 * not a second dispatch mechanism):
 *
 *   PHASE 1 — {@link OWNED_ARTIFACT_CLAIMS} (OWNED-ARTIFACT RECOGNITION): a thing
 *   already MARKED as ours — an `AValue` instance, a re-admitted egress proxy, a
 *   scheme orphan (EOF/Values/R7RSError), or a branded opaque-handle source — is
 *   recognized before ANY foreign-shape predicate runs. Running phase 1 to
 *   completion before phase 2 begins is the OLD "R9-before-array" law, generalized:
 *   an R9 proxy over a vector is `Array.isArray`-true and would otherwise be
 *   mis-claimed by phase 2's array row — the phase boundary makes that structurally
 *   impossible now, not just an ordering convention within one flat list.
 *   MOSTLY, not fully, order-free within the phase: `isMarkedInteropPrivate`
 *   (interop-access.ts) reads the SAME `INTEROP_BOUNDARY` stamp our own scheme
 *   orphans carry (EOF/Values/R7RSError each declare `static [INTEROP_BOUNDARY] =
 *   true` for the read-policy walk, unrelated to the whiteroom opt-in) — that
 *   function's own doc names this explicitly. So the scheme-orphan row MUST be
 *   checked before the branded-host-instance row (its declared order below), or an
 *   EOF/Values/R7RSError would be mis-minted as an AOpaqueHandle instead of passing
 *   by identity. The other three rows (AValue/R9/scheme-orphan) genuinely are
 *   disjoint marks — this one pair is the exception, and the order below pins it.
 *
 *   PHASE 2 — {@link FOREIGN_LENS_CLAIMS} (THE FOREIGN LENS TABLE, typeof-disjoint):
 *   reached only when phase 1 missed. Every row is keyed by a distinct `typeof` tag
 *   (the array/plain-object containment ladder lives INSIDE the single "object" row
 *   below, not as two order-dependent siblings), so — aside from that one internal
 *   ladder — these rows are ALSO order-independent. Every hit here is a LENS, a
 *   defined, familiar crossing: this is where the warn-and-degrade middle tier used
 *   to live (`undefined` used to warn-then-void; it is now a plain lens, no warn,
 *   same as every other row in this phase). ONE row survives verbatim, unresolved:
 *   bare host function (`TODO(V-fork)` on its row) — V has an open fork
 *   (lens-to-callable vs door) this restructure does not settle.
 *
 *   PHASE 3 — {@link INCOMPATIBILITY_DOOR_CLAIMS} (THE INCOMPATIBILITY DOOR):
 *   reached only when phases 1-2 both missed. Every remaining shape is EXPLICITLY
 *   INCOMPATIBLE — never a silent degrade to `#void` or an untethered borrow. Each
 *   row names a DIFFERENT refusal (a bare Promise must settle first; a unique
 *   symbol has no portable identity; an unbranded/exotic class instance has no
 *   lens — mark it `@arrival.private` or hand plain data) so each teaches its own
 *   cure (`NoLensError`/`AsyncCrossingError`, errors.ts).
 *
 * NOTE the registry-vs-switch history in boxing.ts: what that header rejects is
 * SELF-REGISTRATION (order by import accident). This is the opposite construction —
 * one declared table whose order is written down and law-pinned; class knowledge stays
 * in closures/protocol methods, so no class binding is read at module-eval time (the
 * benign AJSObject/AJSArray ↔ rosetta cycles stay TDZ-safe).
 */
export const OWNED_ARTIFACT_CLAIMS: readonly InboundClaim[] = [
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
      // THE ADDITIVE LAW (docs/membrane.md §INBOUND): merge the crossing's origin onto the value's,
      // never overwrite — union keeps `origin ⊇ dependencies`, the precondition uneval's Galois
      // slicing rests on (provenance/uneval.ts); replace would drop the value's own lineage.
      const merged = mergeProvenance(v.provenance, p);
      if (merged === v.provenance) return v;
      const deep = v["arrival/withProvenanceDeep"];
      return deep === undefined ? v.withProvenance(merged) : deep.call(v, ctx, p, seen);
    },
  },
  {
    // R9 RE-ADMISSION (docs/design-history/arrival-egress-membrane-exit.md — the
    // bifunctor law): a value that crossed OUT as one of egress-proxy.ts's lazy
    // ref-tracking proxies (bare/membrane/gated — ALL three laws register in the
    // same PROXY_ORIGIN map at mint) and is now crossing back IN is re-admitted as
    // its ORIGINAL box, not re-borrowed as a fresh AJSArray/AJSObject — so
    // `jsToScheme(schemeToJs(box)) === box` (mem/eq?) holds for containers exactly
    // as it already does for scalars. Phase 1 runs to completion before phase 2's
    // array row ever sees the value (the ordering-is-load-bearing law, restated):
    // an R9 proxy over a VECTOR is `Array.isArray`-true and would otherwise be
    // claimed there first, losing identity permanently (a fresh borrowed AJSArray
    // wrapping the proxy, never eq? to the original vector). Re-dispatches through
    // `jsToSchemeImpl` with the ORIGINAL box — that re-enters the "AValue →
    // identity / provenance re-stamp" row above, reusing its re-stamp logic
    // verbatim rather than duplicating it here (risk: do NOT reimplement
    // re-stamping in this row).
    name: "R9 egress proxy → original box (re-admission)",
    claims: (v) => typeof v === "object" && v !== null && originalBoxOf(v) !== undefined,
    box: (ctx, v, p, seen) => {
      const original = originalBoxOf(v as object);
      invariant(original !== undefined, "inbound claim 'R9 egress proxy': box called off its predicate");
      return jsToSchemeImpl(ctx, original, p, seen);
    },
  },
  {
    // Non-AValue scheme orphans: already scheme values (types.ts's SchemeValue union),
    // no provenance slot → identity. ORDERED BEFORE the branded-host-instance row
    // below on purpose (see this const's header note): EOF/Values/R7RSError each
    // carry the SAME `INTEROP_BOUNDARY` stamp `isMarkedInteropPrivate` reads for the
    // whiteroom brand — checked after this row, that predicate would otherwise be
    // reached with an orphan still unclaimed and mis-mint it as an AOpaqueHandle.
    name: "scheme orphan (EOF/Values/R7RSError) → identity",
    claims: (v) => v instanceof EOF || v instanceof Values || v instanceof R7RSError,
    box: (_ctx, v) => v,
  },
  {
    // Branded HOST class instance (`@arrival.private`/`markInteropPrivate` — the
    // whiteroom opaque-crossing contract, docs/plans/infer-whiteroom-design.md §"V'S
    // API RULING", interop-access.ts's `markInteropPrivate` doc has the full statement):
    // mint-or-reuse THIS RUN's canonical `AOpaqueHandle` via its own cache
    // (`AOpaqueHandle.for` — run-scoped, see that class's header for why not global).
    // This IS the lens for a class instance — the phase 3 door below fires only for
    // an instance NEITHER this row nor any other owned-artifact row recognizes.
    // Ordered AFTER the scheme-orphan row above (load-bearing — see this const's
    // header note): `isMarkedInteropPrivate` also answers true for our OWN
    // EOF/Values/R7RSError classes (they share the same `INTEROP_BOUNDARY` stamp for
    // an unrelated reason — the read-policy walk, not the whiteroom opt-in), so the
    // scheme-orphan row must claim those three classes first.
    name: "branded host instance → opaque handle (mint/reuse, whiteroom contract)",
    claims: (v) => typeof v === "object" && v !== null && isMarkedInteropPrivate(v),
    box: (ctx, v, p) => {
      invariant(typeof v === "object" && v !== null, "inbound claim 'branded host instance': box called off its predicate");
      return AOpaqueHandle.for(ctx, v, p);
    },
  },
] as const;

export const FOREIGN_LENS_CLAIMS: readonly InboundClaim[] = [
  {
    // null → nil: the list-end bottom, provenance-stamped when supplied.
    name: "null → nil",
    claims: (v) => v === null,
    box: (ctx, _v, p) => (p === EMPTY_PROVENANCE ? nil : new ANil(p)),
  },
  {
    // undefined has no portable Scheme value (host-agnostic interpreter), but it IS a
    // FAMILIAR concept (JS absence) — a plain LENS to #void, no warn. (The warn tier
    // this row used to carry is the one V's ruling retires: undefined isn't
    // "explicitly incompatible," it's just the other host bottom — see null → nil
    // above, the two never collapse into one.)
    name: "undefined → #void (lens)",
    claims: (v) => v === undefined,
    box: () => theVoid,
  },
  {
    // The containment hierarchy for object-typed values that ARE plain data: JS array
    // IS an R7RS vector (faithful Rosetta mapping) → borrowed AJSArray; a
    // plain-prototype object → borrowed AJSObject. ONE row, ONE internal ladder
    // (Array.isArray checked first) — not two order-dependent siblings — because the
    // containment relationship (array ⊂ object, plain-proto ⊂ object) is a fact about
    // the shapes, not an accident of declaration order. An object that is NEITHER
    // (Date/Map/Set/RegExp/an unbranded class instance/…) is not claimed here at all;
    // it falls through to phase 3's door.
    name: "object → array/plain-object containment ladder",
    claims: (v) =>
      typeof v === "object" &&
      v !== null &&
      (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null),
    box: (ctx, v, p) => {
      invariant(typeof v === "object" && v !== null, "inbound claim 'object ladder': box called off its predicate");
      return Array.isArray(v) ? new AJSArray(v, p) : new AJSObject(v, p);
    },
  },
  {
    // A HOST `Error` — a FAMILIAR concept (a JS exception/data-shaped error object
    // returned as data, or caught and handed across a capability boundary), not an
    // "explicitly incompatible" exotic. Declared LENS, no warn: borrowed as an
    // AJSObject exactly like the plain-object row above, whose `stack` read
    // collapses to absent through the interop read policy (error-object-exit.law.test.ts
    // owns that law — a host Error's `stack` is a host-internals confession the
    // sandbox has no use for; `message`/`name` stay readable). An `R7RSError` is
    // NEVER reached here — it's claimed by phase 1's scheme-orphan row first, since
    // every Error subclass this router would otherwise see is a genuine host Error.
    // Kept a SEPARATE row from the object ladder above (not folded into its
    // "plain-object" check) because `Error.prototype` is never `Object.prototype` —
    // this is its own, deliberate carve-out, not a silent fallthrough.
    name: "host Error → borrowed AJSObject (declared lens)",
    claims: (v) => v instanceof Error,
    box: (ctx, v, p) => {
      invariant(v instanceof Error, "inbound claim 'host Error': box called off its predicate");
      return new AJSObject(v, p);
    },
  },
  {
    // JS primitives → the boxer table (boxing.ts): number → exact/inexact, boolean →
    // ABool flyweights, string → AString — never raw, the sandbox only holds boxed
    // AValues. `bigint` is deliberately EXCLUDED here — it's an opaque host value
    // (row below, not the boxer table): claiming it here would let boxing.ts's fromJs
    // mint it into an AExact, exactly the silent reinterpretation §2.3 forbids.
    name: "scalar → boxer table (fromJs)",
    claims: (v) => {
      const tag = typeof v;
      return tag === "string" || tag === "number" || tag === "boolean";
    },
    box: (ctx, v, p) => fromJs(ctx, v, p),
  },
  {
    // Registered symbol (`Symbol.for('x')`) has a portable string key → keyword `:x`.
    // A UNIQUE symbol has no portable identity — that is phase 3's door below, not
    // this lens (a registered and a unique symbol share a `typeof` tag but are NOT
    // the same concept: one has a stable cross-realm key, the other doesn't).
    name: "symbol → :keyword (registered)",
    claims: (v) => typeof v === "symbol" && Symbol.keyFor(v) !== undefined,
    box: (ctx, v, p) => {
      invariant(typeof v === "symbol", "inbound claim 'registered symbol': box called off its predicate");
      const key = Symbol.keyFor(v);
      invariant(key !== undefined, "inbound claim 'registered symbol': box called off its predicate (unregistered)");
      return new ASymbol(`:${key}`, p);
    },
  },
  {
    // Opaque HOST value — not a scheme number (docs/design-history/
    // arrival-one-number-rework.md §2.3): `number?` answers #f on it and arithmetic
    // coercion doors (op-helpers.ts's `coerceNumeric`), so it must never be claimed by
    // the scalar row above and boxed into an `AExact`. Rides the same raw identity
    // lane as the binary FFI row below — the explicit, safe-range-checked door OUT of
    // this opacity is `bigintToNumber` (this file).
    name: "bigint → raw passthrough (opaque host value, not a scheme number)",
    claims: (v) => typeof v === "bigint",
    box: (_ctx, v) => v,
  },
  {
    // The other DECLARED raw passthrough (named superset: FFI identity) — mirrors the
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
    // FUNCTION — deliberately UNCHANGED. TODO(V-fork): lens-to-callable vs door —
    // pending ruling. A borrowed JS function is not (yet?) a Scheme value — exposing
    // it as callable would let the sandbox escape into uncontrolled JS — voids,
    // loudly. This is the ONE row the binary ruling does NOT resolve: V has an open
    // fork on whether a bare host function should become a genuine callable lens or
    // the phase 3 door, and this restructure leaves today's behavior verbatim rather
    // than guessing which side of that fork V lands on.
    name: "function → #void (warn) [TODO(V-fork): lens-to-callable vs door — pending ruling]",
    claims: (v) => typeof v === "function",
    box: () => {
      warnMembrane("a JS function");
      return theVoid;
    },
  },
] as const;

export const INCOMPATIBILITY_DOOR_CLAIMS: readonly InboundClaim[] = [
  {
    // A bare Promise (or non-plain thenable) doors — see jsToSchemeAsyncDoor. Promise
    // VALUES inside structures never reach this row: the holding container settles
    // them lazily on entry read (pending-entry.ts). Ordered FIRST in this phase: a
    // Promise's `typeof` is "object", so it must be named before the generic
    // unbranded/exotic-object door below claims it with the wrong message.
    name: "promise → door (settle first; container entries settle lazily)",
    claims: (v) => is_promise(v),
    box: () => {
      throw jsToSchemeAsyncDoor();
    },
  },
  {
    // A unique (unregistered) JS symbol: no stable cross-realm key, so no lens exists
    // for it in the algebra — EXPLICITLY INCOMPATIBLE, not a warn-and-void degrade.
    name: "unique symbol → door (no lens)",
    claims: (v) => typeof v === "symbol",
    box: () => {
      throw new NoLensError("unique-symbol");
    },
  },
  {
    // Residual exotics (Date/Map/Set/RegExp, an unbranded class instance, …) that
    // carry NO owned-artifact mark (phase 1 missed) and match NEITHER declared phase
    // 2 lens (not the array/plain-object ladder, not a host Error): no lens exists
    // for them — EXPLICITLY INCOMPATIBLE. This is the flip from the old warn-and-
    // borrow tier (an AJSObject wrap with a console warning) to a loud door naming
    // the two cures: brand the class `@arrival.private`, or hand plain data instead.
    name: "unbranded/exotic object → door (no lens)",
    claims: (v) => typeof v === "object" && v !== null,
    box: (_ctx, v) => {
      invariant(typeof v === "object" && v !== null, "inbound claim 'unbranded/exotic object': box called off its predicate");
      throw new NoLensError("unbranded-class", v.constructor?.name ?? "<anonymous object>");
    },
  },
] as const;

/**
 * THE inbound claim registry — jsToScheme's whole value-kind algebra as one flat,
 * DECLARED, ORDERED fold: {@link OWNED_ARTIFACT_CLAIMS} then {@link
 * FOREIGN_LENS_CLAIMS} then {@link INCOMPATIBILITY_DOOR_CLAIMS} (first claiming row
 * wins). The concatenation order across the three phases IS semantic (phase 1 must
 * run to completion before phase 2, and phase 2 before phase 3's catch-all doors);
 * within phase 1 and (mostly) within phase 2 the row order is NOT semantic — see the
 * three phases' own doc above. The inbound-registry law test pins this flat list's
 * names in order regardless, so an accidental reorder across phase boundaries is
 * still a caught diff.
 */
export const INBOUND_CLAIMS: readonly InboundClaim[] = [
  ...OWNED_ARTIFACT_CLAIMS,
  ...FOREIGN_LENS_CLAIMS,
  ...INCOMPATIBILITY_DOOR_CLAIMS,
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
 * it — RosettaOptions is entirely an outbound/wrapper-call concern, threaded for
 * signature parity and never read here.
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

/**
 * The ONE explicit, safe-range-checked door out of an opaque host `bigint` (the
 * INBOUND_CLAIMS "bigint → raw passthrough" row above) into a plain JS `number` a
 * caller can then hand to `fromJs`/`mintExact` to become a genuine scheme exact.
 * §2.3's opaque-host-value law: a bigint never SILENTLY becomes a scheme number
 * (`coerceNumeric` doors on it); this is the sanctioned, explicit alternative —
 * throws rather than losing precision on an out-of-range value, mirroring every
 * other ingress gate in the one-number rework (values/mint-numeric.ts's
 * crash-on-overflow law).
 *
 * JS-level conversion only. Binding it as a `symbol.native` (the scheme-visible
 * surface, `bigint->number`) belongs in whichever env/r7rs cluster owns numeric
 * verbs (env/r7rs/numeric.ts is the natural home, alongside
 * `exact->inexact`/`inexact->exact`) — not wired here.
 */
export function bigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TypeError(
      `bigint->number: ${value} exceeds safe-integer range — arrival's exact numbers are safe-integer ` +
        "ratios (docs/design-history/arrival-one-number-rework.md), so this host bigint cannot convert " +
        "without precision loss",
    );
  }
  return Number(value);
}

export const createRosettaWrapper = ({ fn }: RosettaFunction) => {
  return async function rosettaWrapper(this: CallCtx, ...schemeArgs: SchemeValue[]) {
    // Collect provenance from AValue inputs before schemeToJs strips AValue identity (and provenance field) to JS primitives.
    // `Extract<SchemeValue, AValue>`, not abstract `AValue` base: SchemeValue's non-AValue members (EOF/Values/R7RSError/bare-fn AProcedure arm) fail reverse assignability TS `filter` predicate; `AValue` itself missing fields some concrete members (e.g. ARosettaProcedure arity/contract) require — Extract picks exactly union members `instanceof AValue` recognizes.
    const inputAValues = schemeArgs.filter((a): a is Extract<SchemeValue, AValue> => a instanceof AValue);
    const inputProvenance = unionProvenance(inputAValues);

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
          makeCallCtx(runCtx, inv, undefined),
          withRegionScope(scope, () => schemeArgs.map((arg) => schemeToJs(arg))),
        );
      } finally {
        closeRegionScope(scope);
      }

      // Decide output provenance before jsToScheme so deep-stamp reaches every constructed AValue in one pass — mint overrides inputs. No invocation in ctx (e.g. direct JS calls in tests): fall back to input provenance, silently. Node metadata bound separately via `ctx.currentInvocation.setMetadata(…)` — known up front, doesn't ride result.
      // The shrunk `RosettaFunction` (Tier 1 cleanup — sole producer never passes `pure`)
      // always MINTS a fresh provenance point, unconditionally — the `pure`-gated
      // "propagate inputs' provenance instead" branch this used to have died with the field.
      let resultProvenance = inputProvenance;
      if (inv && typeof inv.id === "number") {
        // MobX observable — flip via own action for strict-mode safety. Plain POJO (direct-JS tests) has no method, set directly.
        if (typeof inv.markProvenancePoint === "function") inv.markProvenancePoint();
        else inv.isProvenancePoint = true;
        resultProvenance = pointProvenance(inv.id);
      }

      return jsToScheme(runCtx, rawResult, undefined, resultProvenance);
    } catch (error) {
      console.error("Rosetta function error:", error);
      throw error;
    }
  };
};

// ── Callable-toJS marshal install (module init) ─────────────────────────────────────────────
// ACallable's `arrival/toJS` builds its host-callable reverse-membrane wrapper through these
// two crossings, but cannot import this module (the scheme-zod init cycle its preamble
// documents) — so the seam is injected here, once, at membrane load. Default-options crossings
// only; the mode-keyed, region-disciplined projection stays `callableToHostFn` above.
_installCallableMarshal({
  jsToScheme: (runCtx, value) => jsToScheme(runCtx, value, {}),
  schemeToJs: (value) => schemeToJsUntyped(value),
});

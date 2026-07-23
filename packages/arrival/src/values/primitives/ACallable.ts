// Every arrival callable is an AValue with an EXPLICIT `run(args, callCtx)` surface,
// replacing the `this = { ctx }` smuggling convention that crashed at every non-evaluator
// call site (`APair.map` doing `fn(x)`, the membrane, direct JS). `callCtx` is the ONLY
// threaded context — it wraps the run-level state (strict / heapMeter, via `callCtx.runCtx`)
// with the per-call invocation (provenance minting), built ONCE at dispatch and threaded
// whole rather than reconstructed downstream from ambient state. Provenance is NOT threaded
// separately: it rides the values and is minted only at the rosetta membrane, as `union(args)`.
//
// Three concrete callables, sibling classes each extending AValue directly — NO abstract
// parent. The exported `ACallable` is a UNION of the three concretes, which narrows and
// discriminates far better than an abstract base in the SchemeValue union:
//   • ALambda            — scheme body + captured lexical scope; run trampolines into the body.
//   • ANativeProcedure   — host-JS CONTOUR (car/cdr/cons/map/…); stays in the value algebra.
//   • ARosettaProcedure  — host-JS MEMBRANE (rosetta/MCP); decode → host → encode → mint.
//
// These are LIVE: the bake/capability binders mint ANativeProcedure/ARosettaProcedure
// (common/capability.ts, scheme-zod.ts's z.procedure), the evaluator mints ALambda
// (evalLambda, named-let), and dispatch routes through `applyCallback`/the apply term.
//
// toJS IS the membrane: a callable's `arrival/toJS` returns a HOST-CALLABLE function — the
// reverse-membrane projection (JS args cross IN through jsToScheme, the apply term runs, the
// result crosses OUT through schemeToJs). It is NOT display (that's `arrival/print`) — the
// protocol must answer the same faithful crossing whether reached through schemeToJs's
// fast-path special-case or dispatched directly. The marshallers are INJECTED
// (`_installCallableMarshal`, from membrane/rosetta.ts's module init) because importing
// rosetta.ts here would close the scheme-zod init cycle (see the CallCtx note below).
// REGION-DISCIPLINED (toJS-protocol collapse): the wrapper closes over `currentRegionScope() ??
// DETACHED_SCOPE`, minted/cached on THAT scope's own `cache` — the same (callable, scope,
// WrapperKey) slot membrane/rosetta.ts's (now-thin) `callableToHostFn` reads, and the same
// discipline scheme-zod.ts's typed `z.procedure` family shares one level over (keyed "typed"
// there, "mem" here). The former process-global, options-less, CONSTANT_CTX-only cache is
// GONE — there is exactly ONE cache a callable's host projection ever lives in, region-scope.ts's
// `RegionScope.cache`, regardless of which door (a direct `value["arrival/toJS"]()`, a
// container's nested-element materialization, or rosetta's `schemeToJs`) reached it.

import { AValue } from "./AValue.js";
import type { MembraneExit, SchemeBounceMarker, SchemeValue, WrapperKey } from "../types.js";
import { tf } from "../tagless-final.js";
import type { RunContext } from "../../run/RunContext.js";
// CallCtx lives in this same directory (not common/symbols/_bake.ts) specifically so this file
// never transitively imports common/scheme-zod.ts — that used to close a cycle (scheme-zod
// imports ACallable for ALambda/etc.; _bake imports scheme-zod) that could leave a
// z.instanceof(...) codec's captured class permanently undefined, depending on which path
// entered it first.
import { makeCallCtx, type CallCtx } from "../../run/CallCtx.js";
import { PurityError } from "../../errors.js";
// TYPE-ONLY: erased at compile, so this stays a pure compile-time edge even though
// common/symbols/_bake.ts has its own runtime path back to this file (via scheme-zod.ts,
// see the CallCtx note above) — a REAL (value) import here would close that cycle.
import type { DoorSymbolDef } from "../../common/symbols/_bake.js";
// TYPE-ONLY: `InvocationLike` is rosetta.ts's own duck-typed shape (see that file's doc) — the
// SAME benign compile-time edge CallCtx.ts's own `invocation.currentInvocation` field already
// carries (CallCtx.ts imports it the same way). Erased at compile: no runtime cycle.
import type { InvocationLike } from "../../membrane/rosetta.js";
// Region discipline (membrane/region-scope.ts) sits BELOW this file in the import order — its
// own transitive imports (RunContext.ts, errors.ts, provenance/store/{ids,interfaces,records,
// fold}.ts) are all type-only or equally leaf-ward, none reaching back to ACallable.ts or
// scheme-zod.ts — so importing its ambient scope holder + reverse-call bookkeeping here closes
// no cycle (a genuinely new, but safe, edge).
import { currentRegionScope, DETACHED_SCOPE, withRegionCall, withRegionScope } from "../../membrane/region-scope.js";
// Leaf, ZERO own imports (see that file's header) — lets a reverse-membrane re-entry nest its
// trace under the exporting invocation instead of the lambda's definition-time lexical one.
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import invariant from "tiny-invariant";

/** A callable's return: a settled value, a trampoline bounce (tail-position lambda), or a
 *  promise (JS-host entry). Non-value returns are narrowed out at the call boundary. */
export type CallResult = SchemeValue | SchemeBounceMarker | Promise<SchemeValue>;

/** Arity bounds. `max: null` ⇒ variadic (unbounded tail). Drives the arity check and the
 *  MCP / type-lens introspection that reads it straight off the value. */
export interface Arity {
  readonly min: number;
  readonly max: number | null;
}

/** The impl shape every host-JS callable body targets AFTER the migration: scheme-value args
 *  in, a CallResult out, the call's whole `CallCtx` threaded explicitly (never via `this`) —
 *  the per-call invocation (provenance minting) arrives with it instead of being reconstructed
 *  downstream from ambient state. An impl that needs only the bare run state reads
 *  `callCtx.runCtx`. Typed here as the destination; stage 1 adapts `_bake.ts` to emit it. */
export type CallableImpl = (args: SchemeValue[], callCtx: CallCtx) => CallResult;

// Shared leaf behavior, as free functions the concrete classes delegate to (no abstract
// parent). A procedure's identity is load-bearing (`(eq? car car)`), so provenance stamping
// is a no-op that preserves reference identity, and equality is reference identity.
const callableEquals = (self: object, other: unknown): boolean => other === self;

// ── The injected marshal seam (see preamble, toJS IS the membrane) ─────────────────────────
// membrane/rosetta.ts installs the two crossing functions at its own module init; this file
// cannot import them (scheme-zod init cycle). A callable's `arrival/toJS` before that init is
// a genuine crossing with no membrane to cross — door loudly (P5), never fall back to a lie.
interface CallableMarshal {
  jsToScheme: (runCtx: RunContext, value: unknown) => unknown;
  schemeToJs: (value: unknown) => unknown;
}
let marshal: CallableMarshal | undefined;
/** Module-init hook for membrane/rosetta.ts ONLY — not a public extension point. */
export function _installCallableMarshal(m: CallableMarshal): void {
  marshal = m;
}

// ── The inbound reverse-membrane lens (hostFnToCallable) — the bifunctor's OTHER leg ───────
// hostProjectionOf above is the outbound projection (scheme callable → host fn); this is its
// mirror, js→scheme (V's ruling, stage-c-corpse-deletion.md §"V rulings batch" 2026-07-24):
// "host fn crosses into scheme as a callable; when scheme calls it, args cross scheme→js,
// result crosses js→scheme. SAME logic for functions RETURNED from symbol.rosetta impls."
// Lives here (not membrane/rosetta.ts) for the SAME reason hostProjectionOf does — the one
// module that already owns the injected marshal seam mints both directions off it, so
// neither direction needs a second seam or a fresh cycle into rosetta.ts.

/** Reverse of `WRAPPER_KEY`'s cache: a reverse-membrane wrapper minted by `hostProjectionOf`
 *  → the ORIGINAL `ACallable` it projects. Registered at mint time (below), read by
 *  `originalCallableOf` — the inbound router's re-admission claim (rosetta.ts's
 *  OWNED_ARTIFACT_CLAIMS) consults this BEFORE `hostFnToCallable`'s generic lens, so a
 *  wrapper crossing back IN re-admits as its original callable (`eq?`) instead of being
 *  wrapped a second time — the SAME round-trip-to-identity law egress-proxy.ts's R9
 *  `PROXY_ORIGIN` gives containers, applied to the one shape (a plain function) proxies
 *  can't cover. */
const WRAPPER_ORIGIN = new WeakMap<object, ACallable>();

/** The inverse of `hostProjectionOf`'s mint: `undefined` for anything that isn't one of
 *  THIS module's own reverse-membrane wrappers (a plain host function, a foreign closure,
 *  another callable's wrapper under a DIFFERENT scope never registers here — only ever the
 *  scope it was actually minted under does). */
export function originalCallableOf(fn: object): ACallable | undefined {
  return WRAPPER_ORIGIN.get(fn);
}

/** Run-scoped mint-or-reuse cache for the FORWARD lens: `(RunContext, host fn) → the ONE
 *  ARosettaProcedure that fn crosses in as, within that run.` Run-scoped for the SAME reason
 *  `AOpaqueHandle.for`'s cache is (that class's own header): provenance is minted from ONE
 *  run's own invocation numbering, so a global cache would let a wrapper minted under run A
 *  accumulate ids from run B that mean nothing (or something else) under run A's numbering. */
const HOST_FN_CACHE = new WeakMap<RunContext, WeakMap<(...args: unknown[]) => unknown, ARosettaProcedure>>();

/**
 * THE INBOUND REVERSE-MEMBRANE LENS: a bare host function crossing js→scheme becomes a
 * genuine scheme-callable `ARosettaProcedure` — completing the callable bifunctor
 * `hostProjectionOf` gives the OTHER direction. When scheme applies it: args cross
 * scheme→js (`marshal.schemeToJs`, default options — the args are already IN hand, no
 * region/scope concern the outbound wrapper has to guard), the host fn runs, and its
 * result crosses js→scheme (`marshal.jsToScheme` under the CALLING invocation's
 * `callCtx.runCtx` — the live run, correct meter/provenance) — promise-tolerant, since a
 * host fn reached this way is often async.
 *
 * IDENTITY: mint-or-reuse per `(RunContext, fn)` — the SAME host fn crossing twice within
 * one run answers the literal same callable (`eq?`), never a fresh wrapper each time.
 * `provenance` stamps ONLY the first mint (constructor arg, see `ARosettaProcedure`'s own
 * doc) — a procedure's identity is load-bearing (`callableEquals`'s note, this file's
 * preamble), so unlike `AOpaqueHandle` (a DATA value, remints-and-merges on every crossing)
 * a later crossing of the SAME fn with different provenance does not fork identity; it
 * answers the cached value unchanged, exactly like ALambda/ANativeProcedure's own no-op
 * `withProvenance`.
 *
 * Bounce concerns don't apply here (unlike `hostProjectionOf`): the host fn being wrapped
 * cannot itself trampoline — it is opaque JS, not a scheme apply term.
 */
export function hostFnToCallable(
  ctx: RunContext,
  fn: (...args: unknown[]) => unknown,
  provenance: ReadonlySet<number>,
): ARosettaProcedure {
  let byFn = HOST_FN_CACHE.get(ctx);
  if (byFn === undefined) {
    byFn = new WeakMap();
    HOST_FN_CACHE.set(ctx, byFn);
  }
  const cached = byFn.get(fn);
  if (cached !== undefined) return cached;
  const proc = new ARosettaProcedure(
    {
      // Host functions are frequently anonymous (arrow callbacks) — `fn.name` answers ""
      // for those, not undefined, so the `||` fallback is reachable, not dead.
      name: fn.name || "host-function",
      // Unknown arity by construction — an arbitrary host fn's arity is not introspectable
      // (mirrors the `z.procedure`-minted ARosettaProcedure's own `{min:0, max:null}`,
      // symbols/rosetta.ts).
      arity: { min: 0, max: null },
      contract: undefined,
      strategy: undefined,
      impl: (args, callCtx): CallResult => {
        if (marshal === undefined) {
          throw new Error(
            "jsToScheme: a host-function callable applied before membrane init (membrane/rosetta.ts not loaded)",
          );
        }
        const jsArgs = args.map((a) => marshal!.schemeToJs(a));
        const result = fn(...jsArgs);
        return result instanceof Promise
          ? result.then((r) => marshal!.jsToScheme(callCtx.runCtx, r) as SchemeValue)
          : (marshal!.jsToScheme(callCtx.runCtx, result) as SchemeValue);
      },
    },
    provenance,
  );
  byFn.set(fn, proc);
  return proc;
}

/** Opaque bounce-marker check for a reverse-membrane result reaching this host boundary — see
 *  types.ts's `SchemeBounceMarker` doc: a call boundary always narrows it out before any value
 *  use, so a host caller (this wrapper IS that boundary) must never see one. Named + an explicit
 *  assertion, not a widened input type admitting the structurally-impossible shape. */
function isBounceMarker(x: unknown): x is SchemeBounceMarker {
  return typeof x === "object" && x !== null && (x as Partial<SchemeBounceMarker>).__bounce === true;
}

/** The wrapper cache's key for THIS crossing family — a literal, not a computed mode: a
 *  callable's host projection never varies by RosettaOptions content (a nested callable element
 *  produces the identical wrapper shape whether its container egressed bare or under a real
 *  membrane exit — only a CONTAINER's own proxy identity distinguishes bare/mem, see
 *  egress-proxy.ts), so `"mem"` is simply this family's fixed slot on the two-level cache,
 *  alongside scheme-zod.ts's own `"typed"` slot (RegionScope.cache's own doc, region-scope.ts). */
const WRAPPER_KEY: WrapperKey = "mem";

/**
 * Build (once per (callable, scope)) the host-callable reverse-membrane wrapper — see the file
 * preamble ("toJS IS the membrane"). Region-disciplined (docs/membrane.md §REGION): closes over
 * `currentRegionScope() ?? DETACHED_SCOPE` AT MINT TIME, never re-reads it, and mints/reuses on
 * THAT scope's own `RegionScope.cache` — the SAME (callable, scope, WrapperKey) slot
 * membrane/rosetta.ts's (now-thin) `callableToHostFn` reads, so a dict holding this callable and
 * a bare top-level crossing of it resolve to the literal same wrapper under the same scope. A
 * call long after the exporting invocation returned still targets the scope it was minted under,
 * tripping `withRegionCall`'s escape door rather than silently reading whatever's ambient later.
 *
 * `exit`, when supplied, is the `MembraneExit` a container's own crossing hands its elements
 * (rosetta.ts's `egressAValue` builds it; every native container's `arrival/toJS(exit?)` and this
 * one thread it the same way) — reused VERBATIM for the result leg: `exit.element(raw)` already
 * IS `schemeToJsImpl(raw, options)` run under the pinned exporting scope, so a NESTED callable's
 * result gets the exact recursive crossing a top-level one does, with the SAME options bag, with
 * zero knowledge of `RosettaOptions` needed in this file. No `exit` — a bare direct protocol call
 * (`callable["arrival/toJS"]()`), or a container's BARE serialization egress materializing a
 * nested callable element with no membrane exit at all — falls back to the injected marshal's
 * default-options `schemeToJs`.
 */
function hostProjectionOf(self: ACallable, exit?: MembraneExit): (...args: unknown[]) => unknown {
  const scope = currentRegionScope() ?? DETACHED_SCOPE;
  let byKey = scope.cache.get(self);
  if (byKey === undefined) {
    byKey = new Map();
    scope.cache.set(self, byKey);
  }
  const cached = byKey.get(WRAPPER_KEY);
  if (cached) return cached;
  const wrapper = (...jsArgs: unknown[]): Promise<unknown> =>
    withRegionCall(scope, async () => {
      if (marshal === undefined) {
        throw new Error("arrival/toJS: callable crossing before membrane init (membrane/rosetta.ts not loaded)");
      }
      // Args mint under the ENCLOSING invocation's runCtx, never CONSTANT_CTX — `scope.runCtx`
      // is exactly that (or CONSTANT_CTX for the DETACHED fallback). A promise-valued arg
      // settles BEFORE boxing (the reverse membrane is already async); a bare Promise reaching
      // jsToScheme doors (jsToSchemeAsyncDoor, rosetta.ts).
      const schemeArgs = (await Promise.all(
        jsArgs.map(async (a) => marshal!.jsToScheme(scope.runCtx, await a)),
      )) as SchemeValue[];
      const callCtx = makeCallCtx(scope.runCtx, scope.dynSite as InvocationLike | undefined);
      // Re-entry trace nests under the exporting invocation — `scope.dynSite` is that same
      // invocation, threaded WHOLE through the apply term rather than reconstructed downstream
      // from ambient state; nested lambda re-entry still reads it ambiently at its own dispatch
      // (evaluator HOF-boundary wrappers).
      const raw = await withDynamicCallSite(scope.dynSite, () => applyCallback(self, schemeArgs, callCtx));
      invariant(!isBounceMarker(raw), "arrival/toJS: a reverse-membrane call resolved to a bounce token");
      // Nested callable/container in the result crosses under the SAME scope: exit.element
      // (a real membrane crossing — options already closed over) or the marshal's default (bare).
      return withRegionScope(scope, () => (exit !== undefined ? exit.element(raw) : marshal!.schemeToJs(raw)));
    });
  byKey.set(WRAPPER_KEY, wrapper);
  // Register the reverse-admission mapping at mint time (before returning) — the SAME
  // "register before any trap/read" discipline egress-proxy.ts's R9 proxies follow, so a
  // caller that immediately hands this wrapper back across the membrane (jsToScheme) finds
  // the entry already there. See `originalCallableOf`'s own doc.
  WRAPPER_ORIGIN.set(wrapper, self);
  return wrapper;
}

// `arrival/print` display name — repr parity is what tests trip on first when a
// producer flips from a bare fn to a callable value. Mirrors
// print.ts's `functionRepr` symbol-cleanup: a gensym'd `__name__`/`name` prints its readable
// description, not the raw `Symbol(...)` wrapper.
function displayName(name: string | symbol): string {
  return typeof name === "symbol" ? name.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1") : name;
}

/** A scheme lambda: a body + the lexical scope captured at definition. The evaluator injects
 *  the `runner` closure (value→eval cycle avoidance, the same trick `Macro` uses) — this class
 *  names no evaluator symbol. `scope` is the captured Resolver, typed opaque here and tightened
 *  when evalLambda migrates in stage 2. */
export class ALambda extends AValue {
  readonly kind = "lambda" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  /** The captured lexical scope (a Resolver). */
  readonly scope: unknown;
  /** Mutable display name — `(define foo (lambda …))` stamps it post-construction (the evaluator's
   *  define-naming step), and tracers read it. Distinct from the immutable `name`. */
  __name__?: string | symbol;
  /** Positional parameter names, for tracer↔param-slot correlation. */
  __params__?: string[];
  readonly #runner: (args: SchemeValue[], callCtx: CallCtx, canBounce: boolean) => CallResult;

  constructor(opts: {
    name: string | symbol;
    arity: Arity;
    scope: unknown;
    runner: (args: SchemeValue[], callCtx: CallCtx, canBounce: boolean) => CallResult;
  }) {
    // A lambda's IDENTITY is minted at bake/define time (evalLambda, named-let), not per
    // invocation — live work threads the whole `callCtx` per-call through `impl(args, callCtx)`
    // instead.
    super();
    this.name = opts.name;
    this.arity = opts.arity;
    this.scope = opts.scope;
    this.#runner = opts.runner;
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    // see preamble, toJS IS the membrane. `applyCallback` (inside hostProjectionOf) dispatches
    // this value's own `arrival/tagless-final/apply` term — identical to calling `#runner`
    // directly with `canBounce: false` (a host caller can never trampoline).
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.__name__ ?? this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], callCtx: CallCtx, canBounce = false): CallResult {
    return this.#runner(args, callCtx, canBounce);
  }

  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}

/** A host-JS CONTOUR primitive (car/cdr/cons/map/…): stays inside the value algebra. `run` is
 *  validate → impl → validate; validation gains its teeth when the contract is enforced at
 *  stage 1 (a stub direct-call for now). `contract` is kept on the value for MCP/type-lens
 *  introspection. It carries NO membrane strategy — a native cannot cross into opaque host JS. */
export class ANativeProcedure extends AValue {
  readonly kind = "procedure" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  /** The zod contract, retained for validation + introspection. Opaque until stage 1. */
  readonly contract: unknown;
  readonly #impl: CallableImpl;

  constructor(opts: { name: string | symbol; arity: Arity; contract: unknown; impl: CallableImpl }) {
    // Same reasoning as ALambda's ctor above: a native procedure's IDENTITY is bound
    // once at capability-assembly time (common/capability.ts), never per invocation;
    // `impl(args, callCtx)` carries the live per-call ctx instead.
    super();
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.#impl = opts.impl;
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    // see preamble, toJS IS the membrane
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.name)}>`;
  }

  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], callCtx: CallCtx): CallResult {
    return this.#impl(args, callCtx);
  }

  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}

/** A host-JS MEMBRANE primitive (rosetta / MCP): the one boundary that leaves the value
 *  algebra into opaque host JS. `run` decodes args on entry, calls the host impl, encodes the
 *  result, and mints its provenance as `union(args.provenance)`. `strategy` holds the
 *  decode/encode/provenance options (was rosetta's options closure). The decode/encode bodies
 *  are stubs here and land when rosetta migrates in stage 3.
 *
 *  ALSO the mint target for `hostFnToCallable` below (the INBOUND reverse-membrane lens): a
 *  bare host function crossing js→scheme is exactly this shape — args decode (scheme→js),
 *  an opaque host impl runs, the result encodes (js→scheme) — so a fresh instance of this
 *  SAME class, not a new sibling, is the honest home (see that function's own doc). */
export class ARosettaProcedure extends AValue {
  readonly kind = "procedure" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  readonly contract: unknown;
  /** Decode/encode + provenance-mint options. Opaque until stage 3. */
  readonly strategy: unknown;
  readonly #impl: CallableImpl;

  constructor(
    opts: {
      name: string | symbol;
      arity: Arity;
      contract: unknown;
      strategy: unknown;
      impl: CallableImpl;
    },
    // Bake-time minters (scheme-zod.ts's `z.procedure`, symbols/rosetta.ts) never pass this —
    // a baked symbol's identity is fixed at define time, EMPTY_PROVENANCE is correct. The one
    // caller that DOES pass it is `hostFnToCallable`'s mint-or-reuse below: the value is born
    // from a CROSSING, so its provenance is that crossing's origin, stamped ONCE at mint —
    // `withProvenance` below stays a no-op afterward (a procedure's identity is load-bearing,
    // same as every sibling in this file), so a later re-crossing of the SAME host fn with
    // DIFFERENT provenance answers the cached instance unchanged rather than forking identity.
    provenance?: ReadonlySet<number>,
  ) {
    // Same reasoning as ALambda/ANativeProcedure's ctors above: bound once at
    // capability-assembly time (scheme-zod.ts's `z.procedure`), never per invocation.
    super(provenance);
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.strategy = opts.strategy;
    this.#impl = opts.impl;
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    // see preamble, toJS IS the membrane. NOTE the double crossing this deliberately buys:
    // `#impl` is NOT the raw host fn — it is `def.run`, the full rosetta marshal
    // (z.decode scheme args → authored host impl → z.encode → jsToScheme box; the raw
    // authored fn rides `this.contract.impl`). So the projection crosses host args IN
    // (jsToScheme), rosetta decodes them back OUT, the impl runs, rosetta boxes the result,
    // and the wrapper crosses it OUT again — round-trip-to-identity on both legs (the
    // bifunctor law), which keeps the contract's validation/rejection grammar live for
    // host callers instead of bypassing it to the naked impl.
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], callCtx: CallCtx): CallResult {
    return this.#impl(args, callCtx);
  }
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}

/** A bound DOOR VALUE (errors-as-doors — `symbol.notImplemented`, `common/capability.ts`'s
 *  door bind arm) — the introspectable replacement for the former anonymous throwing
 *  closure (`env.set(verb, () => { throw … })`). Resolves like any other binding — a bare
 *  reference is legal, only APPLICATION throws — carrying the same teaching `PurityError`
 *  a door has always thrown: the message includes just `name` when the baked `door`
 *  carries no `cause`, and leads with `name @ owner` once one is stamped (every identity
 *  in a diagnostic resolves to `name @ capability`, never a raw hash). `.door` is the
 *  static introspection surface: the static validator (and discovery, and the
 *  wireframe) read door-ness + cause off the bound value instead of an opaque closure.
 *
 *  A sibling of ACallable's other concretes — extends `AValue` directly, joins the union
 *  below — rather than a bare JS closure, so it fires through the SAME apply term the
 *  evaluator's structural `is_applyable`/`is_callable_value` gates already dispatch
 *  through (the call-head path, `=>`'s arrow-proc threading, `procedure?`, …) with no
 *  special-casing at any call site. */
export class DoorProcedure extends AValue {
  readonly kind = "procedure" as const;
  /** JS never enforced arity on the former closure (an arrow fn declaring 0 params) — a
   *  door fires unconditionally regardless of arg count. `{min: 0, max: null}` names that
   *  honestly (unbounded-tolerant) and keeps `ACallable.arity` a total field across every
   *  member of the union (srfi-235.ts's `procedure-min-arity` reads it off ANY callable
   *  value, matching the same `.length === 0` the old bare closure answered). */
  readonly arity: Arity = { min: 0, max: null };

  constructor(readonly door: DoorSymbolDef) {
    // Same reasoning as the sibling ctors above: a door is bound once at
    // capability-assembly time; it never mints run-tagged output (its `apply` term
    // unconditionally throws before touching any value).
    super();
  }

  ["arrival/toJS"](exit?: MembraneExit): unknown {
    // Faithful projection of a door: a host-callable that THROWS the same teaching
    // PurityError the apply term throws — crossing a door does not disarm it.
    return hostProjectionOf(this, exit);
  }
  ["arrival/print"](): string {
    return `#<procedure:${this.door.name}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
  /** Fires UNCONDITIONALLY, before any argument is even looked at — matches the pre-
   *  DoorProcedure closure's behavior (`declared-doors.law.test.ts` calls every door with
   *  0 args, uniformly, regardless of its real arity). */
  ["arrival/tagless-final/apply"](): never {
    const owner = this.door.cause?.owner;
    const message = owner
      ? `${this.door.name} @ ${owner} is not available.\n  Why: ${this.door.reason}`
      : `${this.door.name} is not available.\n  Why: ${this.door.reason}`;
    throw new PurityError(message, this.door.name, owner);
  }
}

/** The callable union — of concrete classes, not an abstract parent (better narrowing, clean
 *  `kind` discrimination, and it drops cleanly into the SchemeValue union). `DoorProcedure`
 *  joins it so `is_callable_value`/`z.lambda`'s raw predicate stay SOUND — a door is a
 *  genuine callable value (it has an apply term, the "procedure" kind), not a lesser shape. */
export type ACallable = ALambda | ANativeProcedure | ARosettaProcedure | DoorProcedure;

/**
 * The single invocation seam every callback site routes through — the evaluator call-head, the
 * R7RS `apply`, and every HOF that applies an element callback (`APair.map`, `AVector.map`, …).
 * Dispatches the `arrival/tagless-final/apply` term when the callee is a callable VALUE, and
 * falls back to a bare host fn with an EXPLICIT, DEFINED `this = callCtx` — the fix for the whole
 * `this=undefined` crash class (`APair.map` used to do a bare `fn(x)`, handing `undefined` to an
 * impl that reads `this.runCtx`). `canBounce` stays false: a HOF-applied callback is never in
 * tail position, so a lambda fully runs rather than returning a bounce the HOF can't trampoline.
 * This seam is what makes the native→ANativeProcedure flip (stage 1) non-breaking — both callee
 * shapes are invoked identically here.
 */
// `args` is `readonly unknown[]`, not `SchemeValue[]`: the value algebra surfaces list/vector
// elements as `unknown` (the spine-walk convention — narrowed at consumption, never asserted at
// the slot), so the seam accepts that and casts ONCE here, at the boundary between the
// unknown-typed algebra and the typed callable surface (the elements ARE scheme values).
// `fn` is `unknown` for the same reason: every decoded callback argument funnels here,
// and a non-callable is doored at runtime (the `not applicable` throw), not silently
// tolerated by a type-level cast at each of the ~dozen call sites.
// `callCtx` has no default: a defaulted `testCallCtx()` would let a caller omit the argument
// silently (loader-capability.ts's `require` resolver dispatch used to do exactly that with a
// bare runCtx; it now threads `this` — the CallCtx it was dispatched with — one hop away).
// Every remaining `makeCallCtx(runCtx)` at a call site (op-helpers.ts's `deriveSortCompare`,
// srfi-1/srfi-13's callback seams) is a literal, grep-able confession — a real CallCtx with no
// invocation — rather than a silent fallback.
export function applyCallback(fn: unknown, args: readonly unknown[], callCtx: CallCtx): CallResult {
  const term = (fn as Partial<ALambda> | null | undefined)?.[tf("apply")];
  if (typeof term === "function") {
    return (term as (args: SchemeValue[], callCtx: CallCtx, canBounce?: boolean) => CallResult).call(
      fn,
      args as SchemeValue[],
      callCtx,
      false,
    );
  }
  if (typeof fn === "function") {
    return Reflect.apply(fn, callCtx, args as unknown[]) as CallResult;
  }
  throw new TypeError(
    `not applicable: ${fn === null ? "null" : typeof fn === "object" ? "a non-callable value" : typeof fn}`,
  );
}

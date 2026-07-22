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
// CURRENT LIMITS (next iterations): the wrapper runs under CONSTANT_CTX — no region scope,
// no live run, provenance lost; `callableToHostFn` (membrane/rosetta.ts) remains the
// region-DISCIPLINED projection rosetta crossings use. The two share semantics, not state.

import { AValue } from "./AValue.js";
import type { SchemeBounceMarker, SchemeValue } from "../types.js";
import { tf } from "../tagless-final.js";
import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
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

// Identity-stable projection: `toJS` twice on the same callable answers the SAME host fn
// (mirrors the value's own load-bearing reference identity). Options-less single variant —
// the region-disciplined, mode-keyed cache stays callableToHostFn's.
const hostProjections = new WeakMap<object, (...args: unknown[]) => unknown>();

/** Build (once per value) the host-callable reverse-membrane wrapper: JS args in →
 *  jsToScheme (under CONSTANT_CTX — no live run at a bare protocol crossing; run-axis
 *  fidelity is the next iteration) → apply term (`canBounce` false: a host caller cannot
 *  trampoline) → result out through schemeToJs (promise-tolerant: an async impl's settle
 *  crosses when it lands). */
function hostProjectionOf(
  self: object,
  apply: (args: SchemeValue[], callCtx: CallCtx) => CallResult,
): (...args: unknown[]) => unknown {
  const cached = hostProjections.get(self);
  if (cached) return cached;
  const wrapper = (...jsArgs: unknown[]): unknown => {
    if (marshal === undefined) {
      throw new Error("arrival/toJS: callable crossing before membrane init (membrane/rosetta.ts not loaded)");
    }
    const { jsToScheme, schemeToJs } = marshal;
    const schemeArgs = jsArgs.map((a) => jsToScheme(CONSTANT_CTX, a)) as SchemeValue[];
    const raw = apply(schemeArgs, makeCallCtx(CONSTANT_CTX));
    if (raw instanceof Promise) return raw.then((settled) => schemeToJs(settled));
    return schemeToJs(raw);
  };
  hostProjections.set(self, wrapper);
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

  ["arrival/toJS"](): unknown {
    // see preamble, toJS IS the membrane
    return hostProjectionOf(this, (args, callCtx) => this.#runner(args, callCtx, false));
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

  ["arrival/toJS"](): unknown {
    // see preamble, toJS IS the membrane
    return hostProjectionOf(this, (args, callCtx) => this.#impl(args, callCtx));
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
 *  are stubs here and land when rosetta migrates in stage 3. */
export class ARosettaProcedure extends AValue {
  readonly kind = "procedure" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  readonly contract: unknown;
  /** Decode/encode + provenance-mint options. Opaque until stage 3. */
  readonly strategy: unknown;
  readonly #impl: CallableImpl;

  constructor(opts: {
    name: string | symbol;
    arity: Arity;
    contract: unknown;
    strategy: unknown;
    impl: CallableImpl;
  }) {
    // Same reasoning as ALambda/ANativeProcedure's ctors above: bound once at
    // capability-assembly time (scheme-zod.ts's `z.procedure`), never per invocation.
    super();
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.strategy = opts.strategy;
    this.#impl = opts.impl;
  }

  ["arrival/toJS"](): unknown {
    // see preamble, toJS IS the membrane. NOTE the double crossing this deliberately buys:
    // `#impl` is NOT the raw host fn — it is `def.run`, the full rosetta marshal
    // (z.decode scheme args → authored host impl → z.encode → jsToScheme box; the raw
    // authored fn rides `this.contract.impl`). So the projection crosses host args IN
    // (jsToScheme), rosetta decodes them back OUT, the impl runs, rosetta boxes the result,
    // and the wrapper crosses it OUT again — round-trip-to-identity on both legs (the
    // bifunctor law), which keeps the contract's validation/rejection grammar live for
    // host callers instead of bypassing it to the naked impl.
    return hostProjectionOf(this, (args, callCtx) => this.#impl(args, callCtx));
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

  ["arrival/toJS"](): unknown {
    // Faithful projection of a door: a host-callable that THROWS the same teaching
    // PurityError the apply term throws — crossing a door does not disarm it.
    return hostProjectionOf(this, () => this["arrival/tagless-final/apply"]());
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

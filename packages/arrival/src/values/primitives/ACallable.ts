// Every arrival callable is an AValue with an EXPLICIT `run(args, runCtx)` surface,
// replacing the `this = { ctx }` smuggling convention that crashed at every non-evaluator
// call site (`APair.map` doing `fn(x)`, the membrane, direct JS). `runCtx` is the ONLY
// threaded context (strict / heapMeter) — it is run-level and cannot be
// recovered from operands (a quoted literal carries CONSTANT_CTX). Provenance is NOT
// threaded: it rides the values and is minted only at the rosetta membrane, as `union(args)`.
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
// FALLBACK toJS: a callable's `arrival/toJS` is fallback display ONLY. The real JS projection
// is the reverse-membrane region wrapper (membrane.toJS()/schemeToJs), which special-cases
// is_callable_value BEFORE this protocol method — so exec() can hand back an ALambda/AProcedure
// as a callable host fn. This method is reached only when a callable is protocol-dispatched
// OUTSIDE those exits (e.g. a print path). Keeping rosetta OUT of this file's imports avoids a
// scheme-zod init cycle (see the makeCallCtx note below).

import { AValue } from "./AValue.js";
import { CONSTANT_CTX, type RunContext } from "../../run/RunContext.js";
import type { SchemeBounceMarker, SchemeValue } from "../types.js";
import { tf } from "../tagless-final.js";
// makeCallCtx lives in this same directory (not common/symbols/_bake.ts) specifically so this
// file never transitively imports common/scheme-zod.ts — that used to close a cycle (scheme-zod
// imports ACallable for ALambda/etc.; _bake imports scheme-zod) that could leave a
// z.instanceof(...) codec's captured class permanently undefined, depending on which path
// entered it first.
import { makeCallCtx } from "../../run/CallCtx.js";
import { PurityError } from "../../errors.js";
// TYPE-ONLY: erased at compile, so this stays a pure compile-time edge even though
// common/symbols/_bake.ts has its own runtime path back to this file (via scheme-zod.ts,
// see the makeCallCtx note above) — a REAL (value) import here would close that cycle.
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
 *  in, a CallResult out, the run's `runCtx` threaded explicitly (never via `this`). Typed here
 *  as the destination; stage 1 adapts `_bake.ts` to emit it. */
export type CallableImpl = (args: SchemeValue[], runCtx: RunContext) => CallResult;

// Shared leaf behavior, as free functions the concrete classes delegate to (no abstract
// parent). A procedure's identity is load-bearing (`(eq? car car)`), so provenance stamping
// is a no-op that preserves reference identity, and equality is reference identity.
const callableEquals = (self: object, other: unknown): boolean => other === self;

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
  readonly #runner: (args: SchemeValue[], runCtx: RunContext, canBounce: boolean) => CallResult;

  constructor(opts: {
    name: string | symbol;
    arity: Arity;
    scope: unknown;
    runner: (args: SchemeValue[], runCtx: RunContext, canBounce: boolean) => CallResult;
    ctx?: RunContext;
  }) {
    // A lambda's IDENTITY is minted at bake/define time (evalLambda, named-let), not per
    // invocation — live work threads `runCtx` per-call through `impl(args, runCtx)`
    // instead. (evaluator.ts's `ctx.runCtx ?? CONSTANT_CTX` upstream fallback at the two
    // call sites that construct a LONG-LIVED user lambda is a separate concern — not
    // this ctor.)
    super(opts.ctx ?? CONSTANT_CTX);
    this.name = opts.name;
    this.arity = opts.arity;
    this.scope = opts.scope;
    this.#runner = opts.runner;
  }

  ["arrival/toJS"](): unknown {
    // see preamble, FALLBACK toJS
    return `#<procedure ${String(this.name)}>`;
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.__name__ ?? this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext, canBounce = false): CallResult {
    return this.#runner(args, runCtx, canBounce);
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

  constructor(opts: { name: string | symbol; arity: Arity; contract: unknown; impl: CallableImpl; ctx?: RunContext }) {
    // Same reasoning as ALambda's ctor above: a native procedure's IDENTITY is bound
    // once at capability-assembly time (common/capability.ts), never per invocation;
    // `impl(args, runCtx)` carries the live per-call ctx instead.
    super(opts.ctx ?? CONSTANT_CTX);
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.#impl = opts.impl;
  }

  ["arrival/toJS"](): unknown {
    // see preamble, FALLBACK toJS
    return `#<procedure ${String(this.name)}>`;
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.name)}>`;
  }

  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext): CallResult {
    return this.#impl(args, runCtx);
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
    ctx?: RunContext;
  }) {
    // Same reasoning as ALambda/ANativeProcedure's ctors above: bound once at
    // capability-assembly time (scheme-zod.ts's `z.procedure`), never per invocation.
    super(opts.ctx ?? CONSTANT_CTX);
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.strategy = opts.strategy;
    this.#impl = opts.impl;
  }

  ["arrival/toJS"](): unknown {
    // see preamble, FALLBACK toJS
    return `#<procedure ${String(this.name)}>`;
  }
  ["arrival/print"](): string {
    return `#<procedure:${displayName(this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext): CallResult {
    return this.#impl(args, runCtx);
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

  constructor(
    readonly door: DoorSymbolDef,
    ctx?: RunContext,
  ) {
    // Same reasoning as the sibling ctors above: a door is bound once at
    // capability-assembly time; it never mints run-tagged output (its `apply` term
    // unconditionally throws before touching any value).
    super(ctx ?? CONSTANT_CTX);
  }

  ["arrival/toJS"](): unknown {
    return `#<procedure ${this.door.name}>`;
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
 * falls back to a bare host fn with an EXPLICIT, DEFINED `this = makeCallCtx(runCtx)` (flat
 * `CallCtx`) — the fix for the whole `this=undefined` crash class (`APair.map` used to do a
 * bare `fn(x)`, handing `undefined` to an impl that reads `this.runCtx`). `canBounce` stays
 * false: a HOF-applied callback is never in tail position, so a lambda fully runs rather than
 * returning a bounce the HOF can't trampoline. This seam is what makes the
 * native→ANativeProcedure flip (stage 1) non-breaking — both callee shapes are invoked
 * identically here.
 */
// `args` is `readonly unknown[]`, not `SchemeValue[]`: the value algebra surfaces list/vector
// elements as `unknown` (the spine-walk convention — narrowed at consumption, never asserted at
// the slot), so the seam accepts that and casts ONCE here, at the boundary between the
// unknown-typed algebra and the typed callable surface (the elements ARE scheme values).
// `fn` is `unknown` for the same reason: every decoded callback argument funnels here,
// and a non-callable is doored at runtime (the `not applicable` throw), not silently
// tolerated by a type-level cast at each of the ~dozen call sites.
// `runCtx` has no default: a `= CONSTANT_CTX` default would let a caller omit the
// argument silently (loader-capability.ts's `require` resolver dispatch used to do
// exactly that; it now threads `this.runCtx`, one hop away). Every remaining
// CONSTANT_CTX at a call site (op-helpers.ts's `deriveSortCompare`, srfi-1/srfi-13's
// callback seams) is a literal, grep-able confession rather than a silent fallback.
export function applyCallback(fn: unknown, args: readonly unknown[], runCtx: RunContext): CallResult {
  const term = (fn as Partial<ALambda> | null | undefined)?.[tf("apply")];
  if (typeof term === "function") {
    return (term as (args: SchemeValue[], runCtx: RunContext, canBounce?: boolean) => CallResult).call(
      fn,
      args as SchemeValue[],
      runCtx,
      false,
    );
  }
  if (typeof fn === "function") {
    return Reflect.apply(fn, makeCallCtx(runCtx), args as unknown[]) as CallResult;
  }
  throw new TypeError(
    `not applicable: ${fn === null ? "null" : typeof fn === "object" ? "a non-callable value" : typeof fn}`,
  );
}

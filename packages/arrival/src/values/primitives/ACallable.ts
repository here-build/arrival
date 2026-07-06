// Callables as values (stage 0 of the callable-as-value rework;
// see docs/working-proposals/callable-as-value-run-ctx.md).
//
// Every arrival callable becomes an AValue with an EXPLICIT `run(args, runCtx)` surface,
// replacing the `this = { ctx }` smuggling convention that crashed at every non-evaluator
// call site (`APair.map` doing `fn(x)`, the membrane, direct JS). `runCtx` is the ONLY
// threaded context (strict / heapMeter / speculate) — it is run-level and cannot be
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
// STAGE 0 is purely additive: these classes are defined and guarded, but nothing constructs
// or dispatches them yet. The bake machinery (stage 1), evalLambda (stage 2), and the HOFs
// (stage 3) migrate onto them in later cuts; `run`'s validate/decode/encode bodies are stubs
// here (direct impl call) and gain their contract enforcement when bake is adapted.

import { AValue } from "./AValue.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import type { SchemeValue, SchemeBounceMarker } from "../types.js";

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

/** The tagless-final invocation key. Callability IS declaring this term (AValue.ts); the call
 *  is `callable[APPLY](args, runCtx, canBounce?)`, dispatched the same `resolveMethod` way as
 *  `map`/`car`. Spelled once here so the classes and the call sites share one literal. */
export const APPLY = "arrival/tagless-final/apply" as const;

// Shared leaf behavior, as free functions the concrete classes delegate to (no abstract
// parent). A procedure's identity is load-bearing (`(eq? car car)`), so provenance stamping
// is a no-op that preserves reference identity, and equality is reference identity.
const callableEquals = (self: object, other: unknown): boolean => other === self;

/** A scheme lambda: a body + the lexical scope captured at definition. The evaluator injects
 *  the `runner` closure (value→eval cycle avoidance, the same trick `Macro` uses) — this class
 *  names no evaluator symbol. `scope` is the captured Resolver, typed opaque here and tightened
 *  when evalLambda migrates in stage 2. */
export class ALambda extends AValue {
  readonly kind = "lambda" as const;
  readonly name: string | symbol;
  readonly arity: Arity;
  /** The captured lexical scope (a Resolver). Opaque until stage 2. */
  readonly scope: unknown;
  readonly #runner: (args: SchemeValue[], runCtx: RunContext, canBounce: boolean) => CallResult;

  constructor(opts: {
    name: string | symbol;
    arity: Arity;
    scope: unknown;
    runner: (args: SchemeValue[], runCtx: RunContext, canBounce: boolean) => CallResult;
    ctx?: RunContext;
  }) {
    super(opts.ctx ?? CONSTANT_CTX);
    this.name = opts.name;
    this.arity = opts.arity;
    this.scope = opts.scope;
    this.#runner = opts.runner;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext, canBounce = false): CallResult {
    return this.#runner(args, runCtx, canBounce);
  }

  toJs(): unknown {
    return `#<lambda ${String(this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
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
    super(opts.ctx ?? CONSTANT_CTX);
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.#impl = opts.impl;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext): CallResult {
    return this.#impl(args, runCtx);
  }

  toJs(): unknown {
    return `#<procedure ${String(this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
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
    super(opts.ctx ?? CONSTANT_CTX);
    this.name = opts.name;
    this.arity = opts.arity;
    this.contract = opts.contract;
    this.strategy = opts.strategy;
    this.#impl = opts.impl;
  }

  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext): CallResult {
    return this.#impl(args, runCtx);
  }

  toJs(): unknown {
    return `#<procedure ${String(this.name)}>`;
  }
  withProvenance(): SchemeValue {
    return this;
  }
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return callableEquals(this, other);
  }
}

/** The callable union — of concrete classes, not an abstract parent (better narrowing, clean
 *  `kind` discrimination, and it drops cleanly into the SchemeValue union). */
export type ACallable = ALambda | ANativeProcedure | ARosettaProcedure;

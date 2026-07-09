/**
 * Generator-Based Evaluator with Flat Trampoline
 *
 * This evaluator uses a flat trampoline instead of promises or recursive generators.
 * Key benefits:
 *
 * 1. ~100x fewer promise allocations for pure Scheme code
 * 2. TRUE stack-safety via flat trampoline (not yield*)
 * 3. Event loop breathing via periodic yields
 * 4. JS interop preserved - runner awaits yielded promises
 *
 * The pattern:
 * - yield { call: generator } to invoke a sub-generator (flat, no stack growth)
 * - yield promise for JS interop (runner awaits it)
 * - yield TICK for periodic event loop breathing
 *
 * Lineage: trampolined style (Ganz, Friedman & Wand, "Trampolined Style", ICFP
 * 1999); a generator/CPS definitional interpreter (Reynolds, "Definitional
 * Interpreters for Higher-Order Programming Languages", 1972). Proper tail calls
 * per R7RS §3.5 (Clinger, "Proper Tail Recursion and Space Efficiency", PLDI
 * 1998); delay/force promises per R7RS §4.2.5.
 */

import invariant from "tiny-invariant";
import { theVoid } from "../values/primitives/AVoid.js";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";
import { AValue, unionProvenance } from "../values/primitives/AValue.js";
import { Environment, type EnvironmentValue } from "../Environment.js";
import { unboundVariableError } from "../unbound-variable.js";
import { ArrivalError, EvalError, isHostRuntimeBug, type SourceLocation } from "../errors.js";
import { is_callable, is_false, is_function, is_macro, is_promise } from "./guards.js";
import { is_applyable, is_callable_value, is_lambda } from "../values/value-guards.js";
import { applyCallback, ALambda, type CallResult } from "../values/primitives/ACallable.js";
import { makeCallCtx } from "../common/symbols/_bake.js";
import type { InvocationLike } from "../rosetta.js";
import {
  currentDynamicCallSite,
  setDynamicCallSite,
  withDynamicCallSite,
  type Invocation,
} from "./dynamic-call-site.js";
// Q11a (docs/PROVENANCE-PLAN.md) — the retrospective-stream emission hook. Flag-gated
// OFF by default; see provenance-hooks.ts's header for the full port-site rationale.
import { notePotentialRosettaExit } from "./provenance-hooks.js";
// The shared scheme-visible type-namer — the same helper syntax-rules.ts already
// uses for its "expected pair got X" doors (`got ${type(node)}`). Reused here so
// the not-callable doors below name the ACTUAL type (vector/string/number/dict/…)
// instead of a raw `typeof`, which collapses every boxed value to "object".
import { type } from "../utils/typecheck.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { Resolver } from "./Resolver.js";
import { AVector } from "../values/primitives/AVector.js";
import { Macro } from "./Macro.js";
import { Syntax } from "./Syntax.js";
import { APair } from "../values/primitives/APair.js";
import { DATA, LOCATION } from "../well-known-symbols.js";
import { AListAlike, type SchemeBounceMarker, type SchemeValue } from "../values/types.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { Keyword } from "../values/Keyword.js";
import { AString } from "../values/primitives/AString.js";
// AJSObject here is ONLY the genuinely-foreign borrowed-JS wrapper face (notCallableError's
// dict-shaped-borrow check below) — it exited the dict-literal syntax business entirely
// (docs/working-proposals/dict-literal-true-shape.md). The `{…}` dict-literal NODE face —
// its detection (isDictLiteral) and the DictLiteralNode type — is ADict's own algebra now.
import { AJSObject } from "../values/primitives/AJSObject.js";
import { ADict, foldKeyName, isDictShaped, type DictKey } from "../values/primitives/ADict.js";
// The reader's dict grammar — quasiquote re-instantiates READER literals, so the
// evaluator legitimately reaches into the reader layer for the re-mint.
import { makeDictLiteralNode } from "../reader/dict-grammar.js";
import { tf } from "../values/tagless-final.js";

// ============================================================================
// Error Handling with Stack Traces
// ============================================================================

export interface StackFrame {
  code: SchemeValue;
  env_name?: string;
  procedure?: string;
  /** Source location if available from parsed code */
  location?: SourceLocation;
}

// ============================================================================
// Types
// ============================================================================

// `Invocation` — opaque tag for one dynamic evaluation of an AST node (the tap
// implementation defines its shape; the evaluator only threads it through as
// the parent of nested invocations) — is imported above from `./dynamic-call-site.js`
// (type-only) for internal use in this file's own signatures. `index.ts` now
// imports the type straight from that leaf instead of re-exporting through
// here — see the leaf's header for why the ambient holder lives there.

/**
 * Tap callback surface for tracing evaluation. The evaluator fires `enter`
 * before evaluating a parsed Pair (one carrying a __location__ marker), and
 * `exit` when that Pair's evaluation completes — synchronously or after
 * arbitrary async work, with either a value or an error.
 */
export interface EvalTap {
  /**
   * `tailPosition` surfaces the evaluator's ground-truth: this Pair is being
   * evaluated in tail position (R7RS §3.5), so a call here is a tail call. The
   * trace uses it to identify tail-recursive loops precisely — don't infer TCO
   * from the flattened parent structure, read the flag the evaluator already
   * computes for the trampoline. Optional for backward-compat with taps that
   * don't care.
   */
  enter(node: AListAlike, parent: Invocation | null, tailPosition?: boolean): Invocation;
  /**
   * Returning a value-shaped result substitutes the evaluator's outgoing value
   * for the invocation. Used by provenance plumbing: the tap stamps the result
   * with computed provenance and the substitution flows that stamp into the
   * binding the evaluator is about to create.
   *
   * Why this matters: provenance is computed at exit time (it depends on
   * children's provenance + symbolContributions accumulated during the call,
   * neither of which exists at enter time). The tap stamps a NEW AValue
   * carrying that provenance via `withProvenance`. Without substitution the
   * evaluator continues with the original, un-stamped result, and the
   * provenance never reaches the next env binding — so downstream
   * `onSymbolResolved` reads empty provenance and lineage breaks at the
   * (define greeting (car (infer …))) boundary. Tap-as-transformer is what
   * lets a primitive-shaped binding inherit its producer's provenance.
   */
  exit(
    invocation: Invocation,
    result: { value: SchemeValue } | { error: unknown },
  ): { value: SchemeValue } | { error: unknown } | void;
  /**
   * Fired when a SchemeSymbol is resolved during evaluation, attributed to
   * the currently-entered Pair invocation (or null if at top level). Useful
   * for tracers that need symbol values in the lineage — symbol eval is the
   * one path that doesn't fire enter/exit, so without this method the
   * resolved value never reaches the tap.
   */
  onSymbolResolved?(invocation: Invocation | null, symbol: ASymbol, value: SchemeValue): void;
}

/** Evaluation context passed through the evaluator */
export interface EvalContext {
  /**
   * The name-resolution + scope-construction facade — the SINGLE binding/resolution
   * channel: the lexical {@link LexicalScope} chain plus the {@link Capabilities} base
   * it falls through to, with `resolver.env` the underlying lexical frame
   * ({@link Environment} storage). Both exec entries and every frame the evaluator
   * builds set it; the macro seam stages it through {@link MacroInvokeContext}. There
   * is no coexisting `env` field — the frame env is reached ONLY as `resolver.env`.
   * Optional because an external caller could still hand a bare `EvalContext`; the
   * evaluator's own frame sites always set it.
   */
  resolver?: Resolver;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  error?: (e: Error, code?: SchemeValue) => void;
  /** Stack frames for error reporting */
  _stack?: StackFrame[];
  /** Optional tap for tracing evaluation enter/exit per parsed Pair. */
  tap?: EvalTap;
  /**
   * Optional filter — when present, returning false skips tap firing for a node
   * (atoms and macro-expansion-constructed Pairs are always skipped regardless).
   */
  nodeFilter?: (node: AListAlike) => boolean;
  /** Current dynamic-stack invocation; sub-evaluations receive this as parent. */
  currentInvocation?: Invocation;
  /**
   * Optional execution-budget signal. When `signal.aborted` becomes true the
   * trampoline throws `signal.reason ?? DOMException("aborted", "AbortError")`
   * at the next iteration boundary (the existing 1000-iter / 5ms event-loop
   * yield in `run()` — see the war story there). Composes with Web APIs at
   * the rosetta boundary: `fetch(url, { signal: ctx.signal })` becomes
   * natural, so a single AbortController can cancel both Scheme execution
   * and any in-flight host requests it spawned.
   *
   * Without this, `(define (loop) (loop))` runs forever — the 5ms yield
   * gives the event loop room to breathe but does not bound CPU; sandbox
   * code and agent-generated programs need an actual bound.
   */
  signal?: AbortSignal;
  /**
   * Tail-position flag (R7RS §3.5). True when this expression's value is the
   * value of an enclosing lambda/let body — i.e. when a procedure call here
   * is a tail call and should not grow the host stack. Propagation is
   * structural: `begin`'s last expr inherits the parent flag, `if`'s chosen
   * arm inherits, `and`/`or`'s last expr inherits, `cond`/`case`/`when`/
   * `unless` matched-body inherits, `let`/`let*`/`letrec`/`letrec*` bodies
   * inherit (they desugar to `begin`), `do`'s termination-result inherits.
   * Predicate evaluation and earlier `begin`/`and`/`or` expressions do NOT
   * inherit — only the final expression in tail position does.
   *
   * Read at evaluatePair to decide between `{ call }` (push as sub-call) and
   * `{ tailCall }` (replace this slot) when the callable is a Scheme lambda.
   */
  tail?: boolean;
  /**
   * Interpreter-level NIL-TOLERANCE mode (carried from `ExecOptions.strict`).
   * When `true`, projection ops (`car`/`cdr` and friends) applied to `null`/nil
   * THROW instead of resolving tolerantly to `nil`. Absent/`false` ⇒ TOLERANT,
   * today's behavior. Propagated structurally like `tail` (the
   * `{ ...ctx }` spreads carry it into every child context).
   *
   * Carried on `ctx.runCtx.strict`; numeric's loose comparators read it off the
   * flat `this.runCtx` (the retired `_currentStrict` holder's replacement).
   * Optional so the few `EvalContext` literals that omit the run-level options stay
   * valid; the sole origin is `exec()` in generator-exec.ts.
   */
  strict?: boolean;
  /**
   * The per-run context (minted by `exec()`; see `values/primitives/RunContext`).
   * Carries hermetic run-state — strict mode, the heap meter — as DATA
   * threaded through evaluation; this is the sole live channel for that state (the
   * old `_currentStrict` module holder is retired, readers consult
   * `ctx.runCtx` / the operand ctx instead). Propagated structurally like `strict`
   * (the `{ ...ctx }` spreads).
   */
  runCtx?: RunContext;
}

/** Options for the trampoline runner (`run`). */
export interface RunOptions {
  /**
   * Execution-budget signal. See `EvalContext.signal` for the war story.
   * Threaded as a runner option (not via the generator) because the
   * trampoline lives outside any single `EvalContext` — generators created
   * by sub-evaluations carry their own ctx, but the budget is per-run.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock execution budget in milliseconds. When set, the trampoline
   * starts a deadline at `performance.now() + budgetMs` and throws a
   * `ArrivalError(/budget/)` once the deadline passes — checked at the SAME
   * iteration boundary as the abort signal (the 1000-iter / 5ms TICK
   * cadence), so it costs nothing on the hot path and bounds
   * `(let loop () (loop))` to within one cadence unit.
   *
   * This is the "L0" host bound: an `AbortSignal` lets an EXTERNAL controller
   * cancel (UI cancel button, parent `fetch` abort), but sandbox / agent code
   * needs an INTERNAL bound that fires even when nobody is holding a
   * controller. `budgetMs` is that bound — independent of, and composable
   * with, `signal` (whichever fires first wins).
   */
  budgetMs?: number;
}

// Module-level dynamic call site holder — MOVED to `./dynamic-call-site.js`
// (imported above as `currentDynamicCallSite`/`setDynamicCallSite`/
// `isStrictDescendant`/`withDynamicCallSite`); see that leaf's header for why.
// Set by evaluatePair just before invoking a callable, read by evalLambda /
// named-let loopFn when building the body ctx so that a lambda's body runs
// with the DYNAMIC parent invocation (the call site) rather than the LEXICAL
// one captured at lambda-creation.
//
// Why: when a native JS HOF (map/filter/reduce) iterates over a user lambda,
// the lambda's body would otherwise inherit currentInvocation from the lexical
// ctx (e.g., the enclosing define), severing the parent chain at the HOF
// boundary. With this holder, the lambda picks up the calling Pair's
// invocation, so DNF path reconstruction can surface HOF iteration via
// parent-walking.
//
// Single-threaded JS makes a module-level holder safe; we save/restore around
// each apply to handle nesting.

// `_canBounce` module holder is RETIRED (reverse-membrane-for-callables.md §5 item 3,
// step 1): every bare-fn LAMBDA producer is gone (named-let's loopFn is now a real
// ALambda — see evalLet below), so the flag's only in-callee reader was named-let's
// closure reading the module global directly. `canBounce` now travels the same way
// evalLambda's runner always received it: as the third argument on the
// `arrival/tagless-final/apply` term (evaluatePair mints it as a per-call local right
// before the apply — see `canBounce` there — no ambient state, no save/restore).
//
// The protocol itself is unchanged: a Scheme lambda invoked in tail position from
// inside an active trampoline hands back a Bounce token (see `makeBounce`/`is_bounce`)
// instead of spawning a fresh `run(...)` Promise, so the outer trampoline drives the
// body generator without growing the host call stack. HOFs that call back into a
// lambda (map/filter/reduce) pass `canBounce=false` at their own call site
// (`applyCallback`), so they stay oblivious to the protocol exactly as before.

// `_currentStrict` module holder is retired — strict mode is run-CONSTANT
// (RunContext), so readers consult `ctx.runCtx.strict` directly; it was a pure
// RunContext duplicate. `_currentRunEnv` STAYS: it is the
// rosetta MEMBRANE's env back-channel (llm-plane-arrival-env/prompt.ts evaluates an
// `s/…` schema DSL and reaches the infer capability under a ctx-less `apply`; runCtx
// carries no env).

/**
 * Run-scoped CURRENT ENV, set to the resolver's lexical frame (`resolver.env`) at the
 * apply boundary alongside `_dynamicCallSite` (saved + restored in the
 * surrounding finally). Sole purpose: the rosetta MEMBRANE's env back-channel — a
 * rosetta impl running under a ctx-less `apply` (llm-plane-arrival-env/prompt.ts) reads
 * it to evaluate an `s/…` schema DSL and reach the infer capability. `runCtx` cannot
 * supply this — it carries run-CONSTANT data, not an env. The heap-meter that once also
 * rode this holder moved to the operand's ctx (`operand.ctx.heapMeter` — see the three
 * `to_array` copies).
 *
 * Why module-level: readers are variadic / HOF builtins (`filter`/`join`/`reverse`/
 * `apply`, and `to_array` reached through them) whose arity a trailing `ctx` would
 * corrupt. Single-threaded JS makes the holder safe; nesting is handled by the
 * save/restore. The meter is found by walking `__parent__` from this env, so a
 * child-frame env still resolves the run's installed meter.
 */
let _currentRunEnv: Environment | undefined = undefined;

/** The run's current env at apply time. Read by `to_array`'s heap-meter lookup
 *  (env/pack-helpers.ts) in place of the erased env-as-`this`. */
export const currentRunEnv = (): Environment | undefined => _currentRunEnv;

/**
 * Re-install `_dynamicCallSite` on every invocation of a lambda VALUE passed as
 * an arg. Native HOFs like reduce/fold/find recurse via promise chains
 * (`maybeThen(fn(acc, x)).then(recurse)` in env/srfi/srfi-1.ts's HOFs), so iteration
 * N+1 fires from a microtask AFTER the outer evaluatePair's finally has
 * restored the holder. Without per-call re-install, the lambda body for
 * iteration ≥1 would inherit the WRONG dynamic parent.
 *
 * Since reverse-membrane-for-callables.md §3 step 1 (named-let → ALambda), every
 * lambda-shaped argument reaching here is a real `ALambda` value — the legacy
 * bare-fn `wrapLambda` arm (re-wrapping a `[LAMBDA]`-branded plain function) is
 * gone along with its last producer.
 */
function wrapLambdaArgs(args: SchemeValue[], dynSite: Invocation | undefined): SchemeValue[] {
  let out: SchemeValue[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (is_lambda(a)) {
      if (!out) out = [...args];
      out[i] = wrapLambdaValue(a, dynSite);
    }
  }
  return out ?? args;
}

// `isStrictDescendant`/`withDynamicCallSite` now live in `./dynamic-call-site.js`
// (imported above) — used locally by `wrapLambdaValue` below. The
// reverse-membrane crossing (`rosetta.ts`/`scheme-zod.ts`, per
// docs/working-proposals/reverse-membrane-for-callables.md §7b/§9) imports
// `withDynamicCallSite` straight from that leaf too, rather than through this
// module — no re-export needed here.

/** Re-install `_dynamicCallSite` on each invocation of a lambda VALUE passed as a HOF arg.
 *  Delegates to the original's apply term (its runner is private) inside
 *  {@link withDynamicCallSite}; the holder is read in the runner's synchronous prologue, so
 *  the finally-restore never races the bounced body. */
function wrapLambdaValue(lambda: ALambda, dynSite: Invocation | undefined): ALambda {
  const wrapped = new ALambda({
    name: lambda.name,
    arity: lambda.arity,
    scope: lambda.scope,
    ctx: lambda.ctx,
    runner: (values, runCtx, canBounce) =>
      withDynamicCallSite(dynSite, () => lambda[tf("apply")](values, runCtx, canBounce)),
  });
  wrapped.__name__ = lambda.__name__;
  wrapped.__params__ = lambda.__params__;
  return wrapped;
}

/**
 * A bare JS function value that can still legitimately reach the evaluator's
 * define-naming step — NOT a lambda brand anymore (the `[LAMBDA]` producer, named-let's
 * loopFn, was retired by reverse-membrane-for-callables.md §3 step 1; every scheme-authored
 * lambda is a real `ALambda` value now). The residual producer is the legacy
 * `env.defineRosetta` authoring arm (capability.ts), quarantined per the B4 audit — it still
 * binds a bare host function into value space, and `(define name <expr>)` evaluating to one
 * of those still wants its `__name__`/`__params__` stamped for debugging.
 */
interface NameableFunction {
  __name__?: string;
  /**
   * Positional parameter names captured at lambda creation. Empty for
   * variadic-only lambdas. Used by tracers to correlate a symbol use inside
   * the body with the lambda parameter it binds — see arrival-chain
   * lineage's iteration-element classification.
   */
  __params__?: readonly string[];

  (...args: SchemeValue[]): SchemeValue | Bounce | Promise<SchemeValue>;
}

/** Interface for macro expansion result */
interface DataMarked {
  [DATA]?: boolean;
}

/** Type guard for DataMarked objects */
function is_data_marked(o: unknown): o is DataMarked {
  if (o === null || typeof o !== "object") return false;
  // The data mark is the `__data__` SYMBOL (Symbol.for("__data__")), set by
  // quote() and read by legacy evaluate_macro as `value?.[DATA]`. The earlier
  // string-key check ("__data__" in o) never matched the symbol — invisible for
  // any normal (quote x) because that hits evalQuote (a special form) and skips
  // this macro path, but a hygiene-gensym'd `#:quote` resolves to the quote Macro
  // and DOES take this path, so the mismatch made the generator re-evaluate
  // quoted data inside syntax-rules expansions.
  return (o as Record<symbol, unknown>)[DATA] === true;
}

/** A nameable callable — a legacy bare fn (the quarantined `env.defineRosetta` arm) OR an
 *  ALambda value. Both carry a mutable `__name__` the define-naming step stamps. */
function is_lambda_function(o: unknown): o is NameableFunction | ALambda {
  return typeof o === "function" || o instanceof ALambda;
}

/** The evaluator generator type - third param is what yield returns */
export type EvalGenerator = Generator<unknown, SchemeValue, SchemeValue>;

/**
 * `evaluate`'s return widens `EvalGenerator`'s to also admit a `Macro`/`Syntax`:
 * evaluating a bare symbol can resolve a transformer object — the `define-syntax`
 * mechanism expands to `(define name (let ((g <transformer>)) (typecheck …) g))`,
 * so the `let`-body evaluates the gensym `g`, resolves a `Syntax`, and returns it
 * to be bound. Only the terminal return widens; the yield-send type stays
 * `SchemeValue`, so the trampoline `{ call }` consumers (the inner `let`/`define`
 * eval) receive it as `SchemeValue` and the expander never escapes the value
 * union through them. A direct `run(evaluate(...))` sees the wider value and
 * seals it back with `expectValue` (a run/top-level result is never a bare
 * expander — that would be a structural error).
 */
export type EvaluateGenerator = Generator<unknown, SchemeValue | Macro | Syntax, SchemeValue>;

/** Symbol to mark a yield as "need to check time" vs "await this promise" */
const TICK = Symbol("tick");

/** Marker for sub-generator calls (flat trampoline) */
interface Call {
  call: Generator<unknown, unknown, unknown>;
  /** Optional stack frame for error reporting */
  frame?: StackFrame;
  /**
   * Fired by the trampoline when the sub-generator returns normally.
   * Returning a value substitutes the outgoing result (the trampoline uses
   * the returned value as `valueToSend` to the parent generator). Returning
   * `undefined` is the "no substitution" signal — taps cannot substitute
   * with undefined, which is fine since undefined isn't a meaningful Scheme
   * value to thread through a binding. See `EvalTap.exit` for the war
   * story on why tap-as-transformer is load-bearing for provenance.
   */
  onResolve?: (value: unknown) => unknown | undefined;
  /**
   * Fired by the trampoline when the sub-generator (or its descendants)
   * throws. The return type mirrors `onResolve` for shape symmetry, but the
   * rejection path doesn't currently use the substitution; v0 only needs
   * the resolved-value transformer to close the lineage gap.
   */
  onReject?: (error: unknown) => unknown | undefined;
  /**
   * Tail-position marker (R7RS §3.5). True when the YIELDING generator does
   * nothing but return this sub-call's result (a local pass-through —
   * `return yield { call }`, modulo `onResolve`). The trampoline COLLAPSES
   * the chain when a tail call bubbles up: it pops all consecutive
   * `tail: true` slots down to the first slot that does real work after its
   * child returns (an argument collector, a predicate eval, a binding RHS —
   * none of those are marked tail). The popped slots' `onResolve`/`onReject`
   * hooks compose onto the replacement slot so taps stay enter/exit balanced
   * and provenance transforms still fire when the tail chain returns.
   *
   * Required for O(1) space: a lambda body that tail-calls itself sits under
   * a fixed-depth tower of pass-through slots (begin → if → evaluate →
   * evaluatePair). Without collapse, each recursion stacks a fresh tower and
   * `stack[]` grows O(depth) — replacing only the innermost slot per
   * recursion OOMs at shallow depth. Collapsing the whole tower per
   * iteration keeps `stack[]` bounded.
   */
  tail?: boolean;
}

function is_call(o: unknown): o is Call {
  return o !== null && typeof o === "object" && "call" in o;
}

/**
 * Marker for tail calls — yielded by evaluatePair when a Scheme-to-Scheme
 * call lands in tail position (R7RS §3.5). The trampoline REPLACES the
 * current slot with the callee generator instead of stacking it: a tail
 * call returns IN PLACE OF the caller, not through it — this is what keeps
 * the stack budget flat across recursion.
 *
 * Data flow: the popped slot's `onResolve`/`onReject` move to the new slot,
 * so when the tail body eventually returns/throws, the ORIGINAL consumer
 * (the caller's caller) still sees the value/error via the same hook a
 * normal sub-call would have fired. Without this transfer the tap-
 * substitution chain breaks every tail-recursive step and provenance
 * stamping disappears for values flowing through a tight loop.
 *
 * Frame stack: the popped slot's frame goes away (it's done, by definition,
 * once it tail-calls); the new frame represents the calling Pair (e.g.
 * `(loop n)`) so the stack trace still names who initiated the dispatch.
 * `EvalTap.exit` fires on the popped frame BEFORE the new one is pushed —
 * lineage stays intact via the popped slot's invocation stamp.
 */
interface TailCall {
  tailCall: {
    generator: Generator<unknown, unknown, unknown>;
    /** Frame attributed to the call site that initiated the tail dispatch. */
    frame?: StackFrame;
  };
}

function is_tailCall(o: unknown): o is TailCall {
  return o !== null && typeof o === "object" && "tailCall" in o;
}

/**
 * Sentinel returned by a Scheme lambda's runner when the `canBounce` apply-term
 * argument was true at invocation time — i.e. when the calling evaluatePair speaks
 * the bounce protocol and is willing to route the body generator back into
 * the active trampoline. Bypasses the `run(evalBegin(body, ctx))` path that
 * would otherwise mint a fresh Promise and grow the host stack one await
 * per recursive call. HOF callbacks invoke through `applyCallback`, which always
 * passes `canBounce=false`, so they never see this token.
 */
interface Bounce extends SchemeBounceMarker {
  generator: Generator<unknown, unknown, unknown>;
}

function is_bounce(o: unknown): o is Bounce {
  return o !== null && typeof o === "object" && (o as { __bounce?: unknown }).__bounce === true;
}

/**
 * Brand-only bounce check, narrowing to `SchemeBounceMarker` (no `generator`).
 * Used where a value-typed callable's return surfaces the union's bounce arm
 * (`SchemeBounceMarker`) rather than the local `Bounce`: negating `is_bounce`
 * (a `Bounce` guard) can't remove the structurally-wider marker, so a value
 * boundary that must rule the bounce out narrows on the brand instead.
 */
function is_bounce_marker(o: unknown): o is SchemeBounceMarker {
  return o !== null && typeof o === "object" && (o as { __bounce?: unknown }).__bounce === true;
}

/**
 * Wrap a lambda body generator as a Bounce token. Used by evalLambda's and
 * named-let's ALambda runners when the `canBounce` apply-term argument is
 * true — see Bounce's doc comment for the invariants this preserves.
 */
function makeBounce(generator: Generator<unknown, unknown, unknown>): Bounce {
  return { __bounce: true, generator };
}

/**
 * Narrow a resolved environment binding to what the evaluator can carry: a value,
 * or a `Macro`/`Syntax` expander.
 *
 * `Resolver.resolve`/`lookup` return an `EnvironmentValue | undefined`. Three of
 * those members can never be carried by the evaluator and are thrown with a clear
 * message: an unbound name (`undefined`), an `Environment` (a scope is neither a
 * value nor an operator), and a `RegExp` (internal-only — number-parsing and
 * syntax-rules patterns — never resolved as a binding). What remains is a value
 * (`SchemeValue`, which includes a `AProcedure` procedure) OR a `Macro`/`Syntax`.
 *
 * A `Macro`/`Syntax` is admitted on BOTH the operator and the value path: at a
 * call head it is the operator (`(my-macro …)`, split downstream by `is_macro`);
 * in value position it is the expander object itself — `define-syntax` expands to
 * `(define name (let ((g <transformer>)) (typecheck …) g))`, so evaluating the
 * gensym `g` resolves a `Syntax` and returns it to be bound. So this is not the
 * decision's "macro referenced as a value is an error" case — it is the mechanism
 * by which a macro binding is installed. Callers split value vs expander with
 * `is_macro` where they care (the value-channel tap skips an expander).
 */
function resolvedBindingOrThrow(binding: EnvironmentValue | undefined, sym: ASymbol): SchemeValue | Macro | Syntax {
  if (binding === undefined) {
    // Structurally unreachable via the ordinary `Resolver.resolve` call path (it
    // throws `unboundVariableError` itself before ever returning `undefined` —
    // see `eval/Resolver.ts#resolveSynth`), but kept as a defensive throw for any
    // other caller of this narrowing fn. No vocabulary passed — this branch has no
    // resolver in reach, so it stays the plain wall (suggestions live at the real
    // throw sites, which enumerate the chain they actually missed against).
    throw unboundVariableError(symbol_name(sym));
  }
  if (binding instanceof Environment) {
    throw new TypeError(`\`${symbol_name(sym)}' is an environment — neither a value nor applicable`);
  }
  if (binding instanceof RegExp) {
    throw new TypeError(`\`${symbol_name(sym)}' resolved to a regular expression — neither a value nor applicable`);
  }
  return binding;
}

/**
 * Seal an `evaluate` result back to a `SchemeValue` at a boundary where a
 * `Macro`/`Syntax` cannot legitimately appear. `evaluate`'s return admits a bare
 * expander only as the internal `define-syntax` mechanism (its `let`-body returns
 * a resolved transformer); that flow is always consumed through the trampoline
 * yield channel and immediately bound. A top-level / `run(evaluate(...))` result
 * is never a bare expander, so an expander here is a structural error — throw
 * rather than leak a non-value into the value surface.
 */
export function expectValue(result: SchemeValue | Macro | Syntax): SchemeValue {
  if (is_macro(result)) {
    throw new Error("evaluate produced a macro/syntax where a value was required");
  }
  return result;
}

/**
 * Scheme promise (delay/force) - NOT a JS Promise!
 * This represents a lazily evaluated expression.
 */
export class SchemePromise {
  // Unforced placeholder. `_value` is only read after `_forced` flips true (force()
  // sets both together), so theVoid here is a pure pre-force sentinel — never the
  // observable result of a forced promise. `undefined` is not a SchemeValue.
  private _value: SchemeValue = theVoid;
  private readonly _thunk: () => SchemeValue;

  constructor(thunk: () => SchemeValue) {
    this._thunk = thunk;
  }

  private _forced = false;

  get forced(): boolean {
    return this._forced;
  }

  force(): SchemeValue {
    if (!this._forced) {
      this._value = this._thunk();
      this._forced = true;
    }
    return this._value;
  }
}

export function is_scheme_promise(o: unknown): o is SchemePromise {
  return o instanceof SchemePromise;
}

// ============================================================================
// Symbol name extraction
// ============================================================================

function symbol_name(sym: ASymbol): string {
  const name = sym.__name__;
  return typeof name === "symbol" ? name.description || "" : name;
}

// ============================================================================
// Environment lookup without lips runtime dependency
// ============================================================================
//
// Name-resolution is the Resolver's job (eval/Resolver.ts owns the throwing,
// synth-aware `env_get` lookup + its `c[ad]+r` unfold). Every evaluator lookup
// goes through `ctxResolver(ctx).resolve`/`.lookup`, which bottoms out in
// `env_get` over the wrapped, base-linked env.

/**
 * The ctx's resolver — the evaluator's sole name-resolution + frame-construction
 * channel (there is no coexisting `EvalContext.env`; the resolver IS the env,
 * reached as `resolver.env`). Both exec entries and every frame the evaluator
 * builds set it, so it is present at every evaluation boundary; the invariant
 * catches a malformed bare `EvalContext` from an external caller LOUD rather
 * than NPEing on a later `.scope`/`.env` read.
 */
function ctxResolver(ctx: EvalContext): Resolver {
  invariant(ctx.resolver, "EvalContext.resolver is required (set by exec / every frame site)");
  return ctx.resolver;
}

/**
 * Race a host promise (a JS-interop / rosetta tool-call return the trampoline
 * awaits at its `is_promise(value)` branch) against an AbortSignal, so a PARKED
 * await becomes abort-aware.
 *
 * WHY this is needed on top of the TICK-boundary abort check (run's TICK branch,
 * below): that check only fires while the trampoline is actively STEPPING. While
 * parked on a raw `await value` — a rosetta tool call to a stuck upstream that
 * never resolves — nothing ticks, so `signal.aborted` is never read and the run
 * hangs until the host promise settles on its own. The outer wall-clock race a
 * caller may layer on top (arrival-manifold's manifold-tool.ts) can `abort()`
 * the signal on time, but that only unsticks THIS await if the await itself
 * observes the signal. This makes it observe it, at the ONE choke point every
 * host promise funnels through, regardless of whether the specific host
 * operation honors the signal.
 *
 * This does NOT cancel the underlying host operation by itself — it only returns control
 * to the trampoline, which then throws the abort reason and unwinds the run. Cancelling the
 * upstream connection/request must be wired at the operation itself (e.g. `fetch(url, {
 * signal })`, or the MCP SDK's `client.callTool(params, schema, { signal })`) — arrival-
 * manifold's server boundary forwards this exact signal there (bind.ts's `rosettaDef` reads
 * it off the per-call invocation-`this` and hands it to `RemoteTool.invoke`; server.ts's
 * `toBoundServer` threads it into `client.callTool`), so an aborted eval actually tells a
 * real upstream MCP server to stop, not merely abandons the local await. A host operation
 * that does NOT accept a signal (or a direct-JS caller with no ctx at all) still only gets
 * abandoned — this mechanism can't force an uncooperative operation to stop. The abandoned
 * promise's eventual settlement is SWALLOWED so it never surfaces as an unhandled rejection —
 * the `.then(resolve, reject)` below keeps a rejection handler attached to it for exactly
 * that reason (mirroring manifold-tool.ts's own `running.catch(() => {})` on its parked path).
 */
export function raceAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  // Already aborted: an `addEventListener("abort", …)` would never fire (the event
  // already dispatched), so reject now — and still attach a swallow handler so the
  // abandoned host promise's later settlement is never an unhandled rejection.
  if (signal.aborted) {
    void Promise.resolve(value).catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    // The two-handler `.then` both settles the race on the happy path AND keeps a
    // rejection handler attached to `value` for the abort-loser path, so an
    // abandoned host promise that later rejects is swallowed here (never
    // unhandled). removeEventListener is idempotent — `once: true` already removed
    // the listener if abort won; it actively removes it if `value` won.
    Promise.resolve(value).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// A non-Error scheme value thrown (raw `raise`/`%raise`, R7RS §6.11 — ANY object is a
// valid raised value) gets stringified into an `ArrivalError` by `failAndWrap` below
// (`ArrivalError.cause` is typed `Error` — errors.ts — so a SchemeValue can't ride there).
// This module-level side channel preserves the ORIGINAL raised value, keyed by the wrapper
// instance, so `evalTry`'s catch/guard binding can recover the real object instead of a
// printed re-presentation of it. Module-level (not per-`run()`-call) because `evalTry` reads
// it from a DIFFERENT function than the one that populates it; a WeakMap so a never-caught
// wrapper's raised value doesn't outlive it.
const rawRaisedValues = new WeakMap<ArrivalError, SchemeValue>();

// ============================================================================
// Flat Trampoline Runner
// ============================================================================

/**
 * Run a generator-based evaluator to completion using a FLAT trampoline.
 *
 * This is the core trampoline that:
 * 1. Maintains a stack of generators (no call stack growth!)
 * 2. Handles { call: generator } yields by pushing to stack
 * 3. Awaits any yielded promises (from JS interop)
 * 4. Periodically yields to the event loop (every ~5ms)
 * 5. Tracks stack frames for error reporting
 * 6. Honors an optional AbortSignal at iteration boundaries
 */
async function run<T>(generator: Generator<unknown, T, unknown>, options: RunOptions = {}): Promise<T> {
  const { signal, budgetMs } = options;

  // Fast-fail: if the caller passed an already-aborted signal, refuse
  // before allocating the trampoline state. Mirrors fetch() semantics.
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }

  // Wall-clock deadline. `undefined` when no budget was requested, so the
  // per-TICK comparison short-circuits to a single `!== undefined` check.
  // A non-positive budget means "already expired" — refuse on entry, the
  // budget analogue of the pre-aborted-signal fast path above.
  const deadline = budgetMs === undefined ? undefined : performance.now() + budgetMs;
  if (deadline !== undefined && budgetMs! <= 0) {
    throw new ArrivalError(`execution budget exceeded (${budgetMs}ms)`, []);
  }

  // Stack of generators - this is the key to flat trampolining
  const stack: Generator<unknown, unknown, unknown>[] = [generator];
  // Stack frames for error reporting (parallel to generator stack)
  const frameStack: (StackFrame | undefined)[] = [undefined];
  // Calls that pushed each generator (root has none). Carries onResolve/onReject hooks.
  const callStack: (Call | undefined)[] = [undefined];
  let lastYield = performance.now();
  let iterations = 0;
  let valueToSend: unknown = undefined;

  // Fire onReject up the call stack so any tap subscribers see the error,
  // then build the wrapped ArrivalError to throw out of run().
  const failAndWrap = (error: unknown): never => {
    // Snapshot stack frames BEFORE popping so ArrivalError carries the trace.
    const frames = frameStack.filter((f): f is StackFrame => f !== undefined);
    while (callStack.length > 0) {
      const c = callStack.pop();
      stack.pop();
      frameStack.pop();
      try {
        c?.onReject?.(error);
      } catch {
        // Swallow tap exceptions — they must not mask the real error.
      }
    }
    if (error instanceof ArrivalError) throw error;
    if (!(error instanceof Error)) {
      // R7RS `raise` accepts ANY scheme object (§6.11) — a native throw of a raw, non-Error
      // value (e.g. `%raise` throwing a boxed APair) arrives here. `ArrivalError.cause` is
      // typed `Error` (errors.ts), so the original SchemeValue can't ride there directly —
      // stash it in the side channel below, keyed by the wrapper instance, so a `guard`/
      // `catch` upstream (evalTry) can recover the ORIGINAL raised value instead of this
      // stringified re-presentation (see rawRaisedValues' own doc comment).
      const wrapped = new ArrivalError(String(error), frames, undefined);
      rawRaisedValues.set(wrapped, error as SchemeValue);
      throw wrapped;
    }
    // A raw host-runtime throw is an INTERNAL defect (a native impl that skipped its
    // contract), not a user error. Name the innermost scheme frame's procedure and flag it
    // internal so it reads as an arrival bug to fix — never as a user mistake to explain. The
    // full frame chain still rides as `schemeStack`. Authored errors pass through verbatim.
    const message = isHostRuntimeBug(error)
      ? `internal error in \`${frames.at(-1)?.procedure ?? "?"}\`: ${error.message}`
      : error.message;
    throw new ArrivalError(message, frames, error);
  };

  try {
    while (stack.length > 0) {
      const current = stack.at(-1)!;
      let result: IteratorResult<unknown, unknown>;

      try {
        result = current.next(valueToSend);
      } catch (error) {
        failAndWrap(error);
        return undefined as never; // unreachable
      }

      valueToSend = undefined; // Reset after use

      if (result.done) {
        // Generator finished - fire onResolve, pop, pass result to parent.
        // If onResolve returns a value, substitute it: the tap may have
        // stamped a freshly-cloned AValue with provenance computed only at
        // exit time, and that stamp has to ride into the parent's binding
        // (otherwise the original un-stamped result wins). `undefined`
        // means "no substitution" — see Call.onResolve docstring.
        const finishedCall = callStack.at(-1);
        let finalValue = result.value;
        if (finishedCall?.onResolve) {
          try {
            const subst = finishedCall.onResolve(result.value);
            if (subst !== undefined) finalValue = subst;
          } catch {
            // Tap exceptions must not break evaluation.
          }
        }
        stack.pop();
        frameStack.pop();
        callStack.pop();
        valueToSend = finalValue;
        continue;
      }

      const value = result.value;

      // Check for sub-generator call (flat trampoline)
      if (is_call(value)) {
        stack.push(value.call);
        frameStack.push(value.frame);
        callStack.push(value);
        continue;
      }

      // Tail-call dispatch (R7RS §3.5). A Scheme lambda was invoked in tail
      // position; the callee's eventual return value IS the result of the
      // whole tail-position chain, so rather than stack the callee and return
      // through every intermediate frame, we COLLAPSE the chain.
      //
      // Must unwind the ENTIRE tail tower, not just the yielding slot: every
      // pass-through `{ call }` is tagged `tail: true` (the yielding code does
      // nothing but `return yield { call }`, e.g. begin/if/evaluate wrappers
      // around a recursive call). Replacing only the innermost slot leaves the
      // tower standing and `stack[]` grows O(depth) per recursion. So we pop
      // the current slot plus all consecutive `tail: true` slots beneath it,
      // stopping at the first NON-tail slot (argument collector, predicate
      // eval, binding RHS, or the root) that genuinely consumes the value —
      // the callee is pushed ON TOP of that consumer.
      //
      // Hooks: each popped slot may carry an `onResolve` (tap.exit /
      // provenance stamp) and `onReject`. We COMPOSE them (innermost first)
      // onto the replacement slot so they fire when the tail chain finally
      // returns — keeping tap enter/exit balanced and provenance transforms
      // intact. In the common no-tap case every popped slot's hooks are
      // undefined, so composition is empty and this stays O(1) per iteration
      // (no per-level closure retention).
      if (is_tailCall(value)) {
        // Collect pass-through hooks while unwinding the tail tower.
        const resolvers: Array<(value: unknown) => unknown | undefined> = [];
        const rejecters: Array<(error: unknown) => unknown | undefined> = [];
        // Pop the slot that yielded the tailCall first (it is pass-through by
        // construction — evaluatePair does `return yield { tailCall }`).
        {
          const c = callStack.pop();
          stack.pop();
          frameStack.pop();
          if (c?.onResolve) resolvers.push(c.onResolve);
          if (c?.onReject) rejecters.push(c.onReject);
        }
        // Then pop consecutive pass-through (tail) slots until the first
        // slot that consumes the value (non-tail) or the root.
        while (callStack.length > 0 && callStack.at(-1)?.tail === true) {
          const c = callStack.pop();
          stack.pop();
          frameStack.pop();
          if (c?.onResolve) resolvers.push(c.onResolve);
          if (c?.onReject) rejecters.push(c.onReject);
        }
        // Compose hooks (innermost first → outermost last) so the value
        // threads through them in the same order it would have on a normal
        // return walk back up the popped tower.
        const composedResolve =
          resolvers.length === 0
            ? undefined
            : (v: unknown): unknown | undefined => {
                let acc = v;
                for (const r of resolvers) {
                  const subst = r(acc);
                  if (subst !== undefined) acc = subst;
                }
                return acc === v ? undefined : acc;
              };
        const composedReject =
          rejecters.length === 0
            ? undefined
            : (e: unknown): unknown | undefined => {
                for (const r of rejecters) r(e);
                return undefined;
              };
        const replacement: Call = {
          call: value.tailCall.generator,
          frame: value.tailCall.frame,
          onResolve: composedResolve,
          onReject: composedReject,
          // The replacement is itself pass-through w.r.t. whatever consumer
          // now sits beneath it — so a tail call from INSIDE the new body
          // continues to collapse correctly.
          tail: true,
        };
        stack.push(replacement.call);
        frameStack.push(replacement.frame);
        callStack.push(replacement);
        continue;
      }

      // If yielded value is a promise (from JS interop), await it. When a signal
      // is present, race the await against it (raceAbort): a host promise parked
      // HERE — a rosetta tool call to a stuck upstream — cannot reach the TICK
      // abort check below, because nothing ticks while parked. Without the race an
      // abort would not unstick the run until the host promise settled on its own,
      // however long that took. With no signal the await is byte-identical to
      // before (no wrapper promise, no listener). A raced abort rejects with the
      // abort reason and flows through the SAME failAndWrap path as a host-promise
      // rejection, so the run unwinds identically to the TICK-boundary abort.
      if (is_promise(value)) {
        try {
          valueToSend = signal === undefined ? await value : await raceAbort(value, signal);
        } catch (error) {
          failAndWrap(error);
          return undefined as never; // unreachable
        }
        lastYield = performance.now(); // Reset timer after async
        iterations = 0;
        continue;
      }

      if (value === TICK) {
        iterations++;
        // Yield every 1000 iterations or 5ms, whichever comes first. Check the
        // abort/budget signals at THIS cadence (not per-step): TICK fires at every
        // loop-step / tail-call boundary, exactly the granularity an infinite-loop
        // body hits, so checking per-`current.next()` call would burn ~1-2% CPU on
        // reads that are false 99.999% of the time — at TICK boundaries it costs
        // nothing and still bounds `(let loop () (loop))` within one budget unit.
        if (iterations > 1000 || performance.now() - lastYield > 5) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException("aborted", "AbortError");
          }
          // ArrivalError (not DOMException): a budget overrun is OUR policy, not a
          // Web-standard cancellation; its `/budget/` message is what
          // `exec(code, { budgetMs })` callers (and the sandbox-escape suite) match on.
          const now = performance.now();
          if (deadline !== undefined && now > deadline) {
            throw new ArrivalError(
              `execution budget exceeded (${budgetMs}ms)`,
              frameStack.filter((f): f is StackFrame => f !== undefined),
            );
          }
          // we need specifically macrotask here to let the interceptors
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          lastYield = now;
          iterations = 0;
        }
        continue;
      }

      valueToSend = value;
    }

    return valueToSend as T;
  } catch (error) {
    if (error instanceof ArrivalError) {
      throw error;
    }
    const frames = frameStack.filter((f): f is StackFrame => f !== undefined);
    throw error instanceof Error
      ? new ArrivalError(error.message, frames, error)
      : new ArrivalError(String(error), frames, undefined);
  }
}

export default run;

// Why no sync runner: the env carries promise-returning callables (rosettas,
// `infer`, host fetch). A sync trampoline can only honor pure scheme — the
// first yielded promise must throw "Unexpected promise," which makes sync mode
// a foot-gun that silently works for trivial expressions and fails on anything
// real. The AbortSignal budget reinforces the asymmetry: it relies on the
// event-loop yield cadence inside `run()`, so a sync path can't be cancelled
// at the same granularity. We keep one path — async — and pay the microtask
// cost everywhere rather than maintain a half-working escape hatch that drifts
// out of sync with the async semantics it pretends to mirror.

// ============================================================================
// Special Form Handlers
// ============================================================================

/**
 * Stamp the chosen arm's AValue result with `union(predicate, armResult)`.
 *
 * Per spec §5.3 (control-flow restriction): branching forms must not pollute
 * the result's lineage with provenance from arms that never ran. Without this,
 * binding `(if (= count 3) low high)` to a name would pin BOTH `low` and
 * `high` as ancestors of the bound value — including the path the predicate
 * proved unreachable. The Heisenberg-style "every possible past contributed"
 * reading breaks variant-lineage debugging downstream (arrival-chain DNF path
 * reconstruction would surface phantom contributors).
 *
 * The tap-level provenance computation already gets this right "for free":
 * only entered children fire enter/exit, so `computeProvenance` reading from
 * `inv.children` naturally excludes unchosen arms. THIS function exists for
 * the SECOND channel — the value flowing back into env bindings. When the
 * result binds to a symbol via `define`/`let`, `onSymbolResolved` reads
 * `value.provenance` directly (not the if-invocation's provenance), so the
 * value itself must carry the union(pred, arm) stamp before the binding fires.
 *
 * The two channels are complementary: tap for invocation provenance, value
 * stamping for symbol-binding provenance. Both must restrict to (pred, arm).
 */
function restrictControlFlowProvenance(predicate: SchemeValue, armResult: SchemeValue): SchemeValue {
  if (!(armResult instanceof AValue)) return armResult;
  if (!(predicate instanceof AValue) || predicate.provenance.size === 0) return armResult;
  const prov = unionProvenance([predicate, armResult]);
  // unionProvenance returns the same reference when only one distinct set
  // contributed — no allocation needed unless the predicate genuinely adds
  // new origin ids the arm didn't already carry.
  return prov === armResult.provenance ? armResult : armResult.withProvenance(prov);
}

/**
 * Build the `onResolve` hook that applies control-flow provenance restriction
 * to a branch arm result — but ONLY when the predicate actually carries
 * provenance. When it doesn't (the overwhelmingly common no-tap / plain-value
 * case), return `undefined` so the branch's tail `{ call }` carries no hook.
 *
 * Why this matters for TCO: branch arms run in tail position, so the arm's
 * `{ call }` is marked `tail: true` and may collapse when the arm tail-calls
 * a lambda. Collapsed slots' `onResolve` hooks are RETAINED as composed
 * closures on the replacement slot (so the transform still fires when the
 * tail chain returns). If we attached a hook unconditionally, a deep tail
 * loop threaded through `if`/`cond`/`when` would accumulate one closure per
 * iteration — O(n) memory, defeating the constant-space guarantee. Returning
 * `undefined` for the no-provenance case keeps the steady-state loop O(1);
 * provenance-bearing predicates (rare in a tight loop) pay the O(n) cost,
 * which the spec accepts as reduced tail-loop fidelity.
 *
 * The post-yield call site that previously wrote
 * `return restrictControlFlowProvenance(testResult, armResult)` now just
 * returns `armResult` — the trampoline applies this hook before sending the
 * value back, so the transform already happened for the non-collapsed path.
 */
function controlFlowResolve(predicate: SchemeValue): ((value: unknown) => unknown | undefined) | undefined {
  if (!(predicate instanceof AValue) || predicate.provenance.size === 0) return undefined;
  return (value: unknown): unknown | undefined => {
    const stamped = restrictControlFlowProvenance(predicate, value as SchemeValue);
    return stamped === value ? undefined : stamped;
  };
}

/**
 * Handle 'if' special form: (if test then else?)
 *
 * R7RS §3.5 tail-position propagation: the chosen arm inherits the parent's
 * tail flag — `(if p tail-call other)` in tail position means `tail-call`
 * (when p is truthy) is still in tail position. The predicate is NOT in
 * tail position; its value is consumed by the if itself, so we strip tail.
 */
function* evalIf(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "if: missing test expression");

  const testExpr = rest.car;
  const restAfterTest = rest.cdr;

  invariant(restAfterTest instanceof APair, "if: missing then expression");

  const thenExpr = restAfterTest.car;
  const elseRest = restAfterTest.cdr;
  const elseExpr = elseRest instanceof APair ? elseRest.car : undefined;

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Evaluate test (non-tail — its value is consumed by the if dispatch).
  let testResult = yield { call: evaluate(testExpr, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  // Evaluate appropriate branch — inherits the if's own tail flag. The arm's
  // call is pass-through (tail-collapsible); the provenance restriction rides
  // as `onResolve` so it fires whether the arm tail-calls (collapsed) or
  // returns a plain value (resumed). See controlFlowResolve for the war story.
  const onResolve = controlFlowResolve(testResult);
  const inTail = ctx.tail === true;
  if (is_false(testResult)) {
    if (elseExpr !== undefined) {
      return yield { call: evaluate(elseExpr, ctx), tail: inTail, onResolve };
    }
    return theVoid; // No else branch, return undefined
  } else {
    return yield { call: evaluate(thenExpr, ctx), tail: inTail, onResolve };
  }
}

/**
 * Handle 'begin' special form: (begin expr*)
 *
 * R7RS §3.5 tail-position propagation: the LAST expression in the body
 * inherits the parent's tail flag; earlier expressions are non-tail (their
 * values are discarded). This is the load-bearing primitive — a lambda
 * body is wrapped in begin via evalLambda, so this routing is what makes
 * `(define (loop n) (loop (- n 1)))` tail-recursive.
 */
function* evalBegin(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let result: SchemeValue = theVoid;
  let node = rest;

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (node instanceof APair) {
    // Last expression keeps the begin's tail flag; earlier ones are
    // non-tail (their values are dropped, so tail dispatch wouldn't matter
    // anyway — but threading `tail:true` through would have a Scheme lambda
    // tail-replace this slot mid-body, breaking sequential semantics).
    const isLast = node.cdr instanceof ANil || !(node.cdr instanceof APair);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
    // Mark the LAST expr's call pass-through so a tail call emerging from it
    // collapses this begin frame (the begin frame returns `result` unchanged
    // once the loop sees node.cdr is nil — pure pass-through).
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }
    node = node.cdr;
  }

  return result;
}

/** `(quote datum)` — return the datum unevaluated. */
function* evalQuote(rest: SchemeValue, _ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "quote: missing argument");
  return rest.car;
}

/**
 * Handle 'quasiquote' special form: (quasiquote datum)
 * Supports unquote and unquote-splicing
 */
function* evalQuasiquote(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "quasiquote: missing argument");
  // Unquoted sub-expressions are operands to implicit list construction —
  // not tail positions. Strip tail so a `(unquote (some-lambda))` inside
  // doesn't tail-replace this slot before the surrounding structure builds.
  return yield { call: processQuasiquote(rest.car, ctx.tail ? { ...ctx, tail: false } : ctx, 1) };
}

/**
 * `level` tracks quasiquote nesting (R7RS §4.2.8): unquote fires only at level 1,
 * nested `` ` ``/`,` raise/lower it so inner unquotes stay quoted until their depth.
 */
function* processQuasiquote(expr: SchemeValue, ctx: EvalContext, level: number): EvalGenerator {
  // Vectors are processed element-wise: `#(1 ,x ,@xs) builds a fresh vector with
  // unquote evaluated and unquote-splicing flattened (R7RS §4.2.8). A vector
  // can't be improper or carry a dotted-unquote tail, so this mirrors the
  // list-element loop below without the tail-threading.
  // `{…}` dict-literal template (reader-minted node): process the key/value forms
  // element-wise, exactly like the vector template below — unquote fires at level 1
  // (this is what makes `` `{:a ,x} `` work; the reader's position-scoped comma rule
  // deliberately leaves odd-boundary commas as unquote). At level 1 the processed
  // template is FINAL data — fold it to a plain dict (post-substitution key
  // validation + Clojure-faithful loud duplicates); deeper levels rebuild a literal
  // node carrying the processed forms so nested quasiquotes keep their shape.
  if (ADict.isDictLiteral(expr)) {
    const processed: SchemeValue[] = [];
    for (const form of expr.literalForms) {
      let p = yield { call: processQuasiquote(form, ctx, level) };
      if (is_promise(p)) {
        p = yield p;
      }
      processed.push(p);
    }
    if (level > 1) {
      return makeDictLiteralNode(processed);
    }
    const seen = new Set<string>();
    const pairs: [DictKey, SchemeValue][] = [];
    for (let i = 0; i + 1 < processed.length; i += 2) {
      const keyForm = processed[i];
      const name = foldSubstitutedDictKey(keyForm);
      if (seen.has(name)) {
        throw Object.assign(
          new Error(`duplicate dict literal key :${name} after quasiquote substitution — each key may appear once`),
          { code: "E-DICT-DUP-KEY" },
        );
      }
      seen.add(name);
      // foldSubstitutedDictKey only accepts AString/ASymbol/plain-string (else throws
      // E-DICT-BAD-KEY above) — a bare string form is wrapped so the stored key is
      // always a real DictKey object, keeping whatever provenance it already has.
      const key: DictKey =
        keyForm instanceof ASymbol || keyForm instanceof AString ? keyForm : new AString(CONSTANT_CTX, name);
      pairs.push([key, processed[i + 1]]);
    }
    return new ADict(CONSTANT_CTX, pairs);
  }

  // Vector template: a boxed SchemeVector (a `#(...) literal) or, defensively, a
  // raw array. Build a fresh boxed vector so the result is a proper vector value.
  if (expr instanceof AVector || Array.isArray(expr)) {
    const items = expr instanceof AVector ? expr.__vector__ : expr;
    const out: SchemeValue[] = [];
    for (const item of items) {
      if (
        level === 1 &&
        item instanceof APair &&
        item.car instanceof ASymbol &&
        symbol_name(item.car) === "unquote-splicing"
      ) {
        invariant(item.cdr instanceof APair, "unquote-splicing: missing argument");
        let spliced = yield { call: evaluate(item.cdr.car, ctx) };
        if (is_promise(spliced)) {
          spliced = yield spliced;
        }
        if (spliced instanceof APair) {
          let n: SchemeValue = spliced;
          while (n instanceof APair) {
            out.push(n.car);
            n = n.cdr;
          }
        } else {
          invariant(spliced instanceof ANil, "unquote-splicing: expected list");
        }
        continue;
      }
      out.push(yield { call: processQuasiquote(item, ctx, level) });
    }
    return new AVector(CONSTANT_CTX, out);
  }

  if (!(expr instanceof APair)) {
    return expr;
  }

  const first = expr.car;

  if (first instanceof ASymbol && symbol_name(first) === "unquote") {
    if (level === 1) {
      invariant(expr.cdr instanceof APair, "unquote: missing argument");
      return yield { call: evaluate(expr.cdr.car, ctx) };
    } else {
      // Nested quasiquote: decrease level and keep the unquote wrapper (stays
      // quoted data until its own depth is reached).
      invariant(expr.cdr instanceof APair, "unquote: missing argument");
      const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
      return new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, "unquote"), new APair(CONSTANT_CTX, processed, nil));
    }
  }

  if (first instanceof ASymbol && symbol_name(first) === "unquote-splicing") {
    // Splicing needs list context — a bare top-level `,@x` (level 1) is invalid.
    invariant(level > 1, "unquote-splicing: invalid context");
    invariant(expr.cdr instanceof APair, "unquote-splicing: missing argument");
    const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
    return new APair(
      CONSTANT_CTX,
      new ASymbol(CONSTANT_CTX, "unquote-splicing"),
      new APair(CONSTANT_CTX, processed, nil),
    );
  }

  if (first instanceof ASymbol && symbol_name(first) === "quasiquote") {
    invariant(expr.cdr instanceof APair, "quasiquote: missing argument");
    const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level + 1) };
    return new APair(CONSTANT_CTX, new ASymbol(CONSTANT_CTX, "quasiquote"), new APair(CONSTANT_CTX, processed, nil));
  }

  const results: SchemeValue[] = [];
  let node: SchemeValue = expr;
  // Improper-tail unquote: the reader represents `(a . ,x)` as the proper list
  // `(a . (unquote x))`. R7RS quasiquote treats that trailing `(unquote x)` as
  // the dotted tail — `(cons a x-value)` — NOT as two more list elements
  // `unquote` and `x`. Capture it here so the fold below threads it as `tail`.
  let tail: SchemeValue = nil;

  while (node instanceof APair) {
    const item = node.car;

    // Detect the trailing dotted-unquote `(unquote <expr>)` at level 1 (only
    // when it is the WHOLE remaining node — i.e. `,x` sat in the cdr position).
    // `quasiquote`/`unquote` at the same level outside the tail keep recursing
    // as normal elements via the regular-element branch below.
    if (
      level === 1 &&
      node.car instanceof ASymbol &&
      symbol_name(node.car) === "unquote" &&
      node.cdr instanceof APair &&
      node.cdr.cdr instanceof ANil
    ) {
      tail = yield { call: evaluate(node.cdr.car, ctx) };
      if (is_promise(tail)) {
        tail = yield tail;
      }
      node = nil;
      break;
    }

    if (
      item instanceof APair &&
      item.car instanceof ASymbol &&
      symbol_name(item.car) === "unquote-splicing" &&
      level === 1
    ) {
      invariant(item.cdr instanceof APair, "unquote-splicing: missing argument");
      let spliced = yield { call: evaluate(item.cdr.car, ctx) };
      if (is_promise(spliced)) {
        spliced = yield spliced;
      }
      if (spliced instanceof APair) {
        let splicedNode: SchemeValue = spliced;
        while (splicedNode instanceof APair) {
          results.push(splicedNode.car);
          splicedNode = splicedNode.cdr;
        }
      } else {
        invariant(spliced instanceof ANil, "unquote-splicing: expected list");
      }
      node = node.cdr;
      continue;
    }

    const processed = yield { call: processQuasiquote(item, ctx, level) };
    results.push(processed);
    node = node.cdr;
  }

  // Handle improper list tail (a non-pair atom, e.g. `(1 2 . 3)`). The
  // dotted-unquote tail `(a . ,x)` was already captured inside the loop, which
  // sets `node = nil` on capture — so this branch only fires for atom tails.
  if (!(node instanceof ANil)) {
    tail = yield { call: processQuasiquote(node, ctx, level) };
  }

  // Build result list, threading the (possibly improper) tail through so
  // `(a . ,x)` keeps x as the final cdr rather than nil-terminating (Q9).
  // Pair.fromArray always nil-terminates, so fold manually onto `tail`.
  let result: SchemeValue = tail;
  for (let i = results.length; i--; ) {
    result = new APair(CONSTANT_CTX, results[i], result);
  }
  return result;
}

/** `(define name value)` or `(define (name . args) body)` — the procedure shorthand desugars to a lambda. */
function* evalDefine(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "define: missing name");

  const first = rest.car;
  const valueRest = rest.cdr;

  // Function definition shorthand: (define (f x) body) -> (define f (lambda (x) body))
  if (first instanceof APair) {
    const name = first.car;
    const args = first.cdr;

    invariant(name instanceof ASymbol, "define: expected symbol for function name");

    const value = yield { call: evalLambda(new APair(CONSTANT_CTX, args, valueRest), ctx) };

    if (is_lambda_function(value)) {
      value.__name__ = symbol_name(name);
    }

    ctxResolver(ctx).define(name, value);
    return theVoid;
  }

  // Simple definition: (define name value)
  invariant(first instanceof ASymbol, "define: expected symbol");
  invariant(valueRest instanceof APair, "define: missing value");

  // NOT tail position — the value must return HERE so we can bind it. If we
  // let `tail` flow through, a `(define x (some-lambda))` could tail-replace
  // this slot and skip the `resolver.define` below. Strip it.
  let value = yield { call: evaluate(valueRest.car, ctx.tail ? { ...ctx, tail: false } : ctx) };
  if (is_promise(value)) {
    value = yield value;
  }

  // Set name on functions for debugging
  if (is_lambda_function(value) && !value.__name__) {
    value.__name__ = symbol_name(first);
  }

  ctxResolver(ctx).define(first, value);
  return theVoid;
}

// `set!` — OMITTED by the purity invariant; doored in r7rs/binding (removed from
// the special-form table so env lookup reaches the door, exactly like delay /
// parameterize). Lexical variable rebinding is the last binding-mutation vestige:
// arrival is pure dataflow (every value carries the lineage of WHERE it was bound),
// so re-binding a name severs that lineage. It was a LIPS-fork carry-over, not an
// earned form. With it gone, the `Environment.ref`/`Resolver.env.ref` mutation-
// targeting walk has no evaluator caller (it survives only for hygiene's
// `Capabilities.refFrame` IDENTITY probe, which is not a mutation path).

/** `(lambda args body)` — closes over the definition-time env; body starts in tail position (R7RS §3.5). */
function* evalLambda(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "lambda: missing arguments");

  const args = rest.car;
  const body = rest.cdr;

  // Capture the resolver (lexical scope) at definition time
  const closureResolver = ctxResolver(ctx);

  // The runner — the lambda body, INJECTED into the ALambda value (the value layer names no
  // evaluator symbol; same seam `Macro` uses). `canBounce` replaces the `_canBounce` module
  // global: true ⇒ hand back the body generator as a Bounce for the trampoline (TCO — a
  // `(define (loop) (loop))` stays flat); false ⇒ run to completion (a JS/HOF caller wants a
  // value/promise). `runCtx` is accepted for the apply-term contract; the body still evaluates
  // against the DEFINITION-time ctx exactly as before (call-time runCtx threading is a later cut).
  const runner = (values: SchemeValue[], _runCtx: RunContext, canBounce: boolean): CallResult => {
    const callResolver = closureResolver.child("lambda", "lambda");
    let argNode: SchemeValue = args;
    let i = 0;
    while (argNode instanceof APair) {
      const argName = argNode.car;
      if (argName instanceof ASymbol) callResolver.define(argName, values[i]);
      i++;
      argNode = argNode.cdr;
    }
    // Rest arg: (lambda (a b . rest) …)
    if (argNode instanceof ASymbol) {
      callResolver.define(argNode, APair.fromArray(ctx.runCtx ?? CONSTANT_CTX, values.slice(i), false));
    }
    // Dynamic call site: the caller (evaluatePair / wrapLambdaValue) set the holder just before
    // invoking; else fall back to the lexical ctx's invocation. Read here in the synchronous
    // prologue, so a wrapLambdaValue finally-restore after this point is harmless (bodyCtx captured it).
    const dynamicInv = currentDynamicCallSite() ?? ctx.currentInvocation;
    // Lambda bodies start in tail position (R7RS §3.5): the terminal body expr is tail w.r.t. the
    // caller, so tail=true here propagates through evalBegin/evalIf/… to it.
    const bodyCtx: EvalContext = { ...ctx, resolver: callResolver, currentInvocation: dynamicInv, tail: true };
    if (canBounce) return makeBounce(evalBegin(body, bodyCtx));
    return run(evalBegin(body, bodyCtx), { signal: ctx.signal });
  };

  // Positional parameter names + arity (introspection + tracer↔param-slot correlation).
  const params: string[] = [];
  let walk: SchemeValue = args;
  while (walk instanceof APair) {
    const p = walk.car;
    if (p instanceof ASymbol) params.push(symbol_name(p));
    walk = walk.cdr;
  }
  const hasRest = walk instanceof ASymbol;

  const lambda = new ALambda({
    name: "lambda",
    arity: { min: params.length, max: hasRest ? null : params.length },
    scope: closureResolver,
    runner,
    ctx: ctx.runCtx ?? CONSTANT_CTX,
  });
  lambda.__params__ = params;
  return lambda;
}

/** `(define-macro (name . args) body)` — fexpr-style macro; params bind to UNEVALUATED argument forms. */
function* evalDefineMacro(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "define-macro: missing definition");

  const first = rest.car;
  invariant(first instanceof APair, "define-macro: expected (name . args)");

  const name = first.car;
  const args = first.cdr;
  invariant(name instanceof ASymbol, "define-macro: expected symbol for name");

  const body = rest.cdr;

  // Capture the resolver (lexical scope) at definition time.
  const defResolver = ctxResolver(ctx);

  // The macro body returns `run(...)` — a `Promise<SchemeValue>` of the expansion
  // FORM; the consumer (`fn.invoke` site) `yield`s it via `is_promise`.
  const macro = new Macro(symbol_name(name), function (
    this: Environment,
    code: SchemeValue,
    evalArgs: EvalContext,
  ): Promise<SchemeValue> {
    const macroResolver = defResolver.child("macro", "macro");

    // Fexpr semantics: parameters bind to unevaluated argument forms, not values.
    let argNode: SchemeValue = args;
    let codeNode: SchemeValue = code;
    let i = 0;

    while (argNode instanceof APair) {
      const argName = argNode.car;
      if (argName instanceof ASymbol) {
        const value = codeNode instanceof APair ? codeNode.car : nil;
        macroResolver.define(argName, value);
      }
      i++;
      argNode = argNode.cdr;
      if (codeNode instanceof APair) {
        codeNode = codeNode.cdr;
      }
    }

    if (argNode instanceof ASymbol) {
      macroResolver.define(argNode, codeNode);
    }

    // Forward signal so macro expansion is also budget-bounded.
    return run(evalBegin(body, { ...evalArgs, resolver: macroResolver }), {
      signal: evalArgs.signal,
    });
  });
  ctxResolver(ctx).define(name, macro);

  return theVoid;
}

// ============================================================================
// Core Macros (implemented as special forms for performance)
// ============================================================================

// ── let-family bracket-binding consumption ──────────────────────────────────
// Arrival's reader never erases bracket kind — it survives as the produced
// node's CLASS: `[…]` mints an `AVector` with `evalElements === true` (the
// reader-literal marker — Parser.ts, on `[`); `(…)` mints an `APair`; `#(…)`
// mints an `AVector` with `evalElements === false`. So `evalElements ===
// true` at a binding-position node IS the R2 detection — no reader/lexer
// change (R1). Supersedes the bracket-let DOOR (`5259a9398a`) for
// well-formed shapes; the door survives for malformed ones (R4).
// Spec: docs/reference/bracket-bindings.md. Requirements:
// docs/working-proposals/arrival-bracket-bindings-requirements.md (R1-R8).
//
// Consumption is a PURE SYNTACTIC REWRITE (R3): `normalizeBindings` runs once,
// before the existing per-binding walk, and produces the SAME cons-list-of-
// pairs shape a hand-written paren form would produce. Once it returns, every
// downstream line — the per-pair walk, the tail/provenance handling, the
// error paths for shapes outside this contract — is completely unmodified
// code evaluating a plain list. Equivalence to the paren image is therefore
// structural, not case-by-case.
//
// Two surfaces:
//   - R2a whole-list (Clojure): (let [a 1 b 2] …) — `bindings` itself is the
//     vector. Rewritten to ((a 1) (b 2)) wholesale. NOT accepted for `do`
//     (R2a exclusion — its 3-element steps make pairwise grouping
//     ambiguous); `do` keeps the ORIGINAL door here, unchanged.
//   - R2b per-element (Racket): each ELEMENT of the (paren or already-
//     rewritten) bindings list may itself be a vector [a 1] / [i 0 (+ i 1)]
//     (do only) — rewritten to (a 1) / (i 0 (+ i 1)) in place. R2c mixing is
//     free: a paren-pair element passes through with its own identity
//     untouched, so a bindings list may freely mix (a 1) and [b 2] elements.
//
// `evalElements === false` (`#(…)`) is NEVER touched (R5) — it isn't an
// AVector this code recognizes as bindings syntax, so it falls straight
// through to the generic `invariant(is_pair(binding), …)` below, unchanged.
//
// R4 malformed shapes keep the TWO already-committed door codes
// (`5259a9398a`) — their meanings narrow to genuine malformations now that
// well-formed shapes consume instead of dooring:
//   - E-LET-BRACKET-BINDINGS-LIST: odd element count in a whole-list vector,
//     OR the whole-list form used on `do` (unchanged from the original door).
//   - E-LET-BRACKET-BINDING: a per-element vector of the wrong length, or a
//     non-symbol (including a destructuring vector) in the binding-name slot.

/** `do` doesn't accept the whole-list form (R2a exclusion) — its 3-element
 *  steps make pairwise grouping ambiguous. UNCHANGED from the original door
 *  (`5259a9398a`); the other five forms consume this shape instead. */
function bracketBindingsListError(bindings: AVector, form: string): Error {
  const els = bindings.__vector__;
  const rendered = els.map(String).join(" ");
  const pairs: string[] = [];
  for (let i = 0; i < els.length; i += 2) {
    pairs.push(i + 1 < els.length ? `(${String(els[i])} ${String(els[i + 1])})` : String(els[i]));
  }
  return new EvalError(
    `${form} bindings must be a parenthesized list of pairs — [${rendered}] here is a […] vector literal, not ` +
      `binding syntax. Wrap each binding in parens and the list in parens: (${pairs.join(" ")}).`,
    { code: "E-LET-BRACKET-BINDINGS-LIST" },
  );
}

/** R2a/R4: a whole-list vector's element count is odd — pairwise grouping leaves
 *  the last name with no value. Same code as `bracketBindingsListError` above
 *  (both are "the whole bracketed bindings LIST is malformed for this form"). */
function wholeListOddCountError(bindings: AVector, form: string): Error {
  const els = bindings.__vector__;
  const rendered = els.map(String).join(" ");
  return new EvalError(
    `${form} bindings [${rendered}] has an odd number of elements (${els.length}) — a whole-list binding vector ` +
      `is name/value pairs (\`[s1 v1 s2 v2 …]\`), so the count must be even. Add the missing value, or write the ` +
      `bindings as a parenthesized list of pairs.`,
    { code: "E-LET-BRACKET-BINDINGS-LIST" },
  );
}

/** R2b/R4: a per-element vector's length is wrong (≠2; ≠2-3 for `do`). Code
 *  `E-LET-BRACKET-BINDING` — shared with the non-symbol-name door below; both
 *  are "this bracket binding ELEMENT is malformed" (the per-element sibling
 *  of the whole-list code above). `location` is the enclosing binding-list
 *  cons cell — the `[…]` literal itself carries no location (Parser.ts never
 *  stamps one on it). */
function bindingArityError(
  binding: AVector,
  form: string,
  minLen: number,
  maxLen: number,
  location?: SourceLocation,
): Error {
  const els = binding.__vector__;
  const rendered = els.map(String).join(" ");
  const arity = minLen === maxLen ? `exactly ${minLen}` : `${minLen}–${maxLen}`;
  const shape = maxLen > minLen ? "[name init] or [name init step]" : "[name value]";
  return new EvalError(
    `${form} binding [${rendered}] has ${els.length} element${els.length === 1 ? "" : "s"} — a bracketed ${form} ` +
      `binding is ${shape} (${arity}), not ${els.length}. Fix the count, or write the binding with parens: ` +
      `(${rendered}).`,
    { location, code: "E-LET-BRACKET-BINDING" },
  );
}

/** R2b/R4: a non-symbol in the binding-name slot. SPECIAL-cased text when the
 *  name is itself a vector (Clojure destructuring: `[[x y] v]`) — that's not
 *  a malformed pair but an unsupported binding FORM. Same code as the arity
 *  door above. Reached from BOTH surfaces (R2a whole-list even-position names
 *  and R2b per-element first-elements) via `buildBindingPair`. */
function bindingNameError(name: SchemeValue, form: string, location?: SourceLocation): Error {
  if (name instanceof AVector) {
    return new EvalError(
      `${form}: destructuring is not supported — bind the whole value to one name, then read parts with accessors.`,
      { location, code: "E-LET-BRACKET-BINDING" },
    );
  }
  return new EvalError(
    `${form} binding name must be a symbol, got ${type(name)} (${String(name)}) — each binding is (name value); ` +
      `give the value a plain symbol name.`,
    { location, code: "E-LET-BRACKET-BINDING" },
  );
}

/** Builds the cons-pair `(name val…)` a rewritten bracket binding lowers to —
 *  shared by both R2a (whole-list) and R2b (per-element) rewriting so the
 *  name-slot validation (and its destructuring special-case) is written once.
 *  `parts` is `[name, value]` or `[name, value, step]` (do). */
function buildBindingPair<Car extends SchemeValue, Cdr extends SchemeValue[]>(
  form: string,
  parts: readonly [Car, ...Cdr],
  location: SourceLocation | undefined,
) {
  const name = parts[0];
  if (!(name instanceof ASymbol)) {
    throw bindingNameError(name, form, location);
  }
  let cdr: APair<any, any> | ANil = nil;
  for (let i = parts.length - 1; i >= 1; i--) {
    cdr = new APair(CONSTANT_CTX, parts[i], cdr);
  }
  // Built element-by-element from `parts[1..]` in reverse (the loop above) — exactly the
  // tuple-shaped spine `AListAlike<Cdr>` describes. TS's structural checker can't see that
  // the loop's generic `APair<any,any> | ANil` accumulator matches the specific `Cdr` tuple
  // shape it was just built from, so this narrows what the construction already proves.
  return new APair<Car, AListAlike<Cdr>>(CONSTANT_CTX, name, cdr as AListAlike<Cdr>);
}

/**
 * The R2/R3 syntactic rewrite: lowers a let-family `bindings` slot that uses
 * either bracket surface into the plain cons-list-of-pairs shape the existing
 * per-binding walk already understands, throwing door-grade errors (R4) for
 * malformed shapes right here — BEFORE any walk begins. Once this returns,
 * every line downstream evaluates a form with no bracket bindings in it at
 * all, which is what makes R3's equivalence structural rather than
 * case-by-case.
 *
 *  - `#(…)` (`evalElements === false`) and anything that isn't an `AVector`
 *    pass straight through unchanged — R5 (never consumed) / the generic
 *    invariant downstream is the right door for anything else malformed.
 *  - `bindings` itself an `evalElements` vector (R2a whole-list) is rewritten
 *    wholesale, unless `allowWholeList` is false (`do`'s R2a exclusion — the
 *    caller passes `allowWholeList: false` and gets the ORIGINAL door).
 *  - Each ELEMENT of a (paren, or whole-list-just-rewritten) bindings list
 *    that is itself an `evalElements` vector (R2b per-element) is rewritten
 *    in place; a paren-pair element (or anything else — the generic
 *    invariant's job) passes through with its OWN identity, giving R2c
 *    mixing for free.
 */
function normalizeBindings(
  bindings: SchemeValue,
  form: string,
  allowWholeList: boolean,
  minLen: number,
  maxLen: number,
): SchemeValue {
  if (bindings instanceof AVector) {
    if (!bindings.evalElements) return bindings;
    if (!allowWholeList) throw bracketBindingsListError(bindings, form);
    const els = bindings.__vector__;
    if (els.length % 2 !== 0) throw wholeListOddCountError(bindings, form);
    const items: SchemeValue[] = [];
    for (let i = 0; i < els.length; i += 2) {
      items.push(buildBindingPair(form, [els[i], els[i + 1]], undefined));
    }
    return APair.fromArray(CONSTANT_CTX, items, false);
  }
  if (!(bindings instanceof APair)) return bindings;

  const items: SchemeValue[] = [];
  let node: SchemeValue = bindings;
  while (node instanceof APair) {
    const binding = node.car;
    if (binding instanceof AVector && binding.evalElements) {
      const els = binding.__vector__;
      if (els.length < minLen || els.length > maxLen) {
        throw bindingArityError(binding, form, minLen, maxLen, node[LOCATION]);
      }
      // Nonempty by the arity guard just above (every caller passes minLen ≥ 2).
      items.push(buildBindingPair(form, els as readonly [SchemeValue, ...SchemeValue[]], node[LOCATION]));
    } else {
      items.push(binding);
    }
    node = node.cdr;
  }
  return APair.fromArray(CONSTANT_CTX, items, false);
}

/**
 * Handle 'let' special form: (let ((var val) ...) body...)
 * Also handles named let: (let name ((var val) ...) body...)
 */
function* evalLet(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "let: missing bindings");

  let bindings: SchemeValue;
  let body: SchemeValue;
  let name: ASymbol | null = null;

  // Check for named let: (let name ((var val) ...) body...)
  if (rest.car instanceof ASymbol) {
    name = rest.car;
    const afterName = rest.cdr;
    invariant(afterName instanceof APair, "let: missing bindings after name");
    bindings = afterName.car;
    body = afterName.cdr;
  } else {
    bindings = rest.car;
    body = rest.cdr;
  }

  // named let gets its own form name in the bracket-binding doors below —
  // "named let" reads clearer than "let" when the model bracketed `(let loop
  // […]) …)`'s bindings.
  const letForm = name ? "named let" : "let";
  // R2/R3: consume both bracket surfaces into the plain cons-list-of-pairs
  // shape everything below already understands (see normalizeBindings).
  const normalizedBindings = normalizeBindings(bindings, letForm, true, 2, 2);

  const letResolver = ctxResolver(ctx).child("let", "let");

  // For named let, we need to create a recursive function
  if (name) {
    const params: ASymbol[] = [];
    let bindNode: SchemeValue = normalizedBindings;
    while (bindNode instanceof APair) {
      const binding = bindNode.car;
      if (binding instanceof APair && binding.car instanceof ASymbol) {
        params.push(binding.car);
      }
      bindNode = bindNode.cdr;
    }

    // Recursive `(loop ...)` calls must NOT each call `run(...)` again — every
    // recursion would add a pending await to the JS promise chain and blow V8's
    // call-stack limit from inside PromiseRejectCallback (the abort budget can't
    // rescue it, since the overflow happens inside await machinery before the
    // next TICK check runs). Fix: same Bounce protocol as evalLambda — the
    // `canBounce` apply-term argument (set true by evaluatePair right before
    // invoking a lambda from inside an active trampoline) tells the runner to
    // hand back the body generator as a Bounce token instead of spawning a
    // fresh `run(...)` Promise, so the outer trampoline drives it flat. Falls
    // back to `run(...)` when the loop escaped into a JS HOF (`canBounce`
    // false, e.g. `(map loop xs)`), so HOF callers still see a Promise.
    // `signal` is forwarded on that fallback path for the same reason; the
    // bounce path inherits the outer ctx's signal directly.
    //
    // Mirrors evalLambda's runner exactly (reverse-membrane-for-callables.md §3
    // step 1): named-let is sugar for a letrec-bound lambda, so its loop
    // binding is a real ALambda now, not a bare `[LAMBDA]`-branded JS function.
    const runner = (values: SchemeValue[], _runCtx: RunContext, canBounce: boolean): CallResult => {
      const loopResolver = letResolver.child("named-let", "named-let");

      for (const [i, param] of params.entries()) {
        loopResolver.define(param, values[i]);
      }

      const dynamicInv = currentDynamicCallSite() ?? ctx.currentInvocation;
      const bodyCtx: EvalContext = {
        ...ctx,
        resolver: loopResolver,
        currentInvocation: dynamicInv,
        // Named-let body is tail w.r.t. its caller (the `(loop ...)` call
        // site). Tail flag propagates structurally to the body's last
        // expression — that's what makes `(loop (+ i 1))` actually
        // tail-dispatch into the next iteration.
        tail: true,
      };
      if (canBounce) {
        return makeBounce(evalBegin(body, bodyCtx));
      }
      return run(evalBegin(body, bodyCtx), {
        signal: ctx.signal,
      });
    };

    // letrec shape (R7RS's own definition of named let: `(letrec ((name (lambda
    // (var…) body…))) name)`): the loop's own name must be bound in `letResolver`
    // — the SAME resolver the runner closes over — before any recursive
    // `(loop …)` call inside `body` can resolve back to this ALambda. Binding it
    // right after construction (below) is that letrec tie; the ALambda's
    // `scope: letResolver` is what makes the runner's `letResolver.child(...)`
    // read the binding a call later.
    const loopLambda = new ALambda({
      name: symbol_name(name),
      arity: { min: params.length, max: params.length },
      scope: letResolver,
      runner,
      ctx: ctx.runCtx ?? CONSTANT_CTX,
    });
    loopLambda.__name__ = symbol_name(name);
    loopLambda.__params__ = params.map((p) => symbol_name(p));

    letResolver.define(name, loopLambda);
  }

  // Binding RHS expressions are non-tail (their values feed into the let
  // frame; only the body is tail w.r.t. the let's parent).
  const values: SchemeValue[] = [];
  const names: ASymbol[] = [];
  const bindingCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    invariant(binding instanceof APair, "let: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof ASymbol, "let: expected symbol in binding");

    names.push(varName);

    const bindingCdr = binding.cdr;
    invariant(bindingCdr instanceof APair, "let: missing value in binding");
    const valExpr = bindingCdr.car;

    // Parallel semantics: evaluated in the original (pre-let) environment.
    let value = yield { call: evaluate(valExpr, bindingCtx) };
    if (is_promise(value)) {
      value = yield value;
    }
    values.push(value);

    bindNode = bindNode.cdr;
  }

  for (const [i, varName] of names.entries()) {
    letResolver.define(varName, values[i]);
  }

  // Evaluate body — inherits the let's tail flag via ctx spread; pass-through
  // (tail-collapsible) so a tail call in the body collapses this let frame.
  return yield { call: evalBegin(body, { ...ctx, resolver: letResolver }), tail: ctx.tail === true };
}

/**
 * Handle 'let*' special form: (let* ((var val) ...) body...)
 * Sequential binding - each binding can see previous ones
 */
function* evalLetStar(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "let*: missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // R2/R3: consume both bracket surfaces (see normalizeBindings).
  const normalizedBindings = normalizeBindings(bindings, "let*", true, 2, 2);

  const letStarResolver = ctxResolver(ctx).child("let*", "let*");

  // Evaluate bindings sequentially. Bindings are non-tail; only body is.
  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    invariant(binding instanceof APair, "let*: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof ASymbol, "let*: expected symbol in binding");

    const bindingCdr = binding.cdr;
    invariant(bindingCdr instanceof APair, "let*: missing value in binding");
    const valExpr = bindingCdr.car;

    // Sequential semantics: evaluated in the growing let* environment.
    let value = yield { call: evaluate(valExpr, { ...ctx, resolver: letStarResolver, tail: false }) };
    if (is_promise(value)) {
      value = yield value;
    }

    letStarResolver.define(varName, value);
    bindNode = bindNode.cdr;
  }

  // Evaluate body — inherits let*'s tail flag; pass-through (tail-collapsible).
  return yield { call: evalBegin(body, { ...ctx, resolver: letStarResolver }), tail: ctx.tail === true };
}

/**
 * Handle 'letrec' special form: (letrec ((var val) ...) body...)
 * Recursive binding - all bindings can see each other
 */
function* evalLetrec(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "letrec: missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // R2/R3: consume both bracket surfaces (see normalizeBindings). Also covers
  // letrec* — the SPECIAL_FORMS table aliases "letrec*" straight to this
  // function (R7RS: letrec* evaluates left-to-right, same as our letrec).
  const normalizedBindings = normalizeBindings(bindings, "letrec", true, 2, 2);

  const letrecResolver = ctxResolver(ctx).child("letrec", "letrec");

  // First pass: bind all names to unassigned.
  const bindingList: Array<{ name: ASymbol; expr: SchemeValue }> = [];
  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    invariant(binding instanceof APair, "letrec: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof ASymbol, "letrec: expected symbol in binding");

    const bindingCdr = binding.cdr;
    invariant(bindingCdr instanceof APair, "letrec: missing value in binding");
    const valExpr = bindingCdr.car;

    // letrec first pass: the name exists but is unassigned until the second
    // pass overwrites it. theVoid is the unassigned-slot sentinel (referencing
    // it before assignment is an R7RS error caught elsewhere); `undefined` is
    // not a SchemeValue / EnvironmentValue.
    letrecResolver.define(varName, theVoid);
    bindingList.push({ name: varName, expr: valExpr });
    bindNode = bindNode.cdr;
  }

  // Second pass: evaluate and assign (in the letrec environment).
  // Bindings are non-tail; only body inherits letrec's tail flag.
  for (const { name, expr } of bindingList) {
    let value = yield { call: evaluate(expr, { ...ctx, resolver: letrecResolver, tail: false }) };
    if (is_promise(value)) {
      value = yield value;
    }
    letrecResolver.define(name, value);
  }

  // Evaluate body — inherits letrec's tail flag; pass-through (tail-collapsible).
  return yield { call: evalBegin(body, { ...ctx, resolver: letrecResolver }), tail: ctx.tail === true };
}

/**
 * Handle 'and' special form: (and expr...)
 * Short-circuit evaluation - returns first false value or last value.
 *
 * R7RS §3.5 tail-position: only the LAST expression inherits the and's tail
 * flag — earlier ones short-circuit on `#f` and don't reach tail dispatch.
 */
function* evalAnd(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  // (and) with no args returns #t
  if (!(rest instanceof APair) || rest instanceof ANil) {
    return schemeTrue;
  }

  let node: SchemeValue = rest;
  let result: SchemeValue = schemeTrue;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (node instanceof APair) {
    const isLast = node.cdr instanceof ANil || !(node.cdr instanceof APair);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
    // Last expr is pass-through (its value is returned unchanged); mark tail
    // so it collapses on a tail call. The short-circuit check below only
    // matters for non-last exprs, so collapsing past it on the last is safe.
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }

    // Short-circuit on false
    if (is_false(result)) {
      return result;
    }

    node = node.cdr;
  }

  return result;
}

/**
 * Handle 'or' special form: (or expr...)
 * Short-circuit evaluation - returns first true value or last value.
 *
 * R7RS §3.5 tail-position: only the LAST expression inherits the or's tail
 * flag — earlier ones short-circuit on truthy and don't reach tail dispatch.
 */
function* evalOr(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  // (or) with no args returns #f
  if (!(rest instanceof APair) || rest instanceof ANil) {
    return schemeFalse;
  }

  let node: SchemeValue = rest;
  let result: SchemeValue = schemeFalse;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (node instanceof APair) {
    const isLast = node.cdr instanceof ANil || !(node.cdr instanceof APair);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
    // Last expr is pass-through; mark tail so it collapses on a tail call.
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }

    // Short-circuit on true (anything not false)
    if (!is_false(result)) {
      return result;
    }

    node = node.cdr;
  }

  return result;
}

/**
 * Apply an already-evaluated procedure to one already-evaluated argument,
 * routing the call through the SAME trampoline tail path `evaluatePair` uses
 * for a normal application.
 *
 * This is the `=>` arm of `cond`/`case`: R7RS §3.5 places the `(proc test-value)`
 * application in tail position when the enclosing form is in tail position. A
 * direct synchronous JS call would route a Scheme lambda body through the
 * legacy `run(...)`-per-call path, growing the host stack and overflowing on a
 * self-recursive `=>` loop. Mirroring `evaluatePair`'s bounce protocol here
 * brings `=>` onto the TCO surface: a Scheme lambda hands back a Bounce, which
 * collapses the tail tower (tail) or threads through a pass-through
 * `{ call, tail:true }` (non-tail). Non-lambda callables (builtins,
 * `SchemeJSFunction`) can't tail-recurse into Scheme, so they keep the direct
 * apply.
 *
 * Provenance: this helper does NOT stamp control-flow provenance itself. The
 * caller wraps the `{ call: applyArrowProc(...) }` yield with
 * `onResolve: controlFlowResolve(predicate)`. Because this generator's slot is
 * pass-through (`return yield`), the trampoline's tailCall collapse picks up
 * that caller-supplied `onResolve` from the popped slot and composes it onto
 * the replacement — so the predicate's lineage rides BOTH the collapsed (bounce)
 * and resumed (plain-value) paths, exactly like the non-`=>` arms.
 */
function* applyArrowProc(proc: SchemeValue, arg: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(is_callable(proc), "=> requires a procedure");

  // A callable VALUE dispatches through its apply term. An ALambda in tail position hands back a
  // Bounce so a self-recursive `=>` collapses on the trampoline (TCO); an ANativeProcedure/
  // ARosettaProcedure returns a value/promise (canBounce ignored). Every scheme-authored lambda
  // (including named-let's loop binding, since reverse-membrane-for-callables.md §3 step 1) is a
  // callable VALUE now — the legacy `[LAMBDA]`-branded bare-fn arm this helper once needed is gone.
  if (is_callable_value(proc)) {
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = currentDynamicCallSite();
    setDynamicCallSite(dynSite);
    let r: CallResult;
    try {
      r = proc[tf("apply")](wrapLambdaArgs([arg], dynSite), ctx.runCtx ?? CONSTANT_CTX, is_lambda(proc));
    } finally {
      setDynamicCallSite(__savedDynamicCallSite);
    }
    if (is_bounce(r)) {
      if (ctx.tail) return yield { tailCall: { generator: r.generator } } as unknown as SchemeValue;
      return yield { call: r.generator, tail: true };
    }
    return is_promise(r) ? yield r : (r as SchemeValue);
  }

  // Builtins: direct apply (no Scheme body to tail into).
  invariant(is_function(proc), "=> requires a procedure");
  // `proc` is the non-callable-value arm here — the callable-value branch above returned. The
  // SchemeValue callable surface is heterogeneous (a metadata-bearing `AProcedure`, the plain
  // bare-fn arm) and shares no single call signature, so a direct `proc(arg)` isn't expressible;
  // invoke reflectively — `Reflect.apply` takes the arg array honestly (no cast), the same
  // convention the main apply path uses. A builtin yields a value or a Promise, never a Bounce;
  // rule the bounce arm out explicitly (a builtin handing back a bounce sentinel is a real
  // invariant violation, not a value to thread).
  // `this = CallCtx` — the same invocation-context shape the main apply path hands a
  // builtin (see the `Reflect.apply(fn, makeCallCtx(...), …)` call in evalPair). A native
  // impl reads `this.runCtx`; a genuinely undefined `this` crashed the `=>` arm
  // (`(cond (test => cadr))`) before this shape existed.
  let result: SchemeValue | SchemeBounceMarker | Promise<SchemeValue> = Reflect.apply(
    proc,
    makeCallCtx(ctx.runCtx, ctx.currentInvocation as InvocationLike | undefined),
    [arg],
  );
  invariant(!is_bounce_marker(result), "=> builtin returned a bounce sentinel");
  if (is_promise(result)) {
    result = yield result;
  }
  return result;
}

// R9 (addendum to the bracket-bindings requirements — `docs/working-proposals/
// arrival-bracket-bindings-requirements.md`): the CLAUSE positions of `cond`,
// `case`, and `do`'s test-result clause additionally accept an `evalElements`
// vector, elementwise ≡ the parenthesized clause. `cond`/`case` are evaluator
// SPECIAL FORMS (this file), not syntax-rules prelude macros — so consumption
// lands right here, the same file and shape as the R2/R3 let-family
// consumption above (`normalizeBindings`), applied to CLAUSE positions instead
// of BINDING positions.
//
// `normalizeClause` runs once per clause, before the existing clause walk,
// and produces the SAME plain-list shape a hand-written paren clause already
// is — so downstream (the test/datum/body handling below) is completely
// unmodified code evaluating a plain list, same structural-equivalence
// argument as R3.
//
// Critically, `normalizeClause` converts ONLY the clause's own wrapper — it
// never looks inside element 0. This is what keeps a `case` clause's
// datum-list head a LIST, never bracket-converted (R9): `[(1 2) "low"]`'s
// vector elements are `[(1 2), "low"]`; rewrapping them as a list gives
// `((1 2) "low")` with the inner `(1 2)` untouched, exactly the paren image.
//
// `#(…)` (`evalElements === false`) and non-vector clauses pass straight
// through (R5 — never consumed); the existing `is_pair(clause)` invariants
// below are the right door for anything else malformed.
function normalizeClause(clause: SchemeValue, form: string): SchemeValue {
  if (!(clause instanceof AVector) || !clause.evalElements) return clause;
  const els = clause.__vector__;
  if (els.length === 0) throw emptyClauseError(form);
  return APair.fromArray(CONSTANT_CTX, els, false);
}

/** R9/R4-family: an empty bracket clause `[]` — cond/case/do's clause vector
 *  must contain at least the test/datum slot. Code `E-COND-BRACKET-CLAUSE`
 *  (shared across cond/case/do — this is "the whole bracketed CLAUSE is
 *  malformed for this form", the clause-position sibling of
 *  `E-LET-BRACKET-BINDINGS-LIST`). */
function emptyClauseError(form: string): Error {
  return new EvalError(
    `${form} clause [] is empty — a bracketed clause needs at least a test/datum slot ` +
      `(\`[test expr…]\` for cond/do, \`[(datum…) expr…]\` or \`[else expr…]\` for case). ` +
      `Add the missing slot, or remove the empty clause.`,
    { code: "E-COND-BRACKET-CLAUSE" },
  );
}

/** R9: a `case` clause's datum-list HEAD is itself a bracket vector — the
 *  datum list is DATA and is never bracket-converted (R9), even inside a
 *  bracketed clause. `[[1 2] "low"]` therefore does NOT lower to
 *  `((1 2) "low")`; it stays `([1 2] "low")` and would otherwise fall through
 *  to the generic "case: expected list of datums" invariant with no hint
 *  about why. This door names the vector-ness itself as the confusion (per
 *  R9: "the bracket door only where the vector-ness itself is the
 *  confusion") and points at the fix. */
function caseDatumListVectorError(datums: AVector): Error {
  const els = datums.__vector__;
  const rendered = els.map(String).join(" ");
  return new EvalError(
    `case clause datum list [${rendered}] is a vector — the datum-list head is data and is never ` +
      `bracket-converted, even inside a bracketed clause. Write it as a parenthesized list: (${rendered}).`,
    { code: "E-CASE-BRACKET-DATUM-LIST" },
  );
}

/**
 * Handle 'cond' special form: (cond (test expr...) ... (else expr...)?)
 */
function* evalCond(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let node: SchemeValue = rest;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (node instanceof APair) {
    // R9: consume a bracket clause (see normalizeClause above) before the
    // existing invariant/walk.
    const clause = normalizeClause(node.car, "cond");
    invariant(clause instanceof APair, "cond: invalid clause");

    const test = clause.car;
    const exprs = clause.cdr;

    // Check for else clause. Matched-clause body inherits cond's tail flag
    // and is pass-through (tail-collapsible). `.literal()` (not symbol_name) so a
    // HYGIENE-renamed `else` (#:else, when cond appears in a user syntax-rules template)
    // is still recognized — auxiliary keywords match by their un-renamed literal name.
    if (test instanceof ASymbol && test.literal() === "else") {
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true };
    }

    // Evaluate test (non-tail — its value drives dispatch, not the result).
    let testResult = yield { call: evaluate(test, nonTailCtx) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Check for => syntax: (test => proc). Per R7RS §3.5 the `(proc testResult)`
      // application is in tail position when cond is — route it through
      // applyArrowProc so a self-recursive `=>` loop collapses on the trampoline
      // instead of overflowing the host stack. The control-flow provenance rides
      // as `onResolve` (pass-through, same as the non-`=>` arms below).
      if (exprs instanceof APair) {
        const firstExpr = exprs.car;
        if (firstExpr instanceof ASymbol && firstExpr.literal() === "=>") {
          const exprsCdr = exprs.cdr;
          invariant(exprsCdr instanceof APair, "cond: missing procedure after =>");
          const procExpr = exprsCdr.car;
          let proc = yield { call: evaluate(procExpr, nonTailCtx) };
          if (is_promise(proc)) {
            proc = yield proc;
          }
          invariant(is_callable(proc), "cond: => requires a procedure");
          return yield {
            call: applyArrowProc(proc, testResult, ctx),
            tail: ctx.tail === true,
            onResolve: controlFlowResolve(testResult),
          };
        }
      }

      // No expressions means return test result (already carries its own provenance)
      if (!(exprs instanceof APair) || exprs instanceof ANil) {
        return testResult;
      }

      // Evaluate expressions — pass-through (tail-collapsible). Provenance
      // restriction rides as onResolve so it fires for both the collapsed
      // (tail-call) and resumed (plain-value) paths.
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
    }

    node = node.cdr;
  }

  // No clause matched
  return theVoid;
}

/**
 * Handle 'case' special form: (case key ((datum...) expr...) ... (else expr...)?)
 */
function* evalCase(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "case: missing key");

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Evaluate key (non-tail — drives dispatch, value is consumed by case).
  let key = yield { call: evaluate(rest.car, nonTailCtx) };
  if (is_promise(key)) {
    key = yield key;
  }

  let node: SchemeValue = rest.cdr;

  while (node instanceof APair) {
    // R9: consume a bracket clause (see normalizeClause above) before the
    // existing invariant/walk.
    const clause = normalizeClause(node.car, "case");
    invariant(clause instanceof APair, "case: invalid clause");

    const datums = clause.car;
    const exprs = clause.cdr;

    // Check for else clause — pass-through (tail-collapsible).
    if (datums instanceof ASymbol && datums.literal() === "else") {
      // R7RS §6.3 also allows `(else => proc)`: apply proc to the key in tail
      // position (mirrors cond's `=>`).
      const arrowProc = yield* evalCaseArrowProc(exprs, nonTailCtx);
      if (arrowProc !== undefined) {
        return yield {
          call: applyArrowProc(arrowProc, key, ctx),
          tail: ctx.tail === true,
          onResolve: controlFlowResolve(key),
        };
      }
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true };
    }

    // Check if key matches any datum (using eqv? semantics)
    // R9: the datum-list head is data and is NEVER bracket-converted — a
    // vector here (evalElements) is the confusion itself, not a generic
    // malformation, so it gets its own door (see caseDatumListVectorError).
    if (datums instanceof AVector && datums.evalElements) {
      throw caseDatumListVectorError(datums);
    }
    invariant(datums instanceof APair, "case: expected list of datums");
    let datumNode: SchemeValue = datums;
    let matched = false;

    while (datumNode instanceof APair) {
      const datum = datumNode.car;
      // eqv? comparison
      if (key === datum || (typeof key === typeof datum && key?.valueOf?.() === datum?.valueOf?.())) {
        matched = true;
        break;
      }
      datumNode = datumNode.cdr;
    }

    if (matched) {
      // R7RS §6.3 `=>` arm: `((d1 ...) => proc)` applies proc to the key. Route
      // through applyArrowProc so a tail `=>` collapses on the trampoline.
      const arrowProc = yield* evalCaseArrowProc(exprs, nonTailCtx);
      if (arrowProc !== undefined) {
        return yield {
          call: applyArrowProc(arrowProc, key, ctx),
          tail: ctx.tail === true,
          onResolve: controlFlowResolve(key),
        };
      }
      // Pass-through (tail-collapsible). Per spec §5.3 the dispatching value
      // (the case key) plays the predicate role — its lineage was consulted
      // to pick this arm. Provenance restriction rides as onResolve so it
      // applies for both the collapsed and resumed paths.
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(key) };
    }

    node = node.cdr;
  }

  return theVoid;
}

/**
 * Detect and evaluate a `case` clause's `=> proc` form. Returns the evaluated
 * procedure if `exprs` is `(=> proc)`, else `undefined` (a normal body). The
 * procedure is evaluated in non-tail context; the application itself is routed
 * through applyArrowProc by the caller so it stays on the TCO surface.
 */
function* evalCaseArrowProc(
  exprs: SchemeValue,
  nonTailCtx: EvalContext,
): Generator<unknown, SchemeValue | undefined, SchemeValue> {
  // `undefined` is the "not a `=> proc` form" control sentinel (the caller tests
  // `!== undefined`), genuinely outside the value domain — NOT a Scheme value.
  // So this generator's return type widens to `SchemeValue | undefined`; using
  // theVoid here would be indistinguishable from a real void-returning proc.
  if (!(exprs instanceof APair)) return undefined;
  const first = exprs.car;
  if (!(first instanceof ASymbol) || first.literal() !== "=>") return undefined;
  const exprsCdr = exprs.cdr;
  invariant(exprsCdr instanceof APair, "case: missing procedure after =>");
  let proc = yield { call: evaluate(exprsCdr.car, nonTailCtx) };
  if (is_promise(proc)) {
    proc = yield proc;
  }
  invariant(is_callable(proc), "case: => requires a procedure");
  return proc;
}

/** `(when test expr...)` — body in tail position inherits when's tail flag (R7RS §3.5). */
function* evalWhen(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "when: missing test");

  const test = rest.car;
  const body = rest.cdr;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(test, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (!is_false(testResult)) {
    // Matched body inherits when's tail flag; pass-through (tail-collapsible),
    // provenance restriction rides as onResolve.
    return yield { call: evalBegin(body, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
  }

  return theVoid;
}

/** `(unless test expr...)` — the `#f`-guarded mirror of `when`; body in tail position. */
function* evalUnless(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "unless: missing test");

  const test = rest.car;
  const body = rest.cdr;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(test, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (is_false(testResult)) {
    // Matched body inherits unless's tail flag; pass-through (tail-collapsible),
    // provenance restriction rides as onResolve.
    return yield { call: evalBegin(body, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
  }

  return theVoid;
}

/**
 * Handle 'do' special form: (do ((var init step) ...) (test result...) body...)
 */
function* evalDo(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "do: missing bindings");

  const bindings = rest.car;
  // R2/R3: consume the per-element bracket surface only — do does NOT accept
  // the whole-list form (R2a exclusion; allowWholeList: false keeps the
  // ORIGINAL door, unchanged). Arity is 2-3 ([name init] / [name init step]).
  const normalizedBindings = normalizeBindings(bindings, "do", false, 2, 3);
  const restCdr = rest.cdr;
  invariant(restCdr instanceof APair, "do: missing test clause");

  // R9: do's test clause may be a bracket vector, elementwise ≡ the
  // parenthesized clause (see normalizeClause above).
  const testClause = normalizeClause(restCdr.car, "do");
  const body = restCdr.cdr;

  invariant(testClause instanceof APair, "do: invalid test clause");

  const test = testClause.car;
  const resultExprs = testClause.cdr;

  const doResolver = ctxResolver(ctx).child("do", "do");
  const vars: Array<{ name: ASymbol; step: SchemeValue | null }> = [];

  // do's structural tail-position: ONLY the result-expression(s) are tail.
  // Bindings, test, step, body all evaluate as side-effects/predicates and
  // are explicitly non-tail. (do itself already iterates inside ONE
  // generator's `while (true)` — recursion is flat regardless, so the
  // tail flag matters only for what the result expressions eventually do.)
  const doNonTail: EvalContext = { ...ctx, resolver: doResolver, tail: false };
  const doTail: EvalContext = { ...ctx, resolver: doResolver };

  // Initialize variables (non-tail — values feed into the do frame).
  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    invariant(binding instanceof APair, "do: invalid binding");

    const varName = binding.car;
    invariant(varName instanceof ASymbol, "do: expected symbol");

    const bindingCdr = binding.cdr;
    // No init form → unspecified. theVoid is self-evaluating (an atom — see
    // `evaluate`'s non-pair return), so a missing init yields void; `undefined`
    // is not a SchemeValue.
    let initExpr: SchemeValue = theVoid;
    let stepExpr: SchemeValue | null = null;

    if (bindingCdr instanceof APair) {
      initExpr = bindingCdr.car;
      const bindingCddr = bindingCdr.cdr;
      if (bindingCddr instanceof APair) {
        stepExpr = bindingCddr.car;
      }
    }

    let initValue = yield { call: evaluate(initExpr, ctx.tail ? { ...ctx, tail: false } : ctx) };
    if (is_promise(initValue)) {
      initValue = yield initValue;
    }

    doResolver.define(varName, initValue);
    vars.push({ name: varName, step: stepExpr });

    bindNode = bindNode.cdr;
  }

  while (true) {
    // Test condition (non-tail — predicate for loop dispatch).
    let testResult = yield { call: evaluate(test, doNonTail) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Test is true - evaluate result expressions in tail position;
      // pass-through (tail-collapsible).
      if (resultExprs instanceof APair) {
        return yield { call: evalBegin(resultExprs, doTail), tail: ctx.tail === true };
      }
      return theVoid;
    }

    // Execute body (non-tail — body's value is discarded each iteration).
    if (body instanceof APair) {
      yield { call: evalBegin(body, doNonTail) };
    }

    const newValues: SchemeValue[] = [];
    for (const { step } of vars) {
      if (step === null) {
        // Index-alignment filler for a step-less var; never read (the update
        // pass below only defines names where `step !== null`). theVoid keeps
        // the array a genuine SchemeValue[]; `undefined` is not a SchemeValue.
        newValues.push(theVoid);
      } else {
        let newValue = yield { call: evaluate(step, doNonTail) };
        if (is_promise(newValue)) {
          newValue = yield newValue;
        }
        newValues.push(newValue);
      }
    }

    for (const [i, { name, step }] of vars.entries()) {
      if (step !== null) {
        doResolver.define(name, newValues[i]);
      }
    }
  }
}

/**
 * Handle 'while' special form: (while test body...)
 *
 * Iterate the body while `test` evaluates truthy; returns unspecified (nil).
 * Like `do`, the whole loop runs inside ONE generator's `while (true)` so the
 * host stack stays flat no matter how many iterations execute — this is what
 * makes `while` stack-safe (the legacy Macro recursed on the JS stack).
 */
function* evalWhile(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "while: missing test");

  const test = rest.car;
  const body = rest.cdr;

  // test is a predicate; body's value is discarded each iteration — both
  // strictly non-tail (nothing here is in while's tail position).
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (true) {
    let testResult = yield { call: evaluate(test, nonTailCtx) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (is_false(testResult)) {
      return theVoid;
    }

    if (body instanceof APair) {
      yield { call: evalBegin(body, nonTailCtx) };
    }
  }
}

/**
 * Handle 'try' special form: (try body (catch (var) handler...) [(finally expr...)])
 *
 * Exception handling with optional catch and finally clauses.
 * At least one of catch or finally must be present.
 */
function* evalTry(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  invariant(rest instanceof APair, "try: missing body");

  const body = rest.car;
  let catchClause: SchemeValue | null = null;
  let finallyClause: SchemeValue | null = null;

  let clauseNode = rest.cdr;
  while (clauseNode instanceof APair) {
    const clause = clauseNode.car;
    if (clause instanceof APair) {
      const clauseHead = clause.car;
      // `.literal()` (not symbol_name) — same reason evalCond/evalCase match `else`/`=>`
      // by `.literal()`: a syntax-rules template expanding to `(try … (catch (e) …))`
      // hygiene-renames the auxiliary `catch`/`finally` identifiers to gensyms (they are
      // free template identifiers, not pattern variables), and `symbol_name()` reads the
      // renamed gensym's JS-Symbol description ("#:catch"), never "catch". `.literal()`
      // reads the ORIGINAL source name the hygiene renamer stamped on the gensym, so
      // catch/finally survive hygiene exactly like else/=> do.
      if (clauseHead instanceof ASymbol) {
        const name = clauseHead.literal();
        if (name === "catch") {
          catchClause = clause;
        } else if (name === "finally") {
          finallyClause = clause;
        }
      }
    }
    clauseNode = clauseNode.cdr;
  }

  invariant(catchClause || finallyClause, "try: requires catch or finally clause");

  // Each clause runs in its OWN fresh `run()` (nested trampoline) so the outer
  // try/catch can intercept thrown errors. That boundary already isolates the
  // host stack — `tail` is stripped so body/handlers are top-of-trampoline
  // (not tail w.r.t. the surrounding form), keeping the bounce protocol from
  // reaching across the `run()` boundary. A tail loop INSIDE the body still
  // gets full TCO within its own trampoline.
  const bodyCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;
  const resultPromise = (async () => {
    let result: SchemeValue;
    let caughtError: Error | null = null;

    // Execute body. Forward signal so the body of a try/catch is bounded.
    try {
      result = expectValue(await run(evaluate(body, bodyCtx), { signal: ctx.signal }));
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
    }

    if (caughtError && catchClause) {
      invariant(catchClause instanceof APair, "try: invalid catch clause");
      const catchCdr = catchClause.cdr;
      invariant(catchCdr instanceof APair, "try: invalid catch syntax");

      const varSpec = catchCdr.car;
      invariant(varSpec instanceof APair, "try: catch requires (var)");

      const varName = varSpec.car;
      invariant(varName instanceof ASymbol, "try: catch variable must be a symbol");

      const handlers = catchCdr.cdr;

      const catchResolver = ctxResolver(ctx).child("catch", "catch");

      // Bind the error. A `%raise` of a raw (non-Error) scheme value is stringified by the
      // trampoline's `failAndWrap` (`rawRaisedValues`' own doc comment above `run()`) —
      // recover the ORIGINAL raised value from that side channel when present, so a guard
      // clause like `(assq 'a condition)` sees the real structure R7RS §6.11 promises (raise
      // accepts ANY object), not a printed re-presentation of it.
      const rawRaised = caughtError instanceof ArrivalError ? rawRaisedValues.get(caughtError) : undefined;
      let errorValue: SchemeValue;
      if (rawRaised !== undefined) {
        errorValue = rawRaised;
      } else {
        // Unwrap an ArrivalError to the original raised value; the remaining catch path
        // only ever surfaces host `Error`s here (error()/make-error-object already produce
        // a real Error, and `ArrivalError.cause` carries it), so `caught` is an `Error`.
        const caught: Error =
          caughtError instanceof ArrivalError && caughtError.cause ? caughtError.cause : caughtError;
        // Conformance + security: a raw host `Error` here would make `error-object?`
        // return #f (non-conformant per §6.11) and leak host file paths (`.stack`/
        // `.fileName` are OWN properties the membrane's fast path hands across). Every
        // path re-presents to an `R7RSError` carrying only the message — the one Error
        // subtype the SchemeValue union admits as a value.
        //
        // `R7RSError` is loaded via dynamic import here — historically to dodge the
        // now-deleted bridge.ts's eager `set_interaction_env` at module init, which
        // broke the SchemePromise circular-init ordering. `../errors.js` is already a
        // static top-of-module import in this file today (ArrivalError/EvalError/
        // isHostRuntimeBug above), so that specific hazard no longer applies — this
        // dynamic import may now be vestigial. By the time a `try` body has thrown,
        // every module is initialized, so it resolves synchronously either way.
        const { R7RSError } = await import("../errors.js");
        errorValue = caught instanceof R7RSError ? caught : new R7RSError(caught.message);
        // Even a freshly-minted R7RSError carries an OWN `.stack` (V8 sets it on
        // construction) plus any inherited `.cause`/`.fileName`. The membrane's
        // own-property fast path would hand those host frames to Scheme code, so
        // strip them — the message is the only datum a §6.11 handler needs.
        const errObj = errorValue as { stack?: unknown; cause?: unknown; fileName?: unknown };
        delete errObj.stack;
        delete errObj.cause;
        delete errObj.fileName;
      }
      catchResolver.define(varName, errorValue);

      try {
        // Forward signal: a catch handler running an unbounded computation
        // (e.g. a recovery loop) must respect the same budget.
        result = await run(evalBegin(handlers, { ...ctx, resolver: catchResolver, tail: false }), {
          signal: ctx.signal,
        });
        caughtError = null; // handled
      } catch (error) {
        caughtError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // Forward signal — finally is allowed to be bounded too; aborts in finally
    // propagate per JS semantics (this catch swallows them, matching the old
    // behavior).
    if (finallyClause) {
      invariant(finallyClause instanceof APair, "try: invalid finally clause");
      const finallyCdr = finallyClause.cdr;
      try {
        await run(evalBegin(finallyCdr, { ...ctx, tail: false }), { signal: ctx.signal });
      } catch {
        // Errors in finally are ignored (per JS semantics)
      }
    }

    if (caughtError) {
      throw caughtError;
    }

    return result!;
  })();

  return yield resultPromise;
}

// ============================================================================
// `[…]` / `{…}` collection literals — code-position lowering
// ============================================================================
// The reader mints literal NODES (a frozen `evalElements` AVector / a `literalForms`
// ADict) so `quote` yields them unchanged as data. In CODE position their
// elements EVALUATE (Clojure semantics): the node's own `arrival/tagless-final/lower`
// term (AVector.ts / ADict.ts) lowers ONCE (cached on the term, keyed by node
// identity) to the equivalent `(vector …)` / `(dict …)` application, which is then
// evaluated — so the semantics are BY CONSTRUCTION the documented equivalences
// (`{:k v}` ≡ `(dict :k v)`), including membrane marshaling, heap charging and
// provenance. `#(…)` literals carry no flag and a non-literal ADict has no
// `literalForms`; both answer null from `lower()` and keep self-evaluating semantics.

/**
 * Post-substitution key fold for a quasiquote-instantiated `{…}` template
 * (`` `{,k v} `` — the reader admits unquote forms in key position, validated HERE
 * once the substituted value exists). Admits what `dict`'s own key fold admits:
 * `:keyword` symbols (self-evaluating — keyword-tagless-apply.md), strings, and
 * bare symbols — everything folds to the same string key. Anything else (numbers,
 * composites) is doored: these literals feed JSON-shaped tool args, keys ARE strings.
 */
function foldSubstitutedDictKey(v: SchemeValue): string {
  if (v instanceof AString || v instanceof ASymbol) return foldKeyName(v);
  if (typeof v === "string") return v;
  throw Object.assign(
    new Error(`dict literal key substituted a non-string value (${String(v)}) — keys must be :keywords or "strings"`),
    { code: "E-DICT-BAD-KEY" },
  );
}

// ============================================================================
// Core Evaluator
// ============================================================================

/** Map of special form names to their handlers */
const SPECIAL_FORMS: Record<string, (rest: SchemeValue, ctx: EvalContext) => EvalGenerator> = {
  // Primitive special forms
  if: evalIf,
  begin: evalBegin,
  quote: evalQuote,
  quasiquote: evalQuasiquote,
  define: evalDefine,
  "define-macro": evalDefineMacro,
  // set! — OMITTED by the purity invariant; doored in r7rs/binding (removed from
  // the special-form table so env lookup reaches the door, like delay / parameterize).
  lambda: evalLambda,
  // Core macros (implemented as special forms for performance)
  let: evalLet,
  "let*": evalLetStar,
  letrec: evalLetrec,
  "letrec*": evalLetrec, // R7RS: letrec* evaluates bindings left-to-right (same as our letrec impl)
  and: evalAnd,
  or: evalOr,
  cond: evalCond,
  case: evalCase,
  when: evalWhen,
  unless: evalUnless,
  do: evalDo,
  while: evalWhile,
  // delay / force — OMITTED by the purity invariant; doored in r7rs/control
  // (removed from the special-form table so env lookup reaches the door).
  // Error handling
  // NOTE: `raise` and `error` are deliberately NOT special forms. They are
  // defined in core.ts as R7RS procedures that walk
  // *current-exception-handlers* (§6.11). Special-form dispatch precedes env
  // lookup, so shadowing them here made the entire exception tower inert
  // (with-exception-handler / guard / raise-continuable never saw the value).
  try: evalTry,
  // parameterize — OMITTED by the purity invariant; doored in r7rs/control.
};

/**
 * Evaluate a Scheme expression.
 *
 * This is a generator that yields:
 * - TICK for periodic event loop breathing
 * - { call: generator, frame?: StackFrame } for recursive evaluation (FLAT - no stack growth!)
 * - Promises when JS returns them (for interop)
 */
export function* evaluate(code: SchemeValue, ctx: EvalContext): EvaluateGenerator {
  // Periodic tick for event loop breathing
  yield TICK;

  // Null/nil evaluates to itself
  if (code === null || code instanceof ANil) {
    return code;
  }

  // Symbol lookup. A symbol can resolve to a value OR — via the define-syntax
  // mechanism (a `let`-bound transformer returned to be bound) — a Macro/Syntax.
  if (code instanceof ASymbol) {
    const value = resolvedBindingOrThrow(ctxResolver(ctx).resolve(code), code);
    // The tap reports resolved VALUES; a macro/syntax binding has no value to
    // report, so skip it for an expander.
    if (!is_macro(value)) {
      ctx.tap?.onSymbolResolved?.(ctx.currentInvocation ?? null, code, value);
    }
    return value;
  }

  // `[…]` / `{…}` collection literals evaluate their elements in code position
  // (Clojure semantics): the term's own `lower()` (arrival/tagless-final/lower)
  // answers the cached `(vector …)` / `(dict …)` application when `code` IS a
  // reader literal currently in lowering position; every other value (a plain
  // constructed vector/dict, an R7RS `#(…)` constant, anything without the term
  // at all) answers null/undefined and falls through to ordinary evaluation
  // below. Under `quote` these nodes never reach here — evalQuote returns them
  // as data.
  const lowered = code[tf("lower")]?.();
  // `instanceof APair` both discriminates null/undefined (no lowering) AND narrows the
  // wide `SchemeValue | null` term-return to what `evaluatePair` requires — a lowering
  // is always a non-empty `(head …)` application, never anything else.
  if (lowered instanceof APair) {
    return yield* evaluatePair(lowered, ctx);
  }

  // Non-pair (atoms) evaluate to themselves
  if (!(code instanceof APair)) {
    return code;
  }

  // Tap: fire enter/exit for parsed Pairs (those carrying __location__).
  // Atoms above and macro-expansion-constructed Pairs (no location) are skipped.
  const tap = ctx.tap;
  if (tap && LOCATION in code && (!ctx.nodeFilter || ctx.nodeFilter(code))) {
    const inv = tap.enter(code, ctx.currentInvocation ?? null, ctx.tail === true);
    const childCtx: EvalContext = { ...ctx, currentInvocation: inv };
    return yield {
      call: evaluatePair(code, childCtx),
      // Pass-through (`return yield {...}`) → tail-collapsible. If the
      // evaluated form tail-calls a lambda, this slot's tap.exit is composed
      // onto the replacement so it still fires when the tail chain returns
      // (lineage stays balanced — see the trampoline tailCall war story).
      tail: true,
      // Surface the tap's substituted value (if any) back through the
      // trampoline. The provenance pipeline depends on this: `tap.exit`
      // computes provenance, clones the value with `withProvenance`, and
      // returns `{ value }` so the stamped clone — not the raw result —
      // becomes what gets bound by the surrounding `define`/`let`/arg.
      onResolve: (value) => {
        const result = tap.exit(inv, { value: value as SchemeValue });
        return result && "value" in result ? result.value : undefined;
      },
      onReject: (error) => {
        tap.exit(inv, { error });
        return undefined;
      },
    };
  }

  return yield* evaluatePair(code, ctx);
}

// ── Not-callable doors ───────────────────────────────────────────────────────
// Both application-position invariants below are MODEL-REACHABLE (a model can
// trivially write a program that quotes a call head, or over-parenthesizes),
// so per Rule 0 (assert internally, validate at the boundary) they throw plain
// doors instead of `invariant()` — an `invariant()` failure here would prefix
// every message with "Invariant failed: ", which reads like an engine bug
// rather than a program mistake, and (per the MCP-Atlas error-corpus autopsy)
// the OLD `Cannot apply object: <toString>` wording actively misled: for a
// string head it echoed the string's own content, so the door read exactly
// like a failed TOOL CALL rather than a syntax mistake.

/**
 * Shared "operator position holds a non-callable value" door — used both by
 * `nonCallableHeadError` below (a literal head that isn't a string, e.g. a
 * bare number/vector/boolean) and by the post-dispatch site at the bottom of
 * `evaluatePair` (a COMPUTED head — `((f x) y)` — or any resolved value that
 * fell through every callable check). Names the actual scheme-visible type via
 * `type()` (dict/vector/pair/number/…) rather than `typeof`, which collapses
 * every boxed value to "object". The over-parenthesization hint targets the
 * corpus's #4 class (`((call))` / Python-habit `print(x)`), the most common
 * route to a non-function value reaching call-head position.
 */
function notCallableError(value: unknown): Error {
  const looksDictShaped = value instanceof AJSObject && isDictShaped(value.source);
  const typeName = value instanceof ADict || looksDictShaped ? "dict" : type(value);
  return new Error(
    `Not callable: a ${typeName} sits in operator/call-head position, and a ${typeName} is not a function` +
      ` — common cause: extra parentheses — ((f x)) calls f's RESULT, not f; write (f x).`,
  );
}

/**
 * Door for a non-callable LITERAL sitting directly in operator position —
 * `[("open-library/get_book_by_title" :title "…")]` or `(42 :x 1)`. A quoted
 * string is the #1 MCP-Atlas corpus class: models write a tool/symbol name as
 * a STRING in call-head position (data, not a reference), and the old message
 * echoed the string's own content back, which reads like the tool itself
 * failed. Every other literal type (number, vector, boolean, …) falls through
 * to the shared `notCallableError` door above so the wording never drifts
 * between the two application-position sites.
 */
function nonCallableHeadError(first: SchemeValue): Error {
  if (first instanceof AString) {
    const content = first.valueOf();
    return new Error(
      `"${content}" is a string, not a function — a quoted name is data, it is never called. ` +
        `Drop the quotes and call the symbol directly: (${content} …).`,
    );
  }
  return notCallableError(first);
}

// `code`'s car/cdr are SchemeValues: every caller narrows via the evaluator's
// `is_pair` (→ `APair<SchemeValue, SchemeValue>`) before dispatching here, so the
// form head and tail are boxed scheme values, not the generic `unknown` slots
// `APair`'s default parameters carry for the membrane/reader boundary.
function* evaluatePair(code: APair<SchemeValue, SchemeValue>, ctx: EvalContext): EvalGenerator {
  // It's a pair - function application or special form
  const first = code.car;
  const rest = code.cdr;

  // Build frame for error reporting. The debug frame name is the lexical frame's
  // `__name__` (the LexicalScope env underlying the resolver) — `resolver.env`.
  const frame: StackFrame = {
    code,
    env_name: String(ctxResolver(ctx).env.__name__),
    procedure: first instanceof ASymbol ? symbol_name(first) : undefined,
  };

  // Tail-position context for sub-expressions of THIS call. The call head
  // (`first`) and the arguments are evaluated in NON-tail position — only
  // the final fn.apply step is the tail-relevant boundary. The special
  // forms below thread `ctx.tail` through to their structurally-terminal
  // expressions; we pass the parent's tail flag into the special handler
  // so it can do that. Arg/head evaluation strips the flag.
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Special-form dispatch. VALUE-FIRST for keywords: a head resolving to a Keyword marker
  // dispatches the kernel handler by the marker's NAME, so special-ness travels with the
  // VALUE — aliasable via `(define => lambda)`. EVERY entry in SPECIAL_FORMS is now a
  // `symbol.keyword` binding (core.ts) — the let*/letrec/letrec*/and/or hygiene batch plus
  // its define-macro/do/while/try follow-up completed the set — so this is no longer a
  // migration-in-progress fallback for un-keyworded forms. It stays for two INDEPENDENT,
  // VERIFIED-LIVE reasons (instrumented + run against the full suite + 651-row chibi
  // conformance corpus; zero incidental fallback hits, two real ones):
  //   1. BOOTSTRAP ORDERING — a capability's OWN `prelude` scheme (e.g. core.ts's
  //      `(define true #t) …`) evaluates before that capability's OWN `symbols` keyword
  //      bindings are resolvable through this resolver (phase-gated prelude scope, see
  //      kernel.ts's `assembleEnv`), so `define`'s very first uses — bootstrapping `true`/
  //      `false`/`NaN`/`single` in core.ts, and equivalently for every other BASE_PACKS
  //      prelude — hit this string-keyed fallback with `resolved === undefined`. Confirmed
  //      empirically: a temporary trace fired repeatedly during realm bootstrap even though
  //      `define` IS keyword-bound, because the keyword isn't visible yet at that instant.
  //   2. LEXICAL SHADOWING — `(let ((if 5)) (if))` resolves `if` to the shadowing value (an
  //      AExact, not a Keyword), and this fallback still matches "if" BY NAME and dispatches
  //      `evalIf` regardless — the documented, not-yet-fixed gap kernel-keyword-dispatch.
  //      test.ts calls out ("lexical shadowing of a keyword is NOT yet covered"). Confirmed
  //      empirically the same way. Removing the fallback would flip this to (correct, R7RS-
  //      faithful) un-specialing — a real behavior change, not covered by any test today —
  //      so it is left alone here; fixing it is the deferred "macro-cut pass" this comment
  //      block already named before this fix, now precisely scoped to shadowing only.
  // Resolve via the RAW binding key (`first.__name__`) — the SAME key env_get uses — so a
  // hygiene-renamed gensym head resolves identically. A gensym's __name__ is a JS symbol
  // whose string DESCRIPTION (what symbol_name returns) differs from the symbol key the
  // hygiene engine bound it under; looking up by the description missed, fell through to
  // application, and tried to CALL the resolved Keyword. symbol_name (the string) stays the
  // SPECIAL_FORMS fallback key for a non-keyword-resolving head (bootstrap / shadowing above).
  if (first instanceof ASymbol) {
    const resolved = ctxResolver(ctx).lookup(first.__name__);
    const handler = resolved instanceof Keyword ? SPECIAL_FORMS[resolved.name] : SPECIAL_FORMS[symbol_name(first)];
    if (handler) {
      // Pass-through dispatch — the special form's result IS this Pair's
      // result. Mark tail so a tail call emerging from the special form's
      // terminal expression collapses this frame too (the special handler
      // threads `ctx.tail` to its own structurally-terminal sub-expression).
      return yield { call: handler(rest, ctx), frame, tail: true };
    }
  }

  // If first is a pair, evaluate it to get the function. The operator position
  // admits a value (procedure) OR — when the head is a symbol resolving to one —
  // a `Macro`/`Syntax` expander; the dispatch below splits them with
  // `is_function`/`is_macro`. A computed head (pair) or a literal head can only
  // be a value, since macros are not first-class.
  let fn: SchemeValue | Macro | Syntax;
  if (first instanceof APair) {
    fn = yield { call: evaluate(first, nonTailCtx), frame };
    if (is_promise(fn)) {
      fn = yield fn;
    }
  } else if (first instanceof ASymbol) {
    fn = resolvedBindingOrThrow(ctxResolver(ctx).resolve(first), first);
    // Fire the tap here too — this is the call-head fast path that bypasses
    // `evaluate()`. Without this, tracers miss the resolved value of every
    // function name (e.g., `(my-hof xs)` never reports `my-hof`'s lambda). The
    // tap reports resolved VALUES, so skip it for a macro/syntax operator.
    if (!is_macro(fn)) {
      ctx.tap?.onSymbolResolved?.(ctx.currentInvocation ?? null, first, fn);
    }
  } else {
    if (!is_function(first) && !is_callable_value(first)) {
      throw nonCallableHeadError(first);
    }
    fn = first;
  }

  // Check what kind of callable we have. A callable VALUE (ANativeProcedure — a first-class
  // AValue, not a bare fn) enters the same block: it shares the arg-eval / bounce plumbing,
  // and only the invocation primitive below branches (its apply term vs Reflect.apply).
  if ((is_function(fn) || is_callable_value(fn) || is_applyable(fn)) && !is_macro(fn)) {
    const argsResult = yield { call: evaluateArgs(rest, nonTailCtx) };
    // evaluateArgs's generator return type is `unknown` at this yield site; narrow.
    invariant(Array.isArray(argsResult), "evaluateArgs must return array");
    const args = argsResult;

    // Thread the dynamic call site so user lambdas invoked synchronously
    // from native JS (e.g. map/filter) pick up THIS Pair's invocation as
    // their parent rather than the lexical one captured at lambda creation.
    //
    // Two-pronged: (a) module-level holder for synchronous HOF iteration,
    // (b) per-lambda wrapper for native HOFs that recurse via promises
    // (reduce/fold/find call `maybeThen().then(callback)`, which fires from
    // a microtask AFTER finally restores the holder). Each wrapped lambda
    // re-installs its dynamic site on every invocation, so iter N+1 from
    // a microtask still sees the right parent.
    //
    // canBounce: opt fn into the bounce protocol if it's a Scheme lambda (an ALambda —
    // includes named-let's loop binding, reverse-membrane-for-callables.md §3 step 1).
    // Threaded as the apply term's third argument; the lambda's runner reads it and
    // returns a Bounce token instead of spawning a fresh `run(...)`. This used to be a
    // save/restored MODULE-LEVEL flag (`_canBounce`) because named-let's loopFn read it
    // as an ambient JS closure variable — now that every lambda receives `canBounce` as
    // an explicit runner argument, it's a plain per-call local; nothing reads it
    // ambiently, so there is nothing to save or restore. JS HOFs that call back into a
    // lambda go through `applyCallback` instead, which always passes canBounce=false.
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = currentDynamicCallSite();
    setDynamicCallSite(dynSite);
    const canBounce = is_lambda(fn);
    const __savedRunEnv = _currentRunEnv;
    // The rosetta membrane's env back-channel (llm-plane-arrival-env/prompt.ts reads
    // `currentRunEnv()` under a ctx-less `apply`). The meter/strict run-state that
    // once also rode holders here now travels on `ctx.runCtx` / the operand ctx.
    _currentRunEnv = ctxResolver(ctx).env;
    const wrappedArgs = wrapLambdaArgs(args, dynSite);
    let result: SchemeValue;
    try {
      // A callable VALUE is invoked through the seam (its apply term, `runCtx` threaded
      // explicitly); a bare fn keeps the legacy `this: CallCtx` apply. No `this`-smuggling on
      // the value path.
      // A callable VALUE dispatches through its apply term with the computed `canBounce` (an
      // ALambda in tail position hands back a Bounce for the trampoline — TCO; an ANativeProcedure
      // ignores canBounce). NOT `applyCallback`, which forces canBounce=false (the HOF-callback
      // contract). A bare fn keeps the legacy `this: CallCtx` apply.
      result =
        is_callable_value(fn) || is_applyable(fn)
          ? (fn[tf("apply")](wrappedArgs, ctx.runCtx ?? CONSTANT_CTX, canBounce) as SchemeValue)
          : // The outer gate (is_function || is_callable_value || is_applyable) already
            // guarantees one of the three; the ternary above excludes the latter two, so
            // only the plain-JS-function case remains here.
            (Reflect.apply(
              fn as (...args: unknown[]) => unknown,
              makeCallCtx(ctx.runCtx, ctx.currentInvocation as InvocationLike | undefined),
              wrappedArgs,
            ) as SchemeValue);
    } finally {
      setDynamicCallSite(__savedDynamicCallSite);
      _currentRunEnv = __savedRunEnv;
    }

    // Bounce result — the callee was a Scheme lambda speaking the protocol
    // and handed back its body generator instead of running it itself.
    // Route it through the trampoline:
    //  - In tail position: yield a `tailCall` so the trampoline COLLAPSES
    //    the whole tail tower (this frame plus all enclosing pass-through
    //    frames) and the host stack stays flat across the recursion.
    //  - Otherwise: push the body as a normal sub-call, but mark it `tail`
    //    because `return yield { call }` is itself pass-through — so a tail
    //    call from INSIDE the callee's body still collapses up to (but not
    //    through) whatever non-tail consumer sits beneath THIS frame (e.g.
    //    the evaluateArgs collector when the callee is an argument). The
    //    callee's own body runs in tail context, so its terminal call
    //    collapses naturally.
    if (is_bounce(result)) {
      if (ctx.tail) {
        return yield { tailCall: { generator: result.generator, frame } } as unknown as SchemeValue;
      }
      return yield { call: result.generator, frame, tail: true };
    }

    // Q11a (docs/PROVENANCE-PLAN.md) — the retrospective-stream emission hook, flag-
    // gated OFF by default (see provenance-hooks.ts's header for why this is the port
    // site: no rosetta brand exists to switch on here, so the hook itself re-checks
    // `ctx.currentInvocation.isProvenancePoint` — the eager oracle's own mint signal —
    // after settlement, and no-ops immediately unless a coordinate/sink is installed).
    // Detached from `result`: never wraps, replaces, or awaits it, so this call is a
    // single boolean read (provably inert) whenever the flag is off.
    notePotentialRosettaExit(ctx.currentInvocation, result);

    if (is_promise(result)) {
      return yield result;
    }
    return result;
  }

  if (is_macro(fn)) {
    const useResolver = ctxResolver(ctx);
    const evalArgs = {
      // The macro's `this` is the use-site LEXICAL frame (a define-macro fexpr body
      // runs with `env` as `this`; see Macro.invoke). Sourced FROM the resolver so
      // `env`/`resolver` stay structurally synced, not coincidentally equal.
      env: useResolver.env,
      // The use-site resolver — the def-time Resolver a `Syntax` captures is what
      // hygiene actually consults; this is the call-site one.
      resolver: useResolver,
      dynamic_env: ctx.dynamic_env,
      use_dynamic: ctx.use_dynamic,
      error: ctx.error,
      // So the syntax-rules expander reads its `debug` option from ctx.
      runCtx: ctx.runCtx,
    };

    // is_macro narrowed fn to Macro | Syntax; the is_syntax branch below splits them
    // by their HONEST return shapes: Syntax.expand -> { expr, scope } (a form +
    // hygiene scope), Macro.invoke -> SchemeValue (a form). No flag toggles the shape.
    //
    // `is_syntax(fn) ? code : rest`: syntax-rules patterns carry a keyword slot as
    // their FIRST element, so the matcher (extract_patterns) needs the FULL form
    // (`code`); define-macro fexprs want the keyword-stripped `rest`. Passing `rest`
    // to both makes the keyword consume the first arg — an off-by-one that breaks
    // fixed-arity matching, arity discrimination, and ellipsis (dropped element 0).
    // See src/__tests__/syntax-rules-arity-offbyone.test.ts.
    //
    // STILL OPEN (tracked as the vector-pattern `it.fails` block): syntax-rules
    // VECTOR patterns need a SchemeVector unwrap in matcher/expander; dotted-tail-
    // after-ellipsis template, `_`-wildcard binding, let-syntax recursive hygiene.
    //
    // syntax-rules (Syntax) is FORM-RETURNING: `expand` returns `{ expr, scope }`
    // (the transcribed form + hygiene scope) with NO nested evaluation; the form is
    // yielded into THIS flat trampoline in tail position. Evaluating the expansion
    // in a NESTED `run()` instead would mean a tail-looping macro nests one host-
    // stack frame per iteration and overflows. Form-returning keeps everything flat,
    // so a syntax-rules macro in tail position gets the SAME O(1) TCO as a special
    // form (a transformer is Exp->Exp; it must never evaluate inside itself).
    if (fn instanceof Syntax) {
      const expanded = fn.expand(code, evalArgs);
      // The expansion evaluates in its hygiene scope (`expanded.scope`) but resolves
      // builtins through the run's capability base — thread evalArgs.resolver's
      // capabilities, NOT a glass re-derivation from the (post-cut: null-rooted) merge
      // env. Under glass same globalRoot ⇒ byte-identical. (D3)
      return yield {
        call: evaluate(expanded.expr, {
          ...ctx,
          resolver: new Resolver(expanded.scope, evalArgs.resolver.capabilities),
        }),
        tail: true,
      };
    }

    // ── define-macro (fexpr): invoke returns a FORM; evaluate it (already tail-proper) ──
    let expansion = fn.invoke(rest, evalArgs, false);

    if (is_promise(expansion)) {
      expansion = yield expansion;
    }

    // Data-marked expansion needs no further evaluation.
    if (is_data_marked(expansion)) {
      return expansion;
    }

    // Recursively evaluate the macro expansion. The expansion takes the
    // PARENT's tail flag — a macro invocation in tail position should make
    // its expansion run in tail position too, otherwise rewriting any TCO-
    // critical form through a macro (e.g. `when` rewritten as `(if test
    // body)`) silently loses TCO at the rewrite boundary. Mark pass-through
    // (tail) so the collapse reaches through this dispatch; the post-yield
    // promise check only runs for non-tail-call results (a tail call is
    // never a JS promise), so collapsing past it is safe.
    let result = yield { call: evaluate(expansion, ctx), tail: true };
    if (is_promise(result)) {
      result = yield result;
    }
    return result;
  }

  // Nothing above matched — fn is not a callable value kind. (A borrowed JS
  // function is no longer callable: it crosses the membrane as #void, so it
  // never reaches here as a call head.)
  throw notCallableError(fn);
}

/**
 * Evaluate a list of arguments.
 * Uses iterative approach with flat trampolining.
 */
function* evaluateArgs(rest: SchemeValue, ctx: EvalContext): Generator<unknown, SchemeValue[], SchemeValue> {
  const args: SchemeValue[] = [];
  let node: SchemeValue = rest;

  while (node instanceof APair) {
    // TypeScript knows node is Pair after the is_pair check
    // FLAT: yield { call } instead of yield*
    let arg = yield { call: evaluate(node.car, ctx) };

    // If it's a promise, yield it
    if (is_promise(arg)) {
      arg = yield arg;
    }

    args.push(arg);
    node = node.cdr;
  }

  invariant(node instanceof ANil || node === null, "Syntax Error: improper list in function call");

  return args;
}

// ============================================================================
// High-level API
// ============================================================================

/**
 * Execute Scheme code and return the result. The low-level evaluator entry (the
 * production seam is generator-exec's `exec`, which assembles the capability base).
 * COMPLEX tier (two-tier-exec-api §3, internal) — returns one boxed SchemeValue,
 * never unwrapped.
 *
 * Bootstrap bridge: `EvalContext.resolver` is the single binding channel, but this
 * entry stays ergonomic for embedders/low-level tests that hand a bare `env` — when
 * `resolver` is absent it synthesizes a GLASS `Resolver` over that env (the same
 * glass bridge generator-exec uses for a custom env), byte-identical to the removed
 * `ctxResolver` env-fallback. With `resolver` already set, `env` is ignored.
 */
export function exec(code: SchemeValue, ctx: EvalContext & { env?: Environment }): Promise<SchemeValue> {
  const resolver = ctx.resolver ?? (ctx.env ? new Resolver(ctx.env) : undefined);
  invariant(resolver, "exec: ctx must carry a resolver or a bootstrap env");
  // A top-level form evaluates to a value, never a bare expander — seal it.
  return run(evaluate(code, { ...ctx, resolver }), { signal: ctx.signal }).then(expectValue);
}

export { ArrivalError } from "../errors.js";

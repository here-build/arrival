/**
 * Tree-walking Scheme evaluator, driven by a FLAT TRAMPOLINE: `run()` holds an
 * explicit stack of generators, so recursion in the evaluated program never grows
 * the host call stack. A tail-recursive Scheme loop runs in O(1) host stack and
 * ~100x fewer promise allocations than a recursive-generator or promise-chained
 * evaluator; JS interop and cancellation are preserved (see ABORT / BUDGET).
 *
 * Lineage: trampolined style (Ganz, Friedman & Wand, "Trampolined Style", ICFP
 * 1999); generator/CPS definitional interpreter (Reynolds, "Definitional
 * Interpreters for Higher-Order Programming Languages", 1972). Proper tail calls
 * per R7RS §3.5 (Clinger, "Proper Tail Recursion and Space Efficiency", PLDI
 * 1998); delay/force promises per R7RS §4.2.5.
 *
 * ── FLAT TRAMPOLINE ─────────────────────────────────────────────────────────
 * `evaluate`/`evaluatePair` and every special form are generators. They yield:
 *   { call: gen }   push `gen` as a sub-call (flat — no host-stack growth)
 *   { tailCall: … } replace the current slot (TCO — see BOUNCE PROTOCOL)
 *   promise         a JS-interop / rosetta return; the runner awaits it
 *   TICK            an event-loop / abort / budget checkpoint
 * A `{ call }` may carry `frame` (error trace), `onResolve`/`onReject` (tap +
 * provenance transforms fired on the sub-call's settle), and `tail` (marks the
 * slot pass-through, so a bubbling tail call collapses through it).
 *
 * ── TAIL PROPAGATION (R7RS §3.5) ────────────────────────────────────────────
 * `ctx.tail` is true when this expression's value is the enclosing lambda/let
 * body's value. Only the structurally-TERMINAL sub-expression inherits it:
 * begin's last expr, if's chosen arm, and/or's last expr, cond/case/when/unless
 * matched body, let-family body, do's result. Predicates, binding RHS, call head
 * and arguments, and every non-last begin/and/or expr STRIP it (`{ ...ctx, tail:
 * false }`). A special form threads `ctx.tail` to its terminal expr and marks that
 * `{ call }` `tail: true`; body comments name only where a form DEVIATES.
 *
 * ── BOUNCE PROTOCOL (TCO) ───────────────────────────────────────────────────
 * A Scheme lambda invoked in tail position must not spawn a fresh `run()` Promise
 * per call (that grows the host stack one await per recursion and overflows V8
 * from inside await machinery, before any TICK can rescue it). Instead: the
 * calling `evaluatePair` passes `canBounce = is_lambda(fn)` as the apply term's
 * third argument; a lambda runner with `canBounce` hands back a `Bounce` (its body
 * generator) instead of running it; the trampoline COLLAPSES the tail tower (the
 * yielding slot + all consecutive `tail: true` slots) and pushes the body onto the
 * first real consumer. HOF callbacks invoke through `applyCallback`, which always
 * passes `canBounce = false`, so map/filter/reduce stay off the protocol.
 *
 * ── CONTROL-FLOW PROVENANCE (spec §5.3) ─────────────────────────────────────
 * A branch result's lineage must carry only union(predicate, chosen arm) — never
 * an unchosen arm. Two channels enforce it: the tap reads `inv.children` (only
 * entered arms fired enter/exit — free); the value flowing into an env binding is
 * stamped by `controlFlowResolve`, attached as the arm's `onResolve` so it fires
 * whether the arm tail-collapsed or resumed a plain value. Attached ONLY when the
 * predicate carries provenance — otherwise a deep tail loop through if/cond/when
 * retains one composed closure per iteration, breaking O(1) space.
 *
 * ── HYGIENE / AUXILIARY KEYWORDS ────────────────────────────────────────────
 * `else` / `=>` / `catch` / `finally` are matched by `ASymbol.literal()`, never
 * `symbol_name()`: inside a user syntax-rules template these free identifiers are
 * hygiene-renamed to gensyms whose JS-Symbol description ("#:else") is not "else".
 * `.literal()` reads the ORIGINAL source name the renamer stamped, so auxiliary
 * keywords survive hygiene. Head dispatch resolves by the RAW key (`first.__name__`)
 * for the same reason (see the SPECIAL_FORMS dispatch in `evaluatePair`).
 *
 * ── ABORT / BUDGET ──────────────────────────────────────────────────────────
 * `ctx.signal` (external cancel) and `run`'s `budgetMs` (internal CPU bound) are
 * checked at the TICK cadence (every 1000 iters / 5ms), so they cost nothing on
 * the hot path yet bound `(let loop () (loop))` to one cadence unit. A promise
 * PARKED at the interop await can't tick — `raceAbort` makes that await
 * signal-aware. Budget overrun throws `ArrivalError(/budget/)`; abort throws
 * `signal.reason ?? DOMException("aborted","AbortError")`.
 *
 * ── RUN STATE ───────────────────────────────────────────────────────────────
 * `ctx.runCtx` (RunContext, minted by exec) carries run-CONSTANT state — strict
 * mode, heap meter — threaded as data through every `{ ...ctx }` spread.
 * `ctx.resolver` is the sole binding/resolution + frame channel (there is no
 * `ctx.env`; the frame env is `resolver.env`). `globalThis.__arrivalRunResolver`
 * is the apply-time back-channel for readers that can't take a ctx (the rosetta
 * membrane's env reader; `require`'s module-eval resolver) — see its own doc.
 *
 * Purity omissions: `set!`, `delay`/`force`, `parameterize` are NOT special forms
 * — removed from the table so env lookup reaches their educational door in the
 * r7rs packs. Lexical rebinding is incompatible with per-value lineage: a rebind
 * severs the binding-site lineage every value carries.
 *
 * Bracket-grammar superset (`(let [a 1] …)` etc.): see the labeled section at
 * `normalizeBindings` / `normalizeClause`; executable spec in
 * src/reader/__tests__/polyglot/macro-special-brackets.spec.ts.
 */

import invariant from "tiny-invariant";
import { theVoid } from "../values/primitives/AVoid.js";
import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
import { AValue, unionProvenance } from "../values/primitives/AValue.js";
import { bindValue, AmbientRuntime, type AmbientValue, isAmbientRuntime } from "../env/AmbientRuntime.js";
import { unboundVariableError } from "../unbound-variable.js";
import {
  ArrivalError,
  BudgetExceededError,
  type ErrorClass,
  EvalError,
  isHostRuntimeBug,
  NotCallableError,
  R7RSError,
  ResolvedNonValueError,
  SpecialFormShapeError,
  type SourceLocation,
} from "../errors.js";
import { is_callable, is_false, is_function, is_macro, is_promise } from "./guards.js";
import { is_applyable, is_callable_value, is_lambda } from "../values/value-guards.js";
import { applyCallback, ALambda, type CallResult } from "../values/primitives/ACallable.js";
import { makeCallCtx } from "../common/symbols/_bake.js";
import type { InvocationLike } from "../membrane/rosetta.js";
// Runtime edge for the bare-fn boxing seam below — cycle-benign: rosetta.ts never
// imports the evaluator (its evaluator-adjacent needs ride leaf modules).
import { jsToScheme } from "../membrane/rosetta.js";
import { maybeThen } from "../utils/promises.js";
import {
  currentDynamicCallSite,
  setDynamicCallSite,
  withDynamicCallSite,
  type Invocation,
} from "./dynamic-call-site.js";
// The retrospective-stream emission hook. Flag-gated
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
import { CLASS, DATA, LOCATION } from "../well-known-symbols.js";
import { AListAlike, type SchemeBounceMarker, type SchemeValue } from "../values/types.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { Keyword } from "../values/Keyword.js";
import { AString } from "../values/primitives/AString.js";
// AJSObject here is ONLY the genuinely-foreign borrowed-JS wrapper face (notCallableError's
// dict-shaped-borrow check below). The `{…}` dict-literal NODE face — its detection
// (isDictLiteral) and the DictLiteralNode type — is ADict's own algebra.
import { AJSObject } from "../membrane/AJSObject.js";
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
// implementation defines its shape; the evaluator only threads it through as the
// parent of nested invocations), imported type-only from `./dynamic-call-site.js`.

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
   * ({@link AmbientRuntime} storage). Both exec entries and every frame the evaluator
   * builds set it; the macro seam stages it through {@link MacroInvokeContext}. There
   * is no coexisting `env` field — the frame env is reached ONLY as `resolver.env`.
   * Optional because an external caller could still hand a bare `EvalContext`; the
   * evaluator's own frame sites always set it.
   */
  resolver?: Resolver;
  dynamic_env?: AmbientRuntime;
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
   * at the next iteration boundary (the 1000-iter / 5ms TICK cadence in `run()`).
   * Composes with Web APIs at
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
   * Tail-position flag (R7RS §3.5). True when this expression's value is the enclosing
   * lambda/let body's value — a procedure call here is a tail call and must not grow the
   * host stack. Structural propagation rule: preamble TAIL PROPAGATION. Read at
   * evaluatePair to choose `{ call }` (push) vs `{ tailCall }` (replace slot) for a
   * Scheme lambda.
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
   * flat `this.runCtx`. Optional so the few `EvalContext` literals that omit the
   * run-level options stay valid; the sole origin is `exec()` in generator-exec.ts.
   */
  strict?: boolean;
  /**
   * The per-run context (minted by `exec()`; see `run/RunContext`). Carries
   * hermetic run-state — strict mode, the heap meter — as DATA threaded through
   * evaluation; the sole live channel for that state. Propagated structurally like
   * `strict` (the `{ ...ctx }` spreads).
   *
   * REQUIRED: both mint sites (generator-exec.ts's `exec`/`execExpr`, via
   * `makeRunContext`) always set it, and every derived `EvalContext` is a
   * `{ ...ctx }` spread — so an absent `runCtx` could only mean a hand-built literal
   * skipping the real run, never a legitimate state. Required rather than
   * `ctx.runCtx ?? CONSTANT_CTX`-defaulted because that default silently drops the
   * live run-state (strict/meter) on any path that forgets to thread ctx.
   */
  runCtx: RunContext;
}

/** Options for the trampoline runner (`run`). */
interface RunOptions {
  /**
   * Execution-budget signal; see `EvalContext.signal` for the cancellation rationale.
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

// The dynamic call-site holder lives in `./dynamic-call-site.js` (imported above).
// evaluatePair sets it just before invoking a callable; evalLambda / named-let read
// it when building the body ctx, so a lambda body runs with the DYNAMIC parent
// invocation (the call site), not the LEXICAL one captured at lambda-creation.
// Without it, a native JS HOF (map/filter/reduce) iterating a user lambda would
// give the body the lexical parent (the enclosing define), severing the parent
// chain at the HOF boundary — DNF path reconstruction needs the call-site parent
// to surface HOF iteration via parent-walking.

/**
 * Run-scoped CURRENT RESOLVER, set to `ctxResolver(ctx)` at the apply boundary
 * alongside `_dynamicCallSite` (saved + restored in the surrounding finally). Two
 * readers: (1) the rosetta MEMBRANE's env back-channel (`currentRunEnv()` =
 * `.env`, the resolver's lexical frame) — a rosetta impl running under a ctx-less
 * `apply` (llm-plane-arrival-env/prompt.ts) reads it to evaluate an `s/…` schema
 * DSL and reach the infer capability; (2) `(require …)`'s module-eval seam
 * (`currentRunResolver()`), which needs the WHOLE composed resolver — under the
 * cut, builtins live on the capability base, not the lexical frame's `__parent__`
 * chain. `runCtx` cannot supply either — it carries run-CONSTANT data, not an
 * env/resolver. TODO(ctx-elimination): the heap-meter used to ride the operand's ctx
 * (`operand.ctx.heapMeter`) — AValue no longer carries one at all (see AValue.ts's
 * ctx-removal note); this holder is not that either.
 *
 * Why module-level: readers are variadic / HOF builtins (`filter`/`join`/`reverse`/
 * `apply`, and `to_array` reached through them) whose arity a trailing `ctx` would
 * corrupt. Single-threaded JS makes the holder safe; nesting is handled by the
 * save/restore. The meter is found by walking `__parent__` from this env, so a
 * child-frame env still resolves the run's installed meter.
 */
declare global {
  // eslint-disable-next-line no-var
  var __arrivalRunResolver: Resolver | undefined;
}
// PROCESS-GLOBAL, not module-local: a bundler can load evaluator.ts twice (Vite dev
// serves it raw via /@fs AND prebundles a second copy inside
// `.vite/deps/@here__build_arrival-chain.js`; esbuild/wrangler can dup across
// subpaths), giving each copy its own holder — then `exec` (one copy) publishes the
// resolver into ITS holder while the `(require …)` verb (the other copy, via
// loader.ts's `currentRunResolver`) reads an empty one and doors with "no run
// resolver reachable". Pinning it on `globalThis` shares one holder across copies;
// single-threaded JS keeps the save/restore nesting safe.

/** The run's current env at apply time — the published resolver's lexical frame.
 *  Read by `to_array`'s heap-meter lookup (env/pack-helpers.ts) in place of the
 *  erased env-as-`this`. */
export const currentRunEnv = (): AmbientRuntime | undefined => globalThis.__arrivalRunResolver?.env;

/**
 * The run's current COMPOSED resolver at apply time — the same save/restore holder
 * as {@link currentRunEnv}, publishing the whole `Resolver` instead of only its
 * lexical frame. Needed by `(require …)` (src/loader/): a required module's forms
 * must evaluate through the SAME scope+capability composition as the requiring
 * program. Under the cut the lexical frame is null-rooted and builtins live on the
 * resolver's capability base — an env-only back-channel loses that half, so a
 * module rebuilt from `currentRunEnv()` alone could not see the stdlib
 * (`string-append` unbound). Glass callers see a resolver whose scope and
 * capabilities wrap the same base-linked env — byte-identical resolution.
 */
export const currentRunResolver = (): Resolver | undefined => globalThis.__arrivalRunResolver;

/**
 * Re-install `_dynamicCallSite` on every invocation of a lambda VALUE passed as
 * an arg. Native HOFs like reduce/fold/find recurse via promise chains
 * (`maybeThen(fn(acc, x)).then(recurse)` in env/srfi/srfi-1.ts's HOFs), so iteration
 * N+1 fires from a microtask AFTER the outer evaluatePair's finally has
 * restored the holder. Without per-call re-install, the lambda body for
 * iteration ≥1 would inherit the WRONG dynamic parent.
 *
 * Every lambda-shaped argument reaching here is a real `ALambda` value.
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

/** Re-install `_dynamicCallSite` on each invocation of a lambda VALUE passed as a HOF arg.
 *  Delegates to the original's apply term (its runner is private) inside
 *  {@link withDynamicCallSite}; the holder is read in the runner's synchronous prologue, so
 *  the finally-restore never races the bounced body. */
function wrapLambdaValue(lambda: ALambda, dynSite: Invocation | undefined): ALambda {
  const wrapped = new ALambda({
    name: lambda.name,
    arity: lambda.arity,
    scope: lambda.scope,
    runner: (values, runCtx, canBounce) =>
      withDynamicCallSite(dynSite, () => lambda[tf("apply")](values, runCtx, canBounce)),
  });
  wrapped.__name__ = lambda.__name__;
  wrapped.__params__ = lambda.__params__;
  return wrapped;
}

/**
 * A bare JS function value reaching the evaluator's define-naming step. Its one
 * producer is the legacy `env.defineRosetta` authoring arm (capability.ts), which
 * binds a bare host function into value space; `(define name <expr>)` evaluating to
 * one still wants its `__name__`/`__params__` stamped for debugging. Every
 * scheme-authored lambda is a real `ALambda`, not this shape.
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
  // The data mark is the `__data__` SYMBOL (Symbol.for("__data__")), set by quote() —
  // check it by symbol, not a `"__data__" in o` string key. A normal `(quote x)` hits
  // evalQuote and skips this macro path, but a hygiene-gensym'd `#:quote` resolves to the
  // quote Macro and DOES take it; a string-key miss would re-evaluate quoted data inside
  // syntax-rules expansions.
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
 * `Resolver.resolve`/`lookup` return an `AmbientValue | undefined`. Three of
 * those members can never be carried by the evaluator and are thrown with a clear
 * message: an unbound name (`undefined`), an `AmbientRuntime` (a scope is neither a
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
function resolvedBindingOrThrow(binding: AmbientValue | undefined, sym: ASymbol): SchemeValue | Macro | Syntax {
  if (binding === undefined) {
    // Structurally unreachable via the ordinary `Resolver.resolve` call path (it
    // throws `unboundVariableError` itself before ever returning `undefined` —
    // see `eval/Resolver.ts#resolveSynth`), but kept as a defensive throw for any
    // other caller of this narrowing fn. No vocabulary passed — this branch has no
    // resolver in reach, so it stays the plain wall (suggestions live at the real
    // throw sites, which enumerate the chain they actually missed against).
    throw unboundVariableError(symbol_name(sym));
  }
  if (isAmbientRuntime(binding)) {
    throw new ResolvedNonValueError(symbol_name(sym), "environment");
  }
  if (binding instanceof RegExp) {
    throw new ResolvedNonValueError(symbol_name(sym), "regexp");
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

// ============================================================================
// Symbol name extraction
// ============================================================================

function symbol_name(sym: ASymbol): string {
  const name = sym.__name__;
  return typeof name === "symbol" ? name.description || "" : name;
}

// ============================================================================
// AmbientRuntime lookup without lips runtime dependency
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
 * This does NOT cancel the underlying host operation — it only returns control to the
 * trampoline, which throws the abort reason and unwinds. Cancelling the upstream must be
 * wired at the operation itself (`fetch(url, { signal })`, or the MCP SDK's
 * `client.callTool(params, schema, { signal })`); arrival-manifold forwards this exact
 * signal there (bind.ts's `rosettaDef` → `RemoteTool.invoke`; server.ts's `toBoundServer`
 * → `client.callTool`), so an aborted eval tells a real upstream MCP server to stop. An
 * operation that accepts no signal (or a ctx-less direct-JS caller) is merely abandoned —
 * its eventual settlement is swallowed (the inline `.then` keeps a rejection handler) so it
 * never surfaces as an unhandled rejection.
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

/** The generic wrap `failAndWrap` mints for any throw that wasn't already an
 *  `ArrivalError` — a raw non-Error raised value (R7RS `raise` accepts ANY object),
 *  a foreign host Error, or a tiny-invariant throw. `"arrival/error-category"`
 *  forwards from `cause` when it's already self-classifying (an R7RS `(error …)`
 *  raise: `cause instanceof R7RSError` ⇒ `"user-error"`), else `"other"` — the
 *  same cause-forwarding shape as `ArrivalError`'s own `get stack()` above. */
class ForeignThrowError extends ArrivalError {
  static [CLASS] = "foreign-throw-error";
  public readonly name = "ForeignThrowError";
  readonly "arrival/error-category": ErrorClass;

  constructor(message: string, schemeStack: StackFrame[] = [], cause?: Error) {
    super(message, schemeStack, cause);
    this["arrival/error-category"] = cause instanceof R7RSError ? "user-error" : "other";
  }
}

// ============================================================================
// Flat Trampoline Runner
// ============================================================================

/**
 * Drive a generator-based evaluator to completion on the FLAT TRAMPOLINE (preamble):
 * an explicit generator stack (no host-stack growth), awaiting yielded promises,
 * yielding to the event loop every ~5ms, tracking frames for error reporting, and
 * honoring the optional AbortSignal / budget at TICK boundaries.
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
    throw new BudgetExceededError(`execution budget exceeded (${budgetMs}ms)`, []);
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
      const wrapped = new ForeignThrowError(String(error), frames, undefined);
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
    throw new ForeignThrowError(message, frames, error);
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
      // however long that took. With no signal there is no wrapper
      // promise and no listener — a plain await. A raced abort rejects with the
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
            throw new BudgetExceededError(
              `execution budget exceeded (${budgetMs}ms)`,
              frameStack.filter((f): f is StackFrame => f !== undefined),
            );
          }
          // setTimeout (macrotask), not a microtask: only a macrotask yields the event
          // loop far enough for host interceptors / I/O to run between steps.
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
      ? new ForeignThrowError(error.message, frames, error)
      : new ForeignThrowError(String(error), frames, undefined);
  }
}

export default run;

// No sync runner (rejected alternative): the env carries promise-returning callables
// (rosettas, `infer`, host fetch), so a sync trampoline could honor only pure scheme —
// the first yielded promise would throw "Unexpected promise," a foot-gun that works for
// trivial expressions and fails on anything real. The abort budget compounds it: it
// rides the event-loop yield cadence inside `run()`, so a sync path couldn't cancel at
// the same granularity. One async path, paying the microtask cost everywhere, beats a
// half-working escape hatch that drifts from the async semantics it mirrors.

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
 * which the spec accepts as reduced tail-loop fidelity. The trampoline applies
 * the returned hook before sending the arm value back, so the arm handlers
 * (evalIf/cond/case/when/unless) just return `armResult` unstamped.
 */
function controlFlowResolve(predicate: SchemeValue): ((value: unknown) => unknown | undefined) | undefined {
  if (!(predicate instanceof AValue) || predicate.provenance.size === 0) return undefined;
  return (value: unknown): unknown | undefined => {
    const stamped = restrictControlFlowProvenance(predicate, value as SchemeValue);
    return stamped === value ? undefined : stamped;
  };
}

/** `(if test then else?)` — chosen arm inherits tail; predicate strips it (see
 *  preamble TAIL PROPAGATION + CONTROL-FLOW PROVENANCE). */
function* evalIf(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "if", "missing test expression");

  const testExpr = rest.car;
  const restAfterTest = rest.cdr;

  SpecialFormShapeError.invariant(restAfterTest instanceof APair, "if", "missing then expression");

  const thenExpr = restAfterTest.car;
  const elseRest = restAfterTest.cdr;
  const elseExpr = elseRest instanceof APair ? elseRest.car : undefined;

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(testExpr, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  const onResolve = controlFlowResolve(testResult);
  const inTail = ctx.tail === true;
  if (is_false(testResult)) {
    if (elseExpr !== undefined) {
      return yield { call: evaluate(elseExpr, ctx), tail: inTail, onResolve };
    }
    return theVoid; // no else branch
  } else {
    return yield { call: evaluate(thenExpr, ctx), tail: inTail, onResolve };
  }
}

/**
 * `(begin expr*)` — last expr inherits tail, earlier ones strip it (preamble TAIL
 * PROPAGATION). THE load-bearing primitive: evalLambda wraps every lambda body in
 * begin, so this routing is what makes `(define (loop n) (loop (- n 1)))`
 * tail-recursive. Earlier exprs MUST strip tail — a `tail:true` on a non-last expr
 * would let a Scheme lambda tail-replace this slot mid-body, breaking sequential
 * semantics (not merely a discarded value).
 */
function* evalBegin(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let result: SchemeValue = theVoid;
  let node = rest;

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (node instanceof APair) {
    const isLast = node.cdr instanceof ANil || !(node.cdr instanceof APair);
    const inTail = isLast && ctx.tail === true;
    const exprCtx = isLast ? ctx : nonTailCtx;
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
  SpecialFormShapeError.invariant(rest instanceof APair, "quote", "missing argument");
  return rest.car;
}

/**
 * Handle 'quasiquote' special form: (quasiquote datum)
 * Supports unquote and unquote-splicing
 */
function* evalQuasiquote(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "quasiquote", "missing argument");
  // Strip tail: unquoted sub-expressions are operands to implicit list
  // construction, so an inner `(unquote (lambda-call))` must not tail-replace this
  // slot before the surrounding structure builds.
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
        throw new EvalError(`duplicate dict literal key :${name} after quasiquote substitution — each key may appear once`, {
          code: "E-DICT-DUP-KEY",
        });
      }
      seen.add(name);
      // foldSubstitutedDictKey only accepts AString/ASymbol/plain-string (else throws
      // E-DICT-BAD-KEY above) — a bare string form is wrapped so the stored key is
      // always a real DictKey object, keeping whatever provenance it already has.
      const key: DictKey =
        keyForm instanceof ASymbol || keyForm instanceof AString ? keyForm : new AString(name);
      pairs.push([key, processed[i + 1]]);
    }
    return new ADict(pairs);
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
        SpecialFormShapeError.invariant(item.cdr instanceof APair, "unquote-splicing", "missing argument");
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
          SpecialFormShapeError.invariant(spliced instanceof ANil, "unquote-splicing", "expected list");
        }
        continue;
      }
      out.push(yield { call: processQuasiquote(item, ctx, level) });
    }
    return new AVector(out);
  }

  if (!(expr instanceof APair)) {
    return expr;
  }

  const first = expr.car;

  if (first instanceof ASymbol && symbol_name(first) === "unquote") {
    if (level === 1) {
      SpecialFormShapeError.invariant(expr.cdr instanceof APair, "unquote", "missing argument");
      return yield { call: evaluate(expr.cdr.car, ctx) };
    } else {
      // Nested quasiquote: decrease level and keep the unquote wrapper (stays
      // quoted data until its own depth is reached).
      SpecialFormShapeError.invariant(expr.cdr instanceof APair, "unquote", "missing argument");
      const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
      return new APair(new ASymbol("unquote"), new APair(processed, nil));
    }
  }

  if (first instanceof ASymbol && symbol_name(first) === "unquote-splicing") {
    // Splicing needs list context — a bare top-level `,@x` (level 1) is invalid.
    SpecialFormShapeError.invariant(level > 1, "unquote-splicing", "invalid context");
    SpecialFormShapeError.invariant(expr.cdr instanceof APair, "unquote-splicing", "missing argument");
    const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level - 1) };
    return new APair(new ASymbol("unquote-splicing"),
      new APair(processed, nil),
    );
  }

  if (first instanceof ASymbol && symbol_name(first) === "quasiquote") {
    SpecialFormShapeError.invariant(expr.cdr instanceof APair, "quasiquote", "missing argument");
    const processed = yield { call: processQuasiquote(expr.cdr.car, ctx, level + 1) };
    return new APair(new ASymbol("quasiquote"), new APair(processed, nil));
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
      SpecialFormShapeError.invariant(item.cdr instanceof APair, "unquote-splicing", "missing argument");
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
        SpecialFormShapeError.invariant(spliced instanceof ANil, "unquote-splicing", "expected list");
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
  // `(a . ,x)` keeps x as the final cdr rather than nil-terminating.
  // Pair.fromArray always nil-terminates, so fold manually onto `tail`.
  let result: SchemeValue = tail;
  for (let i = results.length; i--; ) {
    result = new APair(results[i], result);
  }
  return result;
}

/** `(define name value)` or `(define (name . args) body)` — the procedure shorthand desugars to a lambda. */
function* evalDefine(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "define", "missing name");

  const first = rest.car;
  const valueRest = rest.cdr;

  // Function definition shorthand: (define (f x) body) -> (define f (lambda (x) body))
  if (first instanceof APair) {
    const name = first.car;
    const args = first.cdr;

    SpecialFormShapeError.invariant(name instanceof ASymbol, "define", "expected symbol for function name");

    const value = yield { call: evalLambda(new APair(args, valueRest), ctx) };

    if (is_lambda_function(value)) {
      value.__name__ = symbol_name(name);
    }

    bindValue(ctxResolver(ctx).env, name, value);
    return theVoid;
  }

  // Simple definition: (define name value)
  SpecialFormShapeError.invariant(first instanceof ASymbol, "define", "expected symbol");
  SpecialFormShapeError.invariant(valueRest instanceof APair, "define", "missing value");

  // Strip tail: the value must return HERE to be bound. A `tail:true` would let
  // `(define x (some-lambda))` tail-replace this slot and skip the bind below.
  let value = yield { call: evaluate(valueRest.car, ctx.tail ? { ...ctx, tail: false } : ctx) };
  if (is_promise(value)) {
    value = yield value;
  }

  // Set name on functions for debugging
  if (is_lambda_function(value) && !value.__name__) {
    value.__name__ = symbol_name(first);
  }

  bindValue(ctxResolver(ctx).env, first, value);
  return theVoid;
}

// `set!` — one of the purity omissions (preamble): doored in r7rs/binding. Lexical
// rebinding severs the WHERE-bound lineage every value carries. The
// `AmbientRuntime.ref` / `Resolver.env.ref` mutation-targeting walk has no evaluator
// caller — it survives only for hygiene's `Capabilities.refFrame` IDENTITY probe,
// which is not a mutation path.

/** `(lambda args body)` — closes over the definition-time env; body starts in tail position (R7RS §3.5). */
function* evalLambda(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "lambda", "missing arguments");

  const args = rest.car;
  const body = rest.cdr;

  // Capture the resolver (lexical scope) at definition time
  const closureResolver = ctxResolver(ctx);

  // The runner — the lambda body, INJECTED into the ALambda value (the value layer
  // names no evaluator symbol; same seam `Macro` uses). `canBounce` drives the bounce
  // protocol (preamble): true ⇒ hand back the body generator as a Bounce; false ⇒ run
  // to completion for a JS/HOF caller. The body evaluates against the DEFINITION-time
  // ctx — the accepted `runCtx` is unused (call-time runCtx threading is a later cut).
  const runner = (values: SchemeValue[], _runCtx: RunContext, canBounce: boolean): CallResult => {
    const callResolver = closureResolver.child("lambda", "lambda");
    let argNode: SchemeValue = args;
    let i = 0;
    while (argNode instanceof APair) {
      const argName = argNode.car;
      if (argName instanceof ASymbol) bindValue(callResolver.env, argName, values[i]);
      i++;
      argNode = argNode.cdr;
    }
    // Rest arg: (lambda (a b . rest) …)
    if (argNode instanceof ASymbol) {
      bindValue(callResolver.env, argNode, APair.fromArray(ctx.runCtx, values.slice(i), false));
    }
    // Dynamic call site: the caller (evaluatePair / wrapLambdaValue) set the holder just before
    // invoking; else fall back to the lexical ctx's invocation. Read here in the synchronous
    // prologue, so a wrapLambdaValue finally-restore after this point is harmless (bodyCtx captured it).
    const dynamicInv = currentDynamicCallSite() ?? ctx.currentInvocation;
    // Lambda body starts in tail position (preamble TAIL PROPAGATION): tail=true here
    // propagates through evalBegin/evalIf/… to the terminal body expr.
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
  });
  lambda.__params__ = params;
  return lambda;
}

/** `(define-macro (name . args) body)` — fexpr-style macro; params bind to UNEVALUATED argument forms. */
function* evalDefineMacro(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "define-macro", "missing definition");

  const first = rest.car;
  SpecialFormShapeError.invariant(first instanceof APair, "define-macro", "expected (name . args)");

  const name = first.car;
  const args = first.cdr;
  SpecialFormShapeError.invariant(name instanceof ASymbol, "define-macro", "expected symbol for name");

  const body = rest.cdr;

  // Capture the resolver (lexical scope) at definition time.
  const defResolver = ctxResolver(ctx);

  // The macro body returns `run(...)` — a `Promise<SchemeValue>` of the expansion
  // FORM; the consumer (`fn.invoke` site) `yield`s it via `is_promise`.
  const macro = new Macro(symbol_name(name), function (
    this: AmbientRuntime,
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
        bindValue(macroResolver.env, argName, value);
      }
      i++;
      argNode = argNode.cdr;
      if (codeNode instanceof APair) {
        codeNode = codeNode.cdr;
      }
    }

    if (argNode instanceof ASymbol) {
      bindValue(macroResolver.env, argNode, codeNode);
    }

    // Forward signal so macro expansion is also budget-bounded.
    return run(evalBegin(body, { ...evalArgs, resolver: macroResolver }), {
      signal: evalArgs.signal,
    });
  });
  bindValue(ctxResolver(ctx).env, name, macro);

  return theVoid;
}

// ============================================================================
// Core Macros (implemented as special forms for performance)
// ============================================================================

// ── let-family bracket-binding consumption ──────────────────────────────────
// Consumption site for the bracket-bindings superset. The model — both surfaces
// (BG2a whole-list / BG2b per-element / BG2c mixing), the R7RS/Racket/Clojure
// union table, and the non-intersection argument (each bracket surface has ONE
// dialect reading, so one input shape → one meaning with no context branch) —
// is docs/grammar.md §BINDINGS. This is where it lands: `normalizeBindings` runs
// the BG3 pure syntactic rewrite ONCE, before the existing per-binding walk,
// lowering either bracket surface to the SAME cons-list-of-pairs a hand-written
// paren form produces — so every downstream line evaluates a plain list and the
// equivalence is structural, not case-by-case. Detection is `evalElements === true`
// at a binding-position node (BG1 — no reader/lexer change); `#(…)`
// (`evalElements === false`) falls straight through the generic `is_pair` invariant
// (BG5, never consumed). Malformed shapes throw the BG4 door codes
// (E-LET-BRACKET-BINDINGS-LIST / E-LET-BRACKET-BINDING) built by the constructors below.
//
// BG-numbering: this file's local rules are named BG1–BG6/BG9 per §BINDINGS's
// BG-numbering note — the doc's rename of the evaluator's original R1–R6/R9 off
// RULINGS.md's global R-ledger, keeping the two ledgers apart in source too.
//
// Executable spec: src/reader/__tests__/polyglot/macro-special-brackets.spec.ts;
// error taxonomy in docs/grammar.md §ERRORS.

/** `do` doesn't accept the whole-list form (BG2a exclusion) — its 3-element
 *  steps make pairwise grouping ambiguous; the other five forms consume this
 *  shape instead. */
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
    { code: "E-LET-BRACKET-BINDINGS-LIST", hint: `(${pairs.join(" ")})` },
  );
}

/** BG2a/BG4: a whole-list vector's element count is odd — pairwise grouping leaves
 *  the last name with no value. Same code as `bracketBindingsListError` above
 *  (both are "the whole bracketed bindings LIST is malformed for this form"). */
function wholeListOddCountError(bindings: AVector, form: string): Error {
  const els = bindings.__vector__;
  const rendered = els.map(String).join(" ");
  // Two clear readings, neither guessable to a concrete value (the missing value is a
  // hole): keep the even whole-list, filling it — or reparenthesize into pairs. Both
  // shapes carry `<value>` where the dropped value belongs. This is the sole bracket
  // door whose `hint` is a list (see EvalError.hint): the ambiguity is real but bounded.
  const parenPairs: string[] = [];
  for (let i = 0; i < els.length; i += 2) {
    parenPairs.push(i + 1 < els.length ? `(${String(els[i])} ${String(els[i + 1])})` : `(${String(els[i])} <value>)`);
  }
  return new EvalError(
    `${form} bindings [${rendered}] has an odd number of elements (${els.length}) — a whole-list binding vector ` +
      `is name/value pairs (\`[s1 v1 s2 v2 …]\`), so the count must be even. Add the missing value, or write the ` +
      `bindings as a parenthesized list of pairs.`,
    { code: "E-LET-BRACKET-BINDINGS-LIST", hint: [`[${rendered} <value>]`, parenPairs.join(" ")] },
  );
}

/** BG2b/BG4: a per-element vector's length is wrong (≠2; ≠2-3 for `do`). Code
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
    { location, code: "E-LET-BRACKET-BINDING", hint: `(${rendered})` },
  );
}

/** BG2b/BG4: a non-symbol in the binding-name slot. SPECIAL-cased text when the
 *  name is itself a vector (Clojure destructuring: `[[x y] v]`) — that's not
 *  a malformed pair but an unsupported binding FORM. Same code as the arity
 *  door above. Reached from BOTH surfaces (BG2a whole-list even-position names
 *  and BG2b per-element first-elements) via `buildBindingPair`. */
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
 *  shared by both BG2a (whole-list) and BG2b (per-element) rewriting so the
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
    cdr = new APair(parts[i], cdr);
  }
  // Built element-by-element from `parts[1..]` in reverse (the loop above) — exactly the
  // tuple-shaped spine `AListAlike<Cdr>` describes. TS's structural checker can't see that
  // the loop's generic `APair<any,any> | ANil` accumulator matches the specific `Cdr` tuple
  // shape it was just built from, so this narrows what the construction already proves.
  return new APair<Car, AListAlike<Cdr>>(name, cdr as AListAlike<Cdr>);
}

/**
 * The BG2/BG3 syntactic rewrite: lowers a let-family `bindings` slot that uses
 * either bracket surface into the plain cons-list-of-pairs shape the existing
 * per-binding walk already understands, throwing door-grade errors (BG4) for
 * malformed shapes right here — BEFORE any walk begins. Once this returns,
 * every line downstream evaluates a form with no bracket bindings in it at
 * all, which is what makes BG3's equivalence structural rather than
 * case-by-case.
 *
 *  - `#(…)` (`evalElements === false`) and anything that isn't an `AVector`
 *    pass straight through unchanged — BG5 (never consumed) / the generic
 *    invariant downstream is the right door for anything else malformed.
 *  - `bindings` itself an `evalElements` vector (BG2a whole-list) is rewritten
 *    wholesale, unless `allowWholeList` is false (`do`'s BG2a exclusion — the
 *    caller passes `allowWholeList: false` and gets the ORIGINAL door).
 *  - Each ELEMENT of a (paren, or whole-list-just-rewritten) bindings list
 *    that is itself an `evalElements` vector (BG2b per-element) is rewritten
 *    in place; a paren-pair element (or anything else — the generic
 *    invariant's job) passes through with its OWN identity, giving BG2c
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

/** `(let ((var val) …) body…)`, plus named let `(let name ((var val) …) body…)`. */
function* evalLet(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "let", "missing bindings");

  let bindings: SchemeValue;
  let body: SchemeValue;
  let name: ASymbol | null = null;

  // Check for named let: (let name ((var val) ...) body...)
  if (rest.car instanceof ASymbol) {
    name = rest.car;
    const afterName = rest.cdr;
    SpecialFormShapeError.invariant(afterName instanceof APair, "let", "missing bindings after name");
    bindings = afterName.car;
    body = afterName.cdr;
  } else {
    bindings = rest.car;
    body = rest.cdr;
  }

  // "named let" as the door-form name reads clearer than "let" when the model
  // bracketed `(let loop […]) …)`'s bindings.
  const letForm = name ? "named let" : "let";
  // BG2/BG3: consume both bracket surfaces into the plain cons-list-of-pairs
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

    // Named-let is sugar for a letrec-bound lambda; its loop binding is a real
    // ALambda whose runner speaks the bounce protocol (preamble), same as evalLambda.
    // Recursive `(loop ...)` MUST bounce, not re-`run(...)`: each `run(...)` would add
    // a pending await, blowing V8's call-stack from inside PromiseRejectCallback
    // before any TICK check runs (the budget can't rescue an overflow in await
    // machinery). The `run(...)` fallback (HOF escape, `canBounce` false) forwards
    // `signal`; the bounce path inherits the outer ctx's signal directly.
    const runner = (values: SchemeValue[], _runCtx: RunContext, canBounce: boolean): CallResult => {
      const loopResolver = letResolver.child("named-let", "named-let");

      for (const [i, param] of params.entries()) {
        bindValue(loopResolver.env, param, values[i]);
      }

      const dynamicInv = currentDynamicCallSite() ?? ctx.currentInvocation;
      const bodyCtx: EvalContext = {
        ...ctx,
        resolver: loopResolver,
        currentInvocation: dynamicInv,
        // Named-let body is tail w.r.t. the `(loop ...)` call site (preamble TAIL
        // PROPAGATION) — this is what makes `(loop (+ i 1))` tail-dispatch.
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
    });
    loopLambda.__name__ = symbol_name(name);
    loopLambda.__params__ = params.map((p) => symbol_name(p));

    bindValue(letResolver.env, name, loopLambda);
  }

  // Binding RHS: non-tail (values feed the let frame; only the body is tail).
  const values: SchemeValue[] = [];
  const names: ASymbol[] = [];
  const bindingCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    SpecialFormShapeError.invariant(binding instanceof APair, "let", "invalid binding");

    const varName = binding.car;
    SpecialFormShapeError.invariant(varName instanceof ASymbol, "let", "expected symbol in binding");

    names.push(varName);

    const bindingCdr = binding.cdr;
    SpecialFormShapeError.invariant(bindingCdr instanceof APair, "let", "missing value in binding");
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
    bindValue(letResolver.env, varName, values[i]);
  }

  // Body inherits the let's tail flag; pass-through (tail-collapsible).
  return yield { call: evalBegin(body, { ...ctx, resolver: letResolver }), tail: ctx.tail === true };
}

/** `(let* ((var val) …) body…)` — sequential binding; each RHS sees the previous. */
function* evalLetStar(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "let*", "missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // BG2/BG3: consume both bracket surfaces (see normalizeBindings).
  const normalizedBindings = normalizeBindings(bindings, "let*", true, 2, 2);

  const letStarResolver = ctxResolver(ctx).child("let*", "let*");

  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    SpecialFormShapeError.invariant(binding instanceof APair, "let*", "invalid binding");

    const varName = binding.car;
    SpecialFormShapeError.invariant(varName instanceof ASymbol, "let*", "expected symbol in binding");

    const bindingCdr = binding.cdr;
    SpecialFormShapeError.invariant(bindingCdr instanceof APair, "let*", "missing value in binding");
    const valExpr = bindingCdr.car;

    // Sequential semantics: evaluated in the growing let* environment.
    let value = yield { call: evaluate(valExpr, { ...ctx, resolver: letStarResolver, tail: false }) };
    if (is_promise(value)) {
      value = yield value;
    }

    bindValue(letStarResolver.env, varName, value);
    bindNode = bindNode.cdr;
  }

  return yield { call: evalBegin(body, { ...ctx, resolver: letStarResolver }), tail: ctx.tail === true };
}

/** `(letrec ((var val) …) body…)` — recursive binding; all bindings see each other. */
function* evalLetrec(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "letrec", "missing bindings");

  const bindings = rest.car;
  const body = rest.cdr;

  // BG2/BG3: consume both bracket surfaces (see normalizeBindings). Also covers
  // letrec* — the SPECIAL_FORMS table aliases "letrec*" straight to this
  // function (R7RS: letrec* evaluates left-to-right, same as our letrec).
  const normalizedBindings = normalizeBindings(bindings, "letrec", true, 2, 2);

  const letrecResolver = ctxResolver(ctx).child("letrec", "letrec");

  // First pass: bind all names to unassigned.
  const bindingList: Array<{ name: ASymbol; expr: SchemeValue }> = [];
  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    SpecialFormShapeError.invariant(binding instanceof APair, "letrec", "invalid binding");

    const varName = binding.car;
    SpecialFormShapeError.invariant(varName instanceof ASymbol, "letrec", "expected symbol in binding");

    const bindingCdr = binding.cdr;
    SpecialFormShapeError.invariant(bindingCdr instanceof APair, "letrec", "missing value in binding");
    const valExpr = bindingCdr.car;

    // letrec first pass: the name exists but is unassigned until the second
    // pass overwrites it. theVoid is the unassigned-slot sentinel (referencing
    // it before assignment is an R7RS error caught elsewhere); `undefined` is
    // not a SchemeValue / AmbientValue.
    bindValue(letrecResolver.env, varName, theVoid);
    bindingList.push({ name: varName, expr: valExpr });
    bindNode = bindNode.cdr;
  }

  // Second pass: evaluate and assign, in the letrec environment (RHS non-tail).
  for (const { name, expr } of bindingList) {
    let value = yield { call: evaluate(expr, { ...ctx, resolver: letrecResolver, tail: false }) };
    if (is_promise(value)) {
      value = yield value;
    }
    bindValue(letrecResolver.env, name, value);
  }

  return yield { call: evalBegin(body, { ...ctx, resolver: letrecResolver }), tail: ctx.tail === true };
}

/**
 * `(and expr…)` — short-circuit: returns the first `#f` or the last value. Only the
 * LAST expr inherits tail (earlier ones short-circuit before tail dispatch).
 */
function* evalAnd(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
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
    // Last expr pass-through, tail-collapsible; the short-circuit below only
    // gates non-last exprs, so collapsing past it on the last is safe.
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }

    if (is_false(result)) {
      return result;
    }

    node = node.cdr;
  }

  return result;
}

/**
 * `(or expr…)` — short-circuit: returns the first truthy or the last value. Only the
 * LAST expr inherits tail (earlier ones short-circuit before tail dispatch).
 */
function* evalOr(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
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
    // Last expr pass-through, tail-collapsible (safe past the short-circuit below).
    result = yield { call: evaluate(node.car, exprCtx), tail: inTail };
    if (is_promise(result)) {
      result = yield result;
    }

    if (!is_false(result)) {
      return result;
    }

    node = node.cdr;
  }

  return result;
}

/**
 * The `=>` arm of `cond`/`case`: apply an already-evaluated procedure to one
 * already-evaluated argument through the SAME trampoline tail path `evaluatePair`
 * uses. R7RS §3.5 puts `(proc test-value)` in tail position when the enclosing form
 * is — so this must ride the bounce protocol (preamble), not a direct `run(...)`
 * call, or a self-recursive `=>` loop overflows the host stack. Non-lambda callables
 * (builtins) can't tail-recurse into Scheme, so they keep the direct apply.
 *
 * Provenance: this helper does NOT stamp control-flow provenance. The caller wraps
 * the `{ call: applyArrowProc(...) }` yield with `onResolve:
 * controlFlowResolve(predicate)`; because this slot is pass-through, the tailCall
 * collapse composes that `onResolve` onto the replacement, so the predicate's
 * lineage rides both the collapsed and resumed paths — exactly like the non-`=>` arms.
 */
function* applyArrowProc(proc: SchemeValue, arg: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(is_callable(proc), "=>", "requires a procedure");

  // A callable VALUE dispatches through its apply term. An ALambda in tail position
  // hands back a Bounce so a self-recursive `=>` collapses (TCO); an ANativeProcedure/
  // ARosettaProcedure returns a value/promise (canBounce ignored). Every
  // scheme-authored lambda (including named-let's loop binding) is a callable VALUE.
  if (is_callable_value(proc)) {
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = currentDynamicCallSite();
    setDynamicCallSite(dynSite);
    let r: CallResult;
    try {
      r = proc[tf("apply")](wrapLambdaArgs([arg], dynSite), ctx.runCtx, is_lambda(proc));
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
  SpecialFormShapeError.invariant(is_function(proc), "=>", "requires a procedure");
  // The bare-fn callable surface is heterogeneous (metadata-bearing `AProcedure`, plain
  // bare-fn) with no single call signature, so invoke reflectively — `Reflect.apply`
  // takes the arg array honestly, the same convention the main apply path uses. A
  // builtin yields a value or a Promise, never a Bounce, so rule the bounce arm out
  // explicitly (a builtin handing one back is a real invariant violation). `this =
  // CallCtx` matches the shape the main apply path hands a builtin: a native impl reads
  // `this.runCtx`, and an undefined `this` crashes the `=>` arm (`(cond (test => cadr))`).
  let result: SchemeValue | SchemeBounceMarker | Promise<SchemeValue> = maybeThen(
    Reflect.apply(
      proc,
      makeCallCtx(ctx.runCtx, ctx.currentInvocation as InvocationLike | undefined),
      [arg],
    ),
    // Same bare-fn boxing seam as the main apply arm — see its comment.
    (v) => jsToScheme(ctx.runCtx, v, {}),
  ) as SchemeValue | SchemeBounceMarker | Promise<SchemeValue>;
  invariant(!is_bounce_marker(result), "=> builtin returned a bounce sentinel");
  if (is_promise(result)) {
    result = yield result;
  }
  return result;
}

// ── bracket CLAUSE consumption (cond / case / do) ───────────────────────────────
// Consumption site for the bracket-clauses superset. The model — a bracket clause
// elementwise ≡ the parenthesized clause, the BG9 datum-list-stays-a-LIST rule, and
// the non-intersection argument (bracket clauses are a purely Racket surface — Clojure's
// `cond` is flat — so no dialect conflict exists) — is docs/grammar.md §CLAUSES.
// `cond`/`case`/`do` are evaluator SPECIAL FORMS (this file), so consumption lands here
// beside §BINDINGS's `normalizeBindings`: `normalizeClause` runs ONCE per clause, before
// the existing clause walk, producing the plain-list shape a paren clause already is (same
// structural-equivalence argument as BG3). It converts ONLY the clause's own wrapper —
// never element 0 — which is what keeps a `case` clause's datum-list head a LIST (BG9):
// `[(1 2) "low"]`'s elements `[(1 2), "low"]` rewrap to `((1 2) "low")`, the inner `(1 2)`
// untouched. `#(…)` and non-vector clauses pass through (BG5, never consumed); the
// `is_pair(clause)` invariants below are the door for anything else malformed. Malformed
// bracket shapes throw the BG4-family doors below (E-COND-BRACKET-CLAUSE,
// E-CASE-BRACKET-DATUM-LIST). BG-numbering: see §BINDINGS's BG-numbering note.
function normalizeClause(clause: SchemeValue, form: string): SchemeValue {
  if (!(clause instanceof AVector) || !clause.evalElements) return clause;
  const els = clause.__vector__;
  if (els.length === 0) throw emptyClauseError(form);
  return APair.fromArray(CONSTANT_CTX, els, false);
}

/** BG9/BG4-family: an empty bracket clause `[]` — cond/case/do's clause vector
 *  must contain at least the test/datum slot. Code `E-COND-BRACKET-CLAUSE`
 *  (shared across cond/case/do — this is "the whole bracketed CLAUSE is
 *  malformed for this form", the clause-position sibling of
 *  `E-LET-BRACKET-BINDINGS-LIST`). */
function emptyClauseError(form: string): Error {
  // `case` genuinely has two clause shapes (datum-list clause vs `else` clause), so its
  // hint is a list; cond/do have the single `[test expr…]` shape.
  const hint = form === "case" ? ["[(datum…) expr…]", "[else expr…]"] : "[test expr…]";
  return new EvalError(
    `${form} clause [] is empty — a bracketed clause needs at least a test/datum slot ` +
      `(\`[test expr…]\` for cond/do, \`[(datum…) expr…]\` or \`[else expr…]\` for case). ` +
      `Add the missing slot, or remove the empty clause.`,
    { code: "E-COND-BRACKET-CLAUSE", hint },
  );
}

/** BG9: a `case` clause's datum-list HEAD is itself a bracket vector — the
 *  datum list is DATA and is never bracket-converted (BG9), even inside a
 *  bracketed clause. `[[1 2] "low"]` therefore does NOT lower to
 *  `((1 2) "low")`; it stays `([1 2] "low")` and would otherwise fall through
 *  to the generic "case: expected list of datums" invariant with no hint
 *  about why. This door names the vector-ness itself as the confusion (per
 *  BG9: "the bracket door only where the vector-ness itself is the
 *  confusion") and points at the fix. */
function caseDatumListVectorError(datums: AVector): Error {
  const els = datums.__vector__;
  const rendered = els.map(String).join(" ");
  return new EvalError(
    `case clause datum list [${rendered}] is a vector — the datum-list head is data and is never ` +
      `bracket-converted, even inside a bracketed clause. Write it as a parenthesized list: (${rendered}).`,
    { code: "E-CASE-BRACKET-DATUM-LIST", hint: `(${rendered})` },
  );
}

/**
 * Handle 'cond' special form: (cond (test expr...) ... (else expr...)?)
 */
function* evalCond(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  let node: SchemeValue = rest;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  while (node instanceof APair) {
    // BG9: consume a bracket clause (see normalizeClause above) before the
    // existing invariant/walk.
    const clause = normalizeClause(node.car, "cond");
    SpecialFormShapeError.invariant(clause instanceof APair, "cond", "invalid clause");

    const test = clause.car;
    const exprs = clause.cdr;

    // `else` matched by `.literal()` (preamble HYGIENE / AUXILIARY KEYWORDS).
    if (test instanceof ASymbol && test.literal() === "else") {
      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true };
    }

    let testResult = yield { call: evaluate(test, nonTailCtx) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // `(test => proc)`: the application is tail per R7RS §3.5, so route through
      // applyArrowProc (see its doc). Provenance rides as `onResolve`.
      if (exprs instanceof APair) {
        const firstExpr = exprs.car;
        if (firstExpr instanceof ASymbol && firstExpr.literal() === "=>") {
          const exprsCdr = exprs.cdr;
          SpecialFormShapeError.invariant(exprsCdr instanceof APair, "cond", "missing procedure after =>");
          const procExpr = exprsCdr.car;
          let proc = yield { call: evaluate(procExpr, nonTailCtx) };
          if (is_promise(proc)) {
            proc = yield proc;
          }
          SpecialFormShapeError.invariant(is_callable(proc), "cond", "=> requires a procedure");
          return yield {
            call: applyArrowProc(proc, testResult, ctx),
            tail: ctx.tail === true,
            onResolve: controlFlowResolve(testResult),
          };
        }
      }

      // A clause with no body returns the test result (R7RS; carries its own provenance).
      if (!(exprs instanceof APair) || exprs instanceof ANil) {
        return testResult;
      }

      return yield { call: evalBegin(exprs, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
    }

    node = node.cdr;
  }

  return theVoid; // no clause matched
}

/** `(case key ((datum…) expr…) … (else expr…)?)`. */
function* evalCase(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "case", "missing key");

  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let key = yield { call: evaluate(rest.car, nonTailCtx) };
  if (is_promise(key)) {
    key = yield key;
  }

  let node: SchemeValue = rest.cdr;

  while (node instanceof APair) {
    // BG9: consume a bracket clause (see normalizeClause above) before the
    // existing invariant/walk.
    const clause = normalizeClause(node.car, "case");
    SpecialFormShapeError.invariant(clause instanceof APair, "case", "invalid clause");

    const datums = clause.car;
    const exprs = clause.cdr;

    // `else` matched by `.literal()` (preamble HYGIENE / AUXILIARY KEYWORDS).
    if (datums instanceof ASymbol && datums.literal() === "else") {
      // R7RS §6.3 also allows `(else => proc)`: apply proc to the key in tail position.
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

    // BG9: the datum-list head is data and is NEVER bracket-converted — a vector here
    // (evalElements) is the confusion itself, not a generic malformation, so it gets
    // its own door (see caseDatumListVectorError).
    if (datums instanceof AVector && datums.evalElements) {
      throw caseDatumListVectorError(datums);
    }
    SpecialFormShapeError.invariant(datums instanceof APair, "case", "expected list of datums");
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
      // R7RS §6.3 `=>` arm: `((d1 ...) => proc)` applies proc to the key (applyArrowProc).
      const arrowProc = yield* evalCaseArrowProc(exprs, nonTailCtx);
      if (arrowProc !== undefined) {
        return yield {
          call: applyArrowProc(arrowProc, key, ctx),
          tail: ctx.tail === true,
          onResolve: controlFlowResolve(key),
        };
      }
      // Per spec §5.3 the case key plays the predicate role — its lineage picked this
      // arm; provenance rides as onResolve (preamble CONTROL-FLOW PROVENANCE).
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
  SpecialFormShapeError.invariant(exprsCdr instanceof APair, "case", "missing procedure after =>");
  let proc = yield { call: evaluate(exprsCdr.car, nonTailCtx) };
  if (is_promise(proc)) {
    proc = yield proc;
  }
  SpecialFormShapeError.invariant(is_callable(proc), "case", "=> requires a procedure");
  return proc;
}

/** `(when test expr...)` — body in tail position inherits when's tail flag (R7RS §3.5). */
function* evalWhen(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "when", "missing test");

  const test = rest.car;
  const body = rest.cdr;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(test, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (!is_false(testResult)) {
    return yield { call: evalBegin(body, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
  }

  return theVoid;
}

/** `(unless test expr...)` — the `#f`-guarded mirror of `when`; body in tail position. */
function* evalUnless(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "unless", "missing test");

  const test = rest.car;
  const body = rest.cdr;
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  let testResult = yield { call: evaluate(test, nonTailCtx) };
  if (is_promise(testResult)) {
    testResult = yield testResult;
  }

  if (is_false(testResult)) {
    return yield { call: evalBegin(body, ctx), tail: ctx.tail === true, onResolve: controlFlowResolve(testResult) };
  }

  return theVoid;
}

/**
 * Handle 'do' special form: (do ((var init step) ...) (test result...) body...)
 */
function* evalDo(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "do", "missing bindings");

  const bindings = rest.car;
  // BG2/BG3: consume the per-element bracket surface only — do does NOT accept
  // the whole-list form (BG2a exclusion; allowWholeList: false keeps the
  // ORIGINAL door, unchanged). Arity is 2-3 ([name init] / [name init step]).
  const normalizedBindings = normalizeBindings(bindings, "do", false, 2, 3);
  const restCdr = rest.cdr;
  SpecialFormShapeError.invariant(restCdr instanceof APair, "do", "missing test clause");

  // BG9: do's test clause may be a bracket vector, elementwise ≡ the
  // parenthesized clause (see normalizeClause above).
  const testClause = normalizeClause(restCdr.car, "do");
  const body = restCdr.cdr;

  SpecialFormShapeError.invariant(testClause instanceof APair, "do", "invalid test clause");

  const test = testClause.car;
  const resultExprs = testClause.cdr;

  const doResolver = ctxResolver(ctx).child("do", "do");
  const vars: Array<{ name: ASymbol; step: SchemeValue | null }> = [];

  // Only the result-expression(s) are tail; bindings/test/step/body are non-tail.
  // The loop itself iterates inside ONE generator's `while (true)`, so recursion is
  // flat regardless — the tail flag matters only for what the result exprs do.
  const doNonTail: EvalContext = { ...ctx, resolver: doResolver, tail: false };
  const doTail: EvalContext = { ...ctx, resolver: doResolver };

  let bindNode: SchemeValue = normalizedBindings;
  while (bindNode instanceof APair) {
    const binding = bindNode.car;
    SpecialFormShapeError.invariant(binding instanceof APair, "do", "invalid binding");

    const varName = binding.car;
    SpecialFormShapeError.invariant(varName instanceof ASymbol, "do", "expected symbol");

    const bindingCdr = binding.cdr;
    // No init form → unspecified. theVoid is self-evaluating (evaluate's non-pair
    // return), so a missing init yields void; `undefined` is not a SchemeValue.
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

    bindValue(doResolver.env, varName, initValue);
    vars.push({ name: varName, step: stepExpr });

    bindNode = bindNode.cdr;
  }

  while (true) {
    let testResult = yield { call: evaluate(test, doNonTail) };
    if (is_promise(testResult)) {
      testResult = yield testResult;
    }

    if (!is_false(testResult)) {
      // Test true — result expressions in tail position.
      if (resultExprs instanceof APair) {
        return yield { call: evalBegin(resultExprs, doTail), tail: ctx.tail === true };
      }
      return theVoid;
    }

    if (body instanceof APair) {
      yield { call: evalBegin(body, doNonTail) };
    }

    const newValues: SchemeValue[] = [];
    for (const { step } of vars) {
      if (step === null) {
        // Index-alignment filler for a step-less var; never read (the update pass
        // below only defines names where `step !== null`). theVoid keeps the array a
        // genuine SchemeValue[]; `undefined` is not a SchemeValue.
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
        bindValue(doResolver.env, name, newValues[i]);
      }
    }
  }
}

/**
 * `(while test body...)` — iterate body while `test` is truthy; returns nil. Like
 * `do`, the whole loop runs inside ONE generator's `while (true)`, so the host stack
 * stays flat across any number of iterations (nothing here is in tail position).
 */
function* evalWhile(rest: SchemeValue, ctx: EvalContext): EvalGenerator {
  SpecialFormShapeError.invariant(rest instanceof APair, "while", "missing test");

  const test = rest.car;
  const body = rest.cdr;

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
  SpecialFormShapeError.invariant(rest instanceof APair, "try", "missing body");

  const body = rest.car;
  let catchClause: SchemeValue | null = null;
  let finallyClause: SchemeValue | null = null;

  let clauseNode = rest.cdr;
  while (clauseNode instanceof APair) {
    const clause = clauseNode.car;
    if (clause instanceof APair) {
      const clauseHead = clause.car;
      // `catch`/`finally` matched by `.literal()` (preamble HYGIENE / AUXILIARY
      // KEYWORDS) — a `(try … (catch (e) …))` from a syntax-rules template
      // hygiene-renames these free identifiers to gensyms whose description is "#:catch".
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

  SpecialFormShapeError.invariant(catchClause !== null || finallyClause !== null, "try", "requires catch or finally clause");

  // Each clause runs in its OWN fresh `run()` (nested trampoline) so the outer
  // try/catch can intercept thrown errors. `tail` is stripped so body/handlers sit
  // top-of-trampoline, keeping the bounce protocol from reaching across the `run()`
  // boundary; a tail loop INSIDE the body still gets full TCO within its own trampoline.
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
      SpecialFormShapeError.invariant(catchClause instanceof APair, "try", "invalid catch clause");
      const catchCdr = catchClause.cdr;
      SpecialFormShapeError.invariant(catchCdr instanceof APair, "try", "invalid catch syntax");

      const varSpec = catchCdr.car;
      SpecialFormShapeError.invariant(varSpec instanceof APair, "try", "catch requires (var)");

      const varName = varSpec.car;
      SpecialFormShapeError.invariant(varName instanceof ASymbol, "try", "catch variable must be a symbol");

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
      bindValue(catchResolver.env, varName, errorValue);

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

    // Forward signal — finally is bounded too; aborts in finally propagate per JS
    // semantics (this catch swallows them).
    if (finallyClause) {
      SpecialFormShapeError.invariant(finallyClause instanceof APair, "try", "invalid finally clause");
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
  throw new EvalError(`dict literal key substituted a non-string value (${String(v)}) — keys must be :keywords or "strings"`, {
    code: "E-DICT-BAD-KEY",
  });
}

// ============================================================================
// Core Evaluator
// ============================================================================

/** Map of special form names to their handlers. `set!` / `delay` / `force` /
 *  `parameterize` are intentionally ABSENT (preamble purity omissions) — kept out
 *  of the table so env lookup reaches their door in the r7rs packs. The core macros
 *  (let-family, cond/case/…) are implemented as special forms for performance. */
const SPECIAL_FORMS: Record<string, (rest: SchemeValue, ctx: EvalContext) => EvalGenerator> = {
  if: evalIf,
  begin: evalBegin,
  quote: evalQuote,
  quasiquote: evalQuasiquote,
  define: evalDefine,
  "define-macro": evalDefineMacro,
  lambda: evalLambda,
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
  try: evalTry,
  // `raise` / `error` are deliberately NOT here: core.ts defines them as R7RS
  // procedures that walk *current-exception-handlers* (§6.11). Special-form dispatch
  // precedes env lookup, so a table entry would shadow them and leave the whole
  // exception tower (with-exception-handler / guard / raise-continuable) inert.
};

/** Evaluate a Scheme expression (yield protocol: preamble FLAT TRAMPOLINE). */
export function* evaluate(
  code: SchemeValue,
  ctx: EvalContext,
): Generator<unknown, SchemeValue | Macro | Syntax, SchemeValue> {
  yield TICK;

  if (code === null || code instanceof ANil) {
    return code;
  }

  // Symbol lookup. A symbol can resolve to a value OR — via the define-syntax
  // mechanism (a `let`-bound transformer returned to be bound) — a Macro/Syntax.
  if (code instanceof ASymbol) {
    const value = resolvedBindingOrThrow(ctxResolver(ctx).resolve(code, ctx.runCtx), code);
    // The tap reports resolved VALUES; skip it for a macro/syntax binding (no value).
    if (!is_macro(value)) {
      ctx.tap?.onSymbolResolved?.(ctx.currentInvocation ?? null, code, value);
    }
    return value;
  }

  // `[…]` / `{…}` collection literals lower to `(vector …)` / `(dict …)` in code
  // position — see the collection-literal section header above. `lower()` answers
  // the cached application only when `code` IS a reader literal in lowering position;
  // every other value (plain vector/dict, `#(…)` constant, quoted node) answers null.
  const lowered = code[tf("lower")]?.();
  // `instanceof APair` both discriminates null/undefined (no lowering) AND narrows the
  // wide `SchemeValue | null` term-return to what `evaluatePair` requires — a lowering
  // is always a non-empty `(head …)` application, never anything else.
  if (lowered instanceof APair) {
    return yield* evaluatePair(lowered, ctx);
  }

  if (!(code instanceof APair)) {
    return code; // atoms self-evaluate
  }

  // Tap: fire enter/exit for parsed Pairs (those carrying __location__); atoms and
  // macro-expansion-constructed Pairs (no location) are skipped.
  const tap = ctx.tap;
  if (tap && LOCATION in code && (!ctx.nodeFilter || ctx.nodeFilter(code))) {
    const inv = tap.enter(code, ctx.currentInvocation ?? null, ctx.tail === true);
    const childCtx: EvalContext = { ...ctx, currentInvocation: inv };
    return yield {
      call: evaluatePair(code, childCtx),
      // Pass-through, tail-collapsible: on a tail call this slot's tap.exit composes
      // onto the replacement so it still fires when the tail chain returns.
      tail: true,
      // Surface the tap's substituted value back through the trampoline: `tap.exit`
      // computes provenance and returns a `withProvenance` clone via `{ value }`, so
      // the stamped clone — not the raw result — is what the surrounding
      // `define`/`let`/arg binds.
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
// trivially quote a call head or over-parenthesize), so per Rule 0 (assert
// internally, validate at the boundary) they throw plain doors, not `invariant()`:
// an `invariant()` failure prefixes "Invariant failed: ", reading like an engine
// bug rather than a program mistake. The door names the offending value's TYPE, not
// its content — a message echoing a quoted string head's own content reads like a
// failed TOOL CALL rather than the syntax mistake it is.

/**
 * Shared "operator position holds a non-callable value" door — used both by
 * `nonCallableHeadError` below (a literal head that isn't a string, e.g. a
 * bare number/vector/boolean) and by the post-dispatch site at the bottom of
 * `evaluatePair` (a COMPUTED head — `((f x) y)` — or any resolved value that
 * fell through every callable check). Names the actual scheme-visible type via
 * `type()` (dict/vector/pair/number/…) rather than `typeof`, which collapses
 * every boxed value to "object". The over-parenthesization hint targets `((call))` /
 * Python-habit `print(x)`, the most common route to a non-function value in call-head
 * position.
 */
function notCallableError(value: unknown): Error {
  const looksDictShaped = value instanceof AJSObject && isDictShaped(value.source);
  const typeName = value instanceof ADict || looksDictShaped ? "dict" : type(value);
  return new NotCallableError("type", typeName);
}

/**
 * Door for a non-callable LITERAL directly in operator position —
 * `[("open-library/get_book_by_title" :title "…")]` or `(42 :x 1)`. A quoted string
 * head is the most common shape: a model writes a tool/symbol name as a STRING (data,
 * not a reference), so the door must NOT echo the string's content or it reads like
 * the tool itself failed. Every other literal type (number, vector, boolean, …) falls
 * through to the shared `notCallableError` door so the wording never drifts between
 * the two application-position sites.
 */
function nonCallableHeadError(first: SchemeValue): Error {
  if (first instanceof AString) {
    const content = first.valueOf();
    return new NotCallableError("quoted-string", "string", content);
  }
  return notCallableError(first);
}

// `code`'s car/cdr are SchemeValues: every caller narrows via the evaluator's
// `is_pair` (→ `APair<SchemeValue, SchemeValue>`) before dispatching here, so the
// form head and tail are boxed scheme values, not the generic `unknown` slots
// `APair`'s default parameters carry for the membrane/reader boundary.
function* evaluatePair(code: APair<SchemeValue, SchemeValue>, ctx: EvalContext): EvalGenerator {
  const first = code.car;
  const rest = code.cdr;

  // Error-report frame. The debug name is the lexical frame's `__name__` (the
  // LexicalScope env underlying the resolver) — `resolver.env`.
  const frame: StackFrame = {
    code,
    env_name: String(ctxResolver(ctx).env.__name__),
    procedure: first instanceof ASymbol ? symbol_name(first) : undefined,
  };

  // Head and args evaluate NON-tail; only the final fn.apply is tail (preamble TAIL
  // PROPAGATION). The parent's tail flag passes into the special handler, which threads
  // it to its own terminal sub-expression.
  const nonTailCtx: EvalContext = ctx.tail ? { ...ctx, tail: false } : ctx;

  // Special-form dispatch, VALUE-FIRST: a head resolving to a Keyword marker dispatches
  // the handler by the marker's NAME, so special-ness travels with the VALUE (aliasable
  // via `(define => lambda)`). The string-keyed fallback (`symbol_name`) stays for two
  // INDEPENDENT reasons, not as a migration path (every form IS keyword-bound in core.ts):
  //   1. BOOTSTRAP ORDERING — a capability's `prelude` scheme evaluates before its own
  //      `symbols` keyword bindings resolve (phase-gated prelude scope, kernel.ts's
  //      `assembleEnv`), so `define`'s first uses (bootstrapping `true`/`false`/… in
  //      core.ts) hit the fallback with `resolved === undefined`, though `define` is bound.
  //   2. LEXICAL SHADOWING — `(let ((if 5)) (if))` resolves `if` to the shadowing value,
  //      and the fallback still dispatches `evalIf` BY NAME: a documented gap
  //      (kernel-keyword-dispatch.test.ts). Removing it would flip to R7RS-faithful
  //      un-specialing — a real behavior change no test covers — so it stays until fixed.
  // Resolve via the RAW binding key (`first.__name__`), the SAME key env_get uses, so a
  // hygiene-renamed gensym head resolves identically: a gensym's `__name__` JS-symbol key
  // differs from its string description, so a description lookup would miss and try to CALL
  // the resolved Keyword. `symbol_name` stays only the fallback key (bootstrap/shadowing).
  if (first instanceof ASymbol) {
    const resolved = ctxResolver(ctx).lookup(first.__name__, ctx.runCtx);
    const handler = resolved instanceof Keyword ? SPECIAL_FORMS[resolved.name] : SPECIAL_FORMS[symbol_name(first)];
    if (handler) {
      // Pass-through dispatch — the special form's result IS this Pair's result; tail so a
      // tail call from its terminal expression collapses this frame too.
      return yield { call: handler(rest, ctx), frame, tail: true };
    }
  }

  // Operator position admits a value (procedure) OR — when the head is a symbol resolving
  // to one — a `Macro`/`Syntax` expander (split below by `is_function`/`is_macro`). A
  // computed head (pair) or a literal head can only be a value: macros are not first-class.
  let fn: SchemeValue | Macro | Syntax;
  if (first instanceof APair) {
    fn = yield { call: evaluate(first, nonTailCtx), frame };
    if (is_promise(fn)) {
      fn = yield fn;
    }
  } else if (first instanceof ASymbol) {
    fn = resolvedBindingOrThrow(ctxResolver(ctx).resolve(first, ctx.runCtx), first);
    // Fire the tap on this call-head fast path (it bypasses `evaluate()`), else tracers
    // miss every function name's resolved value. Skip it for a macro/syntax operator.
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

    // Thread the dynamic call site so user lambdas invoked synchronously from native JS
    // (map/filter) pick up THIS Pair's invocation as parent, not the lexical one captured
    // at lambda creation. Two-pronged: (a) the module-level holder for synchronous HOF
    // iteration; (b) a per-lambda wrapper for HOFs that recurse via promises (reduce/fold/
    // find call `maybeThen().then(callback)` from a microtask AFTER finally restores the
    // holder) — each wrapped lambda re-installs its site per invocation, so iter N+1 still
    // sees the right parent.
    //
    // `canBounce = is_lambda(fn)` opts a Scheme lambda into the bounce protocol (preamble):
    // a plain per-call local (nothing reads it ambiently), passed as the apply term's third
    // argument.
    const dynSite = ctx.currentInvocation;
    const __savedDynamicCallSite = currentDynamicCallSite();
    setDynamicCallSite(dynSite);
    const canBounce = is_lambda(fn);
    const __savedRunResolver = globalThis.__arrivalRunResolver;
    // Publish the composed resolver as the rosetta membrane's env back-channel
    // (llm-plane-arrival-env/prompt.ts reads `currentRunEnv()` under a ctx-less `apply`;
    // `require` reads the full `currentRunResolver()` so module forms keep the run's
    // capability base). Only the env/resolver rides this holder — meter/strict run-state
    // travel on `ctx.runCtx` / the operand ctx.
    globalThis.__arrivalRunResolver = ctxResolver(ctx);
    const wrappedArgs = wrapLambdaArgs(args, dynSite);
    let result: SchemeValue;
    try {
      // A callable VALUE dispatches through its apply term with the computed `canBounce`
      // (`runCtx` threaded explicitly, no `this`-smuggling); an ALambda bounces in tail
      // position, an ANativeProcedure ignores canBounce. NOT `applyCallback`, which forces
      // canBounce=false (the HOF-callback contract). A bare fn keeps the legacy
      // `this: CallCtx` apply.
      result =
        is_callable_value(fn) || is_applyable(fn)
          ? (fn[tf("apply")](wrappedArgs, ctx.runCtx, canBounce) as SchemeValue)
          : // Only the plain-JS-function case remains (the ternary excluded the other two
            // the outer gate admits). Its result boxes through the membrane: this bare-fn
            // survivor path (registry packs / legacy env.set of raw fns) is the last exit
            // whose raw scalar returns could reach value space unboxed and die at exec's R1
            // strict exit. `jsToScheme` is identity on already-boxed values, so
            // self-boxing wrappers (legacy defineRosetta) pay one instanceof.
            (maybeThen(
              Reflect.apply(
                fn as (...args: unknown[]) => unknown,
                makeCallCtx(ctx.runCtx, ctx.currentInvocation as InvocationLike | undefined),
                wrappedArgs,
              ),
              (v) => jsToScheme(ctx.runCtx, v, {}),
            ) as SchemeValue);
    } finally {
      setDynamicCallSite(__savedDynamicCallSite);
      globalThis.__arrivalRunResolver = __savedRunResolver;
    }

    // Bounce result — the callee handed back its body generator (preamble BOUNCE
    // PROTOCOL). In tail position, yield a `tailCall` so the trampoline collapses the
    // whole tail tower. Otherwise push the body as a sub-call marked `tail` (this
    // `return yield { call }` is itself pass-through), so a tail call from INSIDE the
    // body still collapses up to — but not through — the non-tail consumer beneath this
    // frame (e.g. the evaluateArgs collector when the callee is an argument).
    if (is_bounce(result)) {
      if (ctx.tail) {
        return yield { tailCall: { generator: result.generator, frame } } as unknown as SchemeValue;
      }
      return yield { call: result.generator, frame, tail: true };
    }

    // Retrospective-stream emission hook, flag-gated OFF by default (see
    // provenance-hooks.ts for why this is the port site). Detached from `result` — never
    // wraps/replaces/awaits it — so it is a single boolean read, provably inert when off.
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
    // `is_syntax(fn) ? code : rest`: syntax-rules patterns carry a keyword slot as their
    // FIRST element, so the matcher (extract_patterns) needs the FULL form (`code`);
    // define-macro fexprs want the keyword-stripped `rest`. Passing `rest` to both makes
    // the keyword consume the first arg — an off-by-one breaking fixed-arity matching,
    // arity discrimination, and ellipsis. See src/__tests__/syntax-rules-arity-offbyone.test.ts.
    //
    // STILL OPEN (deferred, tracked as the vector-pattern `it.fails` block): syntax-rules
    // VECTOR patterns need a SchemeVector unwrap in matcher/expander; dotted-tail-after-
    // ellipsis template, `_`-wildcard binding, let-syntax recursive hygiene.
    //
    // syntax-rules (Syntax) is FORM-RETURNING: `expand` returns `{ expr, scope }` (form +
    // hygiene scope) with NO nested evaluation, yielded into THIS trampoline in tail
    // position. A NESTED `run()` would nest one host-stack frame per iteration of a
    // tail-looping macro and overflow; form-returning gives a tail-position macro the same
    // O(1) TCO as a special form (a transformer is Exp→Exp; it must never evaluate inside itself).
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

    // The expansion takes the PARENT's tail flag: a macro invoked in tail position must
    // make its expansion tail too, else rewriting a TCO-critical form through a macro
    // (e.g. `when` → `(if test body)`) silently loses TCO at the rewrite boundary. Mark
    // pass-through so the collapse reaches through this dispatch (a tail call is never a
    // JS promise, so the post-yield promise check is safe to collapse past).
    let result = yield { call: evaluate(expansion, ctx), tail: true };
    if (is_promise(result)) {
      result = yield result;
    }
    return result;
  }

  // Nothing above matched — fn is not a callable kind. (A borrowed JS function crosses
  // the membrane as #void, so it never reaches here as a call head.)
  throw notCallableError(fn);
}

/** Evaluate an argument list, flat-trampolined (no `yield*`). */
function* evaluateArgs(rest: SchemeValue, ctx: EvalContext): Generator<unknown, SchemeValue[], SchemeValue> {
  const args: SchemeValue[] = [];
  let node: SchemeValue = rest;

  while (node instanceof APair) {
    let arg = yield { call: evaluate(node.car, ctx) };
    if (is_promise(arg)) {
      arg = yield arg;
    }

    args.push(arg);
    node = node.cdr;
  }

  SpecialFormShapeError.invariant(node instanceof ANil || node === null, "apply", "improper list in function call");

  return args;
}

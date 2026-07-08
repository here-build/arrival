/**
 * Public `exec`/`parse` entry point: bridges the reader (now the leaf reader/parse.ts,
 * the upstream-LIPS-derived reader) to the generator-based evaluator. Self-bootstraps
 * the runtime on first use, then drives each top-level form through `run()`.
 *
 * Usage:
 *   import { exec } from "./generator-exec.js";
 *   const results = await exec("(+ 1 2 3)");  // Returns [6]
 *   const results = await exec("(+ 1 2)", { env: myEnv });
 */

import { Environment } from "../Environment.js";
import { user_env, global_env } from "../env-roots.js";
import run, { evaluate, expectValue, ArrivalError, type EvalTap } from "./evaluator.js";
import { isHostRuntimeBug } from "../errors.js";
import { Resolver } from "./Resolver.js";
import { Capabilities } from "./Capabilities.js";
import { LexicalScope } from "./LexicalScope.js";
import { assembleEnv } from "../common/kernel.js";
import type { EnvCapability } from "../common/capability.js";
import type { EvalSchemeInto } from "../common/scheme-env.js";
import { parse as readerParse } from "../reader/parse.js";
import { classifierFromEnv } from "../values/lineage-classifier-from-env.js";
import { assertShadowCone } from "../values/lineage-shadow.js";
import { classify, type LineageNode } from "../values/lineage.js";
import { APair } from "../values/primitives/APair.js";
import { makeRunContext, type RunContext } from "../values/primitives/RunContext.js";
import type { AListAlike, SchemeValue } from "../values/types.js";

// The value-layer shadow-cone skip reads the macro classes' `[CLASS]` brand
// directly via `is_macro_value` in value-guards.ts — a downward, eval-import-free
// test, so this module needs no runtime DI for it.

/**
 * The realm-cached lexical root for DEFAULT (no-env) exec — a null-rooted scratch frame
 * where top-level user `define`s land, CUT from the capability base. Builtins resolve through
 * the assembled Resolver (`scope.lookup ?? capabilities.lookup`), NOT this env's `__parent__`
 * chain (it has none). Cached as a realm singleton so default defines ACCUMULATE across exec
 * calls — matching the pre-cut `user_env` accumulation. Custom-env (`exec({ env })`) callers
 * stay glass and never touch it. Lazily built so its identity is a leaf (no env-roots cycle).
 */
let _defaultLexicalRoot: Environment | undefined;
function defaultLexicalRoot(): Environment {
  return (_defaultLexicalRoot ??= new Environment("user-program", {}, null));
}

/**
 * The realm-cached runtime bootstrap — the lazy base assembly, driven directly by `exec`.
 *
 * Folds the base `assembleEnv` into a realm-cached promise — exactly the
 * `defaultLexicalRoot()` pattern above, async-flavoured: the `??=` assigns the
 * in-flight promise synchronously, so the cache IS the once-only guard (a second
 * `exec`, or a re-entrant prelude exec, sees the same settled/in-flight promise).
 *
 * Two steps, order-significant:
 *   1. GLOBAL_NATIVE_PACKS (value-domain clusters + numeric + exceptions) onto global_env,
 *      symbol-only (no prelude → no evalScheme).
 *   2. BASE_PACKS (the `.scm` stdlib: core/macros/polyglot/r7rs/srfi, `nil` among them) onto
 *      user_env. A base-pack prelude may call a native primitive (`+`, `string-length`), which
 *      resolves user_env → global_env, so the natives in step 1 must already be live.
 *
 * The pack rosters are imported DYNAMICALLY: `BASE_PACKS`/polyglot transitively pull the
 * evaluator (membrane), so a static import here would close a module-eval cycle. The
 * dynamic import is awaited exactly once (promise-cached), so it costs nothing after warm-up.
 *
 * `skipBootstrapWait: true` on the prelude evalScheme: those execs ARE this assembly, so they
 * must not re-enter the gate (which would await the very promise they are part of — deadlock).
 */
let _baseAssembled: Promise<void> | undefined;
export function ensureBaseAssembled(): Promise<void> {
  return (_baseAssembled ??= (async () => {
    // The native root is populated ENTIRELY by the assembled packs below
    // (GLOBAL_NATIVE_PACKS + BASE_PACKS). Dynamic import only, by design — no
    // static importer — so the package can declare `sideEffects: false`.
    const { GLOBAL_NATIVE_PACKS } = await import("../bridge.js");
    const { BASE_PACKS } = await import("../env/base-packs.js");
    const evalScheme: EvalSchemeInto = (env, src) =>
      exec(src as string, { env: env as Environment, skipBootstrapWait: true });
    await assembleEnv(
      global_env,
      GLOBAL_NATIVE_PACKS.map((pack) => pack.lower()),
    );
    await assembleEnv(
      user_env,
      BASE_PACKS.map((pack) => pack.lower({ evalScheme })),
    );
  })());
}

// Evaluator injected into a capability's prelude during `exec({ capabilities })`
// assembly — mirrors `ensureBaseAssembled`'s / _fresh-env's evalScheme. `skipBootstrapWait`:
// the assembly happens AFTER `exec`'s own bootstrap gate (below), so the prelude eval must
// not re-await the (already-settled) bootstrap promise.
const capabilityEvalScheme: EvalSchemeInto = (env, src) =>
  exec(src as string, { env: env as Environment, skipBootstrapWait: true });

/**
 * Build the capability base for `exec({ capabilities })`: a fresh `user_env` child with the
 * supplied capabilities assembled on top, so they AUGMENT the standard assembled base
 * (`user_env → global_env`) rather than replace it. A fresh child per call keeps the user's
 * capabilities out of the shared `user_env` (no cross-call bleed); a caller wanting a
 * persistent capability env builds it once with `assembleEnv` and passes it as `{ env }`.
 *
 * `config` is the ONE shared bag (see `ExecOptions.config`) handed to every capability's
 * `lower()` — each validates its own slice; `assembleEnv` supplies the phase-gated prelude
 * scope, so `preludeOnly` symbols work here with no extra wiring.
 */
async function assembleCapabilityBase(capabilities: readonly EnvCapability[], config?: object): Promise<Environment> {
  const base = user_env.inherit("exec-capabilities");
  await assembleEnv(
    base,
    capabilities.map((c) => c.lower({ evalScheme: capabilityEvalScheme, config })),
  );
  return base;
}

export interface ExecOptions {
  /**
   * GLASS — a custom base env. When set, the resolver wraps it directly: defines land in it
   * and builtins resolve up its `__parent__` chain (byte-identical to pre-cut behavior). Takes
   * precedence over `capabilities`/`scope` (the cut refinements); use `env` OR the cut options.
   */
  env?: Environment;
  /**
   * THE CUT, capability-refined. EnvCapability packs assembled onto the standard base
   * (`user_env → global_env`) for THIS run — the inference plane's nil-compat, an MCP/infer
   * capability, etc. — instead of the bare default base. Assembled per call onto a fresh
   * `user_env` child (no cross-call bleed). Ignored when `env` (glass) is set.
   */
  capabilities?: readonly EnvCapability[];
  /**
   * THE SHARED CONFIG BAG for `capabilities` (inert without them). ONE object handed to every
   * capability's `lower({ config })`: each capability validates its OWN slice against its
   * `configuration` zod schemas (`z.object` strips the keys it doesn't declare), so unrelated
   * capabilities ride one bag without knowing about each other. Deliberately reference-shared,
   * never cloned or split per capability: `EnvCapability.lower` threads the SAME raw object to
   * its deps, so the kernel's closure dedup matches a capability's root + dep appearances by
   * IDENTITY instead of tripping `AssembleConfigConflictError` (the idiom `buildArrivalEnv`
   * pioneered — "each capability validates its own slice of the SHARED opts config").
   */
  config?: object;
  /**
   * THE CUT, scope-refined. The lexical root the run's top-level `define`s land in. Pass a
   * persistent {@link LexicalScope} (`LexicalScope.for(env)`) across calls for REPL-style
   * multi-step accumulation, instead of the realm-cached default scratch frame. Builtins still
   * resolve through the capability base (composed `scope.lookup ?? capabilities.lookup`).
   * Ignored when `env` (glass) is set.
   */
  scope?: LexicalScope;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  /** Tap for tracing per-form evaluation enter/exit. See EvalTap. */
  tap?: EvalTap;
  /** Predicate to suppress tap firing for specific nodes (atoms always skipped). Piped straight
   *  through to `EvalContext.nodeFilter` (evaluator.ts), whose domain is the full `AListAlike`
   *  spine, not just `APair` — matching that signature exactly instead of the narrower one. */
  nodeFilter?: (node: AListAlike) => boolean;
  /**
   * Execution-budget signal. When the signal aborts, the trampoline throws
   * `signal.reason ?? DOMException("aborted", "AbortError")` at the next
   * iteration boundary. See `EvalContext.signal` in evaluator.ts — the 5ms
   * event-loop yield prevents UI freeze but does NOT bound CPU, so
   * `(define (loop) (loop))` needs an external bound for sandbox use.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock execution budget in milliseconds. Unlike `signal` (which needs
   * an external controller to fire), this is an INTERNAL bound: the trampoline
   * throws a `ArrivalError(/budget/)` once `budgetMs` of wall-clock elapses,
   * checked at the same iteration boundary that yields to the event loop. This
   * is the bound sandbox / agent code needs so `(let loop () (loop))` can't hang
   * the host. Composable with `signal` — whichever fires first wins.
   */
  budgetMs?: number;
  /**
   * Per-run ALLOCATION budget — the memory analogue of `budgetMs`. Caps the cumulative number of list
   * cells materialized through the two collection-op choke points — `to_array` (append/join/reverse/…) and the
   * fl-interop sequence-op dispatch (filter/map/reduce over a Pair/Vector, charged at the dispatch
   * since the term walk bypasses to_array). The
   * wall-clock budget is checked at trampoline TICKs, which a single native list pass (`filter`/
   * `append` over a large list) never hits — so an O(K²)-churn loop runs uninterruptibly until it
   * stack-overflows. This bound IS checked inside that loop. Undefined ⇒ unbounded (the default; only
   * sandbox / agent runs opt in). Composable with `budgetMs`/`signal` — whichever fires first wins.
   */
  heapBudget?: number;
  /**
   * Interpreter-level NIL-TOLERANCE mode. When `true`, projection ops
   * (`car`/`cdr` and friends) applied to `null`/nil THROW instead of resolving
   * tolerantly to `nil`. Default (`undefined`/`false`) is TOLERANT — today's
   * behavior, where projecting nil yields nil.
   *
   * Nil-tolerance is a real evaluation mode threaded through `EvalContext.strict`,
   * not an env decoration. The inference-plane `car`/`cdr` (env/fl-interop.ts) read
   * this off `ctx.runCtx.strict`: default ⇒ a nil/null projection yields nil, strict
   * ⇒ the R7RS throw. A wrong-TYPE arg (car of a number/string) throws in BOTH
   * modes — tolerance is scoped to absence. The base `user_env` car/cdr are
   * unaffected (always R7RS-strict); `first`/`second`/… and the cxr accessors
   * are a later parity step.
   */
  strict?: boolean;
  /**
   * Opt OUT of freezing borrowed rosetta returns. Default (`undefined`/`true`) `Object.freeze`s the
   * borrowed JS source inside AJSObject/AJSArray the first time Scheme reads it, so the host can't
   * mutate a returned value afterward (prevention by construction, replacing the dev-only purity
   * assert). Set `false` to keep borrowed returns mutable for hosts that intend to keep writing them.
   */
  freezeRosettaReturns?: boolean;
  /**
   * Internal: set by the bootstrap's own prelude evals (`ensureBaseAssembled`'s
   * `evalScheme`) to bypass the bootstrap gate below — awaiting `ensureBaseAssembled`
   * there would deadlock (the prelude eval IS part of the realm-cached promise it
   * would be waiting on).
   */
  skipBootstrapWait?: boolean;
  /**
   * SHADOW MODE (provenance-static-lineage-finalization §8). When set, after each
   * top-level form is evaluated, the static lineage `fullCone` (values/lineage.ts)
   * is computed and ASSERTED equal to the form's UNTAPPED eager `result.provenance`.
   * A divergence throws `ProvenanceShadowDivergence`. Read-only cross-check of the
   * static classifier against the live engine — does NOT alter evaluation;
   * **flag-OFF (the default) is byte-identical**, as the skeleton build + assert are
   * gated entirely behind this flag. Asserts `fullCone` only (never `countCone`,
   * which diverges by design — the v0.2 minimal cone). Forms outside shadow's
   * provable set are skipped + recorded, not asserted.
   *
   * NAME CAVEAT: the `ir`-prefix is borrowed (from the studio's `--ir-*`
   * compile-erased-superset markers) and is a MISFIT here — this flag toggles
   * shadow/dual-run VALIDATION, it does not lower an authoring superset to spec.
   * Read it as "validate-static-lineage," not an IR feature. (Eventual public
   * name: `--ir-lineage`.)
   */
  irLineage?: boolean;
  /**
   * The Rosetta-IN (provenance-MINTING) op names for `classifierFromEnv` when
   * `irLineage` is on (the documented explicit seam — the env has no source
   * registry yet). DEFAULT empty ⇒ the SOURCE-FREE provable scope: untapped eager
   * eval does not mint at sources (the mint is tap-gated, rosetta.ts:453, falling
   * back to input provenance), so a declared-source program's untapped result need
   * not match a `{kind:source}` skeleton — shadow is scoped to source-free programs
   * where it genuinely matches. Pass a set only when extending shadow knowingly.
   */
  irLineageSources?: Iterable<string>;
}

/**
 * COMPLEX tier (docs/working-proposals/two-tier-exec-api.md, RULINGS.md R1) — "run,
 * get reusable state": boxed, provenance-bearing results PLUS the session handles a
 * caller needs to continue or introspect the run. Not a membrane crossing (P4's
 * refinement) — this hands boxed state to JS-side TOOLING (law tests, REPL
 * continuation, arrival-chain), it does not exit. `exec` (SIMPLE tier, below)
 * delegates here and unwraps; `execExpr`/`evaluator.exec` are the other COMPLEX-tier
 * entries (form-at-a-time; unchanged by this migration).
 */
export interface ExecState {
  /** Boxed, provenance-bearing results — one per top-level form. */
  readonly values: readonly SchemeValue[];
  /**
   * The run's lexical accumulation handle — the SAME type `ExecOptions.scope`
   * accepts. When the caller passed `scope`, this IS that object (identity holds via
   * `LexicalScope.for`'s per-env memoization); when not, it wraps the run's
   * `lexicalRoot` so a follow-up `execState(code, { scope })` continues the session.
   * Glass-env runs (`env` option set) have no cut scope — `scope` is the wrapper over
   * that env's exec frame.
   */
  readonly scope: LexicalScope;
  /** The per-run hermetic handle (strict / heap meter / signal). */
  readonly runCtx: RunContext;
}

/**
 * Parse and execute Scheme code using the generator-based evaluator — the COMPLEX
 * tier (see {@link ExecState}). This IS the exec body; `exec` (SIMPLE tier) is a
 * thin delegate over this that unwraps `state.values`.
 *
 * @param code - String of Scheme code or pre-parsed SchemeValue
 * @param options - Optional environment and dynamic binding options
 * @returns Promise<ExecState> - boxed results + the run's scope/runCtx handles
 */
export async function execState(
  code: string | SchemeValue,
  {
    env,
    capabilities,
    config,
    scope,
    dynamic_env,
    use_dynamic,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    heapBudget,
    strict,
    freezeRosettaReturns,
    skipBootstrapWait,
    irLineage,
    irLineageSources,
  }: ExecOptions = {},
): Promise<ExecState> {
  // Resolve the default env from the env-roots leaf — `user_env` is arrival's
  // interaction scope (`global_env.inherit("user-env")`), sourced STATICALLY so this
  // entry never imports the stdlib monolith. The bootstrap gate below drives
  // population: `ensureBaseAssembled` assembles the native packs + the `.scm` base.
  const actualEnv = env ?? user_env;

  // Self-initialize the runtime bootstrap (native packs + the `.scm` base) lazily, so
  // embedders never trigger it manually. `ensureBaseAssembled` is realm-cached (a single
  // in-flight/settled promise), so the first exec assembles and every later exec awaits the
  // same settled promise — no half-assembled env can be observed. `skipBootstrapWait` is the
  // one exception: a base-pack prelude eval IS the bootstrap and must not await its own promise.
  if (!skipBootstrapWait) await ensureBaseAssembled();

  let parsed: SchemeValue[];
  if (typeof code === "string") {
    // Thread strict into the reader so the R7RS control rejects loose-mode literals
    // (#void/#null) at parse time. Default false ⇒ loose parse, unchanged.
    parsed = await readerParse(code, undefined, strict ?? false);
  } else if (code instanceof APair) {
    parsed = [code];
  } else {
    parsed = [code];
  }

  // SHADOW MODE slice 2 — classify@load. Build one static lineage skeleton per
  // parsed form, BEFORE evaluation. Pure (classify runs no eval); gated entirely
  // behind the flag so the flag-OFF path is byte-identical. The classifier is
  // env-derived (classifierFromEnv); `irLineageSources` defaults empty ⇒ the
  // source-free provable scope (see ExecOptions.irLineageSources). Skeletons align
  // by index with `parsed`, consumed at the per-form assert hook below.
  let shadowSkeletons: LineageNode[] | undefined;
  if (irLineage) {
    const classifier = classifierFromEnv(actualEnv, new Set(irLineageSources));
    shadowSkeletons = parsed.map((form) => classify(form, classifier));
  }

  // Evaluate each expression in sequence. The budget spans the WHOLE exec call
  // (all top-level forms share one deadline) — a sandbox program that splits a
  // hang across several forms is still bounded. Recompute the remaining budget
  // per form from a single start so we don't reset the clock between forms.
  // Install the per-run allocation meter on the run's top env AFTER parse/init (so bootstrap + parse
  // allocations don't count against the user program), spanning the WHOLE exec like the wall-clock
  // budget. Save/restore the prior meter so a nested exec on the same env can't clobber the outer
  // one. `to_array` finds it by walking the parent chain from the calling scope.
  // The per-run context (the hermetic handle; see RunContext) carries strict + the heap
  // meter; `exec` also installs the meter on the env node below (where `to_array`/
  // fl-interop find it by parent-walk) until those readers move to `runCtx` directly.
  const runCtx = makeRunContext({ strict: strict ?? false, heapBudget, freezeRosettaReturns, signal });
  // ── THE EXEC SEAM: glass-for-custom-env, cut-for-default, refined by capabilities/scope ──
  // A custom `env` stays GLASS — the resolver wraps it, defines land in it, builtins resolve
  // up its base-linked chain — byte-identical (zero change for arrival-chain/inhuman). `env`
  // wins over the cut refinements (capabilities/scope), which are ignored when it is set.
  // No env → THE CUT: a lexical root (`scope.env` for REPL accumulation, else the realm-cached
  // null-rooted scratch frame) holds user defines; the assembled base (`actualEnv`, optionally
  // AUGMENTED with `capabilities`) supplies builtins; the Resolver composes the two. `actualEnv`
  // (the BASE) still drives bootstrap + the classifier above; only the resolution topology changes.
  let runResolver: Resolver;
  if (env !== undefined) {
    runResolver = new Resolver(actualEnv);
  } else {
    const capabilityBase =
      capabilities !== undefined
        ? Capabilities.assembled(await assembleCapabilityBase(capabilities, config))
        : Capabilities.assembled(actualEnv);
    const lexicalRoot = scope !== undefined ? scope.env : defaultLexicalRoot();
    runResolver = new Resolver(lexicalRoot, capabilityBase);
  }
  // The run's exec frame = the resolver's lexical env (glass: actualEnv; cut: lexicalRoot).
  // Defines land here, the evaluator's `ctx.env` is here, and the heap meter installs here —
  // found by `findHeapMeter` walking the parent chain from a nested `_currentRunEnv`.
  const execEnv = runResolver.env;
  const priorMeter = execEnv.__heapMeter__;
  // Point the env-node meter at the SAME object runCtx holds, so the N2 flip to
  // `operand.ctx.heapMeter` reads the live meter with no behavior change.
  if (runCtx.heapMeter !== undefined) execEnv.__heapMeter__ = runCtx.heapMeter;

  const results: SchemeValue[] = [];
  const start = budgetMs === undefined ? 0 : performance.now();
  try {
    for (let i = 0; i < parsed.length; i++) {
      const expr = parsed[i];
      const remaining =
        budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      // Preserve the audit-#42 wrapOperator contract: run() wraps every non-ArrivalError
      // — including the TypeError wrapOperator throws to name operator + arg types — in
      // an ArrivalError, masking both the TypeError class and its membrane cause. Surface
      // the original TypeError so the user-visible error shape survives.
      let result: SchemeValue;
      try {
        // A top-level form evaluates to a value, never a bare expander — seal it.
        result = expectValue(
          await run(
            evaluate(expr, {
              resolver: runResolver,
              dynamic_env,
              use_dynamic,
              tap,
              nodeFilter,
              signal,
              // Default false ⇒ today's tolerant nil-projection. No consumer reads
              // ctx.strict yet (scaffolding); the car/cdr dispatch reads it later.
              strict: strict ?? false,
              // The per-run handle, threaded as data (unread scaffold; N2 reads it).
              runCtx,
            }),
            { signal, budgetMs: remaining },
          ),
        );
      } catch (e) {
        if (e instanceof ArrivalError && e.cause instanceof TypeError && !isHostRuntimeBug(e.cause))
          throw e.cause;
        throw e;
      }
      results.push(result);

      // SHADOW MODE slice 3 — the assert. Compare the static fullCone against this
      // form's UNTAPPED eager `result.provenance` (mechanism 1; NO tap installed).
      // In-scope divergence throws ProvenanceShadowDivergence; a macro-head /
      // keyword-projection form abstains (returns a skip reason we discard — it is
      // outside the classifier's model, so shadow does not assert it). Behind the
      // flag — never runs flag-OFF.
      if (irLineage && shadowSkeletons) {
        assertShadowCone(shadowSkeletons[i], expr, result, actualEnv, String(expr));
      }
    }
  } finally {
    if (heapBudget !== undefined) execEnv.__heapMeter__ = priorMeter;
  }

  return { values: results, scope: runResolver.scope, runCtx };
}

/**
 * SIMPLE tier (docs/working-proposals/two-tier-exec-api.md, RULINGS.md R1) — THE
 * default exec surface, "run, get JS". Delegates to {@link execState} (COMPLEX
 * tier) and returns just its boxed `values`.
 *
 * NOTE (migration step 1 of 5, §8): this step is BEHAVIOR-UNCHANGED — `values` is
 * still boxed `SchemeValue[]`, not plain JS. The `toJS` final-unwrap (making this
 * tier's return type genuinely `unknown[]`) is step 4, a later task; do not add it
 * here.
 *
 * @param code - String of Scheme code or pre-parsed SchemeValue
 * @param options - Optional environment and dynamic binding options
 * @returns Promise<SchemeValue[]> - Array of evaluation results (one per expression)
 *
 * @example
 * ```typescript
 * // Simple arithmetic
 * const [result] = await exec("(+ 1 2 3)");  // result = 6
 *
 * // Multiple expressions
 * const results = await exec("(define x 10) (+ x 5)");  // results = [undefined, 15]
 *
 * // With custom environment
 * const env = new Environment("my-env", { x: 42 });
 * const [result] = await exec("x", { env });  // result = 42
 * ```
 */
export async function exec(code: string | SchemeValue, options: ExecOptions = {}): Promise<SchemeValue[]> {
  const state = await execState(code, options);
  return state.values.slice();
}

/**
 * Parse Scheme code without evaluating (delegates to the reader leaf, reader/parse.ts).
 * `source` (a filename / module path) is
 * stamped onto every produced location, so frames built from these forms read as
 * `file:line` — used by `(require …)` to attribute a module's throws to its file.
 */
export async function parse(code: string, _env?: Environment, source?: string): Promise<SchemeValue[]> {
  // _env retained for API compat but inert: the reader no longer consults an env (the
  // reader-extension lookup that used it was removed). Parsing is now a pure reader-leaf call.
  return readerParse(code, source);
}

/**
 * Execute a single pre-parsed expression. COMPLEX tier (two-tier-exec-api §3) — the
 * internal form-at-a-time entry (require, prelude eval); returns one boxed
 * SchemeValue, never unwrapped. Use this when you've already parsed the code.
 */
export async function execExpr(
  expr: SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal, budgetMs, skipBootstrapWait }: ExecOptions = {},
): Promise<SchemeValue> {
  const actualEnv = env ?? user_env;

  // See exec() above: the realm-cached lazy bootstrap, awaited once.
  if (!skipBootstrapWait) await ensureBaseAssembled();

  // THE EXEC SEAM (see exec): glass for custom env, the cut for default (fresh null-rooted
  // lexicalRoot + the assembled base).
  const runResolver =
    env !== undefined
      ? new Resolver(actualEnv)
      : new Resolver(defaultLexicalRoot(), Capabilities.assembled(actualEnv));

  // Mint a per-run handle here too (mirrors exec() above) — closes two gaps at once: a
  // required-module impl reading `this.runCtx.signal` (CallCtx) now sees the SAME abort
  // signal `ctx.signal` already carries here, and the handler-stack WeakMap (exceptions.ts)
  // stops falling back to the shared CONSTANT_CTX bucket for every require'd module.
  const runCtx = makeRunContext({ signal });

  try {
    // A top-level form evaluates to a value, never a bare expander — seal it.
    return expectValue(
      await run(
        evaluate(expr, {
          resolver: runResolver,
          dynamic_env,
          use_dynamic,
          tap,
          nodeFilter,
          signal,
          runCtx,
        }),
        { signal, budgetMs },
      ),
    );
  } catch (e) {
    if (e instanceof ArrivalError && e.cause instanceof TypeError) throw e.cause;
    throw e;
  }
}

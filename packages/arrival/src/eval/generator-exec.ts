/**
 * Public `exec`/`parse` entry: bridges the reader (leaf reader/parse.ts,
 * upstream-LIPS-derived) to the generator evaluator. Self-bootstraps the
 * runtime on first use, drives each top-level form through `run()`.
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
import { sealResolutionChain } from "./CompiledResolutionChain.js";
import type { EnvCapability } from "../common/capability.js";
import type { EvalSchemeInto, SchemeEnv } from "../common/scheme-env.js";
import invariant from "tiny-invariant";
import { parse as readerParse } from "../reader/parse.js";
import { classifierFromEnv } from "../values/lineage-classifier-from-env.js";
import { assertShadowCone } from "../values/lineage-shadow.js";
import { classify, type LineageNode } from "../values/lineage.js";
import { APair } from "../values/primitives/APair.js";
import { makeRunContext, type RunContext } from "../values/primitives/RunContext.js";
import type { AListAlike, SchemeValue } from "../values/types.js";
import { toJS } from "../membrane.js";

// `is_macro_value` (value-guards.ts) reads the macro classes' `[CLASS]` brand
// directly — downward, eval-import-free. No runtime DI needed here.

/**
 * Realm-cached lexical root for DEFAULT (no-env) exec — null-rooted scratch frame
 * where top-level `define`s land, CUT from the capability base. Builtins resolve
 * through the assembled Resolver (`scope.lookup ?? capabilities.lookup`), NOT this
 * env's `__parent__` chain (it has none). Cached as a realm singleton so default
 * defines ACCUMULATE across exec calls (matches pre-cut `user_env` accumulation).
 * Custom-env (`{ env }`) callers never touch it. Lazy: identity is a leaf (no env-roots cycle).
 */
let _defaultLexicalRoot: Environment | undefined;
function defaultLexicalRoot(): Environment {
  return (_defaultLexicalRoot ??= new Environment("user-program", {}, null));
}

/**
 * Realm-cached runtime bootstrap (lazy base assembly, driven by `exec`).
 *
 * `??=` assigns the in-flight promise synchronously, so the cache IS the once-only
 * guard (a re-entrant prelude exec sees the same settled/in-flight promise).
 *
 * Two steps, order-significant:
 *   1. NATIVE_PACKS (value-domain clusters + numeric + error-object predicates)
 *      onto global_env — symbol-only, no prelude (no evalScheme).
 *   2. BASE_PACKS (.scm stdlib: core/macros/polyglot/r7rs/srfi, `nil` among them)
 *      onto user_env. A base-pack prelude may call a native primitive (`+`,
 *      `string-length`), which resolves user_env → global_env, so natives in
 *      step 1 must already be live.
 *
 * Pack rosters are dynamic imports: BASE_PACKS/polyglot transitively pull the
 * evaluator (membrane), so a static import here would close a module-eval cycle.
 * Awaited exactly once (promise-cached); free after warm-up.
 *
 * `skipBootstrapWait: true` on the prelude evalScheme: those execs ARE this
 * assembly, so they must not re-enter the gate (would await the promise they
 * are part of — deadlock).
 */
let _baseAssembled: Promise<void> | undefined;
export function ensureBaseAssembled(): Promise<void> {
  return (_baseAssembled ??= (async () => {
    // Populated entirely by assembled packs below (NATIVE_PACKS + BASE_PACKS).
    // Dynamic import only (by design, no static importer) so the package can
    // declare `sideEffects: false`.
    const { NATIVE_PACKS } = await import("../env/native-packs.js");
    const { BASE_PACKS } = await import("../env/base-packs.js");
    await assembleEnv(
      global_env,
      NATIVE_PACKS.map((pack) => pack.lower()),
    );
    await assembleEnv(
      user_env,
      BASE_PACKS.map((pack) => pack.lower({ evalScheme: preludeExec })),
    );
    // THE SEAL (ENV T2, environment-resolution-chain.md §§1–2): the bake ends here — the
    // shared ambient base compiles into its frozen CompiledResolutionChain (zero live
    // resolvers ⇒ one flat Map), which every default-path exec resolves through via
    // `Capabilities.assembled(user_env)` (same memoized artifact). Post-seal the ambient
    // artifact has no write surface; REPL accumulation rides the mutable session frame
    // ABOVE it (`defaultLexicalRoot`), and glass callers keep their live env walk. The
    // chain's `hash` is the content-address hook the PROVENANCE track's "baked-env hash"
    // slot consumes.
    sealResolutionChain(user_env);
  })());
}

// The ONE prelude evalScheme (injected into base-pack assembly above AND `exec({
// capabilities })` assembly below). `skipBootstrapWait`: those execs ARE / follow the
// bootstrap, so they must not (re-)await the bootstrap promise (deadlock / redundant).
//
// ENV T1 narrowing: `env` arrives as the structural `SchemeEnv` the pack machinery is
// typed against, but every assembly this module drives targets a concrete env (the
// env-roots `ResolvingEnvironment`s or an `.inherit()` child of one), and `exec`'s
// `{ env }` option takes the concrete class. Plain `Environment` no longer implements
// `SchemeEnv` (registerResolver lives on `ResolvingEnvironment` — see Environment.ts),
// so the old direct `as Environment` lost its type overlap; narrow HONESTLY on the
// runtime fact (instanceof) instead of a blind double-cast.
const preludeExec = (env: SchemeEnv, src: string): Promise<unknown[]> => {
  invariant(env instanceof Environment, "prelude evalScheme: expected a concrete Environment");
  return exec(src, { env, skipBootstrapWait: true });
};
const capabilityEvalScheme: EvalSchemeInto = preludeExec;

/**
 * Build capability base for `exec({ capabilities })`: fresh `user_env` child
 * with the supplied capabilities assembled on top, so they AUGMENT the standard
 * assembled base (`user_env → global_env`) rather than replace it. Fresh child
 * per call keeps the user's capabilities out of shared `user_env` (no cross-call
 * bleed); a caller wanting a persistent capability env builds it once with
 * `assembleEnv` and passes it as `{ env }`.
 *
 * `config` is the ONE shared bag (see ExecOptions.config) handed to every
 * capability's `lower()` — each validates its own slice; `assembleEnv` supplies
 * the bake-scoped prelude overlay, so `preludeOnly` symbols work with no extra wiring.
 */
async function assembleCapabilityBase(capabilities: readonly EnvCapability[], config?: object): Promise<Environment> {
  const base = user_env.inherit("exec-capabilities");
  await assembleEnv(
    base,
    capabilities.map((c) => c.lower({ evalScheme: capabilityEvalScheme, config })),
  );
  // Seal the per-call baked base (ENV T2) — `Capabilities.assembled(base)` below reuses
  // this artifact (memoized per env), so the run resolves through the frozen chain.
  sealResolutionChain(base);
  return base;
}

export interface ExecOptions {
  /**
   * GLASS — custom base env. When set, the resolver wraps it directly: defines
   * land in it, builtins resolve up its `__parent__` chain (byte-identical to
   * pre-cut). Takes precedence over `capabilities`/`scope` (the cut refinements);
   * use `env` OR the cut options.
   */
  env?: Environment;
  /**
   * THE CUT, capability-refined. EnvCapability packs assembled onto the standard
   * base (`user_env → global_env`) for THIS run (inference-plane nil-compat, an
   * MCP/infer capability, etc.) instead of the bare default base. Assembled per
   * call onto a fresh `user_env` child (no cross-call bleed). Ignored when `env`
   * (glass) is set.
   */
  capabilities?: readonly EnvCapability[];
  /**
   * THE SHARED CONFIG BAG for `capabilities` (inert without them). ONE object
   * handed to every capability's `lower({ config })`: each validates its OWN slice
   * against its `configuration` zod schemas (`z.object` strips undeclared keys),
   * so unrelated capabilities ride one bag without knowing about each other.
   * Deliberately reference-shared, never cloned/split: `EnvCapability.lower`
   * threads the SAME raw object to its deps, so the kernel's closure dedup
   * matches a capability's root + dep appearances by IDENTITY instead of
   * tripping `AssembleConfigConflictError` (the `buildArrivalEnv` idiom —
   * "each capability validates its own slice of the SHARED opts config").
   */
  config?: object;
  /**
   * THE CUT, scope-refined. Lexical root the run's top-level `define`s land in.
   * Pass a persistent {@link LexicalScope} (`LexicalScope.for(env)`) across calls
   * for REPL-style multi-step accumulation, instead of the realm-cached default
   * scratch frame. Builtins still resolve through the capability base (composed
   * `scope.lookup ?? capabilities.lookup`). Ignored when `env` (glass) is set.
   */
  scope?: LexicalScope;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  /** Tap for tracing per-form evaluation enter/exit. See EvalTap. */
  tap?: EvalTap;
  /** Predicate to suppress tap firing for specific nodes (atoms always skipped).
   *  Piped through to `EvalContext.nodeFilter` (evaluator.ts), whose domain is
   *  the full `AListAlike` spine, not just `APair` — matching that signature
   *  exactly instead of the narrower one. */
  nodeFilter?: (node: AListAlike) => boolean;
  /**
   * Execution-budget signal. When the signal aborts, the trampoline throws
   * `signal.reason ?? DOMException("aborted", "AbortError")` at the next
   * iteration boundary. See `EvalContext.signal` (evaluator.ts) — the 5ms
   * event-loop yield prevents UI freeze but does NOT bound CPU, so
   * `(define (loop) (loop))` needs an external bound for sandbox use.
   */
  signal?: AbortSignal;
  /**
   * Wall-clock execution budget (ms). Unlike `signal` (needs an external
   * controller to fire), this is an INTERNAL bound: the trampoline throws
   * `ArrivalError(/budget/)` once `budgetMs` of wall-clock elapses, checked at
   * the same iteration boundary that yields to the event loop. This is the
   * bound sandbox/agent code needs so `(let loop () (loop))` can't hang the host.
   * Composable with `signal` — whichever fires first wins.
   */
  budgetMs?: number;
  /**
   * Per-run ALLOCATION budget — the memory analogue of `budgetMs`. Caps the
   * cumulative number of list cells materialized through the two collection-op
   * choke points: `to_array` (append/join/reverse/…) and the fl-interop
   * sequence-op dispatch (filter/map/reduce over Pair/Vector, charged at dispatch
   * since the term walk bypasses to_array). The wall-clock budget is checked at
   * trampoline TICKs, which a single native list pass (`filter`/`append` over a
   * large list) never hits — so an O(K²)-churn loop runs uninterruptibly until
   * it stack-overflows. This bound IS checked inside that loop. Undefined ⇒
   * unbounded (default; only sandbox/agent runs opt in). Composable with
   * `budgetMs`/`signal` — whichever fires first wins.
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
   * this off `ctx.runCtx.strict`: default ⇒ nil/null projection yields nil, strict
   * ⇒ the R7RS throw. A wrong-TYPE arg (car of a number/string) throws in BOTH
   * modes — tolerance is scoped to absence. The base `user_env` car/cdr are
   * unaffected (always R7RS-strict); `first`/`second`/… and cxr accessors are
   * a later parity step.
   */
  strict?: boolean;
  /**
   * Opt out of freezing borrowed rosetta returns. Default (`undefined`/`true`)
   * `Object.freeze`s the borrowed JS source inside AJSObject/AJSArray the first
   * time Scheme reads it, so the host can't mutate a returned value afterward
   * (prevention by construction, replacing the dev-only purity assert). Set
   * `false` to keep borrowed returns mutable for hosts that intend to keep
   * writing them.
   */
  freezeRosettaReturns?: boolean;
  /**
   * Internal: set by the bootstrap's own prelude evals (`ensureBaseAssembled`'s
   * evalScheme) to bypass the bootstrap gate below — awaiting
   * `ensureBaseAssembled` there would deadlock (the prelude eval IS part of the
   * realm-cached promise it would be waiting on).
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
   * Rosetta-IN (provenance-MINTING) op names for `classifierFromEnv` when
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
  // Default env = env-roots leaf `user_env` (arrival's interaction scope,
  // `global_env.inherit("user-env")`), sourced STATICALLY so this entry never
  // imports the stdlib monolith. Bootstrap gate below drives population:
  // `ensureBaseAssembled` assembles native packs + the `.scm` base.
  const actualEnv = env ?? user_env;

  // Lazy self-init the runtime bootstrap (native packs + .scm base), so embedders
  // never trigger it manually. `ensureBaseAssembled` is realm-cached (one
  // in-flight/settled promise): first exec assembles, every later exec awaits the
  // same settled promise — no half-assembled env observable. `skipBootstrapWait` is
  // the one exception: a base-pack prelude eval IS the bootstrap and must not
  // await its own promise.
  if (!skipBootstrapWait) await ensureBaseAssembled();

  let parsed: SchemeValue[];
  if (typeof code === "string") {
    // Thread strict into the reader so R7RS control rejects loose-mode literals
    // (#void/#null) at parse time. Default false ⇒ loose parse, unchanged.
    parsed = await readerParse(code, undefined, strict ?? false);
  } else if (code instanceof APair) {
    parsed = [code];
  } else {
    parsed = [code];
  }

  // SHADOW MODE slice 2 — classify@load. Build one static lineage skeleton per
  // parsed form, BEFORE evaluation. Pure (classify runs no eval); gated entirely
  // behind the flag so flag-OFF is byte-identical. Classifier is env-derived
  // (classifierFromEnv reads each op's declared `.provenanceRole` directly off the
  // env — Q3, PROVENANCE-PLAN.md; no caller-supplied source list any more, see
  // lineage-classifier-from-env.ts). Skeletons align by index with `parsed`,
  // consumed at the per-form assert hook below.
  let shadowSkeletons: LineageNode[] | undefined;
  if (irLineage) {
    const classifier = classifierFromEnv(actualEnv);
    shadowSkeletons = parsed.map((form) => classify(form, classifier));
  }

  // Evaluate each expression in sequence. Budget spans the WHOLE exec call (all
  // top-level forms share one deadline) — a sandbox program that splits a hang
  // across several forms is still bounded. Recompute remaining budget per form
  // from a single start so we don't reset the clock between forms.
  // Per-run allocation meter minted HERE, once, on `runCtx` — RunContext is its
  // ONLY owner (no env-node courier copy: see heapMeter-ownership tranche). Spans
  // the WHOLE exec like the wall-clock budget; every value built during this run
  // carries this SAME runCtx (`operand.ctx.heapMeter`), which `to_array`/the
  // sequence-op dispatch charge against directly — no parent-chain walk, no
  // install/restore dance.
  const runCtx = makeRunContext({ strict: strict ?? false, heapBudget, freezeRosettaReturns, signal });
  // ── THE EXEC SEAM: glass-for-custom-env, cut-for-default, refined by capabilities/scope ──
  // Custom `env` stays GLASS — resolver wraps it, defines land in it, builtins
  // resolve up its base-linked chain — byte-identical (zero change for
  // arrival-chain/inhuman). `env` wins over the cut refinements (capabilities/scope),
  // which are ignored when set.
  // No env → THE CUT: a lexical root (`scope.env` for REPL accumulation, else the
  // realm-cached null-rooted scratch frame) holds user defines; the assembled base
  // (`actualEnv`, optionally AUGMENTED with `capabilities`) supplies builtins; the
  // Resolver composes the two. `actualEnv` (the BASE) still drives bootstrap + the
  // classifier above; only the resolution topology changes.
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
  // Run's exec frame = resolver's lexical env (glass: actualEnv; cut: lexicalRoot).
  // Defines land here and evaluator's `ctx.env` is here; heap meter lives on
  // `runCtx` only (above), not on this frame.
  const results: SchemeValue[] = [];
  const start = budgetMs === undefined ? 0 : performance.now();
  for (let i = 0; i < parsed.length; i++) {
    const expr = parsed[i];
    const remaining =
      budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
    // Audit-#42 wrapOperator contract: run() wraps every non-ArrivalError —
    // including the TypeError wrapOperator throws to name operator + arg types —
    // in an ArrivalError, masking both the TypeError class and its membrane cause.
    // Surface the original TypeError so the user-visible error shape survives.
    let result: SchemeValue;
    try {
      // Top-level form evaluates to a value, never a bare expander — seal it.
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
            // ctx.strict yet (scaffolding); car/cdr dispatch reads it later.
            strict: strict ?? false,
            // Per-run handle, threaded as data (unread scaffold; N2 reads it).
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

    // SHADOW MODE slice 3 — the assert. Compare static fullCone against this
    // form's UNTAPPED eager `result.provenance` (mechanism 1; NO tap installed).
    // In-scope divergence throws ProvenanceShadowDivergence; a macro-head /
    // keyword-projection form abstains (returns a skip reason we discard — it is
    // outside the classifier's model, so shadow does not assert it). Behind the
    // flag — never runs flag-OFF.
    if (irLineage && shadowSkeletons) {
      assertShadowCone(shadowSkeletons[i], expr, result, actualEnv, String(expr));
    }
  }

  return { values: results, scope: runResolver.scope, runCtx };
}

/**
 * SIMPLE tier (docs/working-proposals/two-tier-exec-api.md, RULINGS.md R1) — THE
 * default exec surface, "run, get JS". Delegates to {@link execState} (COMPLEX
 * tier) and fully unwraps each result through {@link toJS} — a true P4 membrane
 * crossing. Outside this function only plain-JS-observable values exist;
 * provenance reading stays in the run's trace (containers egress as R9 lazy
 * proxies, see membrane.ts's `toJS`). Callers that need boxed values, the
 * lexical scope, or the run context (law tests, tooling, REPL continuation)
 * use {@link execState} directly.
 *
 * @param code - String of Scheme code or pre-parsed SchemeValue
 * @param options - Optional environment and dynamic binding options
 * @returns Promise<unknown[]> - one plain-JS value per top-level expression
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
export async function exec(code: string | SchemeValue, options: ExecOptions = {}): Promise<unknown[]> {
  const state = await execState(code, options);
  return state.values.map((v) => toJS(v));
}

/**
 * Parse Scheme code without evaluating (delegates to the reader leaf, reader/parse.ts).
 * `source` (a filename / module path) is stamped onto every produced location,
 * so frames built from these forms read as `file:line` — used by `(require …)` to
 * attribute a module's throws to its file.
 */
export async function parse(code: string, _env?: Environment, source?: string): Promise<SchemeValue[]> {
  // _env retained for API compat but inert: the reader no longer consults an env
  // (the reader-extension lookup that used it was removed). Parsing is now a pure
  // reader-leaf call.
  return readerParse(code, source);
}

/**
 * Execute a single pre-parsed expression. COMPLEX tier (two-tier-exec-api §3) — the
 * internal form-at-a-time entry (require, prelude eval); returns one boxed
 * SchemeValue, never unwrapped. Use this when you've already parsed the code.
 */
export async function execExpr(
  expr: SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal, budgetMs, heapBudget, skipBootstrapWait }: ExecOptions = {},
): Promise<SchemeValue> {
  const actualEnv = env ?? user_env;

  // See exec(): realm-cached lazy bootstrap, awaited once.
  if (!skipBootstrapWait) await ensureBaseAssembled();

  // THE EXEC SEAM (see exec): glass for custom env, the cut for default (fresh
  // null-rooted lexicalRoot + assembled base).
  const runResolver =
    env !== undefined
      ? new Resolver(actualEnv)
      : new Resolver(defaultLexicalRoot(), Capabilities.assembled(actualEnv));

  // Mint per-run handle here too (mirrors exec()) — closes two gaps: a
  // required-module impl reading `this.runCtx.signal` (CallCtx) now sees the SAME
  // abort signal `ctx.signal` already carries, and the handler-stack WeakMap
  // (exceptions.ts) stops falling back to the shared CONSTANT_CTX bucket for
  // every require'd module. `heapBudget` bounds THIS expression's allocations
  // (a per-form meter; a cumulative multi-form bound needs a shared RunContext,
  // which no caller can inject yet — the ledgered runProgram gap).
  const runCtx = makeRunContext({ signal, heapBudget });

  try {
    // Top-level form evaluates to a value, never a bare expander — seal it.
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

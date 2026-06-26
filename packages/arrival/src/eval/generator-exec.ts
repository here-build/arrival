/**
 * Public `exec`/`parse` entry point: bridges the parser (in stdlib.ts, the
 * upstream-LIPS-derived reader) to the generator-based evaluator. Self-bootstraps
 * the runtime on first use, then drives each top-level form through `run()`.
 *
 * Usage:
 *   import { exec } from "./generator-exec.js";
 *   const results = await exec("(+ 1 2 3)");  // Returns [6]
 *   const results = await exec("(+ 1 2)", { env: myEnv });
 */

import { whenBootstrapComplete } from "../boot.js";
import type { Environment } from "../Environment.js";
import run, { evaluate, ArrivalError, type EvalTap } from "./evaluator.js";
import { parse as readerParse } from "../reader/parse.js";
import { is_pair, is_macro } from "./guards.js";
import { classifierFromEnv } from "../values/lineage-classifier-from-env.js";
import { assertShadowCone, installMacroGuard } from "../values/lineage-shadow.js";
import { classify, type LineageNode } from "../values/lineage.js";
import type { APair } from "../values/primitives/APair.js";
import { makeRunContext } from "../values/primitives/RunContext.js";
import type { SchemeValue } from "../values/types.js";

// Give the value-layer shadow module the evaluator's own `is_macro` without a
// static value→eval import edge (the macro-head skip needs it; this module already
// sits above eval/guards in the DAG). Idempotent — set once at module load.
installMacroGuard(is_macro);

// Lazy import to avoid circular dependency during module initialization
let _stdlib: typeof import("../stdlib.js") | null = null;

async function getStdlib() {
  if (!_stdlib) {
    _stdlib = await import("../stdlib.js");
  }
  return _stdlib;
}

export interface ExecOptions {
  env?: Environment;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
  /** Tap for tracing per-form evaluation enter/exit. See EvalTap. */
  tap?: EvalTap;
  /** Predicate to suppress tap firing for specific nodes (atoms always skipped). */
  nodeFilter?: (node: APair) => boolean;
  /**
   * Execution-budget signal. When the signal aborts, the trampoline throws
   * `signal.reason ?? DOMException("aborted", "AbortError")` at the next
   * iteration boundary. See `EvalContext.signal` in evaluator.ts for the
   * full war story; the short version is that the 5ms event-loop yield
   * prevents UI freeze but does NOT bound CPU, so `(define (loop) (loop))`
   * needs an external bound for sandbox use.
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
   * Opt into Tier-2 speculative evaluation (latency-only; Scheme-invisible).
   * When true, producers (filter/map) may emit a lazy `HalfBaked` carrier so
   * control-flow over a still-filling promise fan can collapse early. With the
   * flag off, evaluation is byte-identical to the eager path. See
   * docs/package-specific/arrival-scheme/speculative-evaluation-promise-functor-2026-06-05.md.
   */
  speculate?: boolean;
  /**
   * Interpreter-level NIL-TOLERANCE mode. When `true`, projection ops
   * (`car`/`cdr` and friends) applied to `null`/nil THROW instead of resolving
   * tolerantly to `nil`. Default (`undefined`/`false`) is TOLERANT — today's
   * behavior, where projecting nil yields nil.
   *
   * This is the interpreter mode that replaces fantasy-land's scattered
   * env-overlay nil guards (the `if (x == null) return nil` pattern in
   * fl-interop): nil-tolerance becomes a real evaluation mode threaded through
   * `EvalContext.strict`, not an env decoration. The inference-plane `car`/`cdr` (env/fl-interop.ts)
   * read this via the run-scoped `isStrict()` (evaluator.ts): default ⇒ a nil/null
   * projection yields nil, strict ⇒ the R7RS throw. A wrong-TYPE arg (car of a number/
   * string) throws in BOTH modes — tolerance is scoped to absence. The base `user_env`
   * car/cdr are unaffected (always R7RS-strict); `first`/`second`/… and the cxr
   * accessors are a later parity step.
   */
  strict?: boolean;
  /**
   * Internal: set by the bootstrap's own prelude evals (bridge.initBridge's
   * `evalScheme`) to bypass the bootstrap-completion gate below — awaiting it
   * there would deadlock (the prelude eval IS part of the bootstrap it would be
   * waiting on). Formerly lived on the now-removed stdlib.ts `exec`.
   */
  skipBootstrapWait?: boolean;
  /**
   * SHADOW MODE (W3 slices 2–3 — provenance-static-lineage-finalization §8). When
   * set, after each top-level form is evaluated, the static lineage `fullCone`
   * (values/lineage.ts) is computed and ASSERTED equal to the form's UNTAPPED eager
   * `result.provenance`. A divergence throws `ProvenanceShadowDivergence`. This is a
   * read-only cross-check of the static classifier against the live engine — it does
   * NOT alter evaluation; **flag-OFF (the default) is byte-identical to today**, as
   * the skeleton build + assert are gated entirely behind this flag. Asserts
   * `fullCone` only (never `countCone`, which diverges by design — the v0.2 minimal
   * cone). Forms outside shadow's provable set are skipped + recorded, not asserted.
   *
   * NAME CAVEAT: the `ir`-prefix is borrowed (from the studio's `--ir-*`
   * compile-erased-superset markers) and is a MISFIT here — this flag toggles
   * shadow/dual-run VALIDATION, it does not lower an authoring superset to spec.
   * Read it as "validate-static-lineage," not as an IR feature. (The eventual public
   * name is `--ir-lineage`; the misfit rides along, see the v0.2 carrier doc §1.)
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
 * Parse and execute Scheme code using the generator-based evaluator.
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
export async function exec(
  code: string | SchemeValue,
  {
    env,
    dynamic_env,
    use_dynamic,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    heapBudget,
    speculate,
    strict,
    skipBootstrapWait,
    irLineage,
    irLineageSources,
  }: ExecOptions = {},
): Promise<SchemeValue[]> {
  const stdlib = await getStdlib();

  // Resolve environment - stdlib.env is the user_env (global_env.inherit("user-env"))
  const actualEnv = env ?? stdlib.env;

  // Self-initialize the runtime bootstrap (TS builtins + Scheme prelude) lazily, so
  // embedders never call initBridge() manually. If the bootstrap has already STARTED
  // (e.g. index.ts's fire-and-forget `void initBridge()`), await its COMPLETION
  // promise — the pack assembly is async, so the started-flag alone would let a racing
  // exec observe a half-assembled env. `skipBootstrapWait` is the one exception: a
  // prelude eval that IS the bootstrap can't await its own completion.
  if (!skipBootstrapWait) {
    if (!actualEnv.initialized) await actualEnv.init();
    else await (whenBootstrapComplete() ?? actualEnv.init());
  }

  // Parse if string, otherwise wrap single value in array
  let parsed: SchemeValue[];
  if (typeof code === "string") {
    parsed = await readerParse(code);
  } else if (is_pair(code)) {
    // Single expression - evaluate directly
    parsed = [code];
  } else {
    // Atom - evaluate directly
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
  // Mint the per-run context (the hermetic handle; see RunContext). Today it carries
  // strict + the heap meter as scaffolding — `exec` still installs the meter on the env
  // node below (where `to_array`/fl-interop find it by parent-walk) and ops read the
  // holders; N2 flips those readers to `runCtx`/`operand.ctx` and retires the holders.
  const runCtx = makeRunContext({ strict: strict ?? false, heapBudget, speculate });
  const priorMeter = actualEnv.__heapMeter__;
  // Point the env-node meter at the SAME object runCtx holds, so the N2 flip to
  // `operand.ctx.heapMeter` reads the live meter with no behavior change.
  if (runCtx.heapMeter !== undefined) actualEnv.__heapMeter__ = runCtx.heapMeter;

  const results: SchemeValue[] = [];
  const start = budgetMs === undefined ? 0 : performance.now();
  try {
    for (let i = 0; i < parsed.length; i++) {
      const expr = parsed[i];
      const remaining =
        budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      // Preserve the audit-#42 wrapOperator contract (ported from the removed
      // stdlib.ts `exec_with_stacktrace`): run() wraps every non-ArrivalError —
      // including the TypeError wrapOperator throws to name operator + arg types —
      // in a ArrivalError, masking both the TypeError class and its membrane cause.
      // Surface the original TypeError so the user-visible error shape survives.
      let result: SchemeValue;
      try {
        result = await run(
          evaluate(expr, {
            env: actualEnv,
            dynamic_env,
            use_dynamic,
            tap,
            nodeFilter,
            signal,
            speculate,
            // Default false ⇒ today's tolerant nil-projection. No consumer reads
            // ctx.strict yet (scaffolding); the car/cdr dispatch reads it later.
            strict: strict ?? false,
            // The per-run handle, threaded as data (unread scaffold; N2 reads it).
            runCtx,
          }),
          { signal, budgetMs: remaining },
        );
      } catch (e) {
        if (e instanceof ArrivalError && e.cause instanceof TypeError) throw e.cause;
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
    if (heapBudget !== undefined) actualEnv.__heapMeter__ = priorMeter;
  }

  return results;
}

/**
 * Parse Scheme code without evaluating (delegates to stdlib's reader).
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
 * Execute a single pre-parsed expression.
 * Use this when you've already parsed the code.
 */
export async function execExpr(
  expr: SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal, budgetMs, speculate, skipBootstrapWait }: ExecOptions = {},
): Promise<SchemeValue> {
  const stdlib = await getStdlib();
  const actualEnv = env ?? stdlib.env;

  // See exec() above: await bootstrap COMPLETION, not just the started-flag.
  if (!skipBootstrapWait) {
    if (!actualEnv.initialized) await actualEnv.init();
    else await (whenBootstrapComplete() ?? actualEnv.init());
  }

  try {
    return await run(
      evaluate(expr, {
        env: actualEnv,
        dynamic_env,
        use_dynamic,
        tap,
        nodeFilter,
        signal,
        speculate,
      }),
      { signal, budgetMs },
    );
  } catch (e) {
    if (e instanceof ArrivalError && e.cause instanceof TypeError) throw e.cause;
    throw e;
  }
}

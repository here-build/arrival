/**
 * Public `exec`/`parse` entry: bridges the reader (leaf reader/parse.ts,
 * upstream-LIPS-derived) to the generator evaluator. Every run resolves through the
 * self-hosted `Vocabulary` (env/vocabulary.ts + env/base-roster.ts, Stage C Cut 2's THE
 * LINCHPIN) — there is no realm-parented ambient anymore (Stage C Cut 3b: the massacre —
 * docs/plans/stage-c-corpse-deletion.md). Drives each top-level form through `run()`.
 *
 * Usage:
 *   import { exec } from "./generator-exec.js";
 *   const results = await exec("(+ 1 2 3)");  // Returns [6]
 *   const results = await exec("(+ 1 2)", { capabilities: [myCapability] });
 */

import { AmbientRuntime, mintPlainFrame, isAmbientRuntime, bindValue } from "../env/AmbientRuntime.js";
import { buildVocabulary, type Vocabulary } from "../env/vocabulary.js";
import { assembleRun } from "../env/assemble-run.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import { inferenceEnv } from "../env/inference-env.js";
import run, { evaluate, expectValue, type EvalTap } from "./evaluator.js";
import { ArrivalError, AmbientShapeError, isHostRuntimeBug, OutputContractError } from "../errors.js";
import { Resolver } from "./Resolver.js";
import { Capabilities } from "./Capabilities.js";
import { LexicalScope } from "./LexicalScope.js";
import { sealResolutionChain, type CompiledResolutionChain } from "./CompiledResolutionChain.js";
import { StaticValidationError } from "../static-validation/validate-program.js";
import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto, SchemeEnv } from "../common/scheme-env.js";
import { parse as readerParse } from "../reader/parse.js";
import { parseProgram, validateAgainstResolution, type ParsedProgram } from "./exec-phases.js";
import { RunContext } from "../run/RunContext.js";
import { disposeRunContext } from "../run/run-lifecycle.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import type { ReadGuard } from "../run/read-guard.js";
import { checkReadWriteGuard } from "../run/read-guard.js";
// TYPE-ONLY (erased — no runtime scheme-zod edge from this module): the `exec` exit
// contract's schema type + its output-face projection (the output-bearing overload).
import type { output as ZodOutputOf, ZodType } from "../common/scheme-zod.js";
import type { AListAlike, SchemeValue } from "../values/types.js";
import { toJS } from "../membrane/membrane.js";

// `is_macro_value` (value-guards.ts) reads the macro classes' own
// `["arrival/is-macro"]` field directly — downward, eval-import-free. No runtime
// DI needed here.

/**
 * INTERNAL BAKE SEAM (Stage C Cut 3b) — NOT reachable through the public `ExecOptions`
 * surface (the retired `env` glass option's replacement, scoped down to exactly what
 * survives it needing). Evaluate parsed `source` directly against `frame`: a `Resolver`
 * wrapping `frame` alone composes `capabilities = new Capabilities(frame)` (Resolver.ts's
 * own glass-shaped constructor branch), so defines land in `frame` and builtins resolve up
 * its OWN `__parent__` chain — exactly the walk the retired glass gate gave a caller-held
 * live env, minus the public surface.
 *
 * The two production seams that still need a literal live-frame bake: `buildVocabulary`'s
 * Pass-2 `symbol.define`/`defineSyntax` evaluator (`capabilityEvalScheme`, below — `frame` is
 * `vocabulary.ts`'s own null-rooted `bakeEnv` scratch frame) and `assembleRun`'s per-run
 * prelude pass (`preludeEvalScheme`, below — `frame` is `assemble-run.ts`'s own discarded
 * `preludeScope`). Neither needs a bootstrap gate: both ARE (or follow) the self-hosted
 * vocabulary build already, never the retired realm bootstrap.
 *
 * `runCtx` reused verbatim when supplied (the prelude pass threads its own run's handle so a
 * resource-touching prelude verb spawns/reads THAT run's bag); absent (the define-bake
 * evalScheme, which has no run at all) ⇒ a throwaway one is minted and disposed here.
 */
export async function execInFrame(source: string, frame: AmbientRuntime, runCtx?: RunContext): Promise<unknown[]> {
  const program = await parseProgram(source);
  const runResolver = new Resolver(frame);
  const ownRunCtx = runCtx === undefined;
  const actualRunCtx = runCtx ?? new RunContext({ strict: false });
  try {
    const results: SchemeValue[] = [];
    for (const expr of program.forms) {
      const result = expectValue(
        await run(evaluate(expr, { resolver: runResolver, strict: false, runCtx: actualRunCtx }), {}),
      );
      results.push(result);
    }
    return results.map((v) => toJS(v));
  } finally {
    if (ownRunCtx) await disposeRunContext(actualRunCtx);
  }
}

// The ONE build-time evalScheme — injected into `buildVocabulary`'s Pass-2 `symbol.define`/
// `defineSyntax` bake (env/vocabulary.ts's `processCapability`, threaded through this module's
// own `execStateViaVocabulary`/`execExpr` calls to `buildVocabulary`). Build-time: shared across
// every run of a given tuple, no `runCtx` to carry (mirrors the retired `preludeExec`'s role,
// minus the bootstrap gate — `execInFrame` needs none).
const capabilityEvalScheme: EvalSchemeInto = (env, source) => {
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("capability define-bake", "expected a concrete AmbientRuntime");
  return execInFrame(source, env);
};

// The PER-RUN prelude evalScheme (env/assemble-run.ts's `AssembleRunOptions.evalPrelude`) —
// carries THIS run's own `runCtx` through, so a resource-touching prelude verb (the loader's
// extension registry, a preludeOnly registration verb) spawns/reads THIS run's bag.
const preludeEvalScheme: EvalPreludeInto = (env, source, runCtx) => {
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("prelude evalScheme", "expected a concrete AmbientRuntime");
  return execInFrame(source, env, runCtx);
};

export interface ExecOptions {
  /** The run's MODEL-FACING NOTE CHANNEL (run/note-sink.ts). Rides onto `RunContext.notes`, the
   *  same per-run seam `cache`/`effects`/`reads` use. A caller that RENDERS an observation (the MCP
   *  runner) mints one and drains it after the call; everyone else omits it and notes are dropped. */
  notes?: NoteSink;
  /** The run's DISPLAY channel — where the MCP runner's `display` affordance records what a model
   *  asked to see. Arrival binds no `display` verb (ports/IO are omitted by design); this is the
   *  seam a HOST uses to offer one without the language acquiring an IO surface. */
  display?: DisplaySink;
  /**
   * EnvCapability packs assembled onto the self-hosted base (`env/base-roster.ts`'s
   * `BASE_ROSTER`, folded in automatically — see `execStateViaVocabulary`'s own doc) for THIS
   * run. A bare `exec(code)` is the DEGENERATE case of the same tuple (`capabilities` empty,
   * the closure is just `BASE_ROSTER`).
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
   * Lexical root the run's top-level `define`s land in. Pass a persistent
   * {@link LexicalScope} (`LexicalScope.for(env)` / `LexicalScope.fresh()`) across calls
   * for REPL-style multi-step accumulation, instead of the per-call default (a FRESH,
   * isolated root — `LexicalScope.fresh()`). Builtins still resolve through the capability
   * base (composed `scope.lookup ?? capabilities.lookup`).
   */
  scope?: LexicalScope;
  /**
   * REUSE an existing RunContext (REPL continuity) instead of minting a fresh one for this
   * call: a REPL spawns ONE RunContext (capture it off a prior call's `ExecState.runCtx`) and
   * threads it through every later pass, so pass-scoped capability resources
   * (`common/resources.ts`'s `runScoped` — a database handle, a require cache, …) survive
   * between passes instead of respawning each call, exactly like `scope`'s accumulating
   * defines already do.
   *
   * CALLER-owned: exec will NOT dispose it. Passing this OPTS OUT of the per-call disposal a
   * bare `exec(code)` performs (see the module's `execState` `finally` — a self-minted
   * RunContext is disposed at THIS call's end; a reused one is disposed only when the caller
   * ends the session, via `disposeRunContext(runCtx)` or `await using` a `new RunContext(...)`-
   * minted one). Also honored by {@link execExpr} — its own single-form sub-program plumbing
   * (require's module-eval loop, prelude eval) threads the requiring run's LIVE `runCtx`
   * through, rather than always minting a fresh standalone one; see that function's own doc
   * for the full contract.
   */
  runCtx?: RunContext;
  /**
   * PHASE-1 OVERRIDE: a pre-parsed program — skip the reader (the parse-once-run-many idiom,
   * {@link parseProgram}). When set, the `code` argument is ignored. The program's READER
   * strictness is its own stamped identity fact (`ParsedProgram.strict`); `ExecOptions.strict`
   * keeps governing the RUN mode.
   */
  program?: ParsedProgram;
  /**
   * MODULE-EVAL RESOLVER PASSTHROUGH (COMPLEX tier — consumed by {@link execExpr}
   * only; `exec`/`execState` ignore it). Evaluate through an EXISTING composed
   * `Resolver` instead of building one from the default base. THE seam `(require …)`
   * (src/loader/) uses: a required module's forms must resolve through the SAME
   * scope+capability composition as the requiring program. Obtained via the
   * evaluator's `currentRunResolver()` back-channel at the require apply boundary.
   */
  resolver?: Resolver;
  dynamic_env?: AmbientRuntime;
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
   * Per-run ALLOCATION budget — the memory analogue of `budgetMs` (docs/execution.md §BUDGETS
   * for the TICK-blind-spot rationale and the two choke points it charges at). Caps the
   * cumulative number of list cells a run materializes, and is checked INSIDE the native
   * collection loop the wall-clock budget can't interrupt. Undefined ⇒ unbounded (default; only
   * sandbox/agent runs opt in). Composable with `budgetMs`/`signal` — whichever fires first wins.
   */
  heapBudget?: number;
  /**
   * THE RUN CACHE (run/run-cache.ts). When set, rides `new RunContext(...)` onto the run's
   * `RunContext.cache` and every baked rosetta penetration is intercepted at the decode/fire
   * chokepoint per the mode law (docs/execution.md §MODE-LAW). Unset ⇒ no interception (inert).
   * The cache is a RUN-level entity: session identity (epoch/roster/configDigest validity) is the
   * session layer's concern, checked BEFORE a cache is handed to a run.
   */
  cache?: RunCache;
  /**
   * THE EFFECT LOG (run/effect-log.ts). When set, rides `new RunContext(...)` onto the run's
   * `RunContext.effects`, arming the burst gather (docs/execution.md §BURST): a `sink` penetration
   * during a PRIME run enqueues and returns `undefined` instead of firing. A SIBLING of `cache`,
   * not a field on it: pass `effects` alone to gather sinks with no `RunCache` at all, or alongside
   * `cache` to gather sinks while a `view`/`pure` cache still serves reads. Unset ⇒ no burst arm (a
   * sink fires immediately). Draining the log (the actual burst — plexus region, atomicity,
   * conflict handling) is HOST territory; this option only wires the gather.
   */
  effects?: EffectLog;
  /**
   * THE READ GUARD (run/read-guard.ts). When set, rides `new RunContext(...)` onto the run's
   * `RunContext.reads`, arming the read-tracking region + the read∩write deferral guard
   * (docs/execution.md §READ-GUARD) that the phase-4 loop below drives per top-level form. Unset ⇒
   * no tracking, no guard. A `reads` with no `writeSetOf` armed (host tracks reads but can't
   * predict write footprints yet) never crashes — the guard degrades to a no-op, not a false claim.
   */
  reads?: ReadGuard;
  /**
   * THE EXIT CONTRACT. When supplied, the LAST form's result is validated against this schema
   * at the exit boundary — AFTER the `toJS` unwrap, so the schema describes the plain-JS value
   * `exec` actually hands back (a plain zod schema, not a scheme-face codec). A mismatch throws
   * a teaching door naming expected vs got — the outbound twin of `define/overridable`'s
   * validation (env/overridable/overridable.ts): the program declares what it yields, the host
   * declares what it expects, and the boundary checks BOTH directions. The parse RESULT replaces
   * the last element (schema transforms/coercions apply), which is what lets the schema drive
   * the static return type: `exec`'s output-bearing overload types the result as
   * `[...unknown[], z.output<O>]` when the generic tuple isn't given explicitly. Consumed by
   * `exec` (the SIMPLE tier's exit) only — `execState`/`execExpr` hand back boxed values and
   * perform no exit validation.
   */
  output?: ZodType;
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
   * THE STATIC VALIDATION PASS. `"on"` runs `validateProgram` over the parsed forms —
   * against the run's SEALED chain + session scope — after parse, before the first form
   * evaluates; error-tier diagnostics throw ONE `StaticValidationError` carrying the COMPLETE
   * list (never crash-on-first), with ZERO side effects fired. `"on"` also opts this run's
   * capability lowering into `degradation: "doors"` (doors become the effective posture
   * exactly where a program is present to validate), so an absent OPTIONAL enabling config key
   * surfaces as a parse-phase causal-chain diagnostic instead of a mid-run unbound throw.
   *
   * DEFAULT — `"off"` (opt-in). The `exec` PRIMITIVE stays opt-in because it is the low-level
   * building block the door/purity/typo LAW suites and internal provisioning evals use to
   * exercise RUNTIME behavior: a global default flip here conflates that primitive with the
   * program-scoped production ENTRY points and turns law/behavior assertions across the suite
   * into parse-phase throws, several of them deliberate runtime invariants (door-fires-at-apply,
   * typo-at-runtime), not stale pins. Strictness is CALLER-scoped instead — the production entry
   * points (DiscoveryTool.call, runProgram) opt IN by passing `"on"`, their own wiring, NOT a
   * flip of this primitive's default.
   */
  staticValidation?: "on" | "off";
}

/**
 * COMPLEX tier — "run, get reusable state": boxed, provenance-bearing results PLUS the
 * session handles a caller needs to continue or introspect the run. Not a membrane crossing —
 * this hands boxed state to JS-side TOOLING (law tests, REPL continuation, arrival-chain), it
 * does not exit. `exec` (SIMPLE tier, below) delegates here and unwraps;
 * `execExpr`/`evaluator.exec` are the other COMPLEX-tier entries (form-at-a-time).
 */
export interface ExecState {
  /** Boxed, provenance-bearing results — one per top-level form. */
  readonly values: readonly SchemeValue[];
  /**
   * The run's lexical accumulation handle — the SAME type `ExecOptions.scope`
   * accepts. When the caller passed `scope`, this IS that object (identity holds via
   * `LexicalScope.for`'s per-env memoization); when not, it wraps the run's
   * `lexicalRoot` so a follow-up `execState(code, { scope })` continues the session.
   */
  readonly scope: LexicalScope;
  /** The per-run hermetic handle (strict / heap meter / signal). */
  readonly runCtx: RunContext;
}

/**
 * STAGE C CUT 2 — THE SHARED SEALED CHAIN, memoized ONCE per {@link Vocabulary} OBJECT (a
 * `WeakMap` so it's GC'd with the tuple's own memo entry, `env/vocabulary.ts`'s `buildVocabulary`
 * memo). Base symbols are ordinary members of the tuple's own map (`BASE_ROSTER` folded in by
 * `execStateViaVocabulary`, below), so this bind loop is sizable — too costly to repeat on every
 * run (the suite alone drives thousands of execs). Building it here, ONCE, amortizes that cost
 * across every run sharing the tuple.
 *
 * `chainFrame` is NULL-ROOTED — the ambient species (THE CORNERSTONE: "I exist before program
 * start and I'm static," never attributed to any run) — never parented on anything: this is
 * exactly what makes the vocabulary path self-hosting instead of a realm-parented child. It
 * exists only to satisfy `sealResolutionChain`'s frame-shaped input; once sealed, `chain` is the
 * only artifact that matters, and `chainFrame` itself is never touched again by any run (nothing
 * binds into it after this).
 *
 * Per-run cost is just: obtain the run's OWN lexical scope (a fresh root, or a caller-passed
 * `scope`/reused `runCtx` for continuity) and wrap this SHARED `{ chainFrame, chain }` in a fresh
 * `Capabilities` instance — `Resolver` composes `scope.lookup ?? capabilities.lookup` as two
 * genuinely separate fields (Resolver.ts), never a frame-parenting relationship, so NOTHING a run
 * does — a `define`, a `require` — ever writes into `chainFrame`: only its READ side (`chain`) is
 * shared.
 */
const sealedChainByVocabulary = new WeakMap<
  Vocabulary,
  { readonly chainFrame: AmbientRuntime; readonly chain: CompiledResolutionChain }
>();
function sealedVocabularyChain(vocabulary: Vocabulary): {
  readonly chainFrame: AmbientRuntime;
  readonly chain: CompiledResolutionChain;
} {
  let sealed = sealedChainByVocabulary.get(vocabulary);
  if (sealed === undefined) {
    const chainFrame = mintPlainFrame("exec-vocabulary");
    for (const [name, value] of vocabulary.map) bindValue(chainFrame, name, value);
    const chain = sealResolutionChain(chainFrame);
    sealed = Object.freeze({ chainFrame, chain });
    sealedChainByVocabulary.set(vocabulary, sealed);
  }
  return sealed;
}

/**
 * Parse and execute Scheme code using the generator-based evaluator — the COMPLEX
 * tier (see {@link ExecState}). THE ROUTER COLLAPSE (Stage C Cut 3b, "the massacre" —
 * docs/plans/stage-c-corpse-deletion.md): EVERY run resolves through the self-hosted,
 * memoized `Vocabulary` (`env/vocabulary.ts`/`env/assemble-run.ts`/`env/base-roster.ts`) — a
 * bare `exec(code)` AND a `{ capabilities }` run alike. There is no second (ambient/glass)
 * path anymore: `execStateViaAmbient`/`instantiate`/`assembleAmbient`/the realm singletons all
 * died with this cut (see the ledger for the corpse list) — no `ensureBaseAssembled`, no
 * `user_env`/`global_env` reference anywhere in this module.
 *
 *   1. THE FOLD (Stage C Cut 2, THE LINCHPIN) — `effectiveCapabilities = [...capabilities,
 *      ...BASE_ROSTER]` (`env/base-roster.ts`): the caller's own capabilities FIRST, the base
 *      stdlib LAST. Order matters and is not arbitrary — see `base-roster.ts`'s own doc: with no
 *      `deps` edge between an unrelated user capability and a base pack, C3's root-list tie-break
 *      decides who's processed (bound) FIRST in the deps-first apply walk. Base LAST in the root
 *      list ⇒ LOWEST precedence ⇒ processed FIRST (its bindings exist before ANY user
 *      capability's OWN `symbol.define` bakes); user capabilities FIRST in the root list ⇒
 *      HIGHEST precedence ⇒ processed LAST ⇒ WIN a same-name conflict against a base pack.
 *   2. `buildVocabulary` — C3 walk over `effectiveCapabilities`, doors, config validation,
 *      define-bake (ONCE per tuple, memoized by closure identity — a bare exec's tuple IS
 *      `BASE_ROSTER` alone, so every bare exec in the process hits the SAME memoized build).
 *   3. `sealedVocabularyChain` (above) — the shared, memoized `{ chainFrame, chain }` for this
 *      tuple, built ONCE, reused across every run sharing it.
 *   3.5. STATIC VALIDATION (`staticValidation: "on"`) — `validateAgainstResolution` over THIS
 *      chain + `vocabulary.degraded`. Runs BEFORE `assembleRun` (below), so an error-tier
 *      diagnostic throws `StaticValidationError` with ZERO prelude effects fired either.
 *   4. `assembleRun` — mints the `RunContext` (or REUSES `ExecOptions.runCtx` — see
 *      `env/assemble-run.ts`'s own header for the tuple-identity invariant) AND runs the
 *      PER-RUN PRELUDE PASS against it (fresh mint only): every capability in this tuple's
 *      closure that declares a `.spec.prelude` runs it, exactly once, THIS run, before program
 *      code evaluates.
 *   5. `Capabilities` (wrapping the shared chain) → `Resolver`, then the per-form evaluation loop.
 *
 * ISOLATION: a run's top-level `define`s land in `scope`'s env when the caller passes one (REPL
 * continuity), else a FRESH, per-call, null-rooted scope (`LexicalScope.fresh()`). Two separate
 * bare execs do not share top-level defines (per the cornerstone: a mutable realm frame playing
 * double duty was the legacy sin, not a feature worth preserving). A caller wanting cross-call
 * continuity passes `scope` (or reuses `runCtx`) explicitly.
 *
 * A capability whose record contains a legacy `{ fn }` entry throws
 * `VocabularyLegacyCapabilityError` (`buildVocabulary`'s own refusal) — this function does not
 * fall back silently; a caller is asserting its capability set is vocabulary-eligible.
 */
export async function execState(code: string | SchemeValue, options: ExecOptions = {}): Promise<ExecState> {
  const {
    capabilities,
    config,
    scope,
    runCtx: passedRunCtx,
    program: passedProgram,
    dynamic_env,
    use_dynamic,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    heapBudget,
    cache,
    effects,
    reads,
    notes,
    display,
    strict,
    freezeRosettaReturns,
    staticValidation,
  } = options;

  const program = passedProgram ?? (await parseProgram(code, { strict }));

  // THE FOLD — see this function's own doc for the ordering rationale. `capabilities` may be
  // absent (a bare exec): the degenerate tuple is `BASE_ROSTER` alone.
  const effectiveCapabilities = [...(capabilities ?? []), ...BASE_ROSTER];

  const vocabulary = await buildVocabulary(effectiveCapabilities, config, capabilityEvalScheme);
  const { chainFrame, chain } = sealedVocabularyChain(vocabulary);

  // ISOLATION (see this function's own doc) — a fresh, null-rooted scope per call unless the
  // caller opts into continuity via `scope` (or `runCtx` reuse, threaded to `assembleRun` below).
  const lexicalScope = scope ?? LexicalScope.fresh();

  // ── STATIC VALIDATION — AFTER the chain seals, BEFORE `assembleRun`'s prelude pass runs, so
  // an error-tier diagnostic throws with ZERO prelude effects fired.
  if (staticValidation === "on") {
    const diagnostics = validateAgainstResolution(program, chain, vocabulary.degraded, lexicalScope);
    if (diagnostics.some((d) => d.severity === "error")) throw new StaticValidationError(diagnostics);
  }

  const runResolver = new Resolver(lexicalScope.env, new Capabilities(chainFrame, chain));
  // `assembleRun` is THE ONE place preludes run — it mints the RunContext THEN runs the per-run
  // prelude pass against it, so a prelude's resource-touching verb spawns/reads THIS run's bag.
  // `runCtx: passedRunCtx` — REUSE (REPL continuity) when supplied; `assembleRun` enforces the
  // tuple-identity invariant and skips re-preluding on a match (see its own header).
  // `capabilities: effectiveCapabilities` — the SAME fold, so `assembleRun`'s own
  // `buildVocabulary` call hits the SAME memoized `Vocabulary` this function already built.
  const runCtxOwned = passedRunCtx === undefined;
  const runCtx = await assembleRun({
    capabilities: effectiveCapabilities,
    config,
    evalScheme: capabilityEvalScheme,
    evalPrelude: preludeEvalScheme,
    runCtx: passedRunCtx,
    strict,
    heapBudget,
    freezeRosettaReturns,
    signal,
    cache,
    effects,
    reads,
    notes,
    display,
  });

  try {
    const results: SchemeValue[] = [];
    const forms = program.forms;
    const start = budgetMs === undefined ? 0 : performance.now();
    for (let i = 0; i < forms.length; i++) {
      const expr = forms[i];
      const remaining = budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      let result: SchemeValue;
      const runForm = () =>
        run(
          evaluate(expr, {
            resolver: runResolver,
            dynamic_env,
            use_dynamic,
            tap,
            nodeFilter,
            signal,
            strict: strict ?? false,
            runCtx,
          }),
          { signal, budgetMs: remaining },
        );
      try {
        result = expectValue(await (runCtx.reads ? runCtx.reads.tracker.region(runForm) : runForm()));
      } catch (e) {
        if (e instanceof ArrivalError && e.cause instanceof TypeError && !isHostRuntimeBug(e.cause)) throw e.cause;
        throw e;
      }
      results.push(result);

      if (runCtx.reads !== undefined && runCtx.effects !== undefined && runCtx.cache?.mode !== "replay") {
        checkReadWriteGuard(runCtx.effects.entries, runCtx.reads.tracker.log, runCtx.reads.writeSetOf);
      }
    }
    return { values: results, scope: runResolver.scope, runCtx };
  } finally {
    // Only THIS call's own (freshly-minted) RunContext is disposed here — a reused
    // `passedRunCtx` (REPL continuity) is the caller's own session-end teardown.
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

/** A short, safe rendering of an arrived value for the exit-contract door's "got …"
 *  clause — the same rendering `define/overridable`'s door uses (env/overridable/overridable.ts). */
function describeExitValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A short human phrase for the declared output schema, for the door's "expected …"
 *  clause. zod 4's public `.def.type` names the schema's own kind ("string", "object",
 *  "array", …); anything unreadable falls back to the honest generic phrase. */
function describeExitSchema(schema: ZodType): string {
  const type = (schema as { def?: { type?: string } }).def?.type;
  return typeof type === "string" ? `a value matching the declared ${type} contract` : "the declared output contract";
}

/**
 * SIMPLE tier — THE default exec surface, "run, get JS". Delegates to {@link execState}
 * (COMPLEX tier) and fully unwraps each result through {@link toJS} — a true membrane crossing.
 * Outside this function only plain-JS-observable values exist; provenance reading stays in the
 * run's trace (containers egress as lazy proxies, see membrane.ts's `toJS`). Callers that need
 * boxed values, the lexical scope, or the run context (law tests, tooling, REPL continuation)
 * use {@link execState} directly.
 *
 * THE RETURN SHAPE: a generic per-form tuple. The caller may assert the tuple shape —
 * `const [, users] = await exec<[void, User[]]>(…)` — a caller-asserted boundary generic (the
 * fetch-json idiom), zero runtime change; the default stays `unknown[]`. Composing half two:
 * `ExecOptions.output` — when supplied WITHOUT an explicit tuple, the schema's output face
 * drives the LAST element's static type (`[...unknown[], z.output<O>]`), and at runtime the
 * last form's result is validated against it either way (see the option's doc — the outbound
 * twin of `define/overridable`'s validation).
 *
 * @param code - String of Scheme code or pre-parsed SchemeValue
 * @param options - Optional environment and dynamic binding options
 * @returns one plain-JS value per top-level expression
 *
 * @example
 * ```typescript
 * // Simple arithmetic
 * const [result] = await exec("(+ 1 2 3)");  // result = 6
 *
 * // Multiple expressions
 * const results = await exec("(define x 10) (+ x 5)");  // results = [undefined, 15]
 *
 * // Caller-asserted tuple (checked by the reader, asserted by the caller)
 * const [, sum] = await exec<[void, number]>("(define x 10) (+ x 5)");  // sum: number
 *
 * // Exit contract — validated at the boundary AND driving the last element's type
 * const results = await exec("(+ 1 2)", { output: z.number() });  // last: number
 * ```
 */
export async function exec<O extends ZodType>(
  code: string | SchemeValue,
  options: ExecOptions & { output: O },
): Promise<[...unknown[], ZodOutputOf<O>]>;
export async function exec<T extends readonly unknown[] = unknown[]>(
  code: string | SchemeValue,
  options?: ExecOptions,
): Promise<T>;
export async function exec(code: string | SchemeValue, options: ExecOptions = {}): Promise<readonly unknown[]> {
  const state = await execState(code, options);
  const values = state.values.map((v) => toJS(v));
  const contract = options.output;
  if (contract !== undefined) {
    // THE EXIT DOOR — the outbound twin of define/overridable's validation: expected
    // vs got, plus the schema's own issue list (which names the precise mismatch path).
    if (values.length === 0) {
      throw new OutputContractError(describeExitSchema(contract), "no-forms");
    }
    const last = values.length - 1;
    const outcome = contract.safeParse(values[last]);
    if (!outcome.success) {
      const issues = outcome.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      throw new OutputContractError(describeExitSchema(contract), describeExitValue(values[last]), issues);
    }
    values[last] = outcome.data; // the parse result — transforms apply, and the static type says so
  }
  return values;
}

/**
 * Parse Scheme code without evaluating (delegates to the reader leaf, reader/parse.ts).
 * `source` (a filename / module path) is stamped onto every produced location,
 * so frames built from these forms read as `file:line` — used by `(require …)` to
 * attribute a module's throws to its file.
 *
 * Parsing is a pure reader-leaf call — no env consulted (the reader extension that once
 * looked one up is gone).
 */
export async function parse(code: string, source?: string): Promise<SchemeValue[]> {
  return readerParse(code, source);
}

/**
 * Execute a single pre-parsed expression. COMPLEX tier — the internal form-at-a-time entry
 * (require, prelude eval); returns one boxed SchemeValue, never unwrapped. Use this when
 * you've already parsed the code.
 *
 * `ExecOptions.runCtx` CONTRACT (Stage C, Cut 1): supplied ⇒ evaluate WITHIN that run — its
 * `vocabulary`/`degraded`/`capabilityConfigurations`, its meter (`heapMeter`), its `strict`, its
 * `signal`, its per-run extension registry (`loader-capability.ts`'s `loaderRegistryOf` keys off
 * `runCtx.vocabulary`) — reused verbatim, never re-minted, and left for the CALLER to dispose
 * (same ownership posture `execState`'s `runCtxOwned` already documents). Absent ⇒ standalone
 * throwaway run.
 *
 * STAGE C CUT 3b — the standalone default is now VOCABULARY-BEARING (previously a vocabulary-
 * less `new RunContext(...)`, the "realm-cached `defaultLexicalRoot()` + `Capabilities.assembled
 * (user_env)`" glass-adjacent shape): with no `resolver` and no `runCtx` supplied, this mints the
 * degenerate `BASE_ROSTER` tuple (the SAME memoized `Vocabulary`/`sealedVocabularyChain` a bare
 * `execState(code)` shares) via `assembleRun`, so the standalone run carries a real `vocabulary`
 * — which is what makes `loader-capability.ts`'s `loaderRegistryOf`'s "no vocabulary" arm
 * genuinely unreachable from any sanctioned call path (a bare `execExpr` used to be the one
 * exception; it no longer is).
 *
 * `require`'s module-eval loop (loader-capability.ts) threads the requiring run's LIVE `runCtx`
 * so a nested `(require …)` inside a `.scm` module resolves through the SAME run (and the SAME
 * per-run extension registry) as its parent — instead of falling to a vocabulary-less standalone.
 */
export async function execExpr(
  expr: SchemeValue,
  {
    resolver,
    dynamic_env,
    use_dynamic,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    heapBudget,
    cache,
    effects,
    reads,
    runCtx: passedRunCtx,
  }: ExecOptions = {},
): Promise<SchemeValue> {
  const runCtxOwned = passedRunCtx === undefined;
  // STANDALONE DEFAULT — the degenerate BASE_ROSTER tuple (see this function's own doc), minted
  // regardless of whether `resolver` is supplied: a passed-`resolver` caller (the module-eval /
  // prelude passthrough) threads its OWN `runCtx` alongside it on every sanctioned call path
  // (loader-capability.ts always threads both), so this only ever mints fresh when BOTH are
  // absent — a bare `execExpr(expr)` call.
  const runCtx =
    passedRunCtx ??
    (await assembleRun({
      capabilities: BASE_ROSTER,
      evalScheme: capabilityEvalScheme,
      evalPrelude: preludeEvalScheme,
      heapBudget,
      signal,
      cache,
      effects,
      reads,
    }));
  let runResolver = resolver;
  if (runResolver === undefined) {
    const vocabulary = await buildVocabulary(BASE_ROSTER, undefined, capabilityEvalScheme);
    const { chainFrame, chain } = sealedVocabularyChain(vocabulary);
    runResolver = new Resolver(LexicalScope.fresh().env, new Capabilities(chainFrame, chain));
  }
  // The run axis is the SOURCE OF TRUTH once a runCtx exists (mirrors the call-time-ctx discipline,
  // evaluator.ts's lambda `runner` — `bodyCtx.signal = callCtx.runCtx.signal`): a freshly-minted
  // runCtx's `.signal` is exactly the `signal` option above, so this is byte-compatible when
  // `runCtx` is absent, and correctly authoritative (over a stray separate `signal` option) when
  // it's supplied.
  const runSignal = runCtx.signal;

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
          signal: runSignal,
          runCtx,
        }),
        { signal: runSignal, budgetMs },
      ),
    );
  } catch (e) {
    if (e instanceof ArrivalError && e.cause instanceof TypeError) throw e.cause;
    throw e;
  } finally {
    // A passed-in `runCtx` is CALLER-owned — same posture `execState`'s `runCtxOwned` already
    // documents — so only a runCtx THIS call minted itself is torn down here.
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// INTERNAL LIVE-FRAME SEAM (Stage C Cut 3b) — NOT part of the public `ExecOptions` surface, NOT
// barrel-exported from index.ts. The retired public `env` (glass) option's narrow replacement
// for the one class of caller that still legitimately needs it: a test harness that mints its
// OWN live `AmbientRuntime` frame (often a child of `inferenceEnv`, below), binds bespoke
// rosettas/resolvers onto it by hand, and evaluates code directly against that frame — rather
// than declaring a proper `EnvCapability` and going through `{ capabilities }`. Production code
// (this module's own `execState`/`exec`/`execExpr` above) never uses this seam.
//
// `ExecOptionsOverFrame` is `ExecOptions` plus a REQUIRED `env` — never optional, so a caller
// reaching this seam is always explicit about it (no accidental fallthrough from the vocabulary
// path). Mirrors the retired `execStateViaAmbient`'s own glass branch byte-for-byte (phase 3:
// build a resolver straight over `env` + mint/reuse a `RunContext`; phase 4: the same per-form
// loop) — minus the ambient-assembly phase, which a glass caller never had anyway.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export type ExecOptionsOverFrame = ExecOptions & { readonly env: SchemeEnv };

/**
 * Lazily bind the full self-hosted `BASE_ROSTER` vocabulary flatly onto {@link inferenceEnv},
 * once (memoized) — mirrors the retired realm bootstrap's "empty at mint, filled before first
 * genuine use" contract, scoped to this one internal test-compat frame. Idempotent-cheap to call
 * unconditionally (every `*OverFrame` entry does): a frame unrelated to `inferenceEnv` (e.g. a
 * fully hand-rolled, parent-less test env) is unaffected — this only ever touches `inferenceEnv`
 * itself.
 */
let _inferenceEnvPopulated: Promise<void> | undefined;
export function ensureInferenceEnvPopulated(): Promise<void> {
  return (_inferenceEnvPopulated ??= (async () => {
    const vocabulary = await buildVocabulary(BASE_ROSTER, undefined, capabilityEvalScheme);
    for (const [name, value] of vocabulary.map) bindValue(inferenceEnv, name, value);
  })());
}

/**
 * COMPLEX tier over a caller-held live frame — see this section's own header. `env`'s
 * `__parent__` chain resolves builtins (the glass `Resolver(env)` composition, Resolver.ts);
 * `scope`/`runCtx` reuse are honored exactly like the vocabulary path's `execState`.
 */
export async function execStateOverFrame(code: string | SchemeValue, options: ExecOptionsOverFrame): Promise<ExecState> {
  const {
    env,
    scope,
    runCtx: passedRunCtx,
    program: passedProgram,
    dynamic_env,
    use_dynamic,
    tap,
    nodeFilter,
    signal,
    budgetMs,
    heapBudget,
    cache,
    effects,
    reads,
    notes,
    display,
    strict,
    freezeRosettaReturns,
  } = options;
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("execStateOverFrame", "expected a concrete AmbientRuntime");
  await ensureInferenceEnvPopulated();

  const program = passedProgram ?? (await parseProgram(code, { strict }));
  const runResolver = scope !== undefined ? new Resolver(scope.env) : new Resolver(env);
  const runCtxOwned = passedRunCtx === undefined;
  const runCtx =
    passedRunCtx ??
    new RunContext({ strict: strict ?? false, heapBudget, freezeRosettaReturns, signal, cache, effects, reads, notes, display });

  try {
    const results: SchemeValue[] = [];
    const forms = program.forms;
    const start = budgetMs === undefined ? 0 : performance.now();
    for (let i = 0; i < forms.length; i++) {
      const expr = forms[i];
      const remaining = budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      let result: SchemeValue;
      const runForm = () =>
        run(
          evaluate(expr, {
            resolver: runResolver,
            dynamic_env,
            use_dynamic,
            tap,
            nodeFilter,
            signal,
            strict: strict ?? false,
            runCtx,
          }),
          { signal, budgetMs: remaining },
        );
      try {
        result = expectValue(await (runCtx.reads ? runCtx.reads.tracker.region(runForm) : runForm()));
      } catch (e) {
        if (e instanceof ArrivalError && e.cause instanceof TypeError && !isHostRuntimeBug(e.cause)) throw e.cause;
        throw e;
      }
      results.push(result);

      if (runCtx.reads !== undefined && runCtx.effects !== undefined && runCtx.cache?.mode !== "replay") {
        checkReadWriteGuard(runCtx.effects.entries, runCtx.reads.tracker.log, runCtx.reads.writeSetOf);
      }
    }
    return { values: results, scope: runResolver.scope, runCtx };
  } finally {
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

/** SIMPLE tier over a caller-held live frame — see this section's own header. Delegates to
 *  {@link execStateOverFrame} and unwraps through {@link toJS}, mirroring `exec`. */
export async function execOverFrame(code: string | SchemeValue, options: ExecOptionsOverFrame): Promise<readonly unknown[]> {
  const state = await execStateOverFrame(code, options);
  return state.values.map((v) => toJS(v));
}

/** Single-form COMPLEX tier over a caller-held live frame — mirrors `execExpr`, minus the
 *  standalone-default machinery (a caller reaching this seam always holds a real frame). */
export async function execExprOverFrame(
  expr: SchemeValue,
  { env, dynamic_env, use_dynamic, tap, nodeFilter, signal, budgetMs, heapBudget, cache, effects, reads, runCtx: passedRunCtx }: ExecOptionsOverFrame,
): Promise<SchemeValue> {
  if (!isAmbientRuntime(env)) throw new AmbientShapeError("execExprOverFrame", "expected a concrete AmbientRuntime");
  await ensureInferenceEnvPopulated();
  const runResolver = new Resolver(env);
  const runCtxOwned = passedRunCtx === undefined;
  const runCtx = passedRunCtx ?? new RunContext({ signal, heapBudget, cache, effects, reads });
  const runSignal = runCtx.signal;
  try {
    return expectValue(
      await run(
        evaluate(expr, { resolver: runResolver, dynamic_env, use_dynamic, tap, nodeFilter, signal: runSignal, runCtx }),
        { signal: runSignal, budgetMs },
      ),
    );
  } catch (e) {
    if (e instanceof ArrivalError && e.cause instanceof TypeError) throw e.cause;
    throw e;
  } finally {
    if (runCtxOwned) await disposeRunContext(runCtx);
  }
}

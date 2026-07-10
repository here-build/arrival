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
import { assembleEnv, type AssembledEnv } from "../common/kernel.js";
import { sealResolutionChain } from "./CompiledResolutionChain.js";
import { StaticValidationError } from "../static-validation/validate-program.js";
import type { DegradationMode } from "../common/degradation.js";
import type { EnvCapability } from "../common/capability.js";
import { overridableCapability } from "../env/overridable.js";
import type { EvalSchemeInto, SchemeEnv } from "../common/scheme-env.js";
import invariant from "tiny-invariant";
import { parse as readerParse } from "../reader/parse.js";
import { assertShadowCone } from "../values/lineage-shadow.js";
import { type LineageNode } from "../values/lineage.js";
import {
  ambientBase,
  classifyProgram,
  instantiate,
  makeAssembledAmbient,
  parseProgram,
  validateAgainstAmbient,
  type AssembledAmbient,
  type ParsedProgram,
} from "./exec-phases.js";
import { makeRunContext, type RunContext } from "../values/primitives/RunContext.js";
import type { RunCache } from "../values/run-cache.js";
import type { EffectLog } from "../values/effect-log.js";
import type { ReadGuard } from "../values/read-guard.js";
import { checkReadWriteGuard } from "../values/read-guard.js";
// TYPE-ONLY (erased — no runtime scheme-zod edge from this module): the `exec` exit
// contract's schema type + its output-face projection (the output-bearing overload).
import type { output as ZodOutputOf, ZodType } from "../common/scheme-zod.js";
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
/** The realm base's own `AssembledEnv` handle (the user_env BASE_PACKS assembly) — retained
 *  so `defaultAmbient()` below can carry the HONEST composition record (order/degraded/
 *  activations) instead of a synthesized facade. Never disposed — realm-scoped by design. */
let _baseAssembledEnv: AssembledEnv<SchemeEnv> | undefined;
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
    _baseAssembledEnv = await assembleEnv<SchemeEnv>(
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

/** Phase-2 assembly options — see {@link assembleAmbient}. */
export interface AssembleAmbientOptions {
  /** Capability packs assembled onto the standard base (`user_env → global_env`) —
   *  same semantics as `ExecOptions.capabilities`. Empty/absent ⇒ a bare (but still
   *  ownable/disposable) child of the standard base. */
  capabilities?: readonly EnvCapability[];
  /** The ONE shared config bag handed to every capability's `lower()` — see
   *  `ExecOptions.config`. */
  config?: object;
  /** Door-set degradation mode for the lowering (see common/degradation.ts). exec's
   *  `staticValidation: "on"` path assembles with `"doors"`. */
  degradation?: DegradationMode;
  /** Default per-run allocation budget POLICY for runs on this ambient —
   *  `ExecOptions.heapBudget` wins per call. See `AssembledAmbient.heapBudget`. */
  heapBudget?: number;
}

/**
 * PHASE 2, public (exec-phases-and-dynamic-metadata.md §3.1; export home = the `/env`
 * subpath, privatization D1): assemble the ambient once, reuse across N runs —
 * `exec(code, { ambient })` — and dispose deliberately (`await using` works: the product
 * is an `AsyncDisposable`). This is `assembleCapabilityBase` made whole: a fresh
 * `user_env` child with the supplied capabilities assembled on top (AUGMENTING the
 * standard base, never replacing it; fresh child per assembly = no cross-call bleed),
 * sealed (ENV T2), and — the fix for dispose-drop site #4 — returning the HANDLE instead
 * of dropping it: `dispose()` runs the kernel's pack disposers AND every lowered pack's
 * resource wind-down.
 */
export async function assembleAmbient(opts: AssembleAmbientOptions = {}): Promise<AssembledAmbient> {
  await ensureBaseAssembled();
  const capabilities = opts.capabilities ?? [];
  const base = user_env.inherit("exec-capabilities");
  const lowered = capabilities.map((c) =>
    c.lower({ evalScheme: capabilityEvalScheme, config: opts.config, degradation: opts.degradation }),
  );
  const assembled = await assembleEnv<SchemeEnv>(base, lowered);
  // Seal the per-assembly baked base (ENV T2) — `Capabilities.assembled(base)` (via
  // `instantiate`) reuses this artifact (memoized per env), so every run on this ambient
  // resolves through the frozen chain.
  const chain = sealResolutionChain(base);
  return makeAssembledAmbient({
    base,
    capabilities,
    assembled,
    lowered,
    chain,
    heapBudget: opts.heapBudget,
    disposable: true,
  });
}

/**
 * The DEFAULT ambient — the realm-memoized product over the standard assembled base
 * (`user_env → global_env`), the phase-2 value a bare `exec(code)` resolves through.
 * NEVER disposed (realm-scoped by design — `disposable: false` makes `dispose()` a
 * documented no-op), exactly the ownership table's "realm default" row.
 */
let _defaultAmbient: AssembledAmbient | undefined;
function defaultAmbient(): AssembledAmbient {
  invariant(_baseAssembledEnv !== undefined, "defaultAmbient: bootstrap has not completed");
  return (_defaultAmbient ??= makeAssembledAmbient({
    base: user_env,
    capabilities: [],
    assembled: _baseAssembledEnv,
    lowered: [],
    chain: sealResolutionChain(user_env),
    disposable: false,
  }));
}

export interface ExecOptions {
  /**
   * GLASS — custom base env. When set, the resolver wraps it directly: defines
   * land in it, builtins resolve up its `__parent__` chain (byte-identical to
   * pre-cut). Takes precedence over `capabilities`/`scope` (the cut refinements);
   * use `env` OR the cut options.
   *
   * Typed `SchemeEnv` (V2, arrival-environment-privatization.md §II.3/D2), not the
   * concrete `Environment` — this frees external glass callers from the
   * `ReturnType<typeof sandboxedEnv.inherit>` alias; they now type against the already-
   * exported structural contract. Narrows back to `Environment` honestly (`instanceof`,
   * the `preludeExec` precedent above) at the one seam below that needs the concrete
   * frame class.
   */
  env?: SchemeEnv;
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
   * SEAMLESS PARAMETER INJECTION for `define/overridable` (V, 2026-07-10: "no
   * jsToScheme at all — it should be seamless"). Sugar over the cut: when set,
   * `arrival/overridable` is appended to this run's `capabilities` (identity-deduped
   * by the kernel if already listed) and this record is merged into
   * `config.params` (override wins key-wise). The program declares the parameter,
   * its s/* type, and its default; the host supplies the value; `overridable/resolve`
   * validates WHOEVER supplied it and boxes it at the membrane — no `jsToScheme`,
   * no `env.set` at the call site:
   *
   *     await exec(`(define/overridable users (s/array (s/object …)) (list))
   *                 (map transform users)`,
   *                { override: { users: [john, mary] } });
   *
   * Ignored when `env` (glass) is set — same posture as `capabilities`/`scope`.
   */
  override?: Record<string, unknown>;
  /**
   * THE CUT, scope-refined. Lexical root the run's top-level `define`s land in.
   * Pass a persistent {@link LexicalScope} (`LexicalScope.for(env)`) across calls
   * for REPL-style multi-step accumulation, instead of the realm-cached default
   * scratch frame. Builtins still resolve through the capability base (composed
   * `scope.lookup ?? capabilities.lookup`). Ignored when `env` (glass) is set.
   */
  scope?: LexicalScope;
  /**
   * PHASE-2 OVERRIDE (exec-phases §3.3): a pre-assembled ambient — skip assembly
   * entirely. CALLER-owned: exec will NOT dispose it (the DO-rehydration / MCP-session
   * warm-reuse idiom — assemble once via {@link assembleAmbient}, run N times, dispose
   * deliberately / `await using`). Takes precedence over `capabilities`/`config`
   * (assembly inputs are meaningless when assembly is skipped; `override` still needs a
   * live overridable capability on the AMBIENT, so pass it to `assembleAmbient` instead).
   * Ignored when `env` (glass) is set — same posture as every cut refinement.
   */
  ambient?: AssembledAmbient;
  /**
   * PHASE-1 OVERRIDE (exec-phases §3.3): a pre-parsed program — skip the reader (the
   * parse-once-run-many idiom, {@link parseProgram}). When set, the `code` argument is
   * ignored. The program's READER strictness is its own stamped identity fact
   * (`ParsedProgram.strict`); `ExecOptions.strict` keeps governing the RUN mode.
   */
  program?: ParsedProgram;
  /**
   * MODULE-EVAL RESOLVER PASSTHROUGH (COMPLEX tier — consumed by {@link execExpr}
   * only; `exec`/`execState` ignore it). Evaluate through an EXISTING composed
   * `Resolver` instead of constructing one from `env`. THE seam `(require …)`
   * (src/loader/) uses: a required module's forms must resolve through the SAME
   * scope+capability composition as the requiring program — cut: null-rooted
   * lexical root + assembled capability base; glass: the live base-linked env.
   * Reconstructing from an env alone drops the capability half under the cut
   * (the stdlib lives on the base, so module code would see `string-append`
   * unbound). Takes precedence over `env` in `execExpr`. Obtained via the
   * evaluator's `currentRunResolver()` back-channel at the require apply boundary.
   */
  resolver?: Resolver;
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
   * THE RUN CACHE (values/run-cache.ts — R2, arrival-mcp-rework-over-phases.md §2.2).
   * When set, rides `makeRunContext` onto the run's `RunContext.cache`, and every baked
   * rosetta penetration is intercepted at the decode/fire chokepoint per the mode law:
   * in `"record"` mode the impl always fires (a `view` writes/overwrites its slot, a
   * `sink` writes its tombstone); in `"replay"` mode a `view` hit is served without
   * re-firing, a `sink` tombstone skips, and `pure`/unclassified always re-fire.
   * `undefined` (the default) ⇒ no interception — byte-identical to today. The cache
   * is a RUN-level entity: session identity (epoch/roster/configDigest validity) is the
   * session layer's concern, checked BEFORE a cache is handed to a run.
   */
  cache?: RunCache;
  /**
   * THE EFFECT LOG (values/effect-log.ts — W1, docs/working-proposals/
   * arrival-plexus-effect-burst.md §2.3). When set, rides `makeRunContext` onto the
   * run's `RunContext.effects`, and every baked rosetta `sink` penetration — during a
   * PRIME run, i.e. `cache` absent or `cache.mode !== "replay"` — enqueues onto it and
   * returns `undefined` immediately instead of firing. A SIBLING of `cache`, not a
   * field on it: pass `effects` alone to gather sinks with no `RunCache` at all, or
   * alongside `cache` to gather sinks while a `view`/`pure` cache still serves reads.
   * `undefined` (the default) ⇒ no burst arm — byte-identical to today (a sink fires
   * immediately). Draining the log (the actual burst — plexus region, atomicity,
   * conflict handling) is HOST territory (W3+); this option only wires the gather.
   */
  effects?: EffectLog;
  /**
   * THE READ GUARD (W2, values/read-guard.ts, docs/working-proposals/
   * arrival-plexus-effect-burst.md §2.4). When set, rides `makeRunContext` onto the
   * run's `RunContext.reads`, and the per-form loop below wraps each top-level form's
   * evaluation in `reads.tracker.region(...)` — so the host's tracking substrate (a
   * mobx tracking context over plexus reads, armed by the host; arrival core never
   * depends on mobx/plexus directly) can observe reads for that form's duration. After
   * each form, for a PRIME run gathering effects (mirroring the burst arm's own
   * `cache?.mode !== "replay"` gate — a fold never gathers, so it never needs a guard),
   * `checkReadWriteGuard` runs over the effect log's current entries against the
   * reads observed so far: a read that lands on a target a PRIOR gathered effect will
   * write throws `ReadYourDeferredWriteError` (the teaching door — see read-guard.ts).
   * `undefined` (the default) ⇒ no tracking, no guard — byte-identical to today. A
   * `reads` with no `writeSetOf` armed (host tracks reads but can't predict write
   * footprints yet) never crashes — the guard degrades to a no-op, not a false claim.
   */
  reads?: ReadGuard;
  /**
   * THE EXIT CONTRACT (B2, arrival-type-hardening-ladder.md §1.2 — RULED: "generic
   * per-form tuple + zod `output` contract"). When supplied, the LAST form's result is
   * validated against this schema at the exit boundary — AFTER the `toJS` unwrap, so
   * the schema describes the plain-JS value `exec` actually hands back (a plain zod
   * schema, not a scheme-face codec). A mismatch throws a teaching door naming
   * expected vs got — the outbound twin of `define/overridable`'s validation
   * (env/overridable.ts): the program declares what it yields, the host declares what
   * it expects, and the boundary checks BOTH directions. The parse RESULT replaces the
   * last element (schema transforms/coercions apply), which is what lets the schema
   * drive the static return type: `exec`'s output-bearing overload types the result as
   * `[...unknown[], z.output<O>]` when the generic tuple isn't given explicitly.
   * Consumed by `exec` (the SIMPLE tier's exit) only — `execState`/`execExpr` hand
   * back boxed values and perform no exit validation.
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
   * THE STATIC VALIDATION PASS (W3, symbol-define-static-program-validation.md §3.6).
   * `"on"` runs `validateProgram` over the parsed forms — against the run's SEALED
   * chain + session scope — after parse, before the first form evaluates; error-tier
   * diagnostics throw ONE `StaticValidationError` carrying the COMPLETE list (V's
   * "never crash-on-first" as an API shape), with ZERO side effects fired. `"on"`
   * also opts this run's capability lowering into `degradation: "doors"` (§3.7's
   * caller split — doors become the effective posture exactly where a program is
   * present to validate), so an absent OPTIONAL enabling config key surfaces as a
   * parse-phase causal-chain diagnostic instead of a mid-run unbound throw.
   *
   * DEFAULT — `"off"` (opt-in), RESOLVED at W4-H4 (not a staging compromise). The
   * `exec` PRIMITIVE stays opt-in because it is the low-level building block that the
   * door/purity/typo LAW suites and internal provisioning evals use to exercise
   * RUNTIME behavior — a global default flip here conflates that primitive with the
   * program-scoped production ENTRY points and (measured, W4-H4) turns ~313 law/behavior
   * assertions across 14 suites into parse-phase throws, several of them deliberate
   * runtime invariants (door-fires-at-apply, typo-at-runtime), not stale pins. §3.7's
   * caller split is the actual posture: strictness is CALLER-scoped — the production
   * entry points (DiscoveryTool.call, runProgram) opt IN by passing `"on"` (the "doors
   * as the real production entry" line), which is their remaining W3 wiring, NOT a flip
   * of this primitive's default. GLASS (`env`) runs never validate regardless — a live,
   * embedder-mutable frame chain has no seal, so the pass makes no claims there
   * (§3.5); the runtime doors remain the backstop.
   *
   * STRICTNESS CAVEAT (§6.6, documented divergence): dead-branch references —
   * `(if #f (missing) 42)` — REPORT under `"on"` although they run today; dead
   * references are drift, and this knob is the opt-out.
   */
  staticValidation?: "on" | "off";
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
  /**
   * The ambient this run resolved through (phase-2 product) — the session handle a
   * COMPLEX-tier caller continues on (`execState(code, { ambient, scope })`). Absent on
   * GLASS runs (`env` set — no product by design, §3.4). CAUTION on `{ capabilities }`
   * runs: exec OWNED that ambient and disposed it at run end (the §3.3 ownership rule);
   * the handle stays inspectable (catalog reads spec data; a resource re-spawns on
   * touch), but reuse-after-dispose is off-contract — a caller wanting warm reuse
   * assembles once and passes `{ ambient }`.
   */
  readonly ambient?: AssembledAmbient;
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
export async function execState(code: string | SchemeValue, options: ExecOptions = {}): Promise<ExecState> {
  const {
    env,
    capabilities,
    config,
    override,
    scope,
    ambient: passedAmbient,
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
    strict,
    freezeRosettaReturns,
    staticValidation,
    skipBootstrapWait,
    irLineage,
  } = options;
  // Default env = env-roots leaf `user_env` (arrival's interaction scope,
  // `global_env.inherit("user-env")`), sourced STATICALLY so this entry never
  // imports the stdlib monolith. Bootstrap gate below drives population:
  // `ensureBaseAssembled` assembles native packs + the `.scm` base.
  const actualEnv = env ?? user_env;
  // SchemeEnv → Environment: `user_env` is always concrete, so this only narrows
  // anything on the GLASS path (`env` set) — but every consumer below (Resolver,
  // Capabilities.assembled, classifierFromEnv, sealResolutionChain) needs the
  // concrete frame regardless of path, so the check sits right here, at the seam,
  // same honest-instanceof posture as `preludeExec` above (not a cast — a runtime fact).
  invariant(actualEnv instanceof Environment, "exec: glass `env` must be a concrete Environment");

  // Lazy self-init the runtime bootstrap (native packs + .scm base), so embedders
  // never trigger it manually. `ensureBaseAssembled` is realm-cached (one
  // in-flight/settled promise): first exec assembles, every later exec awaits the
  // same settled promise — no half-assembled env observable. `skipBootstrapWait` is
  // the one exception: a base-pack prelude eval IS the bootstrap and must not
  // await its own promise.
  if (!skipBootstrapWait) await ensureBaseAssembled();

  // ── PHASE 1 — parse (or reuse a pre-parsed `ParsedProgram`). The READER strict mode
  // is stamped as a program identity fact; the RUN strict mode stays on `runCtx` below —
  // one option, two declared landings (exec-phases §3.1).
  const program = passedProgram ?? (await parseProgram(code, { strict }));

  // ── PHASE 2 — the ambient. THE EXEC SEAM: glass-for-custom-env (NO phase product —
  // §3.4: a glass caller holds a live frame; exec makes no claims about it), cut-for-
  // default, refined by capabilities/scope/ambient. `env` wins over every cut refinement.
  // The §3.3 OWNERSHIP RULE (phase 5): `owned` = THIS call assembled it — per-call
  // `{ capabilities }` assemblies are disposed in the `finally` below (LEDGERED, V-pending
  // #5 resolved per the doc's own recommendation: a behavior change from leak to teardown —
  // `onDispose` teardowns + resource wind-downs now fire at run end, every run, including
  // throw paths; a caller wanting warm reuse across runs uses the designed idiom instead:
  // `assembleAmbient` once, pass `{ ambient }`, which exec never disposes). The realm
  // default is never disposed (realm-scoped memo by design); glass has no handle at all.
  let ambient: AssembledAmbient | undefined;
  let owned = false;
  const validating = env === undefined && staticValidation === "on";
  if (env === undefined) {
    // `override` sugar (ExecOptions.override): append the overridable capability
    // (kernel identity-dedup makes a caller-listed copy harmless) and merge the
    // record into the shared bag's `params` slice, override winning key-wise.
    // Everything downstream sees a plain capabilities+config run.
    const effectiveCapabilities =
      override !== undefined ? [...(capabilities ?? []), overridableCapability] : capabilities;
    const effectiveConfig =
      override !== undefined
        ? { ...config, params: { ...(config as { params?: Record<string, unknown> } | undefined)?.params, ...override } }
        : config;
    if (passedAmbient !== undefined) {
      ambient = passedAmbient; // reuse — skip assembly; CALLER-owned (never disposed here)
    } else if (effectiveCapabilities !== undefined) {
      // §3.7's caller split: a program-scoped run that opted into the pass also opts its
      // capability lowering into doors — an absent OPTIONAL enabling key binds a
      // cause-carrying door for the validator to report ON, instead of withholding.
      ambient = await assembleAmbient({
        capabilities: effectiveCapabilities,
        config: effectiveConfig,
        degradation: validating ? "doors" : undefined,
      });
      owned = true; // phase 5 fires in the `finally` — dispose-drop site #4, fixed structurally
    } else {
      ambient = defaultAmbient(); // the realm-scoped memo — ownership row "never"
    }
  }

  try {
    // ── PHASE 3 — instantiate: scope OBTAINED (caller-passed for REPL continuity, else
    // the realm-cached ACCUMULATING scratch root — REPL semantics preserved exactly);
    // only `runCtx` is minted fresh (per-run by T0). The meter/budget notes from the
    // pre-split pipeline hold verbatim: the allocation meter lives on `runCtx` ONLY,
    // spans the whole exec, and every value built during this run carries it.
    let runResolver: Resolver;
    let runCtx: RunContext;
    if (env !== undefined) {
      // GLASS — resolver wraps the live env; defines land in it; builtins resolve up its
      // base-linked chain — byte-identical (zero change for arrival-chain/inhuman). The
      // validation pass is not offered here (§3.5: no seal ⇒ no claims); the runtime
      // doors (unbound-variable throw + suggestions, PurityError) remain the backstop.
      runResolver = new Resolver(actualEnv);
      runCtx = makeRunContext({
        strict: strict ?? false,
        heapBudget,
        freezeRosettaReturns,
        signal,
        cache,
        effects,
        reads,
      });
    } else {
      const lexicalScope = scope ?? LexicalScope.for(defaultLexicalRoot());
      // ── PHASE 2.5 — static validation (W3, §3.6): validate AFTER parse, BEFORE the
      // first form evaluates — the complete list, one throw, zero side effects fired.
      if (validating) {
        const diagnostics = validateAgainstAmbient(program, ambient!, lexicalScope);
        if (diagnostics.some((d) => d.severity === "error")) throw new StaticValidationError(diagnostics);
      }
      const instance = instantiate(ambient!, {
        scope: lexicalScope,
        strict,
        heapBudget,
        freezeRosettaReturns,
        signal,
        cache,
        effects,
        reads,
      });
      runResolver = instance.resolver;
      runCtx = instance.runCtx;
    }

    // ── PHASE 2.5 — SHADOW MODE slice 2, classify@load: one static lineage skeleton per
    // form, BEFORE evaluation. Pure (classify runs no eval); gated entirely behind the
    // flag so flag-OFF is byte-identical. Classified against the POST-AUGMENTATION base —
    // the phase split fixes the §1.1 classifier wrinkle by construction (a
    // `{ capabilities }` run's capability-declared provenance roles are now visible to
    // the skeleton; glass keeps classifying against its own live env, as always).
    const classifierBase = ambient !== undefined ? ambientBase(ambient) : actualEnv;
    let shadowSkeletons: LineageNode[] | undefined;
    if (irLineage) {
      shadowSkeletons = classifyProgram(program, classifierBase);
    }

    // ── PHASE 4 — execute. Evaluate each form in sequence; budget spans the WHOLE exec
    // call (all top-level forms share one deadline) — a sandbox program that splits a
    // hang across several forms is still bounded. Defines land in the resolver's lexical
    // env; the heap meter lives on `runCtx` only (above), never on the frame.
    const results: SchemeValue[] = [];
    const forms = program.forms;
    const start = budgetMs === undefined ? 0 : performance.now();
    for (let i = 0; i < forms.length; i++) {
      const expr = forms[i];
      const remaining = budgetMs === undefined ? undefined : budgetMs - (performance.now() - start);
      // Audit-#42 wrapOperator contract: run() wraps every non-ArrivalError —
      // including the TypeError wrapOperator throws to name operator + arg types —
      // in an ArrivalError, masking both the TypeError class and its membrane cause.
      // Surface the original TypeError so the user-visible error shape survives.
      let result: SchemeValue;
      // THE READ-TRACKING REGION (W2, values/read-guard.ts, §2.4): one top-level form is
      // the region unit. `runForm` is the plain (untracked) evaluation; when `runCtx.reads`
      // is armed, the host's tracker wraps it for the call's duration so its tracking
      // substrate (mobx over plexus, host-side) observes this form's reads. Absent ⇒
      // `runForm()` runs directly, byte-identical to pre-W2.
      const runForm = () =>
        run(
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
        );
      try {
        // Top-level form evaluates to a value, never a bare expander — seal it.
        result = expectValue(await (runCtx.reads ? runCtx.reads.tracker.region(runForm) : runForm()));
      } catch (e) {
        if (e instanceof ArrivalError && e.cause instanceof TypeError && !isHostRuntimeBug(e.cause)) throw e.cause;
        throw e;
      }
      results.push(result);

      // THE GUARD CHECK (W2, §2.4): after each form, for a PRIME run gathering effects —
      // mirroring the burst arm's own `cache?.mode !== "replay"` gate (run-cache.ts) so a
      // fold (which never gathers) never trips it — check whether any read observed so
      // far lands on a target a PRIOR gathered effect will write. Throws
      // `ReadYourDeferredWriteError` (the teaching door) on the first violation; a clean
      // run (or a run missing either `reads` or `effects`, or `writeSetOf` unarmed) is a
      // no-op. Guard region = EXECUTION only (Part V.1's ruling) — never re-checked at
      // the (post-burst) serializer walk, which this loop does not perform.
      if (runCtx.reads !== undefined && runCtx.effects !== undefined && runCtx.cache?.mode !== "replay") {
        checkReadWriteGuard(runCtx.effects.entries, runCtx.reads.tracker.log, runCtx.reads.writeSetOf);
      }

      // SHADOW MODE slice 3 — the assert. Compare static fullCone against this
      // form's UNTAPPED eager `result.provenance` (mechanism 1; NO tap installed).
      // In-scope divergence throws ProvenanceShadowDivergence; a macro-head /
      // keyword-projection form abstains (returns a skip reason we discard — it is
      // outside the classifier's model, so shadow does not assert it). Behind the
      // flag — never runs flag-OFF.
      if (irLineage && shadowSkeletons) {
        assertShadowCone(shadowSkeletons[i], expr, result, classifierBase, String(expr));
      }
    }

    // ── PHASE 6 — return (the existing two-tier cut; `ambient` is the additive session
    // handle — absent on glass runs, which have no product by design).
    return { values: results, scope: runResolver.scope, runCtx, ambient };
  } finally {
    // ── PHASE 5 — the pipeline's OWN step (ownership table §3.3): dispose exactly what
    // THIS call assembled. Fires on success AND throw paths (validation errors included).
    if (owned) await ambient!.dispose();
  }
}

/** A short, safe rendering of an arrived value for the exit-contract door's "got …"
 *  clause — the same rendering `define/overridable`'s door uses (env/overridable.ts). */
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
 * SIMPLE tier (docs/working-proposals/two-tier-exec-api.md, RULINGS.md R1) — THE
 * default exec surface, "run, get JS". Delegates to {@link execState} (COMPLEX
 * tier) and fully unwraps each result through {@link toJS} — a true P4 membrane
 * crossing. Outside this function only plain-JS-observable values exist;
 * provenance reading stays in the run's trace (containers egress as R9 lazy
 * proxies, see membrane.ts's `toJS`). Callers that need boxed values, the
 * lexical scope, or the run context (law tests, tooling, REPL continuation)
 * use {@link execState} directly.
 *
 * THE RETURN SHAPE (B2, arrival-type-hardening-ladder.md §1.2 — RULED): a generic
 * per-form tuple. The caller may assert the tuple shape —
 * `const [, users] = await exec<[void, User[]]>(…)` — a caller-asserted boundary
 * generic (the fetch-json idiom), zero runtime change; the default stays `unknown[]`.
 * Composing half two: `ExecOptions.output` — when supplied WITHOUT an explicit tuple,
 * the schema's output face drives the LAST element's static type
 * (`[...unknown[], z.output<O>]`), and at runtime the last form's result is validated
 * against it either way (see the option's doc — the outbound twin of
 * `define/overridable`'s validation).
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
      throw new Error(
        `exec output contract: expected ${describeExitSchema(contract)}, got NO forms at all — ` +
          `an empty program has no last result to validate; drop the \`output\` option or run a real form`,
      );
    }
    const last = values.length - 1;
    const outcome = contract.safeParse(values[last]);
    if (!outcome.success) {
      const issues = outcome.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      throw new Error(
        `exec output contract: expected ${describeExitSchema(contract)}, got ` +
          `${describeExitValue(values[last])} — ${issues} — the program's last form must satisfy the ` +
          `declared \`output\` schema at the exit boundary (the outbound twin of define/overridable's validation)`,
      );
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
 * V1 (arrival-environment-privatization.md §II.3): the inert `_env` parameter this
 * used to carry (kept for API compat after the reader-extension lookup that consulted
 * it was removed — parsing has been a pure reader-leaf call for a while) is deleted
 * outright, not deprecated — it did nothing, so there is nothing to migrate off of.
 */
export async function parse(code: string, source?: string): Promise<SchemeValue[]> {
  return readerParse(code, source);
}

/**
 * Execute a single pre-parsed expression. COMPLEX tier (two-tier-exec-api §3) — the
 * internal form-at-a-time entry (require, prelude eval); returns one boxed
 * SchemeValue, never unwrapped. Use this when you've already parsed the code.
 */
export async function execExpr(
  expr: SchemeValue,
  {
    env,
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
    skipBootstrapWait,
  }: ExecOptions = {},
): Promise<SchemeValue> {
  const actualEnv = env ?? user_env;
  // Same honest SchemeEnv → Environment narrow as execState's seam above.
  invariant(actualEnv instanceof Environment, "execExpr: glass `env` must be a concrete Environment");

  // See exec(): realm-cached lazy bootstrap, awaited once.
  if (!skipBootstrapWait) await ensureBaseAssembled();

  // THE EXEC SEAM (see exec): an explicit `resolver` (the module-eval passthrough —
  // ExecOptions.resolver) is reused verbatim, so a `(require …)`d module's forms keep
  // the requiring run's scope+capability composition; else glass for custom env, the
  // cut for default (fresh null-rooted lexicalRoot + assembled base).
  const runResolver =
    resolver ??
    (env !== undefined
      ? new Resolver(actualEnv)
      : new Resolver(defaultLexicalRoot(), Capabilities.assembled(actualEnv)));

  // Mint per-run handle here too (mirrors exec()) — closes two gaps: a
  // required-module impl reading `this.runCtx.signal` (CallCtx) now sees the SAME
  // abort signal `ctx.signal` already carries, and the handler-stack WeakMap
  // (exceptions.ts) stops falling back to the shared CONSTANT_CTX bucket for
  // every require'd module. `heapBudget` bounds THIS expression's allocations
  // (a per-form meter; a cumulative multi-form bound needs a shared RunContext,
  // which no caller can inject yet — the ledgered runProgram gap).
  // `reads` rides the handle for consistency with `cache`/`effects` (a required module's
  // rosetta penetrations still stamp `enqueuedAtReadClock` through the SAME chokepoint —
  // see run-cache.ts), but this single-form entry does not itself wrap a region or run
  // the guard check: it has no per-form LOOP to hang either on (unlike execState's), and
  // its callers (require, prelude eval) are sub-program plumbing, not the top-level prime
  // run the guard targets. A caller wiring a real burst run through execState gets both.
  const runCtx = makeRunContext({ signal, heapBudget, cache, effects, reads });

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

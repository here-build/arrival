/**
 * THE HERMETIC ASSEMBLER RECIPE: replay = γ = `apply` of the wire lambda to recorded
 * ingress in a hermetic env, executed under region discipline. STAGE C CUT 3 — rebuilt
 * over the SELF-HOSTED VOCABULARY path (`env/vocabulary.ts`/`env/assemble-run.ts`) instead
 * of the retired `lower()`/`assembleEnv`/`schemePacks` capability-lowering trio. A NAMED
 * COMPOSITION of primitives already at HEAD — `assembleRun`/`execState`/`LexicalScope` —
 * not new assembly machinery.
 *
 * SHAPE:
 *
 *   1. `assembleRun` mints the run's `RunContext` over `basePacks`' OWN vocabulary tuple
 *      — `basePacks` are the FUNCTION ARGUMENT (the tape decides the roster): this
 *      module never folds `BASE_ROSTER` itself. A caller wanting the standard base
 *      available (every production caller today — `gamma.ts`/`replay.ts`/
 *      `replay-walk.ts`) folds it into `basePacks` at ITS OWN call site before reaching
 *      here (env/base-roster.ts's own doc: the self-hosting fold is the ENTRY POINT's
 *      responsibility, never baked into `assembleRun`/`buildVocabulary` — this module is
 *      just another such entry point, not a third place that fold lives);
 *   2. a FRESH `LexicalScope.fresh()` root — isolation (no cross-replay bleed), the
 *      top-level LEXICAL scope species (THE CORNERSTONE) a replayed program's own
 *      defines land in, never the ambient/vocabulary map itself;
 *   3. the PRELUDE — `prelude.ts`'s `buildPreludeSource`, the joined SOURCE of the
 *      program's PURE top-level defines — evaluated as ORDINARY top-level code via
 *      `execState(prelude, { capabilities: basePacks, config, scope, runCtx })`, landing
 *      every pure define as a REAL binding directly in the root scope (never a
 *      discarded per-run overlay, unlike `assembleRun`'s OWN capability-prelude pass):
 *      on the legacy path the prelude pack's bootstrap ran via `assembleEnv` straight
 *      into the shared `base` frame every wire application resolved through, so a wire
 *      body referencing a prelude-defined name resolved it as an ordinary binding — the
 *      replayed program's own code (and every wire γ'd against this scope) must keep
 *      seeing exactly that, so the discard `assembleRun`'s per-run prelude pass performs
 *      for CAPABILITY preludes would be the WRONG discipline here; binding into the
 *      persistent root scope is the one that preserves it;
 *   4. ingress bindings (the recorded port/slot payloads a wire's parameters resolve
 *      to) land directly in the SAME root scope, AFTER the prelude runs — the
 *      un-baked, per-call data `hermeticApply`'s single-shot application needs visible
 *      to it; a caller `γ`-ing MANY wires against ONE shared base (`gamma.ts`'s
 *      `applyWireInEnv`, replay.ts's per-node walk) instead mints a FRESH CHILD scope
 *      per wire and binds THAT wire's ingress there, so wires never see each other's
 *      bindings — this module's own `ingress` parameter is for the single-shot case
 *      only (`hermeticApply`); the shared-base callers pass `{}` here and do their own
 *      per-wire child-scope binding.
 *
 * Callers MUST partition with `prelude.ts`'s `classifyProgramPrelude` /
 * `assertPreludeEligible` first — a port-reaching define must never reach `prelude`
 * here: name indirection would smuggle sources into "pure" wire bodies.
 */
import invariant from "tiny-invariant";

import { bindValue, isAmbientRuntime, type AmbientValue } from "../env/AmbientRuntime.js";
import { LexicalScope, type SessionScope } from "../eval/LexicalScope.js";
import type { EnvCapability } from "../common/capability.js";
import type { EvalPreludeInto, EvalSchemeInto } from "../common/scheme-env.js";
import { assembleRun } from "../env/assemble-run.js";
import { execState, execInFrame } from "../eval/generator-exec.js";
import type { RunContext } from "../run/RunContext.js";

/** The evalScheme every basePack's OWN `symbol.define`/`defineSyntax` bake shares —
 *  mirrors `generator-exec.ts`'s own private `capabilityEvalScheme`: both route through the
 *  SAME internal bake seam (`execInFrame`), never the public exec surface — a replay's
 *  basePacks tuple is its OWN self-hosted vocabulary, so this bake needs no bootstrap gate at
 *  all (there is no realm bootstrap left to await). */
const replayEvalScheme: EvalSchemeInto = (env, source) => {
  invariant(isAmbientRuntime(env), "hermeticEnv: expected a concrete AmbientRuntime");
  return execInFrame(source, env);
};

/** The evalPrelude every basePack's OWN `.spec.prelude` runs through (`assembleRun`'s
 *  per-run pass) — the SAME bake seam, plus this run's own `runCtx` threaded through (mirrors
 *  `generator-exec.ts`'s own private `preludeEvalScheme`). In practice `BASE_ROSTER` declares
 *  no prelude today (env/base-roster.ts's own doc), so this fires only for a caller-supplied
 *  basePack that declares one. */
const replayEvalPrelude: EvalPreludeInto = (env, source, runCtx) => {
  invariant(isAmbientRuntime(env), "hermeticEnv: expected a concrete AmbientRuntime");
  return execInFrame(source, env, runCtx);
};

/** Ingress bindings a replay supplies to the hermetic env — the recorded port payloads
 *  a wire's parameters resolve to (a wire is a closed arrival lambda whose parameters
 *  ARE its ingress). Values are real `AmbientValue`s (already boxed scheme values) —
 *  the storage membrane's own honest face (`bindValue`'s value type), not a raw-JS convenience. */
export type IngressBindings = Readonly<Record<string, AmbientValue>>;

/**
 * The hermetic replay handle: the run's `RunContext` (reused verbatim across every
 * γ application a caller performs against this base — `assembleRun`'s tuple-identity
 * invariant is what makes that reuse sound) plus the root `LexicalScope` a replayed
 * program's / wire's own defines land in. `capabilities`/`config` are threaded back so a
 * caller driving MULTIPLE subsequent `execState`/`exec` calls against this SAME base
 * (`gamma.ts`'s `applyWireInEnv`, replay.ts's per-node walk) can repeat the IDENTICAL
 * tuple — required for `assembleRun`'s reuse check to keep matching (see that module's
 * own header on the tuple-identity invariant).
 */
export interface HermeticEnv {
  readonly runCtx: RunContext;
  readonly scope: SessionScope;
  readonly capabilities: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Build the hermetic replay env: `basePacks`' own vocabulary + program prelude +
 * ingress bindings, over a fresh session `RunContext`/`LexicalScope` pair. `basePacks`
 * are the program's own capabilities (mcp/infer/…) — see this module's own header for
 * why `BASE_ROSTER` is never folded in here; `prelude` is the joined SOURCE of the
 * program's PURE top-level defines (`prelude.ts`'s `buildPreludeSource` — never a
 * port-reaching define, per that module's partition); `ingress` are the recorded
 * payloads a replayed wire's parameters bind to, landing in the SAME root scope,
 * AFTER the prelude runs (so an ingress name wins over a same-named prelude define,
 * mirroring the legacy "ingress frame ABOVE the sealed base" precedence).
 */
export async function hermeticEnv(
  basePacks: readonly EnvCapability[],
  prelude: string,
  ingress: IngressBindings = {},
  config?: object,
): Promise<HermeticEnv> {
  // Mint the run's OWN RunContext directly (never through `execState`, which would own
  // — and dispose — a self-minted RunContext at ITS call's end): this handle must
  // outlive the prelude eval below and every later γ application a caller performs
  // against it.
  const runCtx = await assembleRun({
    capabilities: basePacks,
    config,
    evalScheme: replayEvalScheme,
    evalPrelude: replayEvalPrelude,
  });
  const scope = LexicalScope.fresh("provenance-hermetic-replay");
  // THE PRELUDE, as ORDINARY top-level code — see this module's own header for why a
  // real (non-discarded) binding into `scope` is the discipline this replays: reusing
  // `runCtx` here (never a self-minted one) means this call never disposes it.
  if (prelude.length > 0) {
    await execState(prelude, { capabilities: basePacks, config, scope, runCtx });
  }
  // THE INGRESS — bound directly into the same root scope, AFTER the prelude, so an
  // ingress name takes precedence on a collision (see this module's own header).
  for (const [name, value] of Object.entries(ingress)) bindValue(scope.env, name, value);
  return { runCtx, scope, capabilities: basePacks, config };
}

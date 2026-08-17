/**
 * registry/greenfield-session — assemble the greenfield interpreter session and
 * harvest its emit registry. The tsx-free half of what used to live in
 * `oracle/harness.ts`, lifted here so the compiler path (`product/compile-source`,
 * `build/project`) can build the registry it needs WITHOUT importing the harness
 * (which loads `tsx/esm/api` at module eval — browser/edge poison).
 *
 * Transitively node-free: `openSession` (this package's own session mint over
 * the runner plane) and the registry / rules harvest are all browser-safe. The
 * differential oracle (`arrival-mercury-oracle`) imports these back DOWN from here.
 */
import { openSession, type MercurySession } from "../session.js";

import { phase1Rules, withRules, type OverlayEmitRegistry } from "../rules/index.js";

import { emitRegistryOf } from "./index.js";

/** The expensive, reusable half of a differential run — one capability-DAG
 *  assembly, held across many corpus/fuzz iterations (spec §4.1). Literally a
 *  {@link MercurySession} — the `(runCtx, scope, capabilities, config)` tuple
 *  `execState` itself mints and reuses; no separate wrapping shape needed. */
export type OracleSession = MercurySession;

/**
 * Build the one shared interpreter session. No `loader` is passed — every
 * corpus/fuzz program is a self-contained snippet, so `(require …)` stays an
 * unbound symbol by capability withholding. The retired `arrival/infer` capability
 * (and its required `InferFn` stub) is gone — the LLM/MCP layer's `chat/completion`
 * is what's bound now, and an unarmed `providers` bag makes any real dispatch throw
 * the layer's own teaching door the moment a program actually calls one (the same
 * "fails loudly, never an unbound-variable red herring" posture the retired stub
 * existed to give `(infer …)`), so no host-side stub is needed here at all.
 */
export async function openOracleSession(): Promise<OracleSession> {
  return openSession({ name: "arrival-mercury-oracle", params: {} });
}

/** One `withRules(harvest, phase1Rules)` registry per session's `RunContext` — the
 *  Law-N witness sweep, once per run (§4.1's reuse contract applied to the compiler
 *  side). Keyed by `session.runCtx` (stable for the session's whole life), so two
 *  `OracleSession` handles over one assembly share the work. */
const registryCache = new WeakMap<object, OverlayEmitRegistry>();

/**
 * Exported so tests can probe the REAL compiled-side registry directly instead of
 * re-deriving it inline — a prior inline re-derivation (cross-pass-fixtures.test.ts)
 * silently fell out of step the moment this function's own merge changed; see that
 * test's own note. Current external callers: rule-lint.test.ts's EmitCtx-surface
 * sweep over the fully-relocated Contract rules and cross-pass-fixtures.test.ts's
 * per-row compile. `compileGreenfield` is the internal (oracle) caller — same
 * registry, same cache, no divergence possible between what a test inspects and
 * what the pipeline actually compiles against.
 *
 * RETIRED: this used to also merge in `scheme/srfi-1`'s STATIC harvest underneath
 * the session's own (the "ambient-gap fix" — `arrival/schema` and `srfi1` disagreed
 * on `deps` order, so both couldn't assemble live in one session; srfi-1's names
 * were harvested off the bare capability instead and merged in as a fallback). The
 * run-reader door (`symbolsOwnedBy`/the vocabulary-harvest discipline this file's
 * `emitRegistryOf` now exclusively walks) reads a session's OWN `capabilities`
 * roster directly, and that roster is `arrivalPlaneCapability`'s dep closure —
 * which folds `scheme/srfi-1` in already, via `env/base-roster.ts`'s `BASE_ROSTER`
 * self-hosting (the vocabulary a session assembles against was never missing
 * srfi-1 to begin with; the gap this workaround closed was a harvest-input
 * artifact of the retired `AssembledAmbient` shape, not a real vocabulary hole).
 * No merge, no separate static harvest, no ordering conflict to route around. The
 * harvest now walks `session.runCtx` directly (`emitRegistryOf`'s `RunContext` mode,
 * registry/harvest.ts) rather than the session's bare `capabilities` list — BASE_ROSTER
 * (srfi-1 included) is folded into a run's `vocabulary` at build time, never present in
 * `capabilities` itself, so a capabilities-only walk would still miss it; the run's own
 * resolved vocabulary is the one view that already has everything, correctly linearized.
 */
export function greenfieldRegistryFor(session: OracleSession): OverlayEmitRegistry {
  let hit = registryCache.get(session.runCtx);
  if (hit === undefined) {
    hit = withRules(emitRegistryOf(session.runCtx), phase1Rules);
    registryCache.set(session.runCtx, hit);
  }
  return hit;
}

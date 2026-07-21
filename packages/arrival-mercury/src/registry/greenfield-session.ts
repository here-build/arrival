/**
 * registry/greenfield-session — assemble the greenfield interpreter session and
 * harvest its emit registry. The tsx-free half of what used to live in
 * `oracle/harness.ts`, lifted here so the compiler path (`product/compile-source`,
 * `build/project`) can build the registry it needs WITHOUT importing the harness
 * (which loads `tsx/esm/api` at module eval — browser/edge poison).
 *
 * Transitively node-free: `buildArrivalSession` (arrival-run) and the registry /
 * rules harvest are all browser-safe. The differential oracle
 * (`arrival-mercury-oracle`) imports these back DOWN from here.
 */
import type { AssembledAmbient } from "@inhuman.tools/arrival/env";
import { srfi1 } from "@inhuman.tools/arrival/srfi";
import { buildArrivalSession, type InferFn } from "@inhuman.tools/arrival-run";

import { phase1Rules, withRules, type OverlayEmitRegistry } from "../rules/index.js";

import { emitRegistryOf, type EmitRegistry } from "./index.js";

/** The expensive, reusable half of a differential run — one capability-DAG
 *  assembly, held across many corpus/fuzz iterations (spec §4.1). */
export interface OracleSession extends AsyncDisposable {
  readonly ambient: AssembledAmbient;
  dispose(): Promise<void>;
}

/**
 * Build the one shared interpreter session. No `loader` is passed — every
 * corpus/fuzz program is a self-contained snippet, so `(require …)` stays an
 * unbound symbol by capability withholding. `infer` is the required non-thunk
 * `InferFn` callback (`BuildArrivalEnvOpts.infer`); the stub keeps `(infer …)`
 * a BOUND symbol that fails loudly, never an "unbound variable" red herring.
 *
 * srfi-1 is deliberately NOT added to `capabilities` here — see
 * `greenfieldRegistryFor`'s own note for the ambient-gap fix and why it lives at the
 * HARVEST layer instead of here (a real `AssembleLinearizationError`, not just a style
 * choice).
 */
/** The required non-thunk `InferFn` (`BuildArrivalEnvOpts.infer`): a loud stub so
 *  `(infer …)` is a BOUND symbol that fails clearly, never an "unbound variable". */
const inferStub: InferFn = () => {
  throw new Error("oracle: (infer …) not supported outside the async-family cell");
};

export async function openOracleSession(): Promise<OracleSession> {
  const session = await buildArrivalSession({ name: "arrival-mercury-oracle", infer: inferStub, params: {} });
  const dispose = (): Promise<void> => session.dispose();
  return { ambient: session.ambient, dispose, [Symbol.asyncDispose]: dispose };
}

/** One `withRules(merged, phase1Rules)` registry per ambient — the Law-N
 *  witness sweep, once per ambient (§4.1's reuse contract applied to the compiler
 *  side). Keyed by the AMBIENT (not the session wrapper) so two OracleSession
 *  handles over one assembly share the work. */
const registryCache = new WeakMap<AssembledAmbient, OverlayEmitRegistry>();

/**
 * THE AMBIENT-GAP FIX (rules/phase1.ts's own relocation note; R1's flagged
 * follow-up): `scheme/srfi-1` cannot simply be ADDED to `openOracleSession`'s live
 * `capabilities` — verified directly, not assumed. `srfi1`'s own `deps`
 * (foundations/arrival/arrival/src/env/srfi/srfi-1.ts: `[equality, numeric,
 * exceptions, vectors, lists]`, `lists` LAST) and `arrival/schema`'s own `deps`
 * (.../env/schema.ts: `[lists, equality, strings, numeric, exceptions]`, `lists`
 * FIRST) disagree about the relative order of `lists` vs `equality` — and
 * `arrival/schema` is unconditionally rooted in `arrivalCapabilities()`, hence always
 * present in `session.ambient.capabilities`. Assembling both roots in one
 * `assembleEnv` call throws `AssembleLinearizationError` (confirmed empirically:
 * `openOracleSession` with `capabilities: [srfi1]` fails at session build, every
 * time). Reordering srfi-1.ts's `deps` to match schema.ts's would only trade one
 * conflict for another — its own comment documents `vectors` must precede `lists`
 * to satisfy `polyglot-clojure.ts`'s independent precedence, a constraint that's
 * ACTUALLY exercised (BASE_PACKS assembles both today).
 *
 * So srfi-1 is harvested STATICALLY instead — off the bare `EnvCapability`, never
 * assembled live — via `emitRegistryOf`'s OTHER documented input mode (harvest.ts:
 * "or from a bare capability tree"), which walks the capability/deps GRAPH directly
 * (a plain deps-first DFS, harvest.ts's own `visit`) with no C3 linearization and
 * therefore no ordering conflict to trip over. Every capability in srfi-1's own dep
 * closure (equality/numeric/exceptions/vectors/lists) declares its `symbols` as a
 * plain object, never a builder function, so the phantom/dry activation this
 * bare-list path falls back to is BYTE-IDENTICAL to any "real" assembled
 * activation's answer for all of them. Computed once, module scope: `emitRegistryOf`
 * takes no session/ambient input here, so there is nothing to key a per-session
 * cache on.
 *
 * Behaviorally inert for everything this package already relied on: `scheme/lists`
 * &c. still resolve through the REAL ambient (below, ambient-first precedence), byte
 * -identical to before. This purely ADDS the names the ambient gap left dark —
 * filter/take/drop/iota/zip/every/any/… — which is exactly (and only) what closes
 * filter's ambient gap (rules/phase1.ts's now-deleted table row).
 */
const srfi1Registry = emitRegistryOf([srfi1]);

/** Exported so tests can probe the REAL compiled-side registry directly instead of
 *  re-deriving the ambient+srfi-1 merge inline — a prior inline re-derivation
 *  (cross-pass-fixtures.test.ts) silently fell out of step the moment this function
 *  grew the srfi-1 merge below; see that test's own note. Current external callers:
 *  rule-lint.test.ts's EmitCtx-surface sweep over the fully-relocated Contract rules
 *  (filter included, now that its ambient gap is closed) and
 *  cross-pass-fixtures.test.ts's per-row compile. `compileGreenfield` is the
 *  internal (oracle) caller — same registry, same cache, no divergence possible
 *  between what a test inspects and what the pipeline actually compiles against. */
export function greenfieldRegistryFor(session: OracleSession): OverlayEmitRegistry {
  let hit = registryCache.get(session.ambient);
  if (hit === undefined) {
    const ambientRegistry = emitRegistryOf(session.ambient);
    // Ambient rows win on any name they carry (the real, C3-consistent assembly);
    // srfi-1's static harvest only fills in names the ambient never reaches. In
    // practice these sets are disjoint on everything but srfi-1's OWN deps
    // (lists/equality/numeric/exceptions/vectors), which the ambient already
    // resolves via arrival/schema — so this fallback fires only for genuinely
    // srfi-1-only symbols.
    const withSrfi1: EmitRegistry = {
      lookup: (name) => ambientRegistry.lookup(name) ?? srfi1Registry.lookup(name),
      names: new Set([...ambientRegistry.names, ...srfi1Registry.names]),
    };
    hit = withRules(withSrfi1, phase1Rules);
    registryCache.set(session.ambient, hit);
  }
  return hit;
}

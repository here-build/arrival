/**
 * THE HERMETIC ASSEMBLER RECIPE: replay = γ = `apply` of the wire lambda to recorded
 * ingress in a hermetic env (base packs + program prelude + ingress bindings via the
 * env-capability assembler). A NAMED COMPOSITION of primitives already at HEAD —
 * `assembleEnv`/`EnvCapability`/`schemePacks` — not new assembly machinery.
 *
 * SHAPE, mirroring `eval/generator-exec.ts`'s private `assembleCapabilityBase` (the
 * exact pattern `exec({ capabilities })` already builds for a per-call capability-
 * augmented base — hermetic replay envs likewise assemble fresh and never touch that
 * shared frame):
 *
 *   1. a FRESH `user_env.inherit()` child — isolation (no cross-replay bleed), while
 *      still inheriting the standard assembled base (`user_env → global_env`) for free;
 *   2. `basePacks` (the program's OWN capabilities — mcp/infer/…, if the original run
 *      used any) lowered and set as the prelude pack's `deps` — `common/scheme-env.ts`'s
 *      own documented idiom: "Because the kernel applies packs in C3 (dependency)
 *      order, a dependency's macros/defs are present before a dependent's bootstrap
 *      runs — the bootstrap sequence falls out of the DAG, not a hand-maintained
 *      order." This is exactly why the prelude pack declares them as deps rather than
 *      relying on array-order incidence;
 *   3. the PRELUDE pack: `schemePacks`' `bootstrap` field evaluates the joined
 *      pure-define source (`prelude.ts`'s `buildPreludeSource`) — landing every pure
 *      define as an ORDINARY BINDING on the same `base` env every pack applies onto
 *      (never the assembly-time-only `preludeOnly` overlay: a wire replayed later must
 *      resolve these names at ordinary lookup time, not just during the bake);
 *   4. SEALED (`sealResolutionChain`) — T2's content-address hook needs no separate
 *      wiring: the prelude's define names already merged into `base.__env__` by step 3,
 *      so they are already part of whatever `compileResolutionChain` walks and hashes
 *      (`CompiledResolutionChain.hash`, FNV-1a over the merged vocabulary's sorted
 *      names) — exactly like any base capability's own symbols;
 *   5. ingress bindings land as a FRAME ABOVE the sealed base (mirrors `env-roots.ts`'s
 *      "session frame above the chain" for top-level user defines) — the sealed
 *      artifact has no write surface, and per-replay ingress values are exactly the
 *      un-baked, per-call data that frame is for; they are never folded into the baked
 *      chain itself.
 *
 * Callers MUST partition with `prelude.ts`'s `classifyProgramPrelude` /
 * `assertPreludeEligible` first — a port-reaching define must never reach `prelude`
 * here: name indirection would smuggle sources into "pure" wire bodies.
 */
import invariant from "tiny-invariant";

import { bindValue, Environment, type EnvironmentValue, type ResolvingEnvironment } from "../Environment.js";
import { user_env } from "../env-roots.js";
import { assembleEnv, type EnvPack } from "../common/kernel.js";
import { schemePacks, type EvalSchemeInto, type SchemeEnv } from "../common/scheme-env.js";
import type { EnvCapability } from "../common/capability.js";
import { sealResolutionChain } from "../eval/CompiledResolutionChain.js";
import { ensureBaseAssembled, exec } from "../eval/generator-exec.js";

/** The ONE evalScheme every pack in this assembly shares — mirrors
 *  `generator-exec.ts`'s private `capabilityEvalScheme` (re-derived from the public
 *  `exec`, rather than reaching around that module's own encapsulation).
 *  `skipBootstrapWait`: `hermeticEnv` already awaits `ensureBaseAssembled` itself
 *  before this ever runs — a nested prelude eval must not re-await the (already
 *  settled) realm bootstrap promise. */
const replayEvalScheme: EvalSchemeInto = (env, source) => {
  invariant(env instanceof Environment, "hermeticEnv: expected a concrete Environment");
  return exec(source, { env, skipBootstrapWait: true });
};

/** Ingress bindings a replay supplies to the hermetic env — the recorded port payloads
 *  a wire's parameters resolve to (a wire is a closed arrival lambda whose parameters
 *  ARE its ingress). Values are real `EnvironmentValue`s (already boxed scheme values) —
 *  `Environment.set`'s own honest signature, not a raw-JS convenience. */
export type IngressBindings = Readonly<Record<string, EnvironmentValue>>;

/**
 * Build the hermetic replay env: base packs + program prelude + ingress bindings.
 * `basePacks` are the program's own capabilities (mcp/infer/…), assembled
 * atop the standard base; `prelude` is the joined SOURCE of the program's PURE
 * top-level defines (`prelude.ts`'s `buildPreludeSource` — never a port-reaching
 * define, per that module's partition); `ingress` are the recorded payloads a
 * replayed wire's parameters bind to, landing in a frame ABOVE the sealed base.
 */
export async function hermeticEnv(
  basePacks: readonly EnvCapability[],
  prelude: string,
  ingress: IngressBindings = {},
  config?: object,
): Promise<ResolvingEnvironment> {
  await ensureBaseAssembled(); // the standard base (`user_env → global_env`) is live + sealed
  const base = user_env.inherit("provenance-hermetic-replay");
  const loweredBase: EnvPack<SchemeEnv>[] = basePacks.map((c) => c.lower({ evalScheme: replayEvalScheme, config }));
  const preludePack = schemePacks(replayEvalScheme)({
    name: "provenance/hermetic-prelude",
    deps: loweredBase,
    bootstrap: prelude,
  });
  await assembleEnv(base, [preludePack]);
  // THE SEAL: the prelude's defines already landed in `base.__env__` above —
  // sealing here just compiles the now-complete chain; no separate hash hook needed.
  sealResolutionChain(base);
  const frame = base.inherit("provenance-ingress");
  for (const [name, value] of Object.entries(ingress)) bindValue(frame, name, value);
  return frame;
}

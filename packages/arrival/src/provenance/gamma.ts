/**
 * provenance/gamma.ts — γ = `hermeticApply(wire, ingress)`: replay = γ = `apply` of
 * the wire lambda to recorded ingress in a hermetic env, executed under region
 * discipline — γ runs in a SILENT region: doors and discipline fully active, stream
 * emission OFF. A NAMED COMPOSITION, not new machinery:
 *
 *   1. `hermeticEnv` — the self-hosted vocabulary tuple (base packs), program prelude,
 *      and ingress bindings, over a fresh `RunContext`/`LexicalScope` pair;
 *   2. `membrane/region-scope.ts`'s `withSilentRegion` — wrapping the WHOLE
 *      apply for its entire dynamic extent;
 *   3. the SAME textual-application idiom `wireframe-agreement.law.test.ts` already
 *      proved end-to-end (`` `(${w.source} 41)` `` — apply the wire's lambda source to
 *      its params BY NAME), generalized from a literal argument to `wire.params`
 *      itself, since `hermeticEnv`'s `ingress` binding already bound those same names
 *      into the root scope before the application ever runs.
 *
 * Wire-locality (checked AT EMISSION by `unevalWire` — `uneval.ts`) already
 * guarantees `FV(wire body) ⊆ params ∪ prelude-names ∪ hermetic-base-names`. This
 * function relies on that closure, it does not re-verify it: every free reference the
 * applied lambda makes resolves EITHER through the vocabulary+prelude scope (by name,
 * `hermeticEnv` steps 2/3) or through one of `wire.params` (`ingress`, step 4) — nothing
 * else can be free in a wire body, by construction. That is exactly why this module only
 * lands the runner: wire-locality already guarantees the closure.
 */
import invariant from "tiny-invariant";

import { exec, execState } from "../eval/generator-exec.js";
import type { EnvCapability } from "../common/capability.js";
import { bindValue } from "../env/AmbientRuntime.js";
import { BASE_ROSTER } from "../env/base-roster.js";
import type { SchemeValue } from "../values/types.js";
import { withSilentRegion } from "../membrane/region-scope.js";
import { hermeticEnv, type HermeticEnv, type IngressBindings } from "./hermetic-env.js";
import { IngressBindingError } from "../errors.js";
import type { EmittedWire } from "./wireframe/types.js";

/** γ's inputs: the wire to replay, the recorded ingress it closes over (keyed BY NAME,
 *  exactly `wire.params`' own names — never positional; a wire's params ARE the
 *  recorded port/slot names `unevalWire` minted, and a name-keyed bag forecloses the
 *  misuse-by-position class of bug a positional array would invite), and the hermetic
 *  env's own two static-layer inputs. `basePacks`/`prelude` mirror `hermeticEnv`'s own
 *  REQUIRED params, unchanged here, never defaulted: a caller silently forgetting the
 *  program's real prelude would replay against the WRONG static layer, not a safe empty
 *  one — the same "no silent degrade" stance `hermeticEnv`'s own doc takes. */
export interface HermeticApplyOptions {
  readonly wire: EmittedWire;
  readonly ingress: IngressBindings;
  readonly basePacks: readonly EnvCapability[];
  readonly prelude: string;
  readonly config?: object;
}

/**
 * γ = apply(wire, ingress) in the hermetic env, under a SILENT region. Returns the
 * egress — `exec`'s own contract already peels to plain JS (`generator-exec.ts`'s
 * `exec`: `state.values.map((v) => toJS(v))`), so a replayed egress is directly
 * comparable to a recorded `MintRecord`'s payload value (the wire-γ law:
 * `apply(wire, recorded ingress) === recorded egress`), no second peeling step
 * needed here.
 *
 * Every free name the wire body's SOURCE could possibly reference is either a
 * `wire.params` slot (bound here, by name, into `hermeticEnv`'s root scope) or
 * resolves through the vocabulary+prelude scope that same call builds — never
 * anything else, by wire-locality's emission-time guarantee (see this file's header).
 * A caller missing an ingress binding for a declared param is therefore always a
 * CALLER bug (a param `unevalWire` minted that the replay driver forgot to supply),
 * not a representable "replay with a hole" — the invariant below names it at this
 * function's own boundary instead of letting it surface three calls later as an
 * opaque unbound-variable error from deep inside `exec`.
 */
export async function hermeticApply(opts: HermeticApplyOptions): Promise<unknown> {
  const { wire, ingress, basePacks, prelude, config } = opts;
  assertIngressCovers(wire, ingress);
  return withSilentRegion(async () => {
    // THE STANDARD-BASE FOLD (this call site's own responsibility — `hermeticEnv`
    // never hardcodes `BASE_ROSTER`; see that module's own header): the legacy
    // ambient path always inherited the FULL base (`mintFrame(user_env)`)
    // unconditionally, so replay fidelity requires the same here, regardless of
    // what `basePacks` itself carries.
    const base = await hermeticEnv([...basePacks, ...BASE_ROSTER], prelude, ingress, config);
    // Apply the wire's lambda to its OWN params, by name — `ingress` already bound
    // each one in the scope `hermeticEnv` just built, so this is a plain application
    // over already-resolved names: the exact idiom `wireframe-agreement.law.test.ts`
    // proved (`` `(${w.source} 41)` ``), generalized from a hardcoded literal to the
    // wire's own declared param list. `capabilities`/`config` repeat the SAME tuple
    // `hermeticEnv` minted `runCtx` from (its own reuse-identity invariant); `runCtx`
    // reused verbatim, never re-preluded.
    const [egress] = await exec(wireApplication(wire), {
      capabilities: base.capabilities,
      config: base.config,
      scope: base.scope,
      runCtx: base.runCtx,
    });
    return egress;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BOXED γ FACE — the composition seam replay.ts drives.
//
// `hermeticApply` above peels (exec's `toJS` contract) because a wire-γ EGRESS
// compares against a recorded payload VALUE. Some laws additionally need the
// replayed value's PROVENANCE — the stamp set the boxed egress carries — which
// peeling destroys. `applyWireInEnv` is the same application idiom returning the
// boxed `SchemeValue`, factored against a caller-supplied env so a graph replay
// (replay.ts) can assemble ONE hermetic base per graph and γ many wires against
// per-wire ingress frames, instead of re-assembling+re-sealing per wire.
// ─────────────────────────────────────────────────────────────────────────────

/** The teaching door `hermeticApply` exposes, shared with every boxed γ face. */
function assertIngressCovers(wire: EmittedWire, ingress: IngressBindings): void {
  for (const name of wire.params) {
    if (!Object.hasOwn(ingress, name)) throw new IngressBindingError(wire.span, name);
  }
}

/** The textual-application idiom, shared by every γ face. */
function wireApplication(wire: EmittedWire): string {
  return wire.params.length > 0 ? `(${wire.source} ${wire.params.join(" ")})` : `(${wire.source})`;
}

/**
 * γ against a PREBUILT hermetic base, returning the BOXED egress (provenance
 * intact). The caller owns BOTH halves `hermeticApply` bundles:
 *   - the silent region — a graph replay wraps its WHOLE walk in ONE
 *     `withSilentRegion`, not one per wire;
 *   - the base — built once per graph via `hermeticEnv(basePacks, prelude)`
 *     (empty ingress); each call here binds this wire's ingress in a FRESH CHILD
 *     scope of `base.scope`, so wires never see each other's bindings. `runCtx`
 *     is reused verbatim across every call (Stage C Cut 2's tuple-identity
 *     invariant — see `assemble-run.ts`'s own header); `capabilities`/`config`
 *     repeat the SAME tuple `hermeticEnv` minted it from.
 */
export async function applyWireInEnv(
  base: HermeticEnv,
  wire: EmittedWire,
  ingress: IngressBindings,
): Promise<SchemeValue> {
  assertIngressCovers(wire, ingress);
  const wireScope = base.scope.child(`gamma-wire-${wire.span}`);
  for (const [name, value] of Object.entries(ingress)) bindValue(wireScope.env, name, value);
  const state = await execState(wireApplication(wire), {
    capabilities: base.capabilities,
    config: base.config,
    scope: wireScope,
    runCtx: base.runCtx,
  });
  const boxed = state.values.at(-1);
  invariant(boxed !== undefined, "applyWireInEnv: a wire application evaluates exactly one form — exec returned none");
  return boxed;
}


/**
 * provenance/gamma.ts — Q15's SECOND landing: γ = `hermeticApply(wire, ingress)`
 * (docs/PROVENANCE.md §1 CHOSEN: "replay = γ = `apply` of the wire lambda to recorded
 * ingress in a hermetic env… executed under region discipline (§4)"; §4 CHOSEN, round 2
 * A4: "γ runs in a SILENT region: doors and discipline fully active, stream emission
 * OFF"). A NAMED COMPOSITION, not new machinery (PROVENANCE-PLAN.md Q15's own note):
 *
 *   1. Q7's `hermeticEnv` — base packs + program prelude + ingress bindings, sealed;
 *   2. `values/primitives/region-scope.ts`'s `withSilentRegion` — this wave's OTHER
 *      Q15 landing, wrapping the WHOLE apply for its entire dynamic extent;
 *   3. the SAME textual-application idiom `wireframe-agreement.law.test.ts` already
 *      proved end-to-end (`` `(${w.source} 41)` `` — apply the wire's lambda source to
 *      its params BY NAME), generalized from a literal argument to `wire.params`
 *      itself, since `hermeticEnv`'s `ingress` frame already bound those same names
 *      above the sealed base (§4 CHOSEN step 5) before the application ever runs.
 *
 * Wire-locality (§1, checked AT EMISSION by `unevalWire` — `uneval.ts`) already
 * guarantees `FV(wire body) ⊆ params ∪ prelude-names ∪ hermetic-base-names`. This
 * function relies on that closure, it does not re-verify it: every free reference the
 * applied lambda makes resolves EITHER through the sealed prelude/base chain (by name,
 * `hermeticEnv` steps 3/4) or through one of `wire.params` (`ingress`, step 5) — nothing
 * else can be free in a wire body, by construction. That is exactly the "wire-locality
 * already guarantees closure; you land the runner" instruction this node works under.
 *
 * Q16 (replay laws) proves the ADJUNCTION laws (wire-γ, replay-nondeterminism, pure-mux
 * derivation — docs/PROVENANCE.md §7) over this function; this node lands the mechanism
 * plus a smoke row (`src/__tests__/provenance/silent-region.test.ts`), not the law suite.
 */
import invariant from "tiny-invariant";

import { exec } from "../eval/generator-exec.js";
import type { EnvCapability } from "../common/capability.js";
import { withSilentRegion } from "../values/primitives/region-scope.js";
import { hermeticEnv, type IngressBindings } from "./hermetic-env.js";
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
 * γ = apply(wire, ingress) in Q7's hermetic env, under a SILENT region (§4 CHOSEN,
 * round 2 A4). Returns the egress — `exec`'s own contract already peels to plain JS
 * (`generator-exec.ts`'s `exec`: `state.values.map((v) => toJS(v))`), so a replayed
 * egress is directly comparable to a recorded `MintRecord`'s payload value (Q16's
 * wire-γ law: `apply(wire, recorded ingress) === recorded egress`), no second peeling
 * step needed here.
 *
 * Every free name the wire body's SOURCE could possibly reference is either a
 * `wire.params` slot (bound here, by name, into `hermeticEnv`'s ingress frame) or
 * resolves through the sealed base+prelude chain that same call builds — never
 * anything else, by wire-locality's emission-time guarantee (see this file's header).
 * A caller missing an ingress binding for a declared param is therefore always a
 * CALLER bug (a param `unevalWire` minted that the replay driver forgot to supply),
 * not a representable "replay with a hole" — the invariant below names it at this
 * function's own boundary instead of letting it surface three calls later as an
 * opaque unbound-variable error from deep inside `exec`.
 */
export async function hermeticApply(opts: HermeticApplyOptions): Promise<unknown> {
  const { wire, ingress, basePacks, prelude, config } = opts;
  for (const name of wire.params) {
    invariant(
      Object.hasOwn(ingress, name),
      `hermeticApply: wire "${wire.span}" declares param "${name}" but no ingress binding was supplied for ` +
        "it — every name in wire.params must have a matching key in ingress (§4 CHOSEN step 5's frame), or " +
        "the applied lambda hits an unbound variable deep inside exec instead of this door.",
    );
  }
  return withSilentRegion(async () => {
    const env = await hermeticEnv(basePacks, prelude, ingress, config);
    // Apply the wire's lambda to its OWN params, by name — `ingress` already bound
    // each one in the frame `hermeticEnv` just built (step 5), so this is a plain
    // application over already-resolved names: the exact idiom
    // `wireframe-agreement.law.test.ts` proved (`` `(${w.source} 41)` ``), generalized
    // from a hardcoded literal to the wire's own declared param list.
    const application = wire.params.length > 0 ? `(${wire.source} ${wire.params.join(" ")})` : `(${wire.source})`;
    const [egress] = await exec(application, { env, skipBootstrapWait: true });
    return egress;
  });
}

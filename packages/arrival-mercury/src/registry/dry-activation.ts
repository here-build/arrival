/**
 * The PHANTOM activation the registry harvest hands a builder-form `symbols`
 * spec (registry-emit.md §"The harvest — dry-harvest over a phantom Activation";
 * constitution §4.5: "Builder-form capabilities need a dry-harvest path; emit
 * rules are static by rule — wanting activation state is a bake-time error").
 *
 * The two halves are deliberately ASYMMETRIC, mirroring their real shapes:
 *
 * - `configuration`'s fields ARE the decoded values (`InferCfg<C>`), so ANY
 *   top-level property get is already a value read → blanket-poisoned. A
 *   well-formed builder destructures `{ configuration }` once (a reference
 *   capture on the activation, which never touches this proxy) and reads
 *   `configuration.x` only inside impl bodies the harvest never calls —
 *   `llm-plane-arrival-env/src/infer.ts` is the ground-truth shape.
 *
 * - `resources` entries are already `Ref<Handle>`s, so a top-level
 *   `resources.foo` access is itself just a reference capture — structurally
 *   identical to the sanctioned `{ configuration }` destructure one level up —
 *   and must NOT throw. Only an actual DEREFERENCE (`.get()` / `.live`)
 *   depends on a spawned resource; those poison.
 *
 * This doubles as the "emit rules must be static" enforcement: a builder whose
 * top-level SHAPE branches on a config value, or that dereferences a resource
 * outside an impl body, throws a teaching error at harvest — errors-as-doors,
 * never a silent miscompile. Known limit (Law-F-safe direction): a builder that
 * conditionally OMITS a symbol key harvests the phantom-config branch; the
 * omitted symbol just falls down the fallback ladder to shim/door.
 */
import type { Activation } from "@inhuman.tools/arrival/capability";
import type { DoorSymbolDef } from "@inhuman.tools/arrival/symbol";

type AnyActivation = Activation<any, any>;
type DegradationInfo = AnyActivation["degradation"];

/** Build the phantom activation for one capability's dry harvest. */
export function dryActivation(capabilityName: string): AnyActivation {
  // configuration: fields ARE the decoded values — any top-level property GET is itself
  // a value read, so blanket-poison every access.
  const poisonConfig = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `emitRegistryOf: capability "${capabilityName}"'s symbols builder read configuration.${String(prop)} ` +
            `outside an impl body — a builder's TOP-LEVEL shape (which keys/rules exist) must not depend ` +
            `on configuration VALUES; close over the reference for use inside impl/call bodies only.`,
        );
      },
    },
  );
  // resources: capturing the Ref itself (property access) is safe and idiomatic; only an
  // actual DEREFERENCE poisons.
  const poisonResourceDeref = (resourceName: string) => ({
    get: () => {
      throw new Error(
        `emitRegistryOf: capability "${capabilityName}"'s symbols builder called ` +
          `resources.${resourceName}.get() outside an impl body — a Ref capture is safe, but ` +
          `dereferencing it depends on a spawned resource; close over the Ref for use inside ` +
          `impl/call bodies only.`,
      );
    },
    get live(): never {
      throw new Error(
        `emitRegistryOf: capability "${capabilityName}"'s symbols builder read ` +
          `resources.${resourceName}.live outside an impl body — same rule as .get() above.`,
      );
    },
  });
  const resourcesProxy = new Proxy({}, { get: (_t, prop) => poisonResourceDeref(String(prop)) });
  // Structurally the REAL `buildDegradationInfo(name)` shape (degradation.ts): the
  // "forbid" vs "doors" mode distinction (and its `missingKeys`/`active` informational
  // fields) is retired from `DegradationInfo` itself (TRAILS CLEANUP Tier 1 — confirmed
  // zero readers anywhere) — the interface is just the `.door(...)` minter now. Hand-
  // rolled here (rather than importing the builder helper) because arrival exposes the
  // TYPE only through `Activation["degradation"]`, not the builder, on its public
  // subpaths.
  const degradation: DegradationInfo = {
    door: (name, needs, reason): DoorSymbolDef => ({
      kind: "door",
      name,
      reason,
      cause: { owner: capabilityName, needs: needs.map((key) => ({ kind: "configuration" as const, key })) },
    }),
  };
  return { configuration: poisonConfig, resources: resourcesProxy, degradation };
}

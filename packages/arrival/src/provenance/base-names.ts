/**
 * The production `isBaseName` for `buildWireframe`: "does this name resolve in the hermetic
 * BASE env?" — wire bodies keep such references BY NAME (the hermetic assembler provides
 * them), everything else free in a wire is program ingress. Mirrors
 * `lineage-classifier-from-env.ts`: read the live env, no name list.
 *
 * Membership = the env's own bindings (natives, macros, base packs — `env.get` walks the
 * parent chain, so inherited packs count) ∪ the Resolver's structural `c[ad]+r` synthesis,
 * which is NOT a binding (resolution misses fall through to it) yet is always callable.
 */
import type { AmbientRuntime } from "../env/AmbientRuntime.js";

// Local copy of eval/Resolver.ts's CXR_RE (not exported there) — same convention as
// static-validation/vocabulary.ts and common/symbols/define-bake.ts. Keep in lock-step.
const CXR_RE = /^c[ad]+r$/;

export function baseNamePredicate(env: AmbientRuntime): (name: string) => boolean {
  return (name) => CXR_RE.test(name) || env.get(name, { throwError: false }) !== undefined;
}

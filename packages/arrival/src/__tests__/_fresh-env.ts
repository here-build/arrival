// Per-test capability-assembled environments.
//
// STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md) retired the realm-singleton
// `global_env`/`user_env` (env-roots.ts) and the ambient bootstrap (`ensureBaseAssembled`/
// `initBridge`) this file used to ride. Two flavors survive, rebuilt over the self-hosted
// vocabulary (env/vocabulary.ts, env/base-roster.ts):
//
//   • `freshEnv()` — a FRESH, ISOLATED env carrying the FULL base surface (`BASE_ROSTER`: every
//     BASE_PACKS `.scm` capability + the two standalone native extras, transitively reaching
//     every native cluster — env/base-roster.ts's own doc). A private child of the shared,
//     lazily-populated `inferenceEnv` root (env/inference-env.ts) — isolation for the test's OWN
//     `(define …)`s / directly-applied test capabilities, same as before this cut.
//   • `nativeOnlyRoot()` — a FRESH env carrying ONLY the native (JS-implemented) clusters —
//     chars/strings/vectors/bytevectors/equality/numeric/error-objects — and NOTHING from
//     BASE_PACKS (`cons`/`list`/`error`/… absent). The pre-cut `global_env` gave tests exactly
//     this distinction (a migration-pin suite proving "standalone `.apply()`, bypassing
//     `assembleEnv`'s C3 dep-walk, leaves BASE_PACKS-only names genuinely unbound" needs a root
//     that has natives but NOT the base stdlib) — reconstructed here directly from the surviving
//     native pack MODULES (the `NATIVE_PACKS` roster array itself died with `global_env`, its
//     only consumer; the member modules are untouched).
import type { AmbientRuntime, ResolvingAmbient } from "../env/AmbientRuntime.js";
import { mintFrame, mintResolvingFrame } from "../env/AmbientRuntime.js";
import { assembleEnv } from "../common/kernel.js";
import { BASE_PACKS } from "../env/base-packs.js";
import { inferenceEnv } from "../env/inference-env.js";
import { ensureInferenceEnvPopulated, execInFrame } from "../eval/generator-exec.js";
import type { SchemeEnv } from "../common/scheme-env.js";
import chars from "../env/r7rs/chars.js";
import strings from "../env/r7rs/strings.js";
import vectors from "../env/r7rs/vectors.js";
import bytevectors from "../env/r7rs/bytevectors.js";
import equality from "../env/r7rs/equality.js";
import numeric from "../env/r7rs/numeric.js";
import errorObjects from "../env/r7rs/error-objects.js";

// The evaluator injected into pack preludes/define-bake in this file — the SAME internal bake
// seam generator-exec.ts's own private `capabilityEvalScheme` uses, reached here because THIS
// file assembles its own scratch envs directly (`assembleEnv`), independent of `execState`'s own
// tuple.
const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as AmbientRuntime);

let counter = 0;

/** A fresh, fully-assembled capability env: a private child of the shared `inferenceEnv` root,
 *  carrying the complete self-hosted `BASE_ROSTER` surface. Await once per test (or per file). */
export async function freshEnv(): Promise<ResolvingAmbient> {
  await ensureInferenceEnvPopulated();
  return mintFrame(inferenceEnv, `test-env-${++counter}`);
}

/** A fresh env carrying ONLY the native clusters — see this file's own header for why a
 *  BASE_PACKS-free root is a genuinely distinct fixture, not an incidental subset. */
export async function nativeOnlyRoot(): Promise<ResolvingAmbient> {
  const base = mintResolvingFrame(`test-native-only-${++counter}`);
  await assembleEnv(
    base as unknown as SchemeEnv,
    [chars, strings, vectors, bytevectors, equality, numeric, errorObjects].map((pack) => pack.lower({ evalScheme })),
  );
  return base;
}

/** A fresh env carrying the base-pack surface WITHOUT the native-only shortcut of `freshEnv`'s
 *  inferenceEnv parenting — a private, from-scratch BASE_PACKS assembly over a `nativeOnlyRoot`,
 *  for a suite that wants its OWN assembly (not a shared-root child) to apply a pack under test
 *  onto directly. Mirrors the pre-cut `freshEnv`'s own construction exactly. */
export async function freshBasePacksEnv(): Promise<ResolvingAmbient> {
  const base = await nativeOnlyRoot();
  await assembleEnv(
    base as unknown as SchemeEnv,
    BASE_PACKS.map((pack) => pack.lower({ evalScheme })),
  );
  return base;
}

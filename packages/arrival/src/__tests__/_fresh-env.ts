// Per-test capability-assembled environment.
//
// `freshEnv()` returns a FRESH env: a private BASE_PACKS scheme layer assembled
// over the (static, shared) global_env native root. Two properties this buys:
//
//   • Isolation — a test's `(define …)` lands on its own layer, never bleeding
//     into a shared singleton or another test.
//   • Migration-robustness (the reason this exists) — the env's surface is the
//     CAPABILITY surface, not "whatever stdlib happens to bind today". A builtin
//     moving stdlib-inline → pack stays in this env (inherited from global_env
//     now; assembled from its own BASE_PACKS layer once migrated) — the test
//     surface never shifts, so capability relocations stop breaking tests.
//
// Decoupled from the dissolving `../stdlib` surface on purpose: it sources
// global_env from the env-roots leaf, BASE_PACKS from base-packs, and the
// assembler from common/kernel — the stable homes that survive stdlib's deletion.
import type { Environment, ResolvingEnvironment } from "../Environment.js";
import { global_env } from "../env-roots.js";
import { assembleEnv } from "../common/kernel.js";
import { BASE_PACKS } from "../env/base-packs.js";
import { initBridge } from "../index.js";
import { exec } from "../eval/generator-exec.js";
import type { SchemeEnv } from "../common/scheme-env.js";

// The evaluator injected into base-pack preludes — mirrors bridge.ts initBridge's
// evalScheme. `skipBootstrapWait`: these execs ARE the assembly of this env, so they
// must not await the (shared, already-settled) bootstrap promise.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as Environment, skipBootstrapWait: true });

let counter = 0;

/** A fresh, fully-assembled capability env: the static native root + a private
 *  BASE_PACKS scheme layer. Await once per test (or per file).
 *
 *  ENV T1: `global_env` is a `ResolvingEnvironment` (the baked-root specialization —
 *  Environment.ts) and `.inherit()` is overridden to preserve that subtype, so `base`
 *  really is one at runtime; the return type says so honestly (callers that `apply()` a
 *  capability directly onto this env, e.g. input-rest-runtime.test.ts, need `registerResolver`
 *  to type-check without a cast). */
export async function freshEnv(): Promise<ResolvingEnvironment> {
  // Ensure the shared native foundation — GLOBAL_NATIVE_PACKS plus the stdlib inline
  // builtins not yet migrated to packs — is live on global_env (idempotent).
  await initBridge();
  const base = global_env.inherit(`test-env-${++counter}`);
  await assembleEnv(
    base as unknown as SchemeEnv,
    BASE_PACKS.map((pack) => pack.lower({ evalScheme })),
  );
  return base;
}

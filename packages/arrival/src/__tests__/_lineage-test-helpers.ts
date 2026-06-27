/**
 * Shared TEST-ONLY helpers for the static-lineage / provenance suites
 * (golden-prov-*, lineage-*, coercion-soundness). These were inlined byte-for-byte
 * across ~8 Wave-R files "so each new file stays collision-free under concurrent
 * authoring; the parent dedupes at integration" — this IS that dedupe.
 *
 * SCOPE BOUNDARY. `provOf` is NOT here — it is exported canonically from the
 * PRODUCTION module `../values/lineage-shadow` (the shadow assert needs it at
 * runtime), so every test imports it from there to keep ONE definition. This file
 * holds only the test-fixture helpers that have no production home: the stamped-
 * value constructors (`sStr`/`sNum`) and the run-a-program-collect-provenance
 * drivers (`runRaw`/`run`). Test-SPECIFIC fixtures (strs/nums/triple/el/…) stay
 * local to their file.
 *
 * `runRaw`/`run` own a single module-level `seq` so every inherited env name is
 * unique across the whole suite (the name is a debug label only — `inherit` does
 * not key behavior on it). An optional `setup` hook runs against the fresh env
 * BEFORE the bindings are set, which is the one degree of freedom golden-prov-infer
 * needs to register its deterministic `defineRosetta` sources.
 */
import { initBridge } from "../bridge.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { exec } from "../eval/generator-exec";
import { inferenceEnv } from "../inference-env.js";
import { AString } from "../values/primitives/AString.js";
import { AValue } from "../values/primitives/AValue.js";
import { fromJs } from "../values/primitives/boxing.js";
import { provOf } from "../values/lineage-shadow.js";
import type { Environment } from "../Environment.js";

/** Stamp a single source-id onto a string input (the per-element id carrier). */
export const sStr = (s: string, p: number): AString => new AString(CONSTANT_CTX, s, new Set([p]));

/** Stamp a single source-id onto a number input (the scalar arithmetic carrier). */
export const sNum = (n: number, p: number): AValue => fromJs(CONSTANT_CTX, n, new Set([p]));

/** A per-env setup applied before the bindings are written (e.g. `defineRosetta`). */
export type EnvSetup = (env: Environment) => void;

let seq = 0;

/**
 * Run `src` in a fresh inherited sandbox env and return the RAW result value. Each
 * call gets a uniquely-named child env; `binds` are written with `env.set`. `setup`
 * (if given) runs against the env first — used to register `defineRosetta` sources.
 */
export async function runRaw(
  src: string,
  binds: Record<string, unknown> = {},
  setup?: EnvSetup,
): Promise<unknown> {
  await initBridge();
  const env = inferenceEnv.inherit(`lin-test-${seq++}`);
  setup?.(env);
  for (const [k, v] of Object.entries(binds)) env.set(k, v as AValue);
  const [r] = await exec(src, { env });
  return r;
}

/** Run a program and return the sorted provenance of its result (`provOf ∘ runRaw`).
 *  `provOf` is the canonical one from the production shadow module — ONE definition. */
export const run = async (
  src: string,
  binds: Record<string, unknown> = {},
  setup?: EnvSetup,
): Promise<number[]> => provOf(await runRaw(src, binds, setup));

/**
 * Shared TEST-ONLY helpers for the static-lineage / provenance suites
 * (golden-prov-*, lineage-*, coercion-soundness). These were inlined byte-for-byte
 * across ~8 Wave-R files "so each new file stays collision-free under concurrent
 * authoring; the parent dedupes at integration" — this IS that dedupe.
 *
 * SCOPE BOUNDARY. `provOf` is NOT here — it is exported canonically from the
 * PRODUCTION module `../provenance/lineage-shadow` (the shadow assert needs it at
 * runtime), so every test imports it from there to keep ONE definition. This file
 * holds only the test-fixture helpers that have no production home: the stamped-
 * value constructors (`sStr`/`sNum`) and the run-a-program-collect-provenance
 * drivers (`runRaw`/`run`). Test-SPECIFIC fixtures (strs/nums/triple/el/…) stay
 * local to their file.
 *
 * `runRaw`/`run` own a single module-level `seq` so every inherited env name is
 * unique across the whole suite (the name is a debug label only — `inherit` does
 * not key behavior on it). An optional `setup` hook runs against the fresh env
 * BEFORE the bindings are set, which is the one degree of freedom golden-prov-infer /
 * lineage-grounding need to wire their deterministic fake-source `EnvCapability`
 * (`symbol.rosetta` verbs — the `env.defineRosetta` migration target, 2026-07-11).
 * `EnvSetup` is `void | Promise<void>` for exactly this: a capability's `.lower({})
 * .apply(env, …)` is async, unlike the legacy `defineRosetta` call it replaced.
 */
import * as z from "../common/scheme-zod.js";
import { initBridge } from "../index.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import type { AString } from "../values/primitives/AString.js";
import type { AValue } from "../values/primitives/AValue.js";
import { jsToScheme } from "../membrane/rosetta.js";
import { provOf } from "../provenance/lineage-shadow.js";
import type { AmbientRuntime } from "../AmbientRuntime.js";
import { isEagerProvenanceOracleEnabled, setEagerProvenanceOracleEnabled } from "../values/op-helpers.js";
import type { SchemeValue } from "../values/types.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue, mintFrame } from "../AmbientRuntime.js";

/** Stamp a single source-id onto a string input (the per-element id carrier). Codec
 *  encode + withProvenance, not a direct AString construction. */
export const sStr = (s: string, p: number): AString => z.string.encode(s).withProvenance(new Set([p]));

/** Stamp a single source-id onto a number input (the scalar arithmetic carrier). Codec
 *  encode canonicalizes to AInexact — matches fromJs's old default for a bare JS number. */
export const sNum = (n: number, p: number): AValue => z.number.encode(n).withProvenance(new Set([p]));

/** A per-env setup applied before the bindings are written — e.g. wiring a test-local
 *  `EnvCapability` (`symbol.rosetta` verbs) via `cap.lower({}).apply(env, undefined as
 *  never)`, which is async, hence the `Promise<void>` arm (widened from the legacy
 *  `defineRosetta`-only, synchronous-only shape). */
export type EnvSetup = (env: AmbientRuntime) => void | Promise<void>;

let seq = 0;

/**
 * Run `src` in a fresh inherited sandbox env and return the RAW (still-boxed) result
 * value. Each call gets a uniquely-named child env; `binds` are boxed through
 * `jsToScheme` (the same membrane `env.set` applies internally; already-boxed AValue
 * inputs short-circuit to identity) and written with `env.set`. `setup` (if given) runs
 * against the env first — used to register `defineRosetta` sources.
 *
 * COMPLEX tier (`execState`, not `exec`) — this whole file exists to read
 * provenance/box discipline off the result (`provOf`, `deepIds`, `collapseProvenance`),
 * a boxed-state concern (RULINGS.md R1), not the SIMPLE tier's plain-JS exit.
 *
 * Q20b: production default is OFF; every caller of this helper is an eager-oracle
 * GOLDEN (golden-prov-*, lineage-*, conservation.law.test.ts) that needs REAL
 * accumulation to freeze anything meaningful. Forces the oracle ON for exactly this
 * run's extent, save/restoring the ambient value (not a hardcoded default) so nested
 * or interleaved use is safe.
 */
export async function runRaw(
  src: string,
  binds: Record<string, unknown> = {},
  setup?: EnvSetup,
): Promise<SchemeValue | undefined> {
  await initBridge();
  const env = mintFrame(inferenceEnv, `lin-test-${seq++}`);
  await setup?.(env);
  for (const [k, v] of Object.entries(binds)) bindValue(env, k, jsToScheme(CONSTANT_CTX, v));
  const savedOracle = isEagerProvenanceOracleEnabled();
  setEagerProvenanceOracleEnabled(true);
  try {
    const [r] = (await execState(src, { env })).values;
    return r;
  } finally {
    setEagerProvenanceOracleEnabled(savedOracle);
  }
}

/** Run a program and return the sorted provenance of its result (`provOf ∘ runRaw`).
 *  `provOf` is the canonical one from the production shadow module — ONE definition. */
export const run = async (
  src: string,
  binds: Record<string, unknown> = {},
  setup?: EnvSetup,
): Promise<number[]> => provOf(await runRaw(src, binds, setup));

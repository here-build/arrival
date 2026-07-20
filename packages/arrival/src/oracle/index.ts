// oracle/index.ts — Track O assembly point (the local module export).
//
// Public face of the constraint-kernel oracle (Track A of sift/docs/CONSTRAINT-KERNEL-SPEC.md;
// its place in the static plane: docs/STATIC-PLANE.md §THE FOUR READERS 4.2).
// Assembles the Layer-S structural reader (scanner.ts) behind the contract interfaces
// (contract.ts). The package-level public export is the deferred `Ocontract`/`A3` node, added
// through src/index.ts's explicit allowlist — this file is the module-local boundary that node
// re-exports; do NOT edit src/index.ts here.
//
// Σ (O2) and T (O3) layers attach to this assembly later; today the scanner degrades them
// gracefully per the contract (validSymbols/expectedType → null, produces → true).

export type {
  CursorPosition,
  EvalResult,
  FormKind,
  OracleEnv,
  OracleScanner,
  OracleSession,
  OracleState,
  TokenClass,
  TypeTag,
} from "./contract.js";

export { scan, structuralScanner, makeSigmaScanner, validNextClasses } from "./scanner.js";
export { computeValidSymbols, scanScope } from "./sigma.js";
export type { OracleEnvΣ, ScopeState } from "./sigma.js";
export { makeOracleEnv, oracleEnvFromBindings, oracleEnvFromAmbient } from "./env.js";

import { structuralScanner, makeSigmaScanner } from "./scanner.js";
import { makeOracleEnv } from "./env.js";
import type { OracleScanner } from "./contract.js";
import type { OracleEnvΣ } from "./sigma.js";
import type { AmbientRuntime } from "../env/AmbientRuntime.js";

/**
 * The assembled oracle. Given an `env` (a live {@link AmbientRuntime} or pre-built {@link OracleEnvΣ})
 * it is Σ-LIVE: `validSymbols()` returns the position-filtered bound set. Given nothing, it's the
 * Layer-S structural scanner — Σ/T degrade to null/true per the contract. T will land behind the
 * same surface as `makeOracle()` with no argument.
 */
export function makeOracle(env?: AmbientRuntime | OracleEnvΣ): OracleScanner {
  if (!env) return structuralScanner;
  const oracleEnv: OracleEnvΣ = isOracleEnv(env) ? env : makeOracleEnv(env);
  return makeSigmaScanner(oracleEnv);
}

/** Discriminate a pre-built {@link OracleEnvΣ} from a raw {@link AmbientRuntime} (which has no
 *  `boundSymbols`/`isCallable` methods). */
function isOracleEnv(env: AmbientRuntime | OracleEnvΣ): env is OracleEnvΣ {
  return typeof (env as OracleEnvΣ).boundSymbols === "function" && typeof (env as OracleEnvΣ).isCallable === "function";
}

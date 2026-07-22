/**
 * The surviving phase PRODUCTS of `exec` as first-class values, post Stage C Cut 3b (the
 * massacre — docs/plans/stage-c-corpse-deletion.md). The ambient-phase products
 * (`AssembledAmbient`/`ExecInstance`/`instantiate`/`assembleAmbient`'s builder) died with the
 * ambient path itself; what's left is the pure, path-agnostic pieces the vocabulary path
 * (generator-exec.ts) still composes:
 *
 *   (1) parse             → {@link ParsedProgram}
 *   (2.5, optional)       → {@link validateAgainstResolution} (pure function over the parsed
 *                           program + a sealed `CompiledResolutionChain`)
 *
 * Export home: the `/env` subpath (src/env/index.ts), NOT the barrel.
 */

import type { CompiledResolutionChain } from "./CompiledResolutionChain.js";
import type { DegradedCapability } from "../common/degradation.js";
import { validateProgram, type Diagnostic } from "../static-validation/validate-program.js";
import { vocabularyFromChain } from "../static-validation/vocabulary.js";
import type { SchemeValue } from "../values/types.js";
import { parse as readerParse } from "../reader/parse.js";
import type { LexicalScope } from "./LexicalScope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — ParsedProgram
// ─────────────────────────────────────────────────────────────────────────────

/** Phase 1 — pure reader output + late-stamped analysis slots. */
export interface ParsedProgram {
  /** Location-bearing top-level forms (APair LOCATION spans survive). */
  readonly forms: readonly SchemeValue[];
  /** The original text, when parsed from a string. */
  readonly source?: string;
  /** Which READER mode produced it — an identity fact of the program, stamped at parse.
   *  (The RUN-time strict mode stays `ExecOptions.strict` → `runCtx` — one option, two
   *  declared landings, no hidden third.) */
  readonly strict: boolean;
  /** Stamped by a validate pass (phase 2.5), not by parse — validation needs the sealed
   *  chain's vocabulary. Optional + append-only: a ParsedProgram is valid without ever
   *  validating. */
  readonly diagnostics?: readonly Diagnostic[];
  /** RESERVED for the provenance track's program-identity work — a declared home so the
   *  field lands in one place when that work arrives. */
  readonly programHash?: string;
}

/** Phase 1, callable: parse `code` into a {@link ParsedProgram}. A pre-parsed
 *  `SchemeValue` wraps as a one-form program (the same acceptance `exec` has always had).
 *  `source` (a filename / module path) stamps every produced location, as with `parse`. */
export async function parseProgram(
  code: string | SchemeValue,
  opts: { strict?: boolean; source?: string } = {},
): Promise<ParsedProgram> {
  const strict = opts.strict ?? false;
  if (typeof code !== "string") return { forms: [code], strict };
  const forms = await readerParse(code, opts.source, strict);
  return { forms, source: code, strict };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.5 — the pure pass over (program, sealed chain)
// ─────────────────────────────────────────────────────────────────────────────

/** Static validation's actual work, over the two things it genuinely needs — a sealed
 *  {@link CompiledResolutionChain} + a degraded list — rather than a full assembled ambient
 *  (retired). `generator-exec.ts`'s `execState` (its `chain` sealed straight from
 *  `Vocabulary.map` via `sealedVocabularyChain`) delegates here. */
export function validateAgainstResolution(
  program: ParsedProgram,
  chain: CompiledResolutionChain,
  degraded: readonly DegradedCapability[],
  scope?: LexicalScope,
): readonly Diagnostic[] {
  const scopeEnv = scope?.env;
  const vocabulary = vocabularyFromChain(chain, {
    scopeNames: scopeEnv?.allBoundNames(),
    scopeLookup: scopeEnv === undefined ? undefined : (name) => scopeEnv.get(name, { throwError: false }),
    degraded,
  });
  return validateProgram(program.forms, vocabulary);
}

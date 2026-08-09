/**
 * Types-only require faces — per-file `export default` modules for the type lens.
 *
 * Product compile (full runtime TS) lives in `build/prompt-module.ts` /
 * `build/hbs-module.ts`: pretreat → `compileScmModule`.
 *
 * Types compile (this file) is the simplified twin: pretreat → `emitTypes` where
 * that yields a usable face, else a typed default-export stub from the pure
 * type synthesizer (`resolvePromptRequireType`). Same CALLABLE RULE / default-
 * export shape as product — not a special import path, just a thinner pipeline.
 */
import { hbsContentsToSchemeSource } from "@inhuman.tools/arrival-env-capability-handlebars";
import { resolvePromptRequireType } from "@inhuman.tools/llm-plane-arrival-env";

import { emitTypes, type EmitTypesOptions } from "./emit.js";

const HBS_HOST = new Set(["template/handlebars", "cons"]);

/** Data face (json/yaml/…): typed default export from the registry type string. */
export function emitDataRequireFace(reqType: string): string {
  return `const __default = null as any as ${reqType};\nexport default __default;\n`;
}

/**
 * Typed stub default export. Used for `.prompt` (full pretreat→emitTypes still
 * mangles bare-symbol `(lambda args …)` to a zero-arg arrow) and as fallback.
 */
export function emitTypedRequireFace(reqType: string): string {
  return `const __default: ${reqType} = null as any as ${reqType};\nexport default __default;\n`;
}

/**
 * `.hbs` types face: pretreat (`hbsContentsToSchemeSource`) then `emitTypes`,
 * re-export as default — same pretreat as product `compileHbsFile`, no scm-module.
 */
export function emitHbsRequireFace(content: string, opts?: EmitTypesOptions): string {
  const scheme = hbsContentsToSchemeSource(content);
  const hostMembers = new Set([...(opts?.hostMembers ?? []), ...HBS_HOST]);
  const { ts } = emitTypes(`(define __default ${scheme})`, { ...opts, hostMembers });
  return ts.replace(/\n?export \{\};\n?$/, "\nexport default __default;\n");
}

/**
 * `.prompt` types face: pure type synthesizer → typed default export.
 * Product uses pretreat→compileScmModule; types stay on resolvePromptRequireType
 * until kwargs-shaped scheme lambda emit is honest for `(lambda args …)`.
 */
export function emitPromptRequireFace(content: string, path: string): string | null {
  const reqType = resolvePromptRequireType(content, path);
  if (reqType === null) return null;
  return emitTypedRequireFace(reqType);
}

/**
 * Dispatch: build the virtual-module TS for one require path.
 * @param content file bytes when available (enables hbs pretreat / prompt type synth)
 * @param reqType registry/synthesizer type string (data files; prompt fallback)
 */
export function emitRequireFaceModule(
  path: string,
  content: string | null,
  reqType: string,
  opts?: EmitTypesOptions,
): string {
  if (path.endsWith(".hbs") && content !== null) {
    return emitHbsRequireFace(content, opts);
  }
  if (path.endsWith(".prompt") && content !== null) {
    return emitPromptRequireFace(content, path) ?? emitTypedRequireFace(reqType);
  }
  return emitDataRequireFace(reqType);
}

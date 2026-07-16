/**
 * `.json` / `.yaml` / `.txt` (and any other "structural load" — design doc §2's
 * "other assets" row) → `export default {…} as const;`. Nothing clever: parse to
 * a plain JS value, print it back as a literal. `as const` is the whole payoff
 * (design doc §2): literal types feed the type lens and raise gate-1's clean
 * rate on real pipelines — R-G6 phase-2 (type-directed folding) consumes exactly
 * this shape.
 *
 * Deliberately NOT the Residual algebra (`../residual/`): a parsed JSON/YAML
 * value is already a plain, finite, acyclic JS value (arrays/objects/scalars) —
 * `JSON.stringify` prints valid TypeScript object/array-literal syntax for
 * exactly that domain, so there is no walker/registry/naming machinery to run.
 */
import { parse as parseYaml } from "yaml";

import type { CompileFileResult } from "./types.js";

/** The default-`export`able value for any of the three data extensions. Kept as
 *  one function (rather than three near-duplicates) since the ONLY difference
 *  between them is the parser — the print/shape step is identical. */
function parseDataFile(ext: string, content: string): unknown {
  if (ext === ".json") return JSON.parse(content);
  if (ext === ".yaml" || ext === ".yml") return parseYaml(content);
  if (ext === ".txt") return content;
  throw new Error(`data-module: unhandled data extension "${ext}"`);
}

/** `.json`/`.yaml`/`.yml`/`.txt` are supported (the design doc's dep-free set —
 *  matching arrival core's own `loader.ts` `defaultResolvers`/`ext/yaml`
 *  built-ins exactly, so a project's require-time semantics and its build-time
 *  semantics agree on which extensions exist at all). */
export const DATA_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".yaml", ".yml", ".txt"]);

/**
 * Compile one data file to its module text. Never doors — a parse failure
 * (malformed JSON/YAML) throws a plain, path-attributed error; the caller
 * decides whether that's fatal or a collected warning.
 */
export function compileDataFile(ext: string, content: string, path: string): CompileFileResult {
  let value: unknown;
  try {
    value = parseDataFile(ext, content);
  } catch (e) {
    throw new Error(`${path}: failed to parse as ${ext} — ${e instanceof Error ? e.message : String(e)}`);
  }
  const printed = JSON.stringify(value, null, 2) ?? "null";
  return {
    content: `// Generated from ${path} by @inhuman.tools/arrival-mercury — do not edit.\nexport default ${printed} as const;\n`,
    // A data file declares no `define/overridable`s of its own — TASK #87
    // Q2's cone walk (project.ts) still reads this field unconditionally, so
    // it must be present, not omitted.
    shape: { named: [], hasDefault: true, overridables: [] },
    warnings: [],
  };
}

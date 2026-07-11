// prelude — assemble the lens's ambient TS prelude from a grant env's tool defs.
//
// The lens compiles a lowered scheme program against this prelude. It is the carrier
// vocabulary (carriers.ts, re-presented as ambient text) followed by one
// `declare const <name>: <harvested signature>` per grant tool — so a lowered call
// `get_route(list("a"), "fast")` type-checks against the harvested signature, and the
// Σ∩T narrow drops the provably ill-typed candidates.
//
// Harvests from the AEntity defs directly (schema-to-ts.signatureOf) rather than through
// `OracleEnv.signatureOf`: that method is a contract shared with sift (type-identical,
// O0-conformance-proven), so re-typing it to a TS string would invert the cross-package
// arrow. The harvest stays one-directional (defs → prelude text), entirely in this package.

import { escapeName, isTsIdentifier } from "./name-escape.js";
import type { AEntity } from "../common/symbol.js";
import { signatureOf } from "./schema-to-ts.js";
import { CARRIERS_TEXT } from "./carriers-text.generated.js";

// carriers.ts as AMBIENT text: strip the leading `export ` so `interface Cons`, `type List`,
// and `declare function map` are GLOBAL in the lens's virtual program (the lowered program
// references `list`/`car`/`map` + the carriers unqualified). The verbatim source is baked into
// `carriers-text.generated.ts` at build time (scripts/gen-carriers-text.mjs) — reading it via
// `node:fs` at runtime would break the browser/worker (Vite externalizes `node:fs`).
let cachedVocabulary: string | undefined;
function carrierVocabulary(): string {
  cachedVocabulary ??= CARRIERS_TEXT.replace(/^export /gm, "");
  return cachedVocabulary;
}

export interface HarvestedPrelude {
  /** The ambient TS the lens prepends to the lowered program. */
  readonly prelude: string;
  /** The grant member names (the lowering's head roster). */
  readonly members: readonly string[];
}

/**
 * Assemble the ambient prelude for a set of `[name, arrow-signature]` grant entries.
 * Identifier-safe names become `declare const <name>: <sig>`; operator / non-identifier names
 * become escaped, dotted members of a `declare const _: { … }` namespace (`+` → `_.$plus$`; the
 * lowering emits the matching escaped access — name-escape.ts). `sig` is used verbatim — callers
 * that harvest from an `AEntity` (`assembleHarvestedPrelude`) or from a tool's JSON Schema
 * (arrival-manifold's `assembleManifoldPrelude`) both funnel through this one assembly.
 */
export function assemblePreludeFromSignatures(
  entries: Iterable<readonly [name: string, sig: string]>,
): HarvestedPrelude {
  const members: string[] = [];
  const identDecls: string[] = [];
  const operatorDecls: string[] = [];
  for (const [name, sig] of entries) {
    members.push(name);
    if (isTsIdentifier(name)) identDecls.push(`declare const ${name}: ${sig};`);
    else operatorDecls.push(`  ${escapeName(name)}: ${sig};`);
  }
  const operatorNamespace =
    operatorDecls.length > 0 ? `declare const _: {\n${operatorDecls.join("\n")}\n};\n` : "";
  return {
    prelude: [carrierVocabulary(), "", ...identDecls, "", operatorNamespace].join("\n"),
    members,
  };
}

/**
 * Assemble the ambient prelude for a set of `[name, AEntity]` grant tools. Thin wrapper over
 * `assemblePreludeFromSignatures`: harvests each def's arrow signature via `signatureOf`, then
 * delegates assembly. A door/macro/keyword harvests as `never` (not callable) — `signatureOf`'s
 * own contract.
 */
export function assembleHarvestedPrelude(
  entries: Iterable<readonly [name: string, def: AEntity]>,
): HarvestedPrelude {
  const sigEntries = Array.from(entries, ([name, def]): readonly [string, string] => [name, signatureOf(def)]);
  return assemblePreludeFromSignatures(sigEntries);
}

// prelude — assemble the lens's ambient TS prelude from a grant env's tool defs.
//
// The lens compiles a lowered scheme program against this prelude. It is the carrier
// vocabulary (carriers.ts, re-presented as ambient text) followed by one
// `declare const <name>: <harvested signature>` per grant tool — so a lowered call
// `get_route(list("a"), "fast")` type-checks against the harvested signature, and the
// Σ∩T narrow drops the provably ill-typed candidates.
//
// We HARVEST from the SymbolDefs directly (schema-to-ts.signatureOf) rather than route
// through `OracleEnv.signatureOf`: that method is a contract SHARED with sift (type-identical,
// O0-conformance-proven), so re-typing it to a TS string would invert the cross-package arrow.
// The harvest is one-directional (defs → prelude text) and lives entirely in this package.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SymbolDef } from "../common/symbol.js";
import { signatureOf } from "./schema-to-ts.js";

// carriers.ts as AMBIENT text: strip the leading `export ` so `interface Cons`, `type List`,
// and `declare function map` are GLOBAL in the lens's virtual program (the lowered program
// references `list`/`car`/`map` + the carriers unqualified). Resolved against the shipped src
// tree (from dist/.../prelude.js that is `../../src/type-layer`; from src it is `.`).
function carrierVocabularyPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const inDist = here.includes(`${"/dist/"}`) || here.endsWith("/dist/type-layer/");
  const base = inDist ? new URL("../../src/type-layer/carriers.ts", import.meta.url) : new URL("./carriers.ts", import.meta.url);
  return fileURLToPath(base);
}

let cachedVocabulary: string | undefined;
function carrierVocabulary(): string {
  cachedVocabulary ??= readFileSync(carrierVocabularyPath(), "utf8").replace(/^export /gm, "");
  return cachedVocabulary;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface HarvestedPrelude {
  /** The ambient TS the lens prepends to the lowered program. */
  readonly prelude: string;
  /** The grant member names (the lowering's head roster). */
  readonly members: readonly string[];
}

/**
 * Assemble the ambient prelude for a set of `[name, SymbolDef]` grant tools. Identifier-safe
 * names become `declare const <name>: <sig>`; operator / non-identifier names become members of
 * a `declare const _: { … }` namespace (the lowering emits `_["+"](…)` for them). `sig` is the
 * harvested arrow string; a door/macro/keyword harvests as `never` (not callable).
 */
export function assembleHarvestedPrelude(
  entries: Iterable<readonly [name: string, def: SymbolDef]>,
): HarvestedPrelude {
  const members: string[] = [];
  const identDecls: string[] = [];
  const operatorDecls: string[] = [];
  for (const [name, def] of entries) {
    const sig = signatureOf(def);
    members.push(name);
    if (IDENTIFIER.test(name)) identDecls.push(`declare const ${name}: ${sig};`);
    else operatorDecls.push(`  ${JSON.stringify(name)}: ${sig};`);
  }
  const operatorNamespace =
    operatorDecls.length > 0 ? `declare const _: {\n${operatorDecls.join("\n")}\n};\n` : "";
  return {
    prelude: [carrierVocabulary(), "", ...identDecls, "", operatorNamespace].join("\n"),
    members,
  };
}

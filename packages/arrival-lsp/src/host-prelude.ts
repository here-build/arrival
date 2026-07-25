// host-prelude — assemble a lens `host` option from a host's rosetta type registry.
//
// THE SINGLE-SOURCE SEAM. A host (sift) registers each evidence tool with a TS
// signature string and lands it on the env's rosetta-type registry
// (`rosettaTypesOf(env)` — via `symbol.rosetta` / internal bind). This function
// turns that registry into the two coupled artifacts the type-lens needs — both
// derived from the ONE registration, so type knowledge lives WITH the rosetta
// and cannot drift into a parallel hand-maintained `.d.ts`:
//
//   • `prelude` — ambient `.d.ts` text: the host's entity-type `preamble` followed
//     by one `declare function <encodeSchemeIdent(name)>…` per tool. Same global
//     ambient scope as the builtin leaves, so `typeof <encoded>` resolves (the
//     CANDIDATE side of the mask narrows).
//   • `members` — the tool names (scheme spelling). The emitter lowers a head in
//     this set via bare `encodeSchemeIdent(name)(…)` like a builtin, so
//     `Parameters<typeof head>` resolves (the SLOT side narrows).
//
// The result plugs straight into `createSchemeLanguageService({ host })`.
//
// CONTRACT: each `type` is a function TAIL — a parameter list + return
// annotation, e.g. `"(ip: SchemeIP): boolean"` or `"(): List<Connection>"`. The
// name is encoded and prepended as `declare function <encoded>`, so `"ip/x?"` +
// `"(ip: SchemeIP): boolean"` becomes
// `declare function ip$slash$x$qmark$(ip: SchemeIP): boolean;`. Base types
// (`List`, plain scalars, `Tuple`) are in scope from the lens prelude
// (`types.d.ts`); host entity types MUST be declared in `preamble` (ambient, no
// import/export — it shares the global merge scope).

import { encodeSchemeIdent } from "@inhuman.tools/arrival-mercury/type-emit";

export interface HostPrelude {
  /** Ambient `.d.ts` text — the entity preamble + host `declare function`s. */
  prelude: string;
  /** The host member names (scheme spelling) — the emitter's head roster. */
  members: string[];
  /**
   * Heads whose Contract `inputRest` is a **plain record** (kwargs channel).
   * Threaded into `emitTypes({ kwargsMembers })` so trailing `:k v` collapse
   * only for true kwargs callees — not for positional HOFs like `map`/`where`.
   */
  kwargsMembers: string[];
}

export interface AssembleHostPreludeOptions {
  /**
   * Ambient TS declaring the host's entity + row types referenced by the tool
   * signatures (`interface Connection { … }`, `interface SchemeIP { … }`, …). No
   * `import`/`export` — it is concatenated into the shared global ambient scope.
   */
  preamble?: string;
  /**
   * Subset of entry names with record-shaped `inputRest`. When omitted, empty
   * (emitter still discovers local `(require "….prompt")` bindings itself).
   */
  kwargsMembers?: readonly string[];
}

/**
 * Build the `{ prelude, members, kwargsMembers }` host option from `[name, type]`
 * rosetta entries (e.g. `[...rosettaTypesOf(env)]`). Order-independent; duplicate
 * names keep the last entry (a re-registration overrides).
 */
export function assembleHostPrelude(
  entries: Iterable<readonly [name: string, type: string]>,
  opts?: AssembleHostPreludeOptions,
): HostPrelude {
  const byName = new Map<string, string>(entries);
  const members = [...byName.keys()];
  const kwargsSet = new Set(opts?.kwargsMembers ?? []);
  // Only keep kwargs names that are also host members (no orphans).
  const kwargsMembers = members.filter((m) => kwargsSet.has(m));

  return {
    prelude: [
      "// Host-injected ambient prelude (assembled from the rosetta type registry).",
      opts?.preamble ?? "",
      ...members.map((name) => `declare function ${encodeSchemeIdent(name)}${byName.get(name)!};`),
      "",
    ].join("\n"),
    members,
    kwargsMembers,
  };
}

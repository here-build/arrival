// host-prelude — assemble a lens `host` option from a host's rosetta type registry.
//
// THE SINGLE-SOURCE SEAM. A host (sift) registers each evidence tool with a TS
// signature string: `env.defineRosetta("ip/external-c2-candidate?", { fn, type: "(ip:
// SchemeIP): SBool" })` — sift's own env shape (parked, `inhuman/sift-submission`); arrival
// core's own public `defineRosetta` method is retired (`AmbientRuntime.ts`'s internal
// `bindRosetta` is the surviving wiring). Either way the TS signature string lands on the
// env's rosetta-type registry (`rosettaTypesOf(env)`). This function turns that registry into the two
// coupled artifacts the type-lens needs — both derived from the ONE registration,
// so the type knowledge lives WITH the rosetta and cannot drift into a parallel
// hand-maintained `.d.ts`:
//
//   • `prelude` — ambient `.d.ts` text: the host's entity-type `preamble` followed
//     by ONE `interface ArrShape { "<name>"<type>; … }` block. Re-opening `ArrShape`
//     merges these members into the same `__arr` the builtin leaves extend, so
//     `typeof __arr["<name>"]` resolves (the CANDIDATE side of the mask narrows).
//   • `members` — the tool names. The emitter lowers a head in this set via
//     `__arr["<name>"](…)` like a builtin, so `Parameters<typeof head>` resolves
//     (the SLOT side narrows — a host tool as the enclosing call head).
//
// The result plugs straight into `createSchemeLanguageService({ host })`.
//
// CONTRACT: each `type` is an interface-method TAIL — a parameter list + return
// annotation, e.g. `"(ip: SchemeIP): SBool"` or `"(): List<Connection>"`. The name
// is prepended as a quoted member key, so `"ip/x?"` + `"(ip: SchemeIP): SBool"`
// becomes the member `"ip/x?"(ip: SchemeIP): SBool;`. Base types (`List`, `SNum`,
// `SBool`, `SStr`, `Dict`, `Pair`, `Nil`, `Unit`) are in scope from the lens prelude
// (`types.d.ts`); host entity types (`SchemeIP`, row shapes) MUST be declared in
// `preamble` (ambient, no import/export — it shares the global merge scope).

export interface HostPrelude {
  /** Ambient `.d.ts` text — the entity preamble + the merged `ArrShape` leaf. */
  prelude: string;
  /** The host member names (the `ArrShape` keys) — the emitter's head roster. */
  members: string[];
}

export interface AssembleHostPreludeOptions {
  /**
   * Ambient TS declaring the host's entity + row types referenced by the tool
   * signatures (`interface Connection { … }`, `interface SchemeIP { … }`, …). No
   * `import`/`export` — it is concatenated into the shared global ambient scope.
   */
  preamble?: string;
}

/**
 * Build the `{ prelude, members }` host option from `[name, type]` rosetta entries
 * (e.g. `[...rosettaTypesOf(env)]`). Order-independent; duplicate names keep the
 * last entry (a re-registration overrides). Names are emitted as quoted member keys
 * so any scheme name (`memory/netscan`, `ip/external-c2-candidate?`) is legal.
 */
export function assembleHostPrelude(
  entries: Iterable<readonly [name: string, type: string]>,
  opts?: AssembleHostPreludeOptions,
): HostPrelude {
  const byName = new Map<string, string>(entries);
  const members = [...byName.keys()];

  return {
    prelude: [
      "// Host-injected ambient prelude (assembled from the rosetta type registry).",
      opts?.preamble ?? "",
      "interface ArrShape {",
      ...members.map((name) => `  ${JSON.stringify(name)}${byName.get(name)!};`),
      "}",
      "",
    ].join("\n"),
    members,
  };
}

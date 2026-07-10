// symbol.alias — per-tag factory file assembled into `symbol` by ./index.ts; shared types
// live in ./_bake.js (imported by sibling factories only — this one needs none of them).
//
// `symbol.alias`originalName`` declares a DUPLICATE binding of an EXISTING symbol under a
// new name — dissolution semantics: the record KEY it's placed under (a sibling of
// `originalName` in the SAME `symbols` record) becomes the alias's own bound name; the
// template head holds the TARGET name it dissolves to, never a contract/impl of its own.
//
// Resolution happens at CAPABILITY bind time (`common/capability.ts`'s apply loop), the same
// locus `notImplemented`'s `DoorCause` stamping uses and for the identical reason: this
// factory runs inside a `symbols` record literal, before the owning `EnvCapability` exists,
// so it cannot look up a sibling key itself. By the time the bind loop runs, `symbolsRec` is
// already a fully-built object (JS object-literal construction completes before any
// consumption), so resolving `target` against it there carries no forward-reference hazard.
// The bind loop substitutes the TARGET's already-baked def in place of this marker and binds
// it a SECOND time under the alias's own name through the exact same per-kind dispatch every
// other entry goes through — byte-equivalent runtime, never a wrapper indirection. A `target`
// absent from the SAME capability's own `symbols` record is a declaration bug, not a runtime
// condition: the bind loop throws a teaching error at assembly (errors-as-doors) rather than
// silently binding nothing.
//
// UNCATALOGUED by construction: `AliasSymbolDef` carries no `metadata` field and its `kind`
// ("alias") is not one of the baked `AEntity` kinds — a catalog walk that reads `spec.symbols`
// directly (arrival-mcp's `McpEnvCapability`) and only recognizes baked-kind defs simply never
// sees it, so an alias is invisible to the MCP catalog even when its target is exposed.

/** The marker `symbol.alias` produces — resolved (never bound directly) by
 *  `common/capability.ts`'s apply loop. Not a member of `AEntity` (_bake.ts's baked-kind
 *  union): it never reaches a `run`/`impl` call itself, only ever stands in for its target. */
export interface AliasSymbolDef {
  readonly kind: "alias";
  /** The EXISTING symbol name (a sibling key in the SAME capability's `symbols` record)
   *  this dissolves to. */
  readonly target: string;
}

/** `symbol.alias`originalName`` — the template head is read WHOLE as the target name (no
 *  `name: doc` split — an alias carries no doc of its own; it inherits the target's). */
export function alias(tpl: TemplateStringsArray, ...sub: (string | number)[]): AliasSymbolDef {
  let target = "";
  for (let i = 0; i < tpl.length; i++) {
    target += tpl[i];
    if (i < sub.length) target += String(sub[i]);
  }
  return { kind: "alias", target: target.trim() };
}

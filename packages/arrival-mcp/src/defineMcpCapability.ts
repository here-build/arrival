/**
 * defineMcpCapability — the MCP capability authoring surface, post-DI-rework
 * (docs/plans/rework-zone-guidelines.md §2). A thin wrapper over
 * `EnvCapability.define` (`@inhuman.tools/arrival/capability`) — the ONE
 * capability-authoring shape — that stamps a capability-level `description`/
 * `dynamicDescription` into a side table (keyed by the minted capability object) and
 * passes every verb straight through to the injected `symbol.*` factories.
 *
 * WHAT DIED with the DI rework (see the guidelines' §2 "Dies" list):
 *   - The `{fn}`-shaped inline symbol authoring (`symbols: { verb: { fn, description,
 *     inputSchema, ... } }`) and the constructor-time annotation-lifting machinery that
 *     used to split it into a separate `annotations` record (`liftInlineAnnotations`,
 *     `withArgParsing`, `wrapSymbol`) — `SymbolDeclaration` no longer HAS a `{fn}` arm
 *     (arrival core's Stage C Cut 4), so there is nothing left to lift.
 *   - The separate MCP-level `inputSchema` re-validation pass: a baked `symbol.rosetta`
 *     verb's own `input`/`inputRest` contract ALREADY validates + decodes args at the
 *     membrane boundary (docs/environments.md §CONTRACT) — a second zod pass over the
 *     same positions was redundant duplication, not a distinct concern.
 *   - The warm-`AssembledAmbient` catalog reflection (`allAnnotations`/
 *     `allAnnotationEntries`, walking `spec.deps` + an `instanceof McpEnvCapability`
 *     gate over a LOWERED closure). Per-verb MCP metadata now rides the baked def's own
 *     `metadata` bag (`BakeRuntimeOpts.metadata`) — written by `tool.*` (tool.ts) at
 *     declaration time — and is read back at describe/catalog time straight off the
 *     RUN's own vocabulary: `symbolsOwnedBy(runCtx, capability)` (the run-reader door,
 *     `/host-internals`) + `contractOf` (`/lsp-internals`). See `mcpCatalogEntries`
 *     below — DiscoveryTool.ts is its one consumer.
 *
 * WHAT SURVIVES: the capability-level `description`/`dynamicDescription` fusion (“the
 * capability is a self-contained home for its own catalog text, no runner-side side
 * bag”) — `mcpCapabilityMeta` below is the new home for that pair, since a bare
 * `EnvCapability` (the base class every `.define()` call returns) carries no such
 * field itself.
 */

import { EnvCapability, type DefineCapabilitySpec, type ImplThis } from "@inhuman.tools/arrival/capability";
import { contractOf } from "@inhuman.tools/arrival/lsp-internals";
import { ownerOf, symbolsOwnedBy } from "@inhuman.tools/arrival/host-internals";
import type { RunContext } from "@inhuman.tools/arrival";
import type * as zod from "zod";

type ZodMap = Record<string, zod.ZodType>;
type InferCfg<C extends ZodMap> = { [K in keyof C]: zod.infer<C[K]> };
type MaybePromise<T> = T | Promise<T>;

/** `defineMcpCapability`'s spec: `EnvCapability.define`'s own `DefineCapabilitySpec`
 *  (configuration/resources/prelude/deps, byte-identical), its `symbols` field renamed
 *  `tools` (the MCP-facing name for "the verbs this capability exposes"), plus the
 *  capability-level catalog-text pair. */
export type McpCapabilityDefineSpec<Shape extends ZodMap, Resources> = Omit<
  DefineCapabilitySpec<Shape, Resources>,
  "symbols"
> & {
  /** The tool's stable, static catalog text — "the whole capability, in one line." */
  readonly description?: string;
  /** Per-connection LIVE text, resolved lazily (sync or async) at describe/catalog read
   *  time, per read, no memo — `this` is `ImplThis<Config,Resources>` (the SAME `this`
   *  shape a `.define()`-authored verb impl sees: `configuration`/`resources`, never
   *  `Activation`'s old per-key `Ref<Handle>` shape) when a describe-time run is
   *  derivable (DiscoveryTool's describe run), the bare capability object otherwise
   *  (the receiver-free posture). Resolves `undefined` ⇒ honest fallback to the
   *  static `description`, NOT flagged session-generated. */
  readonly dynamicDescription?: (this: ImplThis<InferCfg<Shape>, Resources>) => MaybePromise<string | undefined>;
  /** The verbs this capability exposes — `EnvCapability.define`'s own `symbols`
   *  callback, unchanged shape, renamed for the MCP-authoring vocabulary. */
  readonly tools: DefineCapabilitySpec<Shape, Resources>["symbols"];
};

interface McpCapabilityMeta {
  readonly description?: string;
  readonly dynamicDescription?: (this: unknown) => MaybePromise<string | undefined>;
}

/** Capability object → its own catalog-text pair. A capability minted any OTHER way
 *  (`new EnvCapability(...)`, a plain `.define()` call not routed through this factory)
 *  has no entry here — the "plain EnvCapability dep grants live verbs but stays
 *  undocumented to the catalog" posture {@link mcpCatalogEntries} below relies on. */
const mcpCapabilityMeta = new WeakMap<object, McpCapabilityMeta>();

/** Define an MCP capability: a thin wrapper over `EnvCapability.define`. See the module
 *  header for the full model. */
export function defineMcpCapability<
  Shape extends ZodMap = Record<string, never>,
  Resources = Record<string, never>,
>(name: string, spec: McpCapabilityDefineSpec<Shape, Resources>): EnvCapability<Shape, Record<string, never>> {
  const { description, dynamicDescription, tools, ...rest } = spec;
  const capability = EnvCapability.define<Shape, Resources>(name, { ...rest, symbols: tools });
  mcpCapabilityMeta.set(capability, {
    description,
    dynamicDescription: dynamicDescription as McpCapabilityMeta["dynamicDescription"],
  });
  return capability;
}

/** Is `capability` one `defineMcpCapability` minted (vs a plain `EnvCapability` a
 *  capability pulls in as a dep for its live verbs, never its own catalog text)? */
export function isMcpCapability(capability: object): boolean {
  return mcpCapabilityMeta.has(capability);
}

/** Does `capability` declare a capability-level `dynamicDescription`? DiscoveryTool
 *  reads this to decide whether the (assembly-costing) describe-time run is worth
 *  building at all — a purely-static capability never pays for one. */
export function hasCapabilityDynamicDescription(capability: object): boolean {
  return mcpCapabilityMeta.get(capability)?.dynamicDescription !== undefined;
}

/** Resolve a capability's OWN human-channel description — dynamic arm first (against
 *  `activation` when supplied), honest fallback to the static sibling on `undefined`
 *  resolution. `activation` omitted ⇒ the dynamic arm runs with `this` = the capability
 *  itself (the receiver-free posture a function-form host config, or a config
 *  schema requiring actor-only keys, leaves DiscoveryTool with). `undefined` for a
 *  capability `defineMcpCapability` never minted (nothing to resolve). */
export async function resolveCapabilityDescription(
  capability: object,
  activation?: unknown,
): Promise<string | undefined> {
  const meta = mcpCapabilityMeta.get(capability);
  if (meta === undefined) return undefined;
  if (meta.dynamicDescription !== undefined) {
    const live = (await Reflect.apply(meta.dynamicDescription, activation ?? capability, [])) as string | undefined;
    if (live !== undefined) return live;
  }
  return meta.description;
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalog — the run-reader door's consumer shape (V's DI ruling, rework-zone-
// guidelines.md's cross-cutting prerequisite): "discovery takes run context, extracts
// each symbol whose owning capability is an mcp capability, renders it in prelude."
// ─────────────────────────────────────────────────────────────────────────────

/** Every MCP capability reachable from `root`'s dep closure — deps-first, self-last
 *  (mirrors `assembleRun`'s own C3 precedence: a nearer capability's bound value wins a
 *  name clash over a dep's, so `symbolsOwnedBy` naturally reflects only the WINNING
 *  owner per name — no separate last-write-wins bookkeeping needed here). A plain
 *  `EnvCapability` dep (never routed through `defineMcpCapability`) grants its verbs
 *  live but is skipped here — "undocumented to the catalog," by construction. */
function mcpCapabilitiesInClosure(root: EnvCapability, seen: Set<EnvCapability> = new Set()): EnvCapability[] {
  if (seen.has(root)) return [];
  seen.add(root);
  const out: EnvCapability[] = [];
  for (const dep of root.spec.deps ?? []) out.push(...mcpCapabilitiesInClosure(dep, seen));
  if (isMcpCapability(root)) out.push(root);
  return out;
}

/** One catalogued verb: its owning capability's name, its bound name in the run's
 *  vocabulary, the bound value itself (for the rare caller that wants to dispatch it
 *  directly), and its baked `metadata` bag (`description`/`dynamicDescription`/
 *  `isTool`/`risky`/anything a domain's own `tool.*`-alike stamps — see tool.ts). */
export interface McpCatalogEntry {
  readonly owner: string;
  readonly name: string;
  readonly value: unknown;
  readonly metadata: Record<string, unknown>;
}

function metadataOf(value: unknown): Record<string, unknown> {
  const entity = contractOf(value as never);
  return ((entity as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}) as Record<string, unknown>;
}

/** The STATIC fallback: walk `capability.spec.deps`/`.spec.symbols` directly, deps-
 *  first self-last (dedup by name, last write wins — mirrors `assembleRun`'s own C3
 *  precedence). A capability's `symbols` record is ALREADY the baked A-values
 *  (`EnvCapability.define`'s `symbols` callback runs EAGERLY, ONCE, at `define()` time —
 *  see capability.ts) — no run needed to read a verb's static `metadata` bag at all. */
function staticCatalogEntries(root: EnvCapability, seen: Set<EnvCapability> = new Set()): Map<string, McpCatalogEntry> {
  const out = new Map<string, McpCatalogEntry>();
  if (seen.has(root)) return out;
  seen.add(root);
  for (const dep of root.spec.deps ?? []) for (const [k, v] of staticCatalogEntries(dep, seen)) out.set(k, v);
  if (isMcpCapability(root)) {
    for (const [name, value] of Object.entries(root.spec.symbols ?? {})) {
      out.set(name, { owner: root.name, name, value, metadata: metadataOf(value) });
    }
  }
  return out;
}

/** The verb catalog: every verb whose owning capability is an MCP capability reachable
 *  from `root`'s dep closure, in dep-closure order (deps-first, self-last — a nearer
 *  capability's entry wins a name clash over a dep's).
 *
 *  Two sources, by availability:
 *   - `runCtx` supplied (a real, vocabulary-bearing run already exists — the common
 *     case, DiscoveryTool's own warm/describe pair): the run-reader door,
 *     `symbolsOwnedBy(runCtx, capability)` (`/host-internals`) — reflects the run's
 *     OWN resolved bindings, so a genuinely dynamic closure (a `require`d extension
 *     adding capabilities at runtime) is seen correctly.
 *   - `runCtx` absent, or carrying no vocabulary (assembling one would fail — e.g. a
 *     capability's `configuration` schema demands an ACTOR-only key no describe-time
 *     config can supply; `buildVocabulary`'s config validation is a hard `.parse`,
 *     no degrade-to-doors escape): the STATIC `spec.symbols` walk above. Same baked
 *     values either way (bake is eager, at `define()` time) — this is a genuine
 *     fallback, not an approximation. This is the honest-floor behavior
 *     `DiscoveryTool.describe()` needs: catalog TEXT must never depend on actor
 *     config existing, only per-verb metadata does. */
export function mcpCatalogEntries(root: EnvCapability, runCtx?: RunContext): McpCatalogEntry[] {
  if (runCtx?.vocabulary !== undefined) {
    const out: McpCatalogEntry[] = [];
    for (const capability of mcpCapabilitiesInClosure(root)) {
      for (const [name, value] of symbolsOwnedBy(runCtx, capability)) {
        out.push({ owner: capability.name, name, value, metadata: metadataOf(value) });
      }
    }
    return out;
  }
  return [...staticCatalogEntries(root).values()];
}

/** One verb's `metadata` bag, read straight off the run's vocabulary by NAME + owned
 *  by SOME capability (`ownerOf`, `/host-internals`) — the narrow query
 *  `DiscoveryTool.isRisky` needs at CALL time, when a live `runCtx` unambiguously
 *  exists. A base-roster builtin (owned by no capability) or an unbound name answers
 *  `undefined` here, never a false metadata read. */
export function verbMetadataByName(runCtx: RunContext, verbName: string): Record<string, unknown> | undefined {
  const value = runCtx.vocabulary?.get(verbName);
  if (value === undefined || ownerOf(value) === undefined) return undefined;
  return metadataOf(value);
}

/** Resolve one metadata FIELD (static data, or a `(this: Activation) => value` dynamic
 *  thunk — the same per-field static-or-dynamic union every baked def's `metadata` bag
 *  carries, arrival core's `MetadataField`) against `activation`. Mirrors arrival core's
 *  own (unexported) `resolveMetadata` — duplicated here in miniature rather than reached
 *  for across the package boundary, since `/lsp-internals`/`/host-internals` don't
 *  surface it and the whole resolution rule is three lines. */
export async function resolveMcpField<T>(
  field: T | ((this: unknown) => MaybePromise<T | undefined>) | undefined,
  activation: unknown,
): Promise<T | undefined> {
  if (typeof field !== "function") return field;
  return (await (field as (this: unknown) => MaybePromise<T | undefined>).call(activation)) as T | undefined;
}

/**
 * The base `EnvCapability` is MCP-agnostic (verbs, config, resources, deps, prelude). A tool
 * transport needs more per verb to expose it to an actor: a `description` for the catalog and
 * an `inputSchema` to derive the input JSON-schema + validate calls.
 *
 * Those could ride on the generic rosetta config, but that would couple the marshalling layer to
 * MCP + zod — so they live HERE instead, on a thin subclass. The MCP fields are written INLINE
 * on each symbol def (the name appears once, the runtime fn and its catalog text co-located); the
 * constructor LIFTS them off into a separate `annotations` record before handing clean rosetta
 * symbols to the base — `annotations` are inert to the runtime wiring, reflected off the
 * capability root-set by a transport to build its surface. A domain subclass widens the lifted
 * key-set (the third constructor arg) to carry extra catalog fields.
 */

import {
  type Activation,
  type CapabilitySpec,
  EnvCapability,
  type SymbolDeclaration,
} from "@here.build/arrival/capability";
import type { Resource } from "@here.build/arrival/resources";
import invariant from "tiny-invariant";
import * as z from "zod";

type AnyActivation = Activation<any, any>;

type MaybePromise<T> = T | Promise<T>;

/** Per-verb MCP metadata: everything the tool transport needs to advertise + validate
 *  a symbol, and nothing the runtime wiring reads. */
export interface McpAnnotation {
  /** Static one-line catalog summary. Always present; shown unless `dynamicDescription`
   *  resolves to a string. */
  description: string;
  /** Optional LIVE/personalized text, resolved (sync or async) at schema-fetch time —
   *  the per-session "welcome screen". A thunk so it fires ONLY for the catalog,
   *  never on tool execution. Resolves to a string ⇒ that text is shown AND the catalog is
   *  flagged session-generated; resolves to `undefined` ⇒ fall back to `description`,
   *  NOT flagged dynamic (so a failed live-fetch can return `undefined` honestly).
   *
   *  TWO authoring arms, one read cadence (per read, no memo):
   *  - LEGACY closure form: closes over context captured in `capability()` (it runs before
   *    any env/activation exists); ignores `this`. The arm the hermetic doctrine retires.
   *  - METADATA-declared form (tool``'s `dynamicDescription`, riding the baked def's
   *    `metadata` bag): reads `this` — the OWNING capability's describe-ambient
   *    `Activation` (host config + host resources; DiscoveryTool.catalog binds it) —
   *    the declared channel that survives offload/reassembly. */
  dynamicDescription?: () => MaybePromise<string | undefined>;
  /**
   * Positional input schemas, PARSED post-membrane (on the marshalled args) and pre-call —
   * so zod transforms run (validate + resolve) before the verb fn. Implement as a GETTER to
   * resolve args against the capability's LIVE resources; the getter's `this` is the
   * `Activation` (bound when the wrapped fn runs), so the transform closures reach it:
   *
   *   get inputSchema() { return [z.string().transform(v => this.resources.x.live.load(v))] }
   *
   * A static array (no resource access) works too. The declaration stays non-contextual; the
   * getter is evaluated per-call with the live activation.
   */
  inputSchema?: readonly z.ZodType[];
  /** Extra names this symbol is ALSO bound under (same fn + same `inputSchema` parsing). Aliases
   *  are runtime bindings only — they never enter the catalog (`allAnnotations` keys by the primary
   *  name), so they're undocumented shorthands an actor can call but the verb list won't advertise.
   *
   *  Distinct from `symbol.alias` (`@here.build/arrival/symbol`): that factory dissolves into a
   *  SECOND, uncatalogued key in the `symbols` record itself (core-level, capability-agnostic).
   *  This field stays for verbs that want an EXTRA name that still shares the primary's own
   *  catalog identity (same annotation object, same description) — a different shape than
   *  dissolution's "invisible duplicate." */
  aliases?: readonly string[];
  /** STATIC exposure flag (arrival-mcp-extended-capability.md §2.5) — `true` iff this verb is
   *  ALSO its own structured MCP tool (once a runner derives `tools/list` from the catalog),
   *  never just an fn-truthy value: `tools/list` membership must be stable data. Written by
   *  `tool.view`/`tool.pure`/`tool.effect`/`tool.risky` (arrival-mcp/src/tool.ts) via the same
   *  metadata channel `description`/`dynamicDescription` already ride. Absent (or a plain
   *  `description`-only verb) ⇒ a DECLARED ACTION — bound + catalogued, but not its own tool. */
  isTool?: true;
  /** STATIC danger classification (arrival-provenance-confirmation.md §7.5 — "danger is an
   *  attribute of the action, not the arguments set"). Written ONLY by `tool.risky`
   *  (arrival-mcp/src/tool.ts), never by a caller argument or a runtime condition. Lifted here
   *  (added to {@link MCP_ANNOTATION_KEYS}) so `allAnnotations()` — already the catalog's one
   *  reflection point — is also the confirm-manifest builder's one lookup point for "does this
   *  verb name require the hold rule": no second registry, no second convention. */
  risky?: true;
}

/** The annotation property names the BASE lifts off an inline symbol def. A subclass widens
 *  this (via the constructor's third arg) to lift extra, domain-specific catalog fields. */
export const MCP_ANNOTATION_KEYS: readonly string[] = [
  "description",
  "dynamicDescription",
  "inputSchema",
  "aliases",
  "isTool",
  "risky",
];

/** The object form of a `SymbolDeclaration` (the rosetta-config member with an `fn`). */
type ObjectSymbolDef = Extract<SymbolDeclaration, { fn: unknown }>;

/** A symbol def that MAY carry inline MCP annotation fields. The constructor lifts the
 *  annotation keys off into the `annotations` record, leaving a clean rosetta `SymbolDeclaration`.
 *  Bare-fn and `{ value }` defs carry no inline fields. */
export type AnnotatedSymbolDef = SymbolDeclaration | (ObjectSymbolDef & Partial<McpAnnotation>);

/** A `symbols` record (which may carry inline annotation fields), or a builder computing it. */
export type McpSymbolsSpec<C extends Record<string, z.ZodType>, R extends Record<string, Resource<unknown>>> =
  | (Record<string, AnnotatedSymbolDef> & ThisType<Activation<C, R>>)
  | ((activation: Activation<C, R>) => Record<string, AnnotatedSymbolDef>);

/** A `CapabilitySpec` whose `symbols` may carry inline MCP annotations, plus an optional
 *  explicit `annotations` record (the legacy form: annotation keyed by symbol name). When a
 *  symbol declares inline fields they win; otherwise the explicit entry is used verbatim. */
export interface McpCapabilitySpec<
  C extends Record<string, z.ZodType>,
  R extends Record<string, Resource<unknown>>,
> extends Omit<CapabilitySpec<C, R>, "symbols"> {
  symbols?: McpSymbolsSpec<C, R>;
  /** Keyed by symbol name. The legacy form — prefer inline fields on the symbol def. An
   *  `inputSchema` getter's `this` is the `Activation` at call time (bound via `Reflect.get`),
   *  but TS can't type accessor `this` — so getter bodies assert the activation shape. */
  annotations?: Record<string, McpAnnotation>;
  /** The CAPABILITY's own human-channel description (arrival-mcp-extended-capability.md §2.2
   *  CAP_DESCRIPTION) — the FUSION this class exists for: a self-contained declaration carries
   *  its own top-level `Tool.description` instead of a runner-side `DiscoveryToolOptions.description`
   *  side bag. Static text, always present when this field is set; shown unless `dynamicDescription`
   *  resolves to a string. */
  description?: string;
  /** CAP_DYNAMIC_DESCRIPTION — the capability-level dual of a verb's `dynamicDescription`: a
   *  per-connection "welcome screen" for the discovery tool ITSELF, resolved lazily at
   *  describe/catalog time against this capability's own describe-ambient `Activation`, per
   *  read, no memo. Resolving `undefined` falls back to the static `description` above, NOT
   *  flagged session-generated — the same A2 honest-fallback contract every per-verb dynamic
   *  field already obeys (see `./metadata.js`'s `resolveMetadata` at the core-package altitude). */
  dynamicDescription?: (this: Activation<C, R>) => MaybePromise<string | undefined>;
}

/** Resolve a verb's `inputSchema` (invoking its getter with `this`=activation, so resources
 *  are reachable) and parse the marshalled args through it — validate + transform, pre-call. */
function parseArgs(annotation: McpAnnotation, activation: AnyActivation, raw: unknown[]): unknown[] {
  // Reflect.get invokes an `inputSchema` GETTER with `this`=activation (or returns a static
  // array). The getter's transform closures then close over the activation lexically.
  const schemas = Reflect.get(annotation, "inputSchema", activation) as readonly z.ZodType[] | undefined;
  if (!schemas || schemas.length === 0) return raw;
  return [...z.tuple(schemas as [z.ZodType, ...z.ZodType[]]).parse(raw)];
}

/** Wrap one symbol's fn with its `inputSchema` parse. `this` is the Activation (bound by
 *  `lower()`), so the getter + its transform closures reach resources. `{ value }` is untouched. */
function wrapSymbol(def: any, annotation: McpAnnotation | undefined): any {
  // getOwnPropertyDescriptor checks presence WITHOUT invoking a (resource-using) getter.
  if (!annotation || !Object.getOwnPropertyDescriptor(annotation, "inputSchema")) return def;
  const norm = typeof def === "function" ? { fn: def } : def;
  if (!norm || typeof norm.fn !== "function") return def;
  const orig = norm.fn;
  return {
    ...norm,
    fn(this: AnyActivation, ...raw: unknown[]) {
      return orig.apply(this, parseArgs(annotation, this, raw));
    },
  };
}

/** Wrap every symbol that has an `inputSchema` annotation with arg-parsing. Handles both the
 *  record and the builder (`(activation) => record`) `symbols` forms. */
function withArgParsing(symbols: any, annotations: Record<string, McpAnnotation>): any {
  const wrapRecord = (rec: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [name, def] of Object.entries(rec)) {
      const wrapped = wrapSymbol(def, annotations[name]);
      out[name] = wrapped;
      // Bind each alias to the SAME wrapped fn (identical arg-parsing). Catalog-invisible: only
      // `name` is an annotation key, so `allAnnotations` never lists the alias.
      for (const alias of annotations[name]?.aliases ?? []) out[alias] = wrapped;
    }
    return out;
  };

  return typeof symbols === "function" ? (activation: any) => wrapRecord(symbols(activation)) : wrapRecord(symbols);
}

/** Split inline annotation fields off each (object-form) symbol def into a separate annotations
 *  record, leaving a clean rosetta symbol. Property DESCRIPTORS are moved (never read), so an
 *  `inputSchema` getter survives un-invoked. A bare-fn / `{ value }` def carries no inline fields
 *  and passes through; a symbol that declares no inline fields falls back to the explicit
 *  `annotations[name]` (legacy form). Inline fields win over an explicit entry of the same name. */
function liftInlineAnnotations(
  symbols: Record<string, any>,
  explicit: Record<string, McpAnnotation>,
  annotationKeys: readonly string[],
): { symbols: Record<string, any>; annotations: Record<string, McpAnnotation> } {
  const keySet = new Set(annotationKeys);
  const cleanSymbols: Record<string, any> = {};
  const annotations: Record<string, McpAnnotation> = { ...explicit };

  for (const [name, def] of Object.entries(symbols)) {
    if (typeof def !== "object" || def === null) {
      cleanSymbols[name] = def; // bare fn — no inline fields to lift
      continue;
    }

    // A def carries annotation fields on one of TWO channels: direct keys on the
    // object literal (the legacy inline form), or the `metadata` bag of a baked
    // RosettaSymbolDef (the tool`` channel).
    const meta = (def as any).metadata;
    const hasMeta = meta && typeof meta === "object";

    const clean: any = {};
    const ann: any = {};
    let hasInline = false;

    // Direct annotation keys (legacy inline form): descriptor-MOVED off the def —
    // an `inputSchema` getter must survive un-invoked, and the runtime def must not
    // keep a second copy that could drift from the lifted one.
    for (const key of Object.keys(def)) {
      if (keySet.has(key)) {
        const desc = Object.getOwnPropertyDescriptor(def, key)!;
        Object.defineProperty(ann, key, desc);
        hasInline = true;
      } else if (key !== "metadata") {
        const desc = Object.getOwnPropertyDescriptor(def, key)!;
        Object.defineProperty(clean, key, desc);
      }
    }

    // Metadata-bag keys: COPIED, not moved — the bag belongs to the baked def's own
    // shape (core reads it), so lifting mirrors the annotation keys without mutating it.
    if (hasMeta) {
      for (const key of Object.keys(meta)) {
        if (keySet.has(key)) {
          ann[key] = meta[key];
          hasInline = true;
        }
      }
    }

    // A baked def (`kind` present) passes through WHOLE — its metadata bag is part of
    // the baked shape; only a legacy object literal is replaced by its stripped copy.
    if ((def as any).kind) {
      cleanSymbols[name] = def;
    } else {
      cleanSymbols[name] = clean;
    }

    if (hasInline) annotations[name] = { ...(annotations[name] || {}), ...ann };
  }

  return { symbols: cleanSymbols, annotations };
}

/** An `EnvCapability` carrying MCP annotations. Annotation fields live inline on each symbol
 *  def; the constructor lifts them off (descriptor-preserving) and arms `inputSchema` parsing.
 *  Everything else (lowering, resources, deps, prelude) is inherited. */
export class McpEnvCapability<
  C extends Record<string, z.ZodType> = any,
  R extends Record<string, Resource<unknown>> = any,
> extends EnvCapability<C, R> {
  /** CAP_DESCRIPTION — see `McpCapabilitySpec.description`. */
  readonly description?: string;
  /** CAP_DYNAMIC_DESCRIPTION — see `McpCapabilitySpec.dynamicDescription`. */
  readonly dynamicDescription?: (this: Activation<C, R>) => MaybePromise<string | undefined>;

  /**
   * @param annotationKeys which property names to lift off the inline symbol defs. Defaults to
   *   the base MCP fields; a domain subclass passes a WIDER set to also lift its catalog fields.
   *   Must be a constructor arg (not a virtual method) — `this` is unavailable before `super()`.
   */
  constructor(name: string, spec: McpCapabilitySpec<C, R>, annotationKeys: readonly string[] = MCP_ANNOTATION_KEYS) {
    const explicit = spec.annotations ?? {};
    // Only the RECORD form can be inspected statically — `liftInlineAnnotations` walks the
    // object literal's own keys. A BUILDER (`(activation) => {...}`) can't be peeked without
    // actually calling it, and calling it here would need a fake activation before `lower()`
    // ever supplies real `configuration`/`resources` — unsafe (a verb's closure could read
    // config that doesn't exist yet, or capture a placeholder that silently diverges from the
    // real one). So a builder-form `symbols` DOORS here rather than silently skipping the lift:
    // any inline `description`/`inputSchema` an author put on a verb inside the builder's
    // returned record would otherwise vanish with zero signal (no catalog entry, no arg
    // validation) — exactly the failure mode this capability exists to prevent. Every real
    // McpEnvCapability today (here.build's project/general discovery, inhuman's project
    // discovery, sift's whole forensics catalog) already uses the record form; a subclass that
    // genuinely needs a builder should annotate via the explicit `annotations` record instead
    // (no inline splicing) — that path is untouched by this check.
    invariant(
      typeof spec.symbols !== "function",
      `McpEnvCapability "${name}": builder-form \`symbols\` (a function) is not supported — inline ` +
        "annotation fields (description/inputSchema/dynamicDescription/aliases) can't be lifted off a " +
        "builder without invoking it before real configuration/resources exist. Use the record form " +
        "(`symbols: { ... }`), or pass annotations via the explicit `annotations: { name: {...} }` field " +
        "alongside a builder if the verbs themselves need no inline catalog metadata.",
    );
    const lifted =
      spec.symbols === undefined
        ? { symbols: spec.symbols, annotations: explicit }
        : liftInlineAnnotations(spec.symbols, explicit, annotationKeys);
    super(name, {
      ...spec,
      symbols: lifted.symbols === undefined ? undefined : withArgParsing(lifted.symbols, lifted.annotations),
      annotations: lifted.annotations,
    } as McpCapabilitySpec<C, R> as CapabilitySpec<C, R>);
    this.description = spec.description;
    this.dynamicDescription = spec.dynamicDescription;
  }

  /** Resolve THIS capability's own human-channel (CAP_DESCRIPTION/CAP_DYNAMIC_DESCRIPTION)
   *  description — dynamic arm first (against `activation` when supplied), honest fallback
   *  to the static sibling on `undefined` resolution (the A2 contract, one altitude up from
   *  the per-verb read `./metadata.js`'s `resolveMetadata` already implements). `activation`
   *  omitted ⇒ the dynamic arm runs with `this` = the capability itself — the same
   *  receiver-free posture the legacy per-verb closure form takes when no describe ambient is
   *  derivable (a function-form `hostConfig` / an actor-required config key). */
  async resolveDescription(activation?: Activation<C, R>): Promise<string | undefined> {
    if (this.dynamicDescription !== undefined) {
      // `Reflect.apply`'s `thisArgument` is honestly `any` (unlike `.call`, which — under
      // `strictBindCallApply` — would demand a real `Activation<C,R>` even for the
      // receiver-free fallback) — the SAME escape `parseArgs`'s `Reflect.get` below uses for
      // the identical "this=activation-or-legacy-receiver" shape, never a cast.
      const live = (await Reflect.apply(this.dynamicDescription, activation ?? this, [])) as
        | string
        | undefined;
      if (live !== undefined) return live;
    }
    return this.description;
  }

  /** The MCP annotations for THIS capability's own verbs (not its deps) — inline-lifted and
   *  explicit, merged at construction. */
  get annotations(): Record<string, McpAnnotation> {
    return (this.spec as McpCapabilitySpec<C, R>).annotations ?? {};
  }

  /**
   * The catalog of an AGGREGATING capability: this capability's annotations UNIONED
   * across its whole `deps` closure — so a discovery tool takes ONE capability whose
   * `deps` are the constituents, and the env-capability dependency DAG does the
   * aggregating (mirroring how `assembleEnv` closes over `deps` for the env itself).
   *
   * Walk order is deps-first, self-last, so a nearer capability's annotation wins a
   * name clash — matching `assembleEnv`'s last-write-wins C3 precedence (the root is
   * highest). Only `McpEnvCapability` nodes contribute; a plain `EnvCapability` dep
   * still grants live verbs, just undocumented-to-the-catalog (by design).
   */
  allAnnotations(): Record<string, McpAnnotation> {
    return Object.fromEntries(this.allAnnotationEntries().map(({ name, annotation }) => [name, annotation]));
  }

  /**
   * `allAnnotations` with the OWNING capability carried per entry — the describe-time
   * metadata read path (exec-phases-and-dynamic-metadata.md §2.4/§2.7) needs the owner
   * to look up that capability's ACTIVATION (`AssembledEnv.activations` is keyed by pack
   * = capability name) so a dynamic `dynamicDescription` resolves against the right
   * `this`. Same walk, same last-write-wins precedence: deps-first, self-last — a nearer
   * capability's entry (and its owner stamp) replaces a dep's on a name clash.
   */
  allAnnotationEntries(): ReadonlyArray<{ owner: string; name: string; annotation: McpAnnotation }> {
    const out = new Map<string, { owner: string; name: string; annotation: McpAnnotation }>();
    const seen = new Set<EnvCapability>();
    const visit = (cap: EnvCapability): void => {
      if (seen.has(cap)) return;
      seen.add(cap);
      for (const dep of cap.spec.deps ?? []) visit(dep);
      if (cap instanceof McpEnvCapability) {
        for (const [name, annotation] of Object.entries(cap.annotations)) {
          out.set(name, { owner: cap.name, name, annotation });
        }
      }
    };
    visit(this);
    return [...out.values()];
  }
}

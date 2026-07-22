/**
 * The emit-rule registry harvest: collect `[name, Contract-facts]` rows from a
 * live `EnvCapability[]` tree (or an already-assembled ambient) WITHOUT running
 * the program and WITHOUT arming a single resource (constitution §4.1/§4.5;
 * registry-emit.md §"The harvest").
 *
 * This is `exec-phases.ts`'s `rosterEntries` walk with exactly one change:
 * where that precedent returns early on a builder-form `symbols` (a documented
 * LIMIT), this harvest invokes the builder — against the ambient's REAL
 * activation when harvesting an assembly, against the phantom `dryActivation`
 * for a bare capability list (see `emitRegistryOf`'s doc for the split) — and
 * keeps walking. Everything else — deps-first visit order, identity dedup,
 * `symbolPrefix`, last-write-wins on a name clash — matches the roster walk
 * (and therefore C3 apply precedence) deliberately.
 *
 * Placement note: the component spec drafted this module inside arrival core
 * (`src/emit/registry.ts`); the constitution's §4.5 layering ("the compiler
 * HARVESTS contracts") and the wave plan land it here, in the compiler package
 * — arrival core keeps only the pure `EmitRule`/`EmitCtx`/`TypeFacts` types
 * and the Contract fields themselves.
 */
import type { Activation, EnvCapability, SymbolDeclaration } from "@inhuman.tools/arrival/capability";
import type { EmitRule, RefPolicy } from "@inhuman.tools/arrival/emit";
import type { AssembledAmbient } from "@inhuman.tools/arrival/env";
import type { AEntity, CacheClass, ProvenanceRole } from "@inhuman.tools/arrival/symbol";

import { dryActivation } from "./dry-activation.js";

/** One harvested symbol: the Contract facts the compiler reads (registry-emit.md
 *  §"The harvest API", widened by the wave plan with `symbol`/`provenance`/`cacheClass`
 *  so the engine's optimization gates read the same row). */
export interface EmitRegistryRow {
  /** The bound name (capability `symbolPrefix` applied) — also the registry key. */
  readonly symbol: string;
  /** Owning capability name — diagnostics ("«kernel»"-style synthetic owners allowed). */
  readonly capability: string;
  readonly kind: AEntity["kind"];
  /** The idiomatic-residual rewrite. Absent ⇒ the fallback ladder's rung 3 (shim). */
  readonly emit?: EmitRule;
  /** Law-N narrowing declaration — every harvested row's witness must itself be a
   *  harvested symbol (`assertNarrowsWitnessed`). */
  readonly narrows?: { readonly witness: string };
  /** RESOLVED — the authored value with the `"shim"` default applied. */
  readonly refPolicy: RefPolicy;
  /** Lineage role, resolved at bake — the engine's pure-region gates read it here. */
  readonly provenance?: ProvenanceRole;
  /** Cache class, authored at bake — pure-region CSE's second gate (§2.3). */
  readonly cacheClass?: CacheClass;
  /** Author-asserted TS signature (`Contract.type`) when declared. */
  readonly type?: string;
  /** Present iff `kind === "door"` — the notImplemented reason, reused verbatim so the
   *  COMPILER's door diagnostic is as specific as the interpreter's. */
  readonly doorReason?: string;
}

export interface EmitRegistry {
  /** Direct hit; `undefined` ⇒ the caller's fallback ladder proceeds to shim/door.
   *  (The generative `c[ad]+r` composition rung — depths 2-4, `cadr`/`caddr`/`cddr`/…
   *  — landed in the symbol-rules wave: `rules/phase1.ts`'s `compoundCxrRules`. This
   *  harvest itself carries no cxr-specific knowledge; the overlay resolves each
   *  compound name as an ordinary presence row, same as any other table entry.) */
  lookup(name: string): EmitRegistryRow | undefined;
  /** Every DECLARED name. */
  readonly names: ReadonlySet<string>;
}

/** A baked `symbol.*` def carries a string `kind` discriminant; `alias` never binds
 *  directly (it stands in for a sibling's already-baked def) and legacy arms (bare fn /
 *  rosetta-config / `{value}`) carry no `kind` at all — none of them can carry `.emit`. */
const isBakedEntityLike = (def: SymbolDeclaration): def is AEntity =>
  typeof def === "object" &&
  def !== null &&
  "kind" in def &&
  typeof (def as { kind: unknown }).kind === "string" &&
  (def as { kind: string }).kind !== "alias";

/** The per-entry harvest→row conversion. The compiler-facing fields are FLATTENED
 *  top-level properties on the baked def (exactly like `cacheClass`/`type` — never a
 *  `.contract` sub-object), present for native/rosetta/sequence/tagless/tagless-guard/
 *  define, simply absent for door/keyword/macro/define-syntax — "no fields on this def"
 *  reads identically to "a Contract with all three unset". */
function toRow(capability: string, symbolName: string, def: AEntity): EmitRegistryRow {
  return {
    symbol: symbolName,
    capability,
    kind: def.kind,
    emit: "emit" in def ? def.emit : undefined,
    narrows: "narrows" in def ? def.narrows : undefined,
    refPolicy: ("refPolicy" in def ? def.refPolicy : undefined) ?? "shim",
    provenance: "provenance" in def ? def.provenance : undefined,
    cacheClass: "cacheClass" in def ? def.cacheClass : undefined,
    type: "type" in def ? def.type : undefined,
    doorReason: def.kind === "door" ? def.reason : undefined,
  };
}

/** The shared cache key for every PHANTOM (activation-less) harvest — one sentinel, so a
 *  builder is invoked at most once per instance across bare-list harvests. */
const PHANTOM = Symbol("emit-registry phantom activation");

/** Per-INSTANCE builder memoization (mirrors `EnvCapability.exports()`'s own
 *  `_exportsPromise`): a re-invoked builder mints fresh closure identities each call,
 *  so re-harvesting the same instance without this would silently duplicate work and
 *  break identity-keyed callers. Keyed additionally by the ACTIVATION the record was
 *  computed against (single slot, last-write-wins): the same capability instance may be
 *  harvested through one ambient's real activation and later through a bare list's
 *  phantom — those records legitimately differ (withholding-by-absence), so a key
 *  mismatch re-invokes. Module-level so the cache holds ACROSS `emitRegistryOf` calls
 *  within one compiler process. */
const harvestCache = new WeakMap<EnvCapability, { key: unknown; rec: Record<string, SymbolDeclaration> }>();

function harvestSymbolsRec(cap: EnvCapability, activation: Activation<any, any> | undefined): Record<string, SymbolDeclaration> {
  const key: unknown = activation ?? PHANTOM;
  const hit = harvestCache.get(cap);
  if (hit !== undefined && hit.key === key) return hit.rec;
  // The builder-form `symbols` arm is RETIRED from SymbolDeclaration's own type — this
  // typeof branch survives as pure DEFENSE against a type-erased/stale-dist spec handing
  // the harvest a builder (the phantom-activation poison discipline, constitution §4.5),
  // hence the cast at this one seam.
  const rec =
    typeof cap.spec.symbols === "function"
      ? (cap.spec.symbols as unknown as (activation: unknown) => Record<string, SymbolDeclaration>)(
          activation ?? dryActivation(cap.name),
        )
      : (cap.spec.symbols ?? {});
  harvestCache.set(cap, { key, rec });
  return rec;
}

/** Law N's CI invariant (constitution §5.2): every narrows-flagged row's `witness` must
 *  itself be a harvested symbol — a narrowing proposition needs a REGISTERED runtime
 *  symbol to prove it (the schema-driven fuzzer's oracle rows exercise the witness's
 *  behavior against the claim; the fuzzer itself is a later wave — this check is the
 *  standing red-build gate, vacuously green until narrows rows land). Collect-all, one
 *  teaching throw. Runs once per harvest, after the full walk (it needs the complete
 *  name set); exported so CI can also wire it point-blank. */
export function assertNarrowsWitnessed(rows: ReadonlyMap<string, EmitRegistryRow>): void {
  const violations: string[] = [];
  for (const row of rows.values()) {
    if (row.narrows !== undefined && !rows.has(row.narrows.witness)) {
      violations.push(
        `  - "${row.symbol}" (capability "${row.capability}") names witness "${row.narrows.witness}", ` +
          `which is not a harvested symbol`,
      );
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `emitRegistryOf: Law N witness-registry check failed — a narrows-flagged symbol's witness must ` +
        `itself be a registered runtime symbol (its behavior PROVES the narrowing; constitution §5.2):\n` +
        `${violations.join("\n")}\n` +
        `Declare the witness in an assembled capability, or fix the witness name.`,
    );
  }
}

/** Harvest an emit-rule registry from an already-assembled ambient, or from a bare
 *  capability tree. Never arms a resource, never invokes an impl — a builder invocation
 *  only ever captures references (resources spawn on first symbol TOUCH, `capability.ts`'s
 *  documented lazy-spawn contract), so both paths are dry.
 *
 *  Builder-form `symbols` are invoked once per capability INSTANCE, against:
 *
 *  - the ambient's REAL activation when one is at hand (`ambient.activations`, the same
 *    per-env record `lower()` already invoked this builder with once at assembly) — this
 *    is what makes the designed activation-dependent idioms harvestable exactly when
 *    they are resolvable: `arrival/data`'s top-level `configuration.data ?? inert`
 *    value-capture, `arrival/loader`'s withholding-by-absence key set. The record is the
 *    TRUE one, not a phantom-branch guess.
 *
 *  - the phantom `dryActivation` for a bare capability list (no assembly to consult) —
 *    the loud "static by rule" door (constitution §4.5): a builder that WANTS activation
 *    state while none exists throws the teaching error instead of silently harvesting a
 *    wrong-branch record. (Component-spec deviation, deliberate: registry-emit.md
 *    phantoms UNCONDITIONALLY, but the real assembled population — data's value capture,
 *    loader's conditional `require` — proves that model unharvestable; the constitution's
 *    own law is "EMIT RULES are static", not "key sets are static", and rule STALENESS
 *    is what the phantom path still polices.) */
export function emitRegistryOf(source: readonly EnvCapability[] | AssembledAmbient): EmitRegistry {
  // `in`-narrowing, not `Array.isArray`: isArray's `any[]` guard can't subtract a
  // READONLY array from the union's else branch; the ambient's own roster field can.
  const isAmbient = "capabilities" in source;
  const capabilities: readonly EnvCapability[] = isAmbient ? source.capabilities : source;
  const activations = isAmbient ? source.activations : undefined;
  const rows = new Map<string, EmitRegistryRow>();
  const seen = new Set<EnvCapability>();
  const visit = (cap: EnvCapability): void => {
    if (seen.has(cap)) return;
    seen.add(cap);
    for (const dep of cap.spec.deps ?? []) visit(dep); // deps-first — mirrors C3 apply precedence
    const rec = harvestSymbolsRec(cap, activations?.get(cap.name));
    const prefix = cap.spec.symbolPrefix ?? "";
    for (const [name, rawDef] of Object.entries(rec)) {
      if (!isBakedEntityLike(rawDef)) continue; // legacy {fn}/{value}/alias arms — no `.emit` possible
      const bound = prefix + name;
      rows.set(bound, toRow(cap.name, bound, rawDef)); // self OVERWRITES a dep's same-name row
    }
  };
  for (const cap of capabilities) visit(cap);
  assertNarrowsWitnessed(rows);
  return { lookup: (name) => rows.get(name), names: new Set(rows.keys()) };
}

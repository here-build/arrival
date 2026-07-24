/**
 * The emit-rule registry harvest: collect `[name, Contract-facts]` rows WITHOUT
 * running the program and WITHOUT arming a single resource (constitution §4.1/§4.5;
 * registry-emit.md §"The harvest"). Two input modes:
 *
 *  - a live `EnvCapability[]` tree (a bare, ad hoc list — never assembled into a
 *    run) — a dry, deps-first DAG walk against the phantom `dryActivation`
 *    (`emitRegistryOf`'s own doc has the full contract).
 *  - a `RunContext` — the run-reader door's own query surface
 *    (`@inhuman.tools/arrival/host-internals`'s `ownerOf`): walk the run's OWN
 *    resolved `vocabulary` (BASE_ROSTER already folded, every name already
 *    linearized exactly once — no deps-graph walk needed, the run already did
 *    it), reading each bound value's Contract via `contractOf` and its owning
 *    capability via `ownerOf`.
 *
 * The bare-list mode is `exec-phases.ts`'s `rosterEntries` walk with exactly one
 * change: where that precedent returns early on a builder-form `symbols` (a
 * documented LIMIT), this harvest invokes the builder — against the phantom
 * `dryActivation` — and keeps walking. Everything else — deps-first visit order,
 * identity dedup, last-write-wins on a name clash — matches the roster walk (and
 * therefore C3 apply precedence) deliberately.
 *
 * Placement note: the component spec drafted this module inside arrival core
 * (`src/emit/registry.ts`); the constitution's §4.5 layering ("the compiler
 * HARVESTS contracts") and the wave plan land it here, in the compiler package
 * — arrival core keeps only the pure `EmitRule`/`EmitCtx`/`TypeFacts` types
 * and the Contract fields themselves.
 */
import type { EnvCapability, SymbolDeclaration } from "@inhuman.tools/arrival/capability";
import type { EmitRule, RefPolicy } from "@inhuman.tools/arrival/emit";
import { ownerOf } from "@inhuman.tools/arrival/host-internals";
import { contractOf } from "@inhuman.tools/arrival/lsp-internals";
import type { AEntity, CacheClass, ProvenanceRole } from "@inhuman.tools/arrival/symbol";
import type { RunContext } from "@inhuman.tools/arrival";

import { dryActivation } from "./dry-activation.js";

/** One harvested symbol: the Contract facts the compiler reads (registry-emit.md
 *  §"The harvest API", widened by the wave plan with `symbol`/`provenance`/`cacheClass`
 *  so the engine's optimization gates read the same row). */
export interface EmitRegistryRow {
  /** The bound name — also the registry key. */
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

/** Per-INSTANCE builder memoization (mirrors `EnvCapability.exports()`'s own
 *  `_exportsPromise`): a re-invoked builder mints fresh closure identities each call,
 *  so re-harvesting the same instance without this would silently duplicate work and
 *  break identity-keyed callers. Module-level so the cache holds ACROSS `emitRegistryOf`
 *  calls within one compiler process.
 *
 *  Single-key now (no activation axis): the real-assembly harvest mode this cache used
 *  to also key on is retired (see `emitRegistryOf`'s own doc) — every harvest is a dry
 *  one, against the phantom activation, so one capability instance has exactly one
 *  harvested record for its whole life. */
const harvestCache = new WeakMap<EnvCapability, Record<string, SymbolDeclaration>>();

function harvestSymbolsRec(cap: EnvCapability): Record<string, SymbolDeclaration> {
  const hit = harvestCache.get(cap);
  if (hit !== undefined) return hit;
  // The builder-form `symbols` arm is RETIRED from SymbolDeclaration's own type — this
  // typeof branch survives as pure DEFENSE against a type-erased/stale-dist spec handing
  // the harvest a builder (the phantom-activation poison discipline, constitution §4.5),
  // hence the cast at this one seam.
  const rec =
    typeof cap.spec.symbols === "function"
      ? (cap.spec.symbols as unknown as (activation: unknown) => Record<string, SymbolDeclaration>)(dryActivation(cap.name))
      : (cap.spec.symbols ?? {});
  harvestCache.set(cap, rec);
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

/** Synthetic owner name for a `RunContext`-mode row whose value carries no `ownerOf`
 *  attribution — should not happen in practice (every `runCtx.vocabulary` entry is
 *  capability-bound; a root-scope `define` never lands in `vocabulary` at all, per the
 *  Stage B1 split), kept only as a diagnostic fallback rather than a thrown assertion. */
const UNOWNED = "«base»";

/** Harvest an emit-rule registry from a `RunContext` — the run-reader door's own query
 *  surface (`ownerOf`, `@inhuman.tools/arrival/host-internals`): walk the run's OWN
 *  resolved `vocabulary` (`RunContext.vocabulary`, a flat, already-linearized name→value
 *  map — BASE_ROSTER included, folded in at vocabulary-build time, so `scheme/srfi-1` and
 *  the rest of the self-hosted base are ordinary rows here with no special-casing). No
 *  deps-graph walk, no dry/phantom activation branch — every value is the run's REAL
 *  bound value, so `contractOf` reads its true Contract directly. */
function harvestFromRunContext(runCtx: RunContext): EmitRegistry {
  const rows = new Map<string, EmitRegistryRow>();
  if (runCtx.vocabulary !== undefined) {
    for (const [name, value] of runCtx.vocabulary) {
      const entity = contractOf(value as SymbolDeclaration);
      if (entity === undefined) continue;
      const owner = ownerOf(value) as EnvCapability | undefined;
      rows.set(name, toRow(owner?.name ?? UNOWNED, name, entity));
    }
  }
  assertNarrowsWitnessed(rows);
  return { lookup: (name) => rows.get(name), names: new Set(rows.keys()) };
}

/** Harvest an emit-rule registry from a bare, ad hoc `EnvCapability[]` list — never
 *  assembled into a run. Never arms a resource, never invokes an impl — a builder
 *  invocation only ever captures references (resources spawn on first symbol TOUCH,
 *  `capability.ts`'s documented lazy-spawn contract), so the walk is dry.
 *
 *  Builder-form `symbols` are invoked once per capability INSTANCE, against the phantom
 *  `dryActivation` — the loud "static by rule" door (constitution §4.5): a builder that
 *  WANTS activation state throws the teaching error instead of silently harvesting a
 *  wrong-branch record. */
function harvestFromCapabilities(capabilities: readonly EnvCapability[]): EmitRegistry {
  const rows = new Map<string, EmitRegistryRow>();
  const seen = new Set<EnvCapability>();
  const visit = (cap: EnvCapability): void => {
    if (seen.has(cap)) return;
    seen.add(cap);
    for (const dep of cap.spec.deps ?? []) visit(dep); // deps-first — mirrors C3 apply precedence
    const rec = harvestSymbolsRec(cap);
    for (const [name, rawDef] of Object.entries(rec)) {
      // Stage A2 (arrival core, 2026-07-22): the symbol.* factories mint the runtime
      // A-value directly now — `contractOf` (the shared read-side seam every describe/
      // catalog/harvest reader dispatches through) pulls the AEntity CONTRACT off
      // `.contract`/`.door`, `undefined` for the legacy {fn}/{value}/alias arms (no
      // `.emit` possible either way).
      const entity = contractOf(rawDef);
      if (entity === undefined) continue;
      rows.set(name, toRow(cap.name, name, entity)); // self OVERWRITES a dep's same-name row
    }
  };
  for (const cap of capabilities) visit(cap);
  assertNarrowsWitnessed(rows);
  return { lookup: (name) => rows.get(name), names: new Set(rows.keys()) };
}

/** Harvest an emit-rule registry — dispatches on input shape (see this file's header for
 *  the two modes' full contract).
 *
 *  RETIRED: this used to also accept an already-assembled `AssembledAmbient` and harvest
 *  builder-form `symbols` against its REAL per-capability `Activation` (config value
 *  capture, resource Ref state) instead of the phantom — the shape the rework-zone
 *  guidelines retired along with `AssembledAmbient` itself. The `RunContext` mode above
 *  is its replacement, and reads TRUER than the retired mode ever did: it harvests the
 *  run's actual bound values (post-linearization), not a re-invoked builder guessing at
 *  activation state. */
/** A named type-predicate guard, not an inline `Array.isArray`/`"vocabulary" in source`
 *  check: TS's control-flow narrowing over `readonly EnvCapability[] | RunContext` only
 *  narrows the branch the check's OWN shape matches (an inline `Array.isArray` narrows
 *  the true arm but leaves the union in the false arm; an inline `"x" in source` narrows
 *  the true arm but not the false arm when the field is optional) — a declared predicate
 *  forces both arms. */
function isCapabilityList(source: readonly EnvCapability[] | RunContext): source is readonly EnvCapability[] {
  return Array.isArray(source);
}

export function emitRegistryOf(source: readonly EnvCapability[] | RunContext): EmitRegistry {
  return isCapabilityList(source) ? harvestFromCapabilities(source) : harvestFromRunContext(source);
}

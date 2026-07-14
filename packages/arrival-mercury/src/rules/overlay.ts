/**
 * withRules — the compiler-side rule OVERLAY over a harvested EmitRegistry.
 *
 * PLACEMENT (interim by design — the wave-plan ruling): Phase-1 emit rules live in a
 * compiler-side table overlaid on the harvest, NOT on arrival-core Contracts yet.
 * Phase 2's package-deal discipline (constitution §9: emit rule + lens leaf + witness +
 * oracle rows, one reviewed change per symbol) relocates the knowledge onto each
 * symbol's own Contract; this wave the core env files belong to the types track, so
 * the table keeps the two workstreams physically disjoint. `withRules` makes the
 * interim invisible to the walker: it consumes the SAME `EmitRegistry` interface
 * either way, and deleting the overlay at Phase-2 completion is a one-call removal.
 *
 * Resolution order (the overlay contract): `lookup` consults the TABLE first, then the
 * base registry; a table hit merges over the base row (rule/narrows/refPolicy from the
 * table win; provenance/cacheClass/type/capability enrichment stays the base's).
 * `names` is the union. Law N holds at this layer too: every table row's
 * `narrows.witness` must name a symbol in the UNION (the overlay twin of the harvest's
 * `assertNarrowsWitnessed`), so `narrowsMembersOf(withRules(...))` — the type-emit
 * narrowing-form grammar's key set — derives from overlay rows exactly as from
 * Contract-carried ones.
 */
import type { EmitRule, RefPolicy } from "@here.build/arrival/emit";

import type { EmitRegistry, EmitRegistryRow } from "../registry/index.js";
import type { R } from "../residual/types.js";

/** One table entry — the compiler-side stand-in for the Contract fields a Phase-2
 *  relocation moves onto the symbol's own declaration (constitution §4.1). */
export interface SymbolRule {
  /** The idiomatic-residual rewrite (`Contract.emit`'s stand-in). Optional so a
   *  prohibition-only entry (doorCategory, no rule) is expressible. */
  readonly emit?: EmitRule<R>;
  /** Law-N narrowing declaration — `witness` must name a symbol in the overlay UNION. */
  readonly narrows?: { readonly witness: string };
  /** Value-position policy; absent ⇒ the base row's, else the `"shim"` default. */
  readonly refPolicy?: RefPolicy;
  /**
   * Door-category slug seam (walker finding): the walker's `doorRowExpr` hardcodes the
   * `unsupported-form/<symbol>` category today; a prohibited symbol (e.g. `set-car!`,
   * §2.2's `prohibited-dynamics`) needs its OWN category slug for the oracle's
   * error-class comparison to be honest. This field carries that slug through to the
   * row. Deliberately applied to NOTHING yet — no Phase-1 entry sets it and the walker
   * does not read it this wave; the seam exists so the walker change is one field read,
   * not a table-shape migration.
   */
  readonly doorCategory?: string;
}

export type SymbolRuleTable = Readonly<Record<string, SymbolRule>>;

/** A harvest row widened with the overlay's door-category seam (see `SymbolRule`). */
export interface OverlayRegistryRow extends EmitRegistryRow {
  readonly doorCategory?: string;
}

/** `EmitRegistry` with the widened row visible to callers that know they hold an
 *  overlay (the walker keeps consuming plain `EmitRegistry` — covariant return). */
export interface OverlayEmitRegistry extends EmitRegistry {
  lookup(name: string): OverlayRegistryRow | undefined;
}

/**
 * Overlay `table` onto `base`. Merged rows are computed eagerly (both inputs are
 * static — the harvest memoizes per instance, the table is a module constant), so
 * `lookup` stays a bare Map hit and the Law-N witness check runs exactly once, here.
 */
export function withRules(base: EmitRegistry, table: SymbolRuleTable): OverlayEmitRegistry {
  const merged = new Map<string, OverlayRegistryRow>();
  for (const [symbol, entry] of Object.entries(table)) {
    const b = base.lookup(symbol);
    // A table entry carrying a RULE makes the symbol compilable — a door-kind base row
    // must not keep dooring it (the walker checks `kind === "door"` before rules).
    const kind: EmitRegistryRow["kind"] =
      entry.emit !== undefined && (b === undefined || b.kind === "door") ? "native" : (b?.kind ?? "native");
    merged.set(symbol, {
      symbol,
      capability: b?.capability ?? "«phase1-rules»",
      kind,
      emit: entry.emit ?? b?.emit,
      narrows: entry.narrows ?? b?.narrows,
      refPolicy: entry.refPolicy ?? b?.refPolicy ?? "shim",
      provenance: b?.provenance,
      cacheClass: b?.cacheClass,
      type: b?.type,
      doorReason: b?.doorReason,
      ...(entry.doorCategory !== undefined ? { doorCategory: entry.doorCategory } : {}),
    });
  }
  const names: ReadonlySet<string> = new Set([...base.names, ...merged.keys()]);
  // Law N at the overlay layer (constitution §5.2) — the twin of the harvest's
  // assertNarrowsWitnessed, run over the UNION name set. Collect-all, one teaching throw.
  const violations: string[] = [];
  for (const row of merged.values()) {
    if (row.narrows !== undefined && !names.has(row.narrows.witness)) {
      violations.push(`  - "${row.symbol}" names witness "${row.narrows.witness}", which is neither a table nor a base symbol`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `withRules: Law N witness check failed — a narrows-flagged rule's witness must be a registered symbol ` +
        `(its runtime behavior PROVES the narrowing; constitution §5.2):\n${violations.join("\n")}\n` +
        `Add the witness to the table or the base registry, or fix the witness name.`,
    );
  }
  return { lookup: (name) => merged.get(name) ?? base.lookup(name), names };
}

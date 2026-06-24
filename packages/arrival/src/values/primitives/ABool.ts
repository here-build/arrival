import { CLASS } from "../../well-known-symbols.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../../interop-access.js";

/**
 * Boxed boolean. Lineage: the representation-blind `fantasy-land/equals` is a
 * Fantasy Land Setoid (fantasyland/fantasy-land); the shared schemeTrue/
 * schemeFalse singletons on the empty-provenance fast path are the flyweight
 * pattern.
 */
export class ABool extends AValue {
  static [CLASS] = "boolean";
  readonly kind = "bool" as const;

  constructor(
    public readonly value: boolean,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  toString(): string {
    return this.value ? "#t" : "#f";
  }
  valueOf(): boolean {
    return this.value;
  }
  toJs(): boolean {
    return this.value;
  }
  withProvenance(p: ReadonlySet<number>): ABool {
    return new ABool(this.value, p);
  }

  // Fantasy Land Setoid: REPRESENTATION-BLIND — a boxed SchemeBool equals another SchemeBool of the
  // same value AND the same value UNBOXED (a plain JS boolean). Booleans carry no grade, so identity
  // is the truth value alone; the chain plane boxes inconsistently, so equal? meets boxed vs plain.
  // `this.value === other` matches a plain-boolean `other` and rejects non-booleans (1, "true").
  ["fantasy-land/equals"](other: unknown): boolean {
    return this.value === (other instanceof ABool ? other.value : other);
  }
}

export const schemeTrue = new ABool(true);
export const schemeFalse = new ABool(false);

// Reuse singletons on the empty-provenance fast path; allocate only when stamped.
AValue.registerBoxer("boolean", (v, p) =>
  p === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new ABool(v as boolean, p),
);

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// War story (2026-05-28 audit): SchemeBool's prototype is narrow today but
// the boundary marker still matters — the singletons `schemeTrue` and
// `schemeFalse` are heavily reused, so any future helper grafted onto
// SchemeBool.prototype reaches every Boolean-valued response from the
// inference plane. Mark now so the surface stays empty by default.
// ============================================================================
markInteropBoundary(ABool);

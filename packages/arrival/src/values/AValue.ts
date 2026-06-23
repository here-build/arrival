/**
 * Provenance lives on the value, not in a sidecar WeakMap. A WeakMap keyed by
 * object identity snaps the instant any builtin produces a fresh value
 * (`string-append`, `car`, `+`, hundreds more) — every builtin would have to
 * remember to re-stamp. On-value means a builtin can only forget to *propagate*
 * (visible: empty result-set), never to *carry*.
 *
 * Propagation algebra: `docs/spec/arrival-chain.md` §5.
 *
 * Boxer registry rather than a switch in `fromJs`: a switch would import every
 * subtype, but subtypes already import this file for `extends AValue` — cycle.
 * Registry inverts the dependency; subtypes call `registerBoxer` at module load.
 *
 * Lineage (claimed: none — see docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md §1,§11):
 * provenance-on-the-value is how-provenance — provenance as an expression/circuit
 * over operators, not a flat trace (Green, Karvounarakis & Tannen, "Provenance
 * Semirings", PODS 2007). Its dual — a demanded slice of the output induces the
 * minimal slice of the input — is Galois slicing (Perera, Acar, Cheney & Levy,
 * "Functional Programs That Explain Their Work", ICFP 2012).
 */

import invariant from "tiny-invariant";
import { markInteropBoundary } from "../interop-access.js";
import type { SeenMap } from "./structural-equal.js";

const EMPTY_PROVENANCE: ReadonlySet<number> = new Set<number>();

export type AKind =
  | "string"
  | "number"
  | "bool"
  | "pair"
  | "nil"
  | "symbol"
  | "character"
  | "procedure"
  | "object"
  | "vector"
  | "bytevector"
  | "halfbaked"
  | "lazy-seq"
  | "void";

/** Keyed by `typeof`-tag plus the two null-ish tags ("null", "undefined") — see `resolveTypeofTag`. */
type Boxer = (v: unknown, p: ReadonlySet<number>) => AValue;

const boxers = new Map<string, Boxer>();

export abstract class AValue {
  abstract readonly kind: AKind;
  readonly provenance: ReadonlySet<number>;

  protected constructor(provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    this.provenance = provenance;
  }

  /** Plain-JS representation for serialization (cache / log / HTTP). */
  abstract toJs(): unknown;

  /** AValues are immutable — provenance updates mint a new instance. */
  abstract withProvenance(p: ReadonlySet<number>): AValue;

  /**
   * Fantasy Land Setoid — structural equality, ON THE TERM. Making this abstract
   * forces EVERY subtype to own its `equal?` comparison (totality): a subtype
   * with no equals is a compile error, not a silent fall-through. `structuralEqual`
   * is the harness — it records the (this, other) co-induction pair, then dispatches
   * HERE, threading the shared `seen` so recursive terms (Pair/Vector) co-induct
   * through one visited set and mutual cycles terminate. The `seen` parameter is
   * optional: a direct `a["fantasy-land/equals"](b)` call (no harness) starts a
   * fresh walk; leaf Setoids ignore it.
   */
  abstract ["fantasy-land/equals"](other: unknown, seen?: SeenMap): boolean;

  /** Subtype modules call this at top-level. Registration order is not significant. */
  static registerBoxer(typeofTag: string, fn: Boxer): void {
    boxers.set(typeofTag, fn);
  }

  /**
   * Single JS-input membrane. Already-AValue input is returned as-is unless
   * a non-empty provenance is supplied (then `withProvenance` mints a copy);
   * the same-instance fast path is what makes this safe to call on the hot path.
   * Throws if the subtype module hasn't loaded yet — that's a programmer error,
   * not a runtime condition.
   */
  static fromJs(v: unknown, provenance: ReadonlySet<number> = EMPTY_PROVENANCE): AValue {
    if (v instanceof AValue) {
      return provenance === EMPTY_PROVENANCE || provenance === v.provenance
        ? v
        : v.withProvenance(provenance);
    }

    const tag = resolveTypeofTag(v);
    const boxer = boxers.get(tag);
    invariant(
      boxer !== undefined,
      `AValue.fromJs: no boxer registered for tag "${tag}" — subtype module not loaded`,
    );
    return boxer(v, provenance);
  }
}

/** `null` gets its own tag — JS quirk: `typeof null === "object"`. */
function resolveTypeofTag(v: unknown): string {
  switch (true) {
    case v === null:
      return "null";
    case v === undefined:
      return "undefined";
    default:
      return typeof v;
  }
}

/** Per `docs/spec/arrival-chain.md` §5.1: distinct-by-reference, forward singleton, union ≥2. */
export function unionProvenance(args: readonly AValue[]): ReadonlySet<number> {
  const distinct = new Set<ReadonlySet<number>>();
  for (const arg of args) {
    if (arg.provenance.size > 0) distinct.add(arg.provenance);
  }
  switch (true) {
    case distinct.size === 0:
      return EMPTY_PROVENANCE;
    case distinct.size === 1:
      return distinct.values().next().value!;
    default: {
      const merged = new Set<number>();
      for (const s of distinct) for (const x of s) merged.add(x);
      return merged;
    }
  }
}

export function pointProvenance(callId: number): ReadonlySet<number> {
  return new Set([callId]);
}

export { EMPTY_PROVENANCE };

// ============================================================================
// INTEROP BOUNDARY (defensive on the abstract base)
// ============================================================================
// War story (2026-05-28 audit): the symbol-to-field auto-resolution in
// `accessMember` walks the prototype chain of any object reachable from
// inference-plane scheme. Subtypes (SchemeString, Pair, …) graft methods onto their
// own prototypes — those subtypes are individually marked at their definition
// sites — but marking the abstract `AValue` base is a defensive belt: any
// future AValue subtype that forgets its own marker still inherits the
// boundary from the base prototype chain, so accidental method exposure
// degrades to "blocked" rather than "exposed."
// ============================================================================
markInteropBoundary(AValue);

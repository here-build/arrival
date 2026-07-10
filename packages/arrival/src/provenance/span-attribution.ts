/**
 * provenance/span-attribution.ts — RESERVED SURFACE for `spanAttribution(wire, ingress)`:
 * a named γ-side query (static for the TEMPLATED family, γ in general) answering
 * substring-level consumption — "which span of `wire.source` did this ingress value's
 * provenance flow through." Not a record kind, not a demand-lattice amendment: it
 * demands at the QUERY layer only, never the storage layer (no new `WireframeNode`
 * or record kind is added here or implied).
 *
 * Not yet implemented. This file reserves the name and signature so a caller has a
 * stable import to code against before the implementation lands, and reaching for
 * substring attribution today gets a teaching door (errors-as-doors) instead of a
 * missing export.
 *
 * LIMIT: an opaque JS rosetta body has no span structure to walk, so it stays
 * unattributable regardless of when this lands.
 */
import type { IngressBindings } from "./hermetic-env.js";
import type { EmittedWire } from "./wireframe/types.js";

export class SpanAttributionNotImplemented extends Error {
  constructor(readonly wire: EmittedWire) {
    super(
      `spanAttribution: substring-level consumption for the wire at ${wire.span} is not yet ` +
        "implemented. This call reserves the name/signature only: a named γ-side query, static " +
        "for the TEMPLATED family, γ in general, answering \"which span of this wire's source did " +
        "the demanded value's provenance flow through.\" An opaque JS rosetta body will remain " +
        "unattributable regardless once implemented — it has no span structure to walk.",
    );
    this.name = "SpanAttributionNotImplemented";
  }
}

/**
 * RESERVED SIGNATURE. Always throws {@link SpanAttributionNotImplemented} today: this
 * is the door, not the query.
 */
export function spanAttribution(wire: EmittedWire, ingress: IngressBindings): never {
  void ingress;
  throw new SpanAttributionNotImplemented(wire);
}

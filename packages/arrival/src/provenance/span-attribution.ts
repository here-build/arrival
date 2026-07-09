/**
 * provenance/span-attribution.ts — Q17's RESERVATION ONLY (docs/PROVENANCE-PLAN.md
 * Q17's note, citing `docs/working-proposals/inhuman-elk-over-provenance.md` §4bis):
 * the ONE promoted render capability, `spanAttribution(wire, ingress)` — a named
 * γ-side query (static for the TEMPLATED family, γ in general) answering
 * substring-level consumption: "which span of `wire.source` did this ingress
 * value's provenance flow through."
 *
 * NOT a record kind, NOT a demand-lattice amendment — docs/PROVENANCE.md §6
 * excludes further demand grades "until a consumer demands it"; the P11 render
 * window IS that consumer, demanding at the QUERY layer (this file), never the
 * storage layer (no new `WireframeNode`/record kind is added here or implied).
 * LIMIT (stated in the plan note, repeated here so it travels with the door): an
 * opaque JS rosetta body stays UNATTRIBUTABLE even once P11 lands — it has no span
 * structure this query could ever walk.
 *
 * SCOPE: this function is the DOOR only (errors-as-doors: name what was demanded,
 * why it is out of THIS window's scope, and where it is served instead — never a
 * bare "not implemented"). PROVENANCE-PLAN.md's P-track absorption map: "P11 |
 * unchanged — product track, out of this plan; gates on Q17 for drill-in" — P11 owns
 * the implementation, once it starts. Reserving the name/signature here means a
 * P11 caller has a stable import to code against before that work begins, and any
 * Q17-era caller reaching for substring attribution gets a teaching door instead of
 * a missing export.
 */
import type { IngressBindings } from "./hermetic-env.js";
import type { EmittedWire } from "./wireframe/types.js";

export class SpanAttributionNotImplemented extends Error {
  constructor(readonly wire: EmittedWire) {
    super(
      `spanAttribution: substring-level consumption for the wire at ${wire.span} is P11 product-track ` +
        "work (docs/PROVENANCE-PLAN.md Q17 note; docs/working-proposals/inhuman-elk-over-provenance.md " +
        "§4bis) — not implemented at Q17. This call reserves the name/signature only: a named γ-side " +
        "query, static for the TEMPLATED family, γ in general, answering \"which span of this wire's " +
        "source did the demanded value's provenance flow through.\" The render capability's " +
        "IMPLEMENTATION lands with P11, gated on the replay layer that already exists as of Q16/Q17 " +
        "(replay.ts/replay-walk.ts). Once implemented, an OPAQUE JS rosetta body will remain " +
        "unattributable regardless (stated LIMIT) — it has no span structure to walk.",
    );
    this.name = "SpanAttributionNotImplemented";
  }
}

/**
 * RESERVED SIGNATURE — P11 implements the body. Always throws
 * {@link SpanAttributionNotImplemented} today: this is the door, not the query.
 */
export function spanAttribution(wire: EmittedWire, ingress: IngressBindings): never {
  void ingress;
  throw new SpanAttributionNotImplemented(wire);
}

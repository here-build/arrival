/**
 * `traceToLineage` — surface the fine-grained op-sequence lineage WHOLE.
 *
 * Every other producer (statechart / flow-graph / regions / chain) builds its topology from the
 * flat `Invocation.provenance` id-sets + Pair-collapse, so the intermediate operations between a
 * producer and its consumer — the pure `pipe`/`merge` chain, the `field` lens step, the `fan`
 * source/template split, the `mux` selector∪arms branch — are never emitted. They ARE computed:
 * `classify` (arrival core) builds the `LineageNode` skeleton statically off the reader AST, and
 * the `AutoBindings` sidecar grounds its leaf/source slots to the producer point-ids the runtime
 * value carried. `carrierFieldEdges` uses exactly this pair but projects it down to field-KEY
 * strings; this producer emits the pair itself.
 *
 * A WIRE = one consumer argument's op-sequence: the `classify` skeleton for that arg plus the
 * `Bindings` that ground its slots (scoped to the consumer's invocation subtree). Nothing is
 * invented on top of the primitives — the studio renders the `LineageNode` tree directly and
 * looks up `bindings[slot]` at each leaf/source to dock the wire onto the real producer regions
 * (the same point-ids the RegionGraph nodes use), so the wires stitch into the full flow for free.
 *
 * Granularity is slot-granular through-nesting (the arg is walked into for its producers, attributed
 * to the slot the value landed in) — matching the carrier. Sub-slot attribution (which nested
 * position of one slot came from which producer) is a separate, deferred unit.
 *
 * ADDITIVE + flag-gated exactly like the carrier: no `AutoBindings` sidecar
 * (`trace.withAutoBindings()`) → an empty graph with a warning, never a throw.
 */
import { classify, slotsOf } from "@here.build/arrival";
import type { Bindings, Classifier, LineageNode } from "@here.build/arrival";

import { classifierFromTrace, operandsOf, scopedBindings, subtreeIds } from "./carrier-fields.js";
import type { EvalTrace } from "./trace.js";

/** One consumer argument's op-sequence: the static skeleton + the runtime grounding of its slots. */
export interface LineageWire {
  /** The consumer provenance-point invocation id this wire feeds into. */
  readonly consumer: number;
  /** Which argument slot of the consumer call this wire feeds (0-based). */
  readonly slot: number;
  /** The op-sequence tree from `classify` — verbatim (pipe / merge / field / fan / mux / …). */
  readonly skeleton: LineageNode;
  /** `leaf.slot` / `source.op` name → the producer point-ids it carried at THIS invocation. */
  readonly bindings: Bindings;
}

export interface LineageGraph {
  readonly wires: readonly LineageWire[];
  readonly warnings: readonly string[];
}

/**
 * The whole op-sequence lineage as a set of wires. The classifier defaults to
 * `classifierFromTrace` — the trace self-describes its sources, so nothing needs wiring in.
 */
export function traceToLineage(
  trace: EvalTrace,
  classifier: Classifier = classifierFromTrace(trace),
): LineageGraph {
  const auto = trace.autoBindings;
  if (!auto) {
    return { wires: [], warnings: ["no AutoBindings sidecar — call trace.withAutoBindings() to surface lineage"] };
  }

  const wires: LineageWire[] = [];
  for (const inv of trace.invocationLog) {
    if (!inv.isProvenancePoint) continue; // consumers are the source-points (infer / effect calls)
    const consumer = inv.id;
    const scope = subtreeIds(inv); // ground this consumer's slots only against ITS subtree's bindings
    const args = operandsOf(inv.node);
    for (let slot = 0; slot < args.length; slot++) {
      const skeleton = classify(args[slot]!, classifier);
      if (skeleton.kind === "literal") continue; // an inert arg carries no lineage to render
      const bindings = scopedBindings(auto, scope, slotsOf(skeleton));
      wires.push({ consumer, slot, skeleton, bindings });
    }
  }
  return { wires, warnings: [] };
}

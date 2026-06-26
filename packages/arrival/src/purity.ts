// PurityError — the typed error carried by a deliberately-omitted feature.
//
// arrival is PURE DATAFLOW: value-level provenance requires immutable values and
// pure evaluation, so value mutation (set-car!/vector-set!/…) and the dynamics
// (call/cc/dynamic-wind/parameterize/delay/force) are omitted by design — they
// would falsify the lineage every value carries. The capability door surface
// throws this when an omitted verb is reached; each omission lives as a
// `symbol.notImplemented` door INSIDE the pack that owns that part of the spec
// (value-mutators with their type packs; control/dynamics/laziness in
// env/r7rs/control; the §6.13/§6.14 host interface in env/r7rs/host).

import { CLASS } from "./well-known-symbols.js";
import { ArrivalError } from "./ArrivalError.js";

export class PurityError extends ArrivalError {
  static [CLASS] = "purity-error";
  public readonly owner = "owned-by/purity-invariant";
  public readonly name = "PurityError";

  constructor(
    message: string,
    /** The omitted feature, e.g. "set-cdr!" — internal routing/telemetry key. */
    public readonly feature: string,
  ) {
    super(message);
  }
}



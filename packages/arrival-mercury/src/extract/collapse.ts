/**
 * T3a — collapse-kind inference (signature freeze; the stub is SOUND).
 *
 * Decides whether a Fan's axis may collapse, by abstract interpretation of the
 * BODY's attribution over (acc, element) — §2c's two-regime rule:
 *   "combine" — the body is a recognized, const-free, arity-liftable AC
 *               combinator from the CLOSED enumerated list (+ * string-append
 *               cons) → the fan may fold to one fused node.
 *   "route"   — the body selects rather than combines (ignores acc = route-
 *               last; ignores element = route-init; min/max/filter masks) —
 *               statically all-gray, the recorded activation lights the path.
 *   "lowered" — everything else: the body's full dialect program stays, every
 *               internal choice and const visible. ALWAYS sound.
 *
 * The stub returns "lowered" unconditionally — the fail-closed default the
 * fold-collapse forge (longcat's row, fixture-corpus row 3) died against.
 * The impl agent may only ever make this MORE precise, never less sound:
 * "combine" for anything outside the enumerated closure is the one forbidden
 * answer (it erases body-internal consts from the content channel).
 *
 * NEVER read the collapse kind from the head's TYPE (max and + share one);
 * infer it from the body's attribution structure.
 */
import type { CollapseKind, StaticProv } from "../model/static-prov.js";

export function inferCollapse(body: StaticProv): CollapseKind {
  void body; // stub — T3a impl agent replaces (test-author lane writes the red suite first)
  return "lowered";
}

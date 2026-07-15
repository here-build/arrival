/**
 * T3a — collapse-kind inference (contract CORRECTED 2026-07-15; stub SOUND).
 *
 * A Fan's `collapse` says whether its axis may fold. §2c has two collapsing
 * regimes and a fail-closed default:
 *   "combine" — the fan folds to ONE fused node. Allowed ONLY when the fold's
 *               COMBINATOR is a member of the CLOSED enumerated AC list
 *               (`+ * string-append cons`) — const-free, associative,
 *               arity-liftable.
 *   "route"   — the body selects rather than combines (ignores acc = route-
 *               last; ignores element = route-init; min/max/filter masks) —
 *               statically all-gray, the recorded activation lights the path.
 *   "lowered" — everything else: the body's full dialect program stays, every
 *               internal choice and const visible. ALWAYS sound (the default
 *               the fold-collapse forge — longcat's row — died against).
 *
 * ─── THE SPLIT (why `inferCollapse` cannot decide "combine") ────────────────────
 *
 * "combine" needs the COMBINATOR'S IDENTITY, and that identity is ERASED before
 * a body-only view exists: `+`, `-`, `*` all classify to `role:"fuse"` and
 * extract to a BIT-IDENTICAL `FusedProv{sources:[acc,element]}` (verified
 * 2026-07-15). A function of the body alone therefore CANNOT tell the AC `+`
 * from the non-AC `-` — returning "combine" for the `+`-shape would return it
 * for the `-`-shape too (same input), and erase a non-associative fold's
 * structure. That is a forge.
 *
 * So the decision is split by WHERE the head still exists:
 *   - `buildFan` (arm-containers.ts) HOLDS the raw fn CoreForm. It alone decides
 *     "combine": iff the combinator is a bare closed-list AC head, or a lambda
 *     whose raw body is exactly `(ac-head acc element)` over the two params and
 *     nothing else. This is a RAW-COREFORM check against the closed list — it
 *     never trusts a `FusedProv`, which has already forgotten the operator.
 *   - `inferCollapse` (here) sees only the extracted body and decides the rest:
 *     **route vs lowered, NEVER combine.** buildFan calls it after ruling
 *     combine in or out.
 *
 * `inferCollapse` returning "combine" is therefore itself the forbidden answer.
 * The stub returns "lowered" (sound). The impl may return "route" for a body
 * that structurally ignores acc or element or is a selection mask; everything
 * else stays "lowered".
 */
import type { CollapseKind, StaticProv } from "../model/static-prov.js";

/** route | lowered ONLY — see the header split. "combine" is buildFan's call
 *  (it needs the combinator identity this body-only view has lost). */
export function inferCollapse(body: StaticProv): CollapseKind {
  void body; // stub — T3a impl replaces (returns "route" | "lowered", never "combine")
  return "lowered";
}

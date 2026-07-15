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

/** `element` — the distinguished one-of-collection projection buildFan mints
 *  for every fan body (`{kind:"mux", site:fn.id, key:null, source:collection}`).
 *  Recognized structurally by shape (`mux` + `key === null`), never by identity
 *  — inferCollapse never sees the `collection` it was minted from to compare
 *  against, only the body. */
const isElement = (p: StaticProv): boolean => p.kind === "mux" && p.key === null;

/** `acc` — "the other leaf" (header's own words): a bare, unstructured leaf
 *  that is NOT the element projection. Deliberately excludes `const`/`opaque`
 *  (and any combinator: `fused`/`build`/`string`/`choice`/`fan`, and a `mux`
 *  with a real key) — a hidden constant or an unresolved crossing standing in
 *  for "the whole body" is a fabrication-or-failure mark, never a legitimate
 *  acc-selection, and MUST stay lowered (never routed away). Only `input` and
 *  `mint` are plain evidence leaves eligible to read as "the accumulator". */
const isAccLeaf = (p: StaticProv): boolean => {
  if (isElement(p)) return false;
  return p.kind === "input" || p.kind === "mint";
};

/** route | lowered ONLY — see the header split. "combine" is buildFan's call
 *  (it needs the combinator identity this body-only view has lost).
 *
 *  "route" iff the body structurally SELECTS rather than combines:
 *    - the body IS the element leaf (ignores acc entirely — route-last), or
 *    - the body IS a bare acc-shaped leaf (ignores element entirely — route-init), or
 *    - the body is a `choice` whose EVERY alt is an element/acc leaf (a pure
 *      selection mask — min/max/last, filter survivors: §2c's "min/max/filter
 *      shape"). A single const or opaque anywhere among the alts disqualifies
 *      the whole choice back to "lowered" — a mask that could be smuggling a
 *      fabricated alternative is not statically all-gray, it is a forge.
 *
 *  Everything else — any `fused`/`build`/`string` combinator, any `mux` with a
 *  real key, any `choice` with a non-leaf or const/opaque alt, any bare
 *  `const`/`opaque` body — stays "lowered", the sound default. */
export function inferCollapse(body: StaticProv): CollapseKind {
  if (isElement(body)) return "route";
  if (isAccLeaf(body)) return "route";
  if (body.kind === "choice" && body.alts.length > 0 && body.alts.every((alt) => isElement(alt) || isAccLeaf(alt))) {
    return "route";
  }
  return "lowered";
}

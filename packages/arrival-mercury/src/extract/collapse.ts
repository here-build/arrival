/**
 * Collapse-kind inference for a Fan's `collapse` axis.
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
 *               the fold-collapse forge died against).
 *
 * ─── THE SPLIT (why `inferCollapse` cannot decide "combine") ────────────────────
 *
 * "combine" needs the COMBINATOR'S IDENTITY, and that identity is ERASED before
 * a body-only view exists: `+`, `-`, `*` all classify to `role:"fuse"` and
 * extract to a BIT-IDENTICAL `FusedProv{sources:[acc,element]}`. A function
 * of the body alone therefore CANNOT tell the AC `+`
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
import type { StaticProv } from "../model/static-prov.js";

/** `inferCollapse`'s own return alphabet — route|lowered ONLY (see header:
 *  "combine" is buildFan's call, made against the raw CoreForm before the
 *  combinator's identity is erased; a body-only view can never legitimately
 *  answer "combine"). `CollapseKind` (static-prov.ts) stays the 3-member
 *  FanProv.collapse alphabet; this narrower alias is `inferCollapse`'s own
 *  contract, checked by tsc at every call site and every return statement. */
export type InferredCollapse = "route" | "lowered";

/** Is `p` THE distinguished one-of-collection projection buildFan minted for
 *  THIS fan body — checked by OBJECT IDENTITY against the `element` buildFan
 *  actually passed in, never by shape. A shape check (`mux` + `key === null`)
 *  is not unique to this fan's element: `dispatchMux`'s generic branch mints
 *  the identical shape for ANY dynamically-keyed projection whose key isn't
 *  statically known (`max-by`'s mux entry, arm-containers.ts's `MUX_HEADS`,
 *  is exactly this — its key is always the comparator function, never a
 *  `Lit`, so `staticKeyOf` always returns `null`). A fold body that reads
 *  `(max-by keyfn other-list)` over some UNRELATED collection would shape-
 *  match this fan's own element and mislabel as route-last — the same
 *  identity-is-the-key discipline `ExtractCtx.memo` (index.ts) already uses
 *  for Bound sharing applies here for exactly the same reason. */
const isElement = (p: StaticProv, element: StaticProv): boolean => p === element;

/** Is `p` THE fold's accumulator leaf — checked by OBJECT IDENTITY against
 *  the `acc` buildFan actually bound the accumulator param to (`init`, or its
 *  missing-init opaque fallback — the SAME object reference used for both the
 *  scope binding and this comparison, never re-derived), AND `acc` must
 *  itself be a bare evidence leaf (`input`/`mint`) — never `null` for
 *  map/filter (no accumulator exists to match).
 *
 *  Identity alone is not enough here, unlike `isElement`: `element` is ALWAYS
 *  structurally a fresh `mux{key:null}` by construction (buildFan mints
 *  nothing else for it), so identity is the ONLY question worth asking. `acc`
 *  is different — it's the SEED's own attribution (`init`), which can be
 *  ANY StaticProv kind the source produces, including a bare `const` or the
 *  missing-init `opaque` fallback. A hidden constant or an unresolved
 *  crossing standing in for "the whole body" is a fabrication-or-failure
 *  mark, never a legitimate acc-selection, and MUST stay lowered even when it
 *  IS (by identity) the exact accumulator this fan bound — routing it away
 *  would still be sound in the narrow sense that `body` stays visible either
 *  way, but "route" is this design's OWN claim that nothing here needs a
 *  second look, which a fabrication/failure leaf never earns. Only `input`
 *  and `mint` are plain evidence leaves eligible to read as "the
 *  accumulator". Identity STILL does its own job on top of the kind check:
 *  it rules out an UNRELATED `input`/`mint` leaf (a stray `infer` crossing
 *  inside the body, an unrelated program input) that merely shape-matches
 *  and would otherwise be misread as "the accumulator, passed through
 *  untouched" when it is really a fresh value the body computed. */
const isAccLeaf = (p: StaticProv, acc: StaticProv | null): boolean =>
  acc !== null && p === acc && (acc.kind === "input" || acc.kind === "mint");

/** route | lowered ONLY — see the header split. "combine" is buildFan's call
 *  (it needs the combinator identity this body-only view has lost).
 *  `element`/`acc` are the ACTUAL objects buildFan minted/bound for this fan
 *  (`acc` is `null` for map/filter, which have no accumulator) — passed in
 *  rather than re-derived, so every comparison below is by identity.
 *
 *  "route" iff the body structurally SELECTS rather than combines:
 *    - the body IS the element leaf (ignores acc entirely — route-last), or
 *    - the body IS the acc leaf (ignores element entirely — route-init), or
 *    - the body is a `choice` whose EVERY alt is the element/acc leaf (a pure
 *      selection mask — min/max/last, filter survivors: §2c's "min/max/filter
 *      shape"). A single const or opaque anywhere among the alts disqualifies
 *      the whole choice back to "lowered" — a mask that could be smuggling a
 *      fabricated alternative is not statically all-gray, it is a forge.
 *
 *  Everything else — any `fused`/`build`/`string` combinator, any `mux` that
 *  isn't THIS element, any `choice` with a non-leaf or const/opaque alt, any
 *  bare `const`/`opaque` body — stays "lowered", the sound default. */
export function inferCollapse(body: StaticProv, element: StaticProv, acc: StaticProv | null): InferredCollapse {
  if (isElement(body, element)) return "route";
  if (isAccLeaf(body, acc)) return "route";
  if (
    body.kind === "choice" &&
    body.alts.length > 0 &&
    body.alts.every((alt) => isElement(alt, element) || isAccLeaf(alt, acc))
  ) {
    return "route";
  }
  return "lowered";
}

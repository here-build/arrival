/**
 * THE ORIGIN SIDE-TABLE — walker/walk.ts records WHY each Binding it mints
 * exists (a real scheme binding site, or engine glue) as it mints it;
 * census.ts reads it back while walking the FINISHED (provisional) tree.
 * WeakMap-keyed by Binding IDENTITY — never serialized, never mutated after
 * the one mint that populates it — the same "attached provenance" shape
 * NodeId side-tables use elsewhere in this package (coreform/types.ts's
 * `ClassifyResult.originAtom`).
 *
 * Kept OUTSIDE `residual/types.ts` deliberately (E1a's boundary keeps that
 * file untouched — and model-design law's own "derived, never stored"
 * reading applies doubly here: a Binding's mint origin is compile-time-only
 * bookkeeping, never a property the Residual algebra itself needs to carry).
 */
import type { Binding } from "../residual/types.js";
import type { BindingOrigin } from "./types.js";

const origins = new WeakMap<Binding, BindingOrigin>();

/** Record `binding`'s mint origin. Called exactly once per Binding, at mint
 *  time (walker/walk.ts's `declareJs`/`fresh`) — returns `binding` unchanged
 *  so call sites can wrap the mint expression directly. */
export function recordOrigin(binding: Binding, origin: BindingOrigin): Binding {
  origins.set(binding, origin);
  return binding;
}

/**
 * `undefined` for a Binding minted OUTSIDE this module's tracking — the
 * handful of raw global references (`Ref(Binding("Error"))` in walk.ts's
 * `doorThrow`, ASYNC-IFY's `Promise` binding) that are never renamed and
 * never reached as a census DECLARATION site (they occur only in Ref/value
 * position — see census.ts's header for why a site is always a declaration).
 */
export function originOf(binding: Binding): BindingOrigin | undefined {
  return origins.get(binding);
}

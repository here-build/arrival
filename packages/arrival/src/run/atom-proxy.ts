/**
 * Thin atom-proxy definition (Phase 5).
 *
 * Product law freezes MobX as the internal library of choice, accessed ONLY through
 * this surface so a same-API substitute can be dropped in later. Not a generalized
 * public FRP interface; not re-exported as product API beyond host-internals.
 *
 * See docs/working-proposals/cqs-reactivity/01-unified-design.md §8.4 / STATUS #4.
 */

/** One path-keyed reactive cell. `reportObserved` arms a dependency; `reportChanged` invalidates. */
export interface ProxyAtom {
  reportObserved(): void;
  reportChanged(): void;
}

/**
 * Factory for path-keyed atoms. Implementations (MobX, memory, test doubles) mint
 * one cell per key; callers never import the backing library at product call sites.
 */
export interface AtomProxy {
  atom(key: string): ProxyAtom;
}

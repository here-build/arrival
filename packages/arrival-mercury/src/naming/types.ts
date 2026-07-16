/**
 * NAMING — E1a's census + allocation vocabulary (engine plan §2 E1a). A global
 * census view answers "what bindings exist, and what does each want to be
 * called" (entity kind, scope shape, use-shape); one allocation phase commits
 * final names + destructure decisions via `@here.build/lexical-namer`. The
 * walker (walker/walk.ts) drives both internally — `fresh()`-at-emit and the
 * legibility pass's destructure/singularize legs dissolve into this module;
 * see ../legibility/legibility.ts's header for what stayed (pure-region CSE,
 * a genuine post-pass unaffected by this phase).
 */
import type { Binding, R } from "../residual/types.js";

/**
 * Structural role a binding site plays — the census's OWN classification
 * (computed from tree shape, not parroted from mint-time metadata: the same
 * `fresh("item")` mint site produces a "param" in one context and an
 * "element" in another, depending on where it lands — see census.ts's
 * `registerParams`). Informational primarily; the naming LADDER itself keys
 * off `BindingOrigin.mint` + the use-shape fields below, not kind directly.
 */
export type EntityKind = "function" | "value" | "param" | "element" | "accumulator";

/**
 * How a Binding was minted, recorded at mint time (walker/walk.ts's
 * `declareJs`/`fresh`) into the origin side-table (./origin.ts) and read back
 * by the census. "declared" = a real scheme binding site (a define/param/
 * let-binding — user-authored identity, `text` is the raw scheme name,
 * predicate markers intact); "fresh" = engine glue with no scheme binding of
 * its own (HOF zip params, the guarded and/or temp, eta-expansion params) —
 * `text` is the mint hint ("item", "and", "x", …), never a scheme name.
 */
export interface BindingOrigin {
  readonly mint: "declared" | "fresh";
  readonly text: string;
}

/**
 * A car/cdr-composed positional-access destructure candidate (constitution
 * §3.5's implicit destruction, ported from the now-dissolved
 * legibility/destructure.ts's `DestructureAnalysis` — identical shape,
 * computed as a CENSUS READ instead of a decide-and-rewrite pass).
 */
export interface DestructureShape {
  /** Qualifying occurrence node (by identity, over the PROVISIONAL tree
   *  census read) → its resolved tuple position. */
  readonly positions: ReadonlyMap<R, number>;
  readonly maxIndex: number;
}

export interface BindingSite {
  readonly binding: Binding;
  readonly origin: BindingOrigin;
  readonly kind: EntityKind;
  /** Present iff every occurrence of this "param"-kind binding is a car/cdr-
   *  composed positional access — the naming policy's destructure candidate.
   *  Mutually exclusive with `singularName` (destructure takes precedence,
   *  matching the dissolved legs' own ordering: a destructured param has no
   *  single remaining Binding to singularize). */
  readonly destructure?: DestructureShape;
  /** Present iff this "element"-kind (fresh-minted HOF callback) binding's
   *  receiver has a derivable singular collection name — the naming policy's
   *  singularize candidate. */
  readonly singularName?: string;
}

/**
 * One lexical scope's own binding sites, plus its nested child scopes — the
 * JS block-nesting the RENDERED code will have. Reconstructed from every
 * SURVIVING `Block`/`Arrow`/`FnDecl` node in the walked (post-splice) tree;
 * see census.ts's header for why that tree — not the raw CoreForm/scheme AST —
 * is the right granularity, and why no OTHER scope-tracking is needed.
 */
export interface ScopeCensus {
  readonly sites: readonly BindingSite[];
  readonly children: readonly ScopeCensus[];
}

export interface BindingCensus {
  readonly root: ScopeCensus;
  /** Flat identity index — every site, keyed by its Binding (allocation's
   *  entry point; also handy for tests/introspection). */
  readonly bySite: ReadonlyMap<Binding, BindingSite>;
}

/**
 * The allocation phase's output (engine plan §2 E1a item 2): binding site →
 * final name, for every NON-destructured site; a destructured param resolves
 * through `destructureOf` instead (its Param.pattern changes shape — a single
 * name doesn't apply). `positions` is carried through unchanged from the
 * census's `DestructureShape` so materialize.ts never needs the census itself.
 */
export interface NameAllocation {
  readonly nameOf: ReadonlyMap<Binding, string>;
  readonly destructureOf: ReadonlyMap<
    Binding,
    { readonly slots: readonly Binding[]; readonly positions: ReadonlyMap<R, number> }
  >;
}

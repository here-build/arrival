/**
 * PEEPHOLES — the shared vocabulary (constitution §3.1/§3.5/Law C;
 * docs/working-proposals/arrival-ts-transpiler-design.md).
 *
 * A peephole is a NAMED, structural CoreForm→CoreForm rewrite recognizing a
 * cross-node idiom the registry's per-symbol emit rules cannot express (Law A
 * forbids a rule from inspecting its own parent or a sibling's shape; Law C
 * names peepholes as the ONE sanctioned home for exactly that class of
 * rewrite). `match`/`rewrite` are deliberately split — cheap to unit test in
 * isolation (`match` alone proves what a peephole recognizes; a golden proves
 * what it produces) and cheap to read (a peephole is a fact, not a control-flow
 * blob).
 *
 * `match` takes a SINGLE node with no parent/ancestor access — the same Law-C
 * boundary `EmitCtx` enforces on registry rules (see
 * `../../../../foundations/arrival/arrival/src/emit/emit-rule.ts`'s own
 * `selfFacts` doc: "never parent-node peeking"). A peephole earns its idiom
 * recognition by matching the node's OWN shape (which may itself already be a
 * rewritten child — see index.ts's bottom-up traversal), never by walking
 * upward.
 */
import type { CoreForm, NodeId } from "../coreform/types.js";

/**
 * What a peephole's `rewrite` may do to mint new tree structure. Node ids
 * classify() produced are NEVER reused for a genuinely NEW node (a fusion of
 * two source nodes into one has no single honest identity to inherit) —
 * `mintId()` hands out ids strictly ABOVE every id classify() minted for this
 * ClassifyResult, so a facts side-table computed against the pre-peephole tree
 * can never collide with a peephole-minted id (it simply has no entry for one,
 * which is exactly Law F's "absence ⇒ conservative" contract applied to the
 * facts join). See index.ts's `maxNodeId` for how the floor is computed.
 *
 * A rewrite that only TRIMS an existing node (dropping a trailing argument,
 * say) should prefer reusing that node's OWN id/span via a spread (`{...node,
 * positionalArgs: […]}`) rather than minting — the node is still "the same
 * call", just shorter, and keeping its id lets any pre-computed fact about
 * that exact call site remain valid post-rewrite.
 */
export interface PeepholeCtx {
  /** A NodeId no classify() call for this tree ever produced and no earlier
   *  mintId() call in this same pass has returned. Monotonically increasing. */
  mintId(): NodeId;
}

export interface Peephole {
  /** Stable identity for diagnostics/golden-test naming — never surfaces in
   *  emitted output. Kebab-case, matching the constitution's own naming
   *  (`infer-scalar-fold`, `cache-key-elide`). */
  readonly name: string;
  /** Structural predicate over a single (already children-rewritten — see
   *  index.ts) node. Pure; no side effects; must not throw. `rewrite` is only
   *  ever called on a node for which `match` returned `true`. */
  match(node: CoreForm): boolean;
  /** Produce the replacement for a node `match` has already approved. May
   *  re-derive the same narrowing `match` performed (TypeScript does not
   *  carry a boolean predicate's narrowing across a separate function call) —
   *  cheap, and it keeps `rewrite` safe to call in isolation in tests without
   *  faking a driver. */
  rewrite(node: CoreForm, ctx: PeepholeCtx): CoreForm;
}

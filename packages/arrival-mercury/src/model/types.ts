/**
 * SchemeSemanticModel — the spine types (design: docs/working-proposals/
 * scheme-semantic-model.md; the provenance-first model).
 *
 * v1 is PURE — no mobx, no observability: plain memoization over an immutable
 * snapshot. The reactive layer (three epochs, ComputedWeakMap) wraps this in
 * the editor phase; nothing here may preclude it (no module-level mutable
 * state, no ambient caches keyed by anything but the model instance).
 *
 * Ontology (design §1, POST-PERTURBATION): Anchor (static site where data is
 * born/preserved/surrendered) · Chain (pure segment; interior DARK by design) ·
 * one program per chain, two algebras (value → slice, provenance → the wire
 * descriptor). There is NO carried Marker — the carrier design was retired by
 * `provenance-by-perturbation.md`: provenance is a PROBE over stored crossings,
 * never a runtime token handed along. The static wire (src/wire/) IS the
 * provenance reading; the probe (src/probe/) is its dynamic validator, attaching
 * via a run and never a model member (interior darkness). `Transfer` below is a
 * fold of the wire descriptor — same structure, chain granularity.
 */
import type { CoreForm, NodeId, Span } from "../coreform/types.js";

// ── anchors ──────────────────────────────────────────────────────────────

export type AnchorId = number & { readonly __anchorId: unique symbol };

export type AnchorKind =
  | "source" // a crossing that mints (rosetta points-by-default; provenance ≠ pure)
  | "sink" // a crossing that absorbs (order-pinned; always demanded)
  | "boundary-in" // program inputs: initial scope / source vars
  | "boundary-out"; // the program's result

export interface Anchor {
  readonly id: AnchorId;
  readonly kind: AnchorKind;
  /** The registry symbol at a crossing anchor (`infer`, `http/get`…); absent on boundaries. */
  readonly symbol?: string;
  /** The CoreForm site (absent on boundaries — they have no node). */
  readonly node?: NodeId;
  readonly span?: Span;
  /**
   * The STATIC atom name — known before any run (design §1: "each atom name
   * being known already"). A define-bound crossing takes its binding's name
   * (`response`); an anonymous one gets a stable synthesized name (`infer#2`).
   * Runtime instances bind live ids to this name, two-sided.
   */
  readonly name: string;
}

// ── chains ───────────────────────────────────────────────────────────────

export type ChainId = number & { readonly __chainId: unique symbol };

/** A port: which anchor, and which face of it the chain touches. */
export interface AnchorPort {
  readonly anchor: AnchorId;
  readonly face: "output" | "input";
  /** Input anchors may have several slots (an `infer`'s args); outputs one. */
  readonly slot?: number;
}

export interface Chain {
  readonly id: ChainId;
  /** The anchor OUTPUTS this chain consumes. */
  readonly inputs: readonly AnchorPort[];
  /** The single anchor INPUT (or boundary-out) this chain feeds. */
  readonly output: AnchorPort;
  /** The CoreForm nodes interior to this chain — dark at runtime, by law L3. */
  readonly nodes: readonly NodeId[];
}

// ── one program, two algebras ────────────────────────────────────────────

/** The chain's program: a self-contained sub-forest with the input anchors as
 *  free variables (by their static names). Runnable in either algebra. */
export interface ChainProgram {
  /** Free variables = the input anchors' static names, in `inputs` order. */
  readonly params: readonly string[];
  readonly body: readonly CoreForm[];
  /** Minimal-scheme source of the program (canonical, no polyglot — v0.2's
   *  chunk-uneval contract). `(lambda (<params>) <body>)`-shaped. */
  readonly source: string;
}

/** The provenance-algebra result, per tier (design §1: three tiers). */
export type Transfer =
  | {
      readonly tier: 1;
      /** Partial evaluation converged: output channels as pure functions of
       *  input marker sets, represented as a table over input ports. */
      readonly where: readonly AnchorPort[]; // which inputs reach the output (where-channel)
      readonly why: readonly AnchorPort[]; // control-dependence inputs (fuse; why-channel)
      /** Lens path when the where-flow is a pure projection (identity/mux):
       *  the fan×lens single-wire (`[z][:bar]`-style steps). */
      readonly lens?: readonly LensStep[];
    }
  | {
      readonly tier: 2;
      /** JOIN over alternatives, each with its guard (fuse-channel uneval). */
      readonly alternatives: readonly { readonly guard: string | null; readonly where: readonly AnchorPort[]; readonly why: readonly AnchorPort[] }[];
    }
  | {
      readonly tier: 3;
      /** Partial evaluation did not converge (computed flow): the provenance
       *  program itself, runnable live (dynamic-exact) — never a per-step
       *  value shadow (L4). */
      readonly program: ChainProgram;
    };

export type LensStep =
  | { readonly kind: "field"; readonly name: string } // mux pin
  | { readonly kind: "z" } // the fan axis
  | { readonly kind: "forward" }; // positional transparency

// ── the wire map ─────────────────────────────────────────────────────────

/** `producer→consumer` edge key: `${producerAnchor}→${consumerAnchor}#${slot}`. */
export type EdgeKey = string;

export interface WireUneval {
  /** The human-readable label: a bare lens path for identity/mux chains, or a
   *  minimal-scheme expression with anchor names free (`(:verdict (json-parse
   *  response))`). Tier-3 residue carries an explicit `⟨runtime-dispatch⟩` hole. */
  readonly label: string;
  /** The guard's uneval for tier-2 alternatives; null when unconditional. */
  readonly guard: string | null;
  readonly tier: 1 | 2 | 3;
}

// ── the demand graph (liveness = static teleology) ───────────────────────

export interface DemandGraph {
  /** Anchors reachable (reverse) from boundary-out ∪ sinks (effects pinned). */
  readonly demanded: ReadonlySet<AnchorId>;
  /** Chains on demanded paths. Everything else is shaken. */
  readonly demandedChains: ReadonlySet<ChainId>;
  /** Reverse edges: which chains demand this anchor's output. */
  dependents(anchor: AnchorId): readonly ChainId[];
}

// ── slices ───────────────────────────────────────────────────────────────

export interface RunnableSlice {
  /** The value-algebra reading of the chain program: scheme source that, run
   *  with the input anchors' recorded values bound to `params`, reproduces the
   *  chain's output value. The slice contains its own literals, so re-running
   *  it proves nothing about grounding — grounding is a PROBE (perturb +
   *  validate), never a reconstruction. This slice is the re-derivation
   *  substrate the probe perturbs, not a grounding proof itself. */
  readonly source: string;
  readonly params: readonly string[];
}

/**
 * Q8a (PROVENANCE-PLAN.md; docs/PROVENANCE.md §1 "Model") — THE PROSPECTIVE TEMPLATE
 * GRAPH's data model. One vocabulary, two layers (§2 CHOSEN: declaration kinds LOWER
 * 1:1 to graph node kinds): nodes are exactly the DESIGNATED entities of §1 —
 * membrane-crossing ports (`source`/`sink`/`transparent`), PORT-COUPLED muxes (a mux
 * whose selector cone reaches a port — a pure-selector mux collapses INTO its wire,
 * §1 A2), fan instantiation points (region hosts — ONE node from G, §3 I5), binders
 * (loop shapes; interior topology is Q8a′'s), template-refs (call sites of
 * port-reaching top-level defines — §1: "its call sites reference its template
 * subgraph"), and the program's out-port. Everything BETWEEN nodes is a WIRE: a
 * closed, lambda-lifted arrival lambda (§1 CHOSEN; execution-plan-wireframe.md §9.1),
 * serialized as re-parseable source — never a JS closure (§1 EXCLUDED: "not
 * serializable, not content-addressable, retain ambient references").
 *
 * Identity/keying: nodes and wires carry `span` = `scopeId(surface form)` — the same
 * reader-`Pair` span identity the trace keys on. Content hashes (template-hash /
 * site-hash) and ordinal-path keying are Q8b's, layered over these spans.
 */
import type { CallbackRoles } from "../../common/symbols/_bake.js";
import type { PreludeMembership } from "../prelude.js";

/** Which input of a node a wire feeds: `arg0…argN` (port/template-ref operands),
 *  `selector`/`selector0…` and `arm0…armN` (port-coupled mux), `source`/`source1…`
 *  (a fan's fanned containers), `out` (the graph egress port). */
export type WireSlot = string;

/** The node input a wire delivers into. */
export interface WireConsumer {
  readonly node: number;
  readonly slot: WireSlot;
}

/** One wire parameter's DATAFLOW referent — parallel to `EmittedWire.params`.
 *  - `slot`: program/template ingress — a free variable the run's environment (or a
 *    template's formal, or a region capture) binds; the name IS the param name.
 *  - `node`: a designated node's egress — the wire consumed a port/mux/fan/
 *    template-ref result; the surface subterm was CUT and replaced by this param. */
export type WireParam =
  | { readonly kind: "slot"; readonly name: string }
  | { readonly kind: "node"; readonly name: string; readonly node: number };

/** A wire as `unevalWire` emits it: the closed lambda (source text — Pairs-with-spans
 *  under `parse`, the tagless algebra under evaluation; the evaluator is the iso) plus
 *  its parameter list and dataflow referents. γ = `(apply wire ingress)` (§4). */
export interface EmittedWire {
  /** `(lambda (p…) body)` — re-parseable, CLOSED: FV(body) ⊆ params ∪ pure-prelude
   *  names ∪ hermetic-base names, enforced at emission (wire-locality law). */
  readonly source: string;
  readonly params: readonly string[];
  readonly paramRefs: readonly WireParam[];
  /** `scopeId` of the wire body's surface form (site identity; hashes are Q8b). */
  readonly span: string;
}

/** An emitted wire PLACED in a graph — it feeds exactly one node input. */
export interface Wire extends EmittedWire {
  readonly consumer: WireConsumer;
}

export type WireframeNode =
  /** Rosetta-in mint port — provenance is born here (§2 `source`). */
  | { readonly kind: "source"; readonly op: string; readonly span: string }
  /** Effect/output port — "a port with no egress wire" (§2 `sink`). */
  | { readonly kind: "sink"; readonly op: string; readonly span: string }
  /** Membrane crossing that neither mints nor stamps (§2 `transparent`) — still a
   *  designated crossing FACT, hence a node, though cone-inert. */
  | { readonly kind: "transparent"; readonly op: string; readonly span: string }
  /** PORT-COUPLED mux only (§1 A2): its selector cone reaches a port, so its decision
   *  is genuine runtime information (a decision record at Q11a). A pure-selector mux
   *  never becomes a node — it collapses into its wire and γ rederives it. */
  | { readonly kind: "mux"; readonly op: string; readonly span: string; readonly arms: number }
  /** Fan instantiation point = region host (§3). I5 exterior collapse: from the
   *  enclosing graph this is ONE node; `template` is the region's PRIVATE interior
   *  (the callback body's own wireframe), replayed on demand — never spliced into G. */
  | {
      readonly kind: "fan";
      readonly op: string;
      readonly span: string;
      readonly lengthPreserving: boolean;
      /** The callback body's own graph, when the callback is a lambda literal. */
      readonly template?: WireframeGraph;
      /** The lambda callback's formals — per-element ingress. A template wire's slot
       *  params beyond these are region CAPTURES (sealed at region open, §3 I2). */
      readonly elementParams?: readonly string[];
      /** Bare-symbol callback (`(map inc xs)`) — no template graph; the name. */
      readonly fnOp?: string;
      /** Q4's contract-extracted callback roles for the HOST verb, when supplied. */
      readonly callbackRoles?: CallbackRoles;
    }
  /** Loop/recursive binder (named-let / do / declared `loop` role). First landing
   *  records the designated node ONLY — backedge wiring and interior topology are
   *  Q8a′ (PROVENANCE-PLAN.md), hence `deferred`. */
  | {
      readonly kind: "binder";
      readonly op: string;
      readonly span: string;
      readonly cycles: boolean;
      readonly deferred: "Q8a′";
    }
  /** Call site of a port-reaching top-level define — references its template
   *  subgraph in `WireframeProgram.templates` by name (§1). */
  | { readonly kind: "template-ref"; readonly name: string; readonly span: string }
  /** Declared black box — quarantined escape hatch (§2). */
  | { readonly kind: "opaque"; readonly op: string; readonly span: string }
  /** The graph's egress port. NOTE deliberately absent: region FIELD-ports — §3 I5
   *  LIMIT rules field-demand at a region boundary answers by REPLAY, not by records;
   *  no per-field egress node kind exists until a workload demands one. */
  | { readonly kind: "port"; readonly direction: "out"; readonly span: string };

export interface WireframeGraph {
  readonly nodes: readonly WireframeNode[];
  readonly wires: readonly Wire[];
  /** Index of the `port{out}` node, or null when the graph has no value egress
   *  (an all-defines program, or a program whose final form is a sink — §2: a sink
   *  has no egress wire, so nothing flows to an out-port). */
  readonly egress: number | null;
}

/** A port-reaching top-level define's template subgraph (§1: wireframe material). */
export interface DefineTemplate {
  readonly params: readonly string[];
  readonly graph: WireframeGraph;
}

/** The whole-program prospective layer: prelude (pure defines, referenced BY NAME
 *  from wire bodies — §1 A3/M1), one template per port-reaching define, and the main
 *  expression's graph. */
export interface WireframeProgram {
  readonly prelude: { readonly names: ReadonlySet<string>; readonly source: string };
  readonly membership: PreludeMembership;
  readonly templates: ReadonlyMap<string, DefineTemplate>;
  readonly main: WireframeGraph;
}

/** A `let`-family scope frame the wire emitter re-wraps around a wire body — the
 *  lambda-lifting keeps the ORIGINAL binding structure (sound verbatim; minimality
 *  is a later refinement, granularity being an accepted LIMIT of §1). */
export interface WireFrame {
  readonly kind: "let" | "let*" | "letrec" | "letrec*";
  readonly entries: readonly WireFrameEntry[];
}

export interface WireFrameEntry {
  readonly name: string;
  readonly rhs: unknown;
}

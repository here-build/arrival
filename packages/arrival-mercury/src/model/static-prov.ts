/**
 * StaticProv — the attribution circuit (G1 type freeze, 2026-07-15).
 *
 * The static plane of provenance-by-perturbation: a PURE, transformation-blind
 * attribution value computed by `extract` over CoreForm — which sources reach a
 * value, never what the value is. `+` and `-` have identical attribution (`fused`);
 * `(map f v)` and `(map g v)` differ only in the body, never the fan.
 *
 * Vocabulary is the FIELD's, per the borrow decision (synthesis doc §2d):
 *   - a StaticProv is a provenance CIRCUIT (Deutch-Milo-Roy-Tannen, ICDT 2014)
 *     over an annotation alphabet of typed indeterminates (integrity classes per
 *     Biba 1977 — invention I3 of the design);
 *   - `const` = a query-introduced constant with EMPTY where-provenance
 *     (Buneman-Khanna-Tan, ICDT 2001) — THE fabrication mark. (Renamed from the
 *     design drafts' "void": that collides with Scheme's own `(void)`.)
 *   - `choice` = ⊕ with kept alternatives — c-table local conditions
 *     (Imieliński-Lipski 1984). A run's recorded outcomes are a VALUATION
 *     selecting one world; un-taken alternatives render gray. (Renamed from the
 *     drafts' "dnf": that collides with the why-channel's guard-DNF normal form.)
 *   - `fused` = ⊗ (provenance semirings, Green-Karvounarakis-Tannen, PODS 2007);
 *     `mint` = a fresh indeterminate; `mux` = where-provenance projection.
 *   - `fan` + `unwind`/`wind` = the K-side of the K⊗M aggregation semimodule
 *     (Amsterdamer-Deutch-Tannen, PODS 2011) — deliberately K-side-only
 *     (invention I4): the probe supplies the M-side dynamically.
 *
 * THE LAW (I1, extract-totality): every CoreForm lifts to a StaticProv or
 * becomes `opaque` — never mislabeled, never partial. A budget overflow anywhere
 * emits `opaque`, never a truncated circuit (a partial attribution
 * under-approximates the const-set and would forge). The adversary is the
 * program's AUTHOR: fail closed.
 *
 * Everything here is immutable; sites key back into the CoreForm walk by NodeId
 * (side-table discipline — the Roslyn rule, same as coreform/types.ts).
 */
import type { NodeId } from "../coreform/types.js";

/** The integrity class of an annotation (invention I3 — the typed alphabet).
 *  `evidence` = a recorded membrane crossing over real inputs (perturbable);
 *  `ambient`  = environment-derived, evidence-free (`(now)`, `(uuid)`) — the
 *               source of the third verdict, "ungrounded-ambient";
 *  `program-text` = written by the (adversarial) author — bottom integrity.
 *  The full 3-member alphabet: used for `InputProv`/anchor-integrity reads
 *  (`ChannelAnchor.integrity` in circuit-verdict.ts) where a `program-text`
 *  reading is a real, reachable classification. `MintProv.integrity` and the
 *  `HeadClass` mint arm use the NARROWER `MintIntegrity` below — a mint is
 *  always a real membrane crossing (`MINT_HEADS`'s registry only ever stamps
 *  `evidence`/`ambient`), so `program-text` there would be a type-level lie a
 *  registry could never actually produce. */
export type Integrity = "evidence" | "ambient" | "program-text";

/** The mint-only integrity alphabet (2-member) — see `Integrity`'s doc above
 *  for why `MintProv`/`HeadClass`'s mint arm are narrowed to this rather than
 *  the full 3-member `Integrity`: `program-text` is not a real mint class,
 *  only `MINT_HEADS` registry entries reach here, and that table only ever
 *  contains `"evidence"`/`"ambient"`. */
export type MintIntegrity = "evidence" | "ambient";

/** A program INPUT — the evidence handle a run is invoked over (a
 *  `define/overridable` parameter). Evidence-class by construction: inputs are
 *  the caller's, not the author's. */
export interface InputProv {
  readonly kind: "input";
  readonly site: NodeId;
  readonly name: string;
}

/** A membrane-crossing SITE — statically, the place where a recorded effect
 *  fires (`infer`, `read-file`, `(now)`…). The perturbation points: the probe
 *  substitutes a marked witness for this crossing's recorded output and re-runs.
 *  `closed` is the attribution of the crossing's own inputs (the prompt, the
 *  path) — recorded, but lineage-CUT: a mint is a fresh source, its inputs
 *  ground the SELECTION story, never the content. */
export interface MintProv {
  readonly kind: "mint";
  readonly site: NodeId;
  readonly head: string;
  readonly integrity: MintIntegrity; // "evidence" for recorded crossings, "ambient" for (now)/(uuid)
  readonly closed: readonly StaticProv[];
}

/** A program-text constant — empty where-provenance — THE fabrication mark.
 *  Grounding = a backward walk from the leaf reaching an evidence-class anchor
 *  WITHOUT crossing one of these in content position. */
export interface ConstProv {
  readonly kind: "const";
  readonly site: NodeId;
}

/** ⊗ — N sources, all contribute, one fused value (`+ - * string-append hash`). */
export interface FusedProv {
  readonly kind: "fused";
  readonly site: NodeId;
  readonly sources: readonly StaticProv[];
}

/** Lens projection — where-provenance: the value IS (part of) the source
 *  (`car`, `:field`, `vector-ref` with static key). `key` null = statically
 *  unknown index (still a projection, coarser). */
export interface MuxProv {
  readonly kind: "mux";
  readonly site: NodeId;
  readonly key: string | number | null;
  readonly source: StaticProv;
}

/** Container mirror — per-part attribution preserved (`cons list vector dict`). */
export interface BuildProv {
  readonly kind: "build";
  readonly site: NodeId;
  readonly ctor: "pair" | "vector" | "dict";
  readonly parts: readonly { readonly key: string | number; readonly prov: StaticProv }[];
}

/** String as ordered runs by source (byte-level-taint shape, Xu et al. 2006).
 *  Static plane knows run SOURCES and order; lengths are a runtime overlay. */
export interface StringProv {
  readonly kind: "string";
  readonly site: NodeId;
  readonly runs: readonly StaticProv[];
}

/** ⊕ with kept alternatives — `if/cond/and/or/when`. `guards` attribute the
 *  SELECTION (why this world); `alts` attribute the CONTENT (what flowed).
 *  All alternatives stay in the circuit (gray wires); the run's recorded
 *  valuation (`Chosen`, keyed by `site`) lights one solid. */
export interface ChoiceProv {
  readonly kind: "choice";
  readonly site: NodeId;
  readonly guards: readonly StaticProv[];
  readonly alts: readonly StaticProv[];
}

/** How a Fan's axis may collapse (inferred by abstract interpretation of the
 *  body over `(acc, element)` — NEVER stamped, never read from type; §2c):
 *  `combine` = enumerated, void-free, arity-liftable AC combinator (`+ *
 *  string-append cons`) → one fused node;
 *  `route`   = `choice`-under-fan (min/max/last, filter survivors) — statically
 *              all-gray, the recorded activation mask lights the path;
 *  `lowered` = everything else: the body's FULL dialect program is kept, every
 *              internal `if` a visible `choice`, every literal a visible
 *              `const` (the fold-collapse forge, longcat's row, dies here). */
export type CollapseKind = "combine" | "route" | "lowered";

/** The variable-arity aggregation boundary — `map/filter/fold` DESUGAR to this
 *  (they are not primitives; the fan zoo vanishes into unwind/wind). `site` is
 *  the axis id (`ChoiceId` for activation-keyed valuation). `body` is the
 *  attribution of ONE element's pass, over `element` (and `acc` for folds). */
export interface FanProv {
  readonly kind: "fan";
  readonly site: NodeId;
  readonly collection: StaticProv;
  readonly body: StaticProv;
  readonly collapse: CollapseKind;
}

/** Fail closed — the I1 lift target for everything unresolvable: unknown heads,
 *  unbound refs, budget overflow, arity mismatch, Door nodes. `reason` is a
 *  stable namespaced code (errors-as-doors: the code is the identity). */
export interface OpaqueProv {
  readonly kind: "opaque";
  readonly site: NodeId;
  readonly reason: string;
}

export type StaticProv =
  | InputProv
  | MintProv
  | ConstProv
  | FusedProv
  | MuxProv
  | BuildProv
  | StringProv
  | ChoiceProv
  | FanProv
  | OpaqueProv;

/** `Super` — the Fan-INTERMEDIATE: a collection lifted to all element-states at
 *  once (the z-axis, first-class) while the dialect program of a fan body is
 *  being evaluated. Internal to `extract`; never appears in a finished circuit
 *  (a finished Fan holds `body`, not a Super). */
export interface Super {
  readonly kind: "super";
  readonly axis: NodeId;
  readonly element: StaticProv;
}

/** The working value inside extract's dialect evaluation. */
export type DialectValue = StaticProv | Super;

// ── head classification (ARM-C's registry contract) ─────────────────────────────

/** What a known primitive head DOES attributionally (the per-primitive
 *  dependency calculus, DCC/Cheney-Ahmed-Acar — a CLASSIFICATION, not a
 *  semantics; transformation-blind). `fanRole` marks the collection-taking
 *  heads (`map/filter/fold/for-each`) that desugar to Fan. */
export type HeadClass =
  | { readonly role: "fuse" }
  | { readonly role: "mux"; readonly keyArg: number | "self" } // which arg names the key (`:field` heads are "self")
  | { readonly role: "build"; readonly ctor: BuildProv["ctor"] }
  | { readonly role: "string" } // string-append & friends: fuse with run-order preserved
  | { readonly role: "mint"; readonly integrity: MintIntegrity }
  | { readonly role: "fan"; readonly fanKind: "map" | "filter" | "fold" }
  | { readonly role: "choice" } // `when`/`unless`-like heads if they survive to App position
  | { readonly role: "opaque"; readonly reason: string };

export interface HeadRegistry {
  /** Total: unknown heads MUST return `{role:"opaque", reason:"unknown-head/<name>"}`,
   *  never throw, never undefined (I1). */
  classifyHead(name: string): HeadClass;
}

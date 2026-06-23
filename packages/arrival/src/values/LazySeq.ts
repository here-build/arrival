/**
 * LazySeq — a deferred-COMPUTE collection: a source plus an un-run op-chain.
 * (Working name; the real primitive is the `{pipe, refine}` algebra named in
 * HalfBaked.ts — this is the half HalfBaked doesn't yet have.)
 *
 * ── Why this, when HalfBaked already exists ──────────────────────────────────
 * HalfBaked defers the *await*: `map`/`filter` have ALREADY dispatched `fn` into
 * promise-slots; HalfBaked merely observes their settlement lazily so `length`
 * can collapse a cardinality interval early. The work is running.
 *
 * LazySeq defers the *compute*: `map`/`filter` do NOT run — they `pipe` an op
 * onto a plan. Nothing runs until `refine(observation)`, and refine runs ONLY
 * the ops the observation depends on. So `(length (map f xs))` calls `f` ZERO
 * times: length walks the plan, sees `map` preserves length, and reads the
 * source count without ever touching a value. This is "map passes through to
 * count's origin."
 *
 * ── The thesis: the demand cone IS the provenance cone ───────────────────────
 * Provenance asks, of a value: which inputs/ops did you flow from? — a backward
 * walk from value to source. Demand asks, of an observation: what must I run to
 * produce you? — also a backward walk from observation to source. Same walk.
 * `refine` computes the answer and stamps the provenance from the SAME traversal,
 * so the provenance it carries is the true minimal dependency cone — not the
 * conservative over-approximation eager evaluation pays for. Correct-minimal
 * provenance and lazy evaluation are one object, viewed from opposite ends.
 *
 * ── Soundness precondition: immutability ─────────────────────────────────────
 * A plan is only safe to defer if its source can't change underneath it.
 * arrival's purity invariant doors `vector-set!`/`set-car!`/… — in the pure
 * plane collections are immutable, which is exactly what fusion requires. The
 * mutation doors built for provenance-lineage soundness are the same constraint
 * that licenses this laziness. If a mutation door is ever reopened, this layer
 * silently unsounds — that coupling is load-bearing.
 *
 * ── Eager fallback, never a correctness requirement ──────────────────────────
 * Eager is always the semantics; LazySeq is an observationally-identical fusion.
 * Any op or observation this layer doesn't recognize falls back to materializing
 * (`refine("iterate")`) and running eager. So it ships incrementally and is
 * provable byte-identical-to-eager when disabled, like `speculate`.
 *
 * First cut covers `map`/`filter` ops and `length`/`iterate` observations — the
 * minimum that proves the thesis. Membrane-wrap-as-an-op, `ref i`, type-tag for
 * `list?`/`vector?`, and the HalfBaked-as-a-refine-policy unification are the
 * obvious next ops, deferred until the primitives that emerge here settle.
 *
 * Lineage (we claim none — see docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md):
 * demand cone = provenance cone is Galois slicing (Perera, Acar, Cheney & Levy,
 * ICFP 2012); op-chain fusion is deforestation / stream fusion (Wadler 1990;
 * Gill, Launchbury & Peyton Jones 1993; Coutts et al. 2007; Kiselyov et al.
 * 2017); the deferral rides the Fantasy Land algebra as a tagless-final encoding
 * (Carette, Kiselyov & Shan 2009); routing-provenance is how-provenance (Green,
 * Karvounarakis & Tannen, PODS 2007).
 */

import { AValue, EMPTY_PROVENANCE, pointProvenance } from "./AValue.js";
import { markInteropBoundary } from "../interop-access.js";

// Loose, like the rest of the interpreter — SchemeValue is `any` in types.ts.
type SchemeValue = any;
type Provenance = ReadonlySet<number>;

/**
 * One operation in the deferred chain. `prov` is the operation's OWN provenance
 * (the call that introduced it) — folded into the cone only when an observation
 * actually depends on this op. `lengthChanging` is the single preservation law
 * the first cut needs: does running this op alter the element count?
 *  - `map`    → false (one out per in; length/order/type preserved; value = fn)
 *  - `filter` → true  (length depends on running pred over each element)
 */
// fn/pred may be async: live LIPS lambdas always return Promises (the carrier was
// born with sync JS fns for the isolated proof). `refine` awaits them. The headline
// `(length (map f xs))` never invokes fn at all, so a pure-map length cone stays
// zero-cost regardless of async-ness — the async only materializes when an
// observation's cone genuinely reaches the fn (a filter, or iterate).
export type LazyOp =
  | {
      readonly kind: "map";
      readonly fn: (x: SchemeValue) => SchemeValue | Promise<SchemeValue>;
      readonly prov: Provenance;
    }
  | {
      readonly kind: "filter";
      readonly pred: (x: SchemeValue) => boolean | Promise<boolean>;
      readonly prov: Provenance;
    };

function isLengthChanging(op: LazyOp): boolean {
  return op.kind === "filter";
}

/** What a consumer demands of the collection. The refine fold runs only the
 *  ops this observation's cone reaches. */
export type Observation = { readonly kind: "length"; readonly callId?: number } | { readonly kind: "iterate" };

/** A refine result carries the value AND the provenance cone the fold walked —
 *  by construction the minimal dependency cone for that observation. */
export interface LengthResult {
  readonly count: number;
  readonly provenance: Provenance;
}
export interface IterateResult {
  readonly items: readonly SchemeValue[];
  readonly provenance: Provenance;
}

/** Provenance carried by a source element (0-prov for a bare JS value). */
function provOf(x: SchemeValue): Provenance {
  return x instanceof AValue ? x.provenance : EMPTY_PROVENANCE;
}

function union(...sets: readonly Provenance[]): Provenance {
  const distinct = sets.filter((s) => s.size > 0);
  if (distinct.length === 0) return EMPTY_PROVENANCE;
  if (distinct.length === 1) return distinct[0];
  const merged = new Set<number>();
  for (const s of distinct) for (const x of s) merged.add(x);
  return merged;
}

export class LazySeq extends AValue {
  readonly kind = "lazy-seq" as const;

  /**
   * @param source     materialized source elements (immutable — see header)
   * @param ops        the un-run op-chain, applied source → ops[0] → ops[1] → …
   * @param provenance COLLECTION-LEVEL provenance: the grouping fact ("these
   *                   were assembled together, in this order, by this rule").
   *                   Cheap and eager. Per-ELEMENT provenance lives on the
   *                   elements and is distributed lazily, only on materialization.
   */
  constructor(
    readonly source: readonly SchemeValue[],
    readonly ops: readonly LazyOp[] = [],
    provenance: Provenance = EMPTY_PROVENANCE,
  ) {
    super(provenance);
  }

  /** `pipe` — extend the plan. Pure, cheap, runs NOTHING. */
  pipe(op: LazyOp): LazySeq {
    return new LazySeq(this.source, [...this.ops, op], this.provenance);
  }

  map(fn: (x: SchemeValue) => SchemeValue | Promise<SchemeValue>, prov: Provenance = EMPTY_PROVENANCE): LazySeq {
    return this.pipe({ kind: "map", fn, prov });
  }

  filter(pred: (x: SchemeValue) => boolean | Promise<boolean>, prov: Provenance = EMPTY_PROVENANCE): LazySeq {
    return this.pipe({ kind: "filter", pred, prov });
  }

  /** `refine` — fold under an observation, running only what its cone reaches.
   *  Async to match the interpreter: a live op's fn/pred may return a Promise. */
  async refine(obs: Observation): Promise<LengthResult | IterateResult> {
    return obs.kind === "length" ? this.refineLength(obs.callId) : this.refineIterate();
  }

  /**
   * Length demand. The count is unchanged by every length-preserving op, so we
   * only need to run the plan up to and INCLUDING the last length-changing op
   * (a filter). Everything after it — and every map anywhere — contributes
   * nothing to the count and is never run. The cone is the union of the ops
   * actually run plus the provenance of every element those ops inspected; that
   * is the true minimal dependency set for the count.
   */
  private async refineLength(callId?: number): Promise<LengthResult> {
    const callProv = callId === undefined ? EMPTY_PROVENANCE : pointProvenance(callId);

    // Index of the last length-changing op. -1 ⇒ count is the source length and
    // NOTHING runs (the headline: `(length (map f xs))` never touches f).
    let lastChanging = -1;
    for (let k = this.ops.length - 1; k >= 0; k--) {
      if (isLengthChanging(this.ops[k])) {
        lastChanging = k;
        break;
      }
    }

    if (lastChanging === -1) {
      // Pure length: cone = the collection grouping fact ∪ this length call.
      // (Element values and every op's fn are OUTSIDE the cone — correctly.)
      // No op runs, so no await happens — zero-cost even for async fns.
      return { count: this.source.length, provenance: union(this.provenance, callProv) };
    }

    // Run ops[0..lastChanging] over the elements — a filter observes the output
    // of every preceding op, so all of them (maps included) must run; ops after
    // the last filter are length-preserving and stay un-run. Accumulate the cone
    // from the ops run and every element value inspected. Sequential await
    // preserves order and is correct for async lambdas (parallelization is a
    // later optimization, gated on a Monoid/independence proof — not the proof).
    let items: SchemeValue[] = [...this.source];
    let cone = union(this.provenance, callProv);
    for (let k = 0; k <= lastChanging; k++) {
      const op = this.ops[k];
      cone = union(cone, op.prov);
      const next: SchemeValue[] = [];
      for (const x of items) {
        cone = union(cone, provOf(x));
        if (op.kind === "map") next.push(await op.fn(x));
        else if (await op.pred(x)) next.push(x);
      }
      items = next;
    }
    return { count: items.length, provenance: cone };
  }

  /**
   * Full materialization — the egress / for-each / membrane-crossing boundary.
   * Runs the whole plan in order; this is where a map's fn finally runs. The
   * cone is everything: the grouping fact, every op, every element inspected.
   */
  private async refineIterate(): Promise<IterateResult> {
    let items: SchemeValue[] = [...this.source];
    let cone = this.provenance;
    for (const op of this.ops) {
      cone = union(cone, op.prov);
      const next: SchemeValue[] = [];
      for (const x of items) {
        cone = union(cone, provOf(x));
        if (op.kind === "map") next.push(await op.fn(x));
        else if (await op.pred(x)) next.push(x);
      }
      items = next;
    }
    return { items, provenance: cone };
  }

  /** Un-forced egress is a programmer error in production, but for host-debug
   *  the honest representation is the plan shape, not a materialized array. */
  toJs(): unknown {
    return { __lazySeq__: true, sourceLength: this.source.length, ops: this.ops.map((o) => o.kind) };
  }

  // Setoid (Fantasy Land) — IDENTITY. A LazySeq is a deferred-compute plan (a source
  // plus un-run op CLOSURES); op fns/preds are functions, structurally incomparable, so
  // there is no value equality to define. The abstract AValue Setoid forces this method;
  // identity is faithful and minimal. (`seen` unused — identity never recurses.)
  ["fantasy-land/equals"](other: unknown): boolean {
    return this === other;
  }

  withProvenance(p: Provenance): LazySeq {
    return new LazySeq(this.source, this.ops, p);
  }
}

markInteropBoundary(LazySeq);

export function is_lazy_seq(o: unknown): o is LazySeq {
  return o instanceof LazySeq;
}

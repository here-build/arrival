/**
 * AJSArray — the AValue term that re-presents a borrowed JS array as a vector inside the
 * Scheme value space. It carries the run ctx + provenance and its own tagless-final (vector)
 * algebra, so it lives here in primitives/ with the rest of the term family. Split from its
 * membrane sibling AJSObject (AJSObject.ts) so each borrowed-value wrapper is its own file.
 * See the class doc below for the implements-not-extends-AVector cycle rationale.
 *
 * IMPORT CYCLE (benign): `jsToScheme` (rosetta.ts) is a hoisted `export function` declaration
 * whose module statically imports this class — so importing it here closes a runtime import
 * cycle, safe because the wrapper methods call it only at runtime and a hoisted function binding
 * is never in TDZ.
 *
 * SANDBOX BOUNDARY (`static [INTEROP_BOUNDARY] = true`): marked like its membrane siblings so the
 * sandbox symbol-to-field walk stops at this prototype before it can reach `source` (or the
 * delegated vector / its `vec()` builder).
 */

import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { attestDeep, freshIfSingleton, isAttested } from "../attestation.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./AValue.js";
import { fromJs } from "./boxing.js";
import { AVector } from "./AVector.js";
import { printValue } from "../print.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import { type SchemeValue } from "../types.js";
// Runtime import cycle (benign — see header): a hoisted `export function` declaration,
// called only inside wrapper methods at runtime.
import { jsToScheme } from "../../rosetta.js";
import { tf } from "../tagless-final.js";

/**
 * A borrowed JS array, re-presented as a vector. It is an `AValue` (a sibling of
 * AJSObject) that *implements* the vector algebra — it does NOT inherit
 * `AVector`. Inheriting (`extends AVector`) would force the AVector class to be DEFINED
 * at this module's eval time, closing a module-init cycle
 * (AJSArray.ts → AVector → … → AJSArray.ts → `extends AVector(undefined)`). Implementing
 * by DELEGATION touches AVector only at RUNTIME (`new AVector` inside `vec()`), so the
 * binding need not exist yet when this module loads — the cycle stays benign, exactly
 * like every other function-body op-helpers↔AVector edge.
 *
 * The borrowed `source` boxes through the membrane ON DEMAND (`vec()` materializes once,
 * cached): reading `.length` or crossing back out to JS never copies the whole array. The
 * vector algebra (map / filter / reduce / sort) forwards to that materialized vector —
 * no duplicated logic.
 *
 * The Rosetta translation: a JS array IS an R7RS vector, so the membrane presents it as
 * one — `kind` is "vector". It used to answer car/cdr; a faithful vector has neither, so
 * `(car it)` now throws like `(car #(1 2 3))` — use `(vector->list it)`. `equals` stays
 * reference-identity, matching its opaque-view sibling AJSObject.
 * (`source` is kept as the borrowed reference so rosetta's `schemeToJs` crosses it back
 * out raw without materializing.)
 */
export class AJSArray extends AValue {
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "js-array";
  readonly kind = "vector" as const;

  // The borrowed source materialized into an owned vector — lazy + cached (the delegation
  // target). A plain field, NOT a #-private (the workspace's importHelpers emits a tslib
  // helper for ES #-private slots; AJSObject's entry cache is a module-level WeakMap for
  // the same reason).
  private boxedVec?: AVector;

  constructor(
    ctx: RunContext,
    readonly source: readonly unknown[],
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  // Cheap read stays lazy — `.length` (and `(vector-length it)`) never boxes the array.
  get length(): number {
    this.freezeSource();
    return this.source.length;
  }

  // Materialized element array — the vector surface the printer (and asVector) read.
  get __vector__(): readonly SchemeValue[] {
    return this.vec().__vector__;
  }

  // Crosses back OUT to JS as the RAW borrowed source (not the boxed materialization) — the
  // lazy unwrap rosetta's schemeToJs reads off `.source`.
  ["arrival/toJS"](): readonly unknown[] {
    return this.source;
  }

  valueOf(): readonly unknown[] {
    return this.source;
  }

  withProvenance(p: ReadonlySet<number>): AJSArray {
    return new AJSArray(this.ctx, this.source, p);
  }

  // ── Vector algebra — DELEGATED to the materialized vector (no duplicated logic) ──
  // Return types MIRROR AVector's concrete returns: honest + precise, never the abstract
  // `AValue` (not assignable to the `SchemeValue` union the base declares). `map` is
  // box-preserving (DR4 fix, P8 "one algebra, every carrier") — it returns a FRESH AVector,
  // same as AVector's own map; a borrowed array's map is no longer a foreign-Functor cross-out.
  ["arrival/tagless-final/map"](
    fn: (x: SchemeValue) => SchemeValue | Promise<SchemeValue>,
    runCtx?: RunContext,
  ): AVector | Promise<AVector> {
    return this.vec()[tf("map")](fn, runCtx);
  }

  ["arrival/tagless-final/filter"](
    pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx?: RunContext,
  ): Promise<AVector> {
    return this.vec()[tf("filter")](pred, runCtx);
  }

  ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx?: RunContext,
  ): Acc | Promise<Acc> {
    return this.vec()[tf("reduce")](fn, initial, runCtx);
  }

  ["arrival/tagless-final/sort"](comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): AVector {
    return this.vec()[tf("sort")](comparator, runCtx);
  }

  // Delegated so `(car borrowed-array)` still works in non-strict mode (loose-mode list-like
  // reading through the vector's own strict gate).
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    return this.vec()[tf("car")](runCtx);
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AVector {
    return this.vec()[tf("cdr")](runCtx);
  }

  // Print protocol — the same #(...) vector repr as AVector; the __vector__ getter
  // materializes the source once (cached), matching the printer's get_instances AJSArray
  // entry at quote=false.
  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Setoid — reference identity (SAME borrowed source), matching the opaque-view sibling
  // AJSObject. A borrowed foreign array is a read-only view; deep-comparing its source is
  // the deep semantics the membrane exists to avoid.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSArray && other.source === this.source;
  }

  // Element-count read straight off `source` (no materialize) — filters for elements that
  // are ALREADY AValue-boxed (a borrowed array can hold either raw JS or pre-boxed values)
  // and unions their provenance; a raw/live element carries none (post-box it'd be
  // empty-provenance).
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    this.freezeSource();
    const count = this.source.length;
    const inputs = this.source.filter((e): e is AValue => e instanceof AValue);
    if (inputs.length === 0) return count;
    const prov = unionProvenance(inputs);
    return prov.size === 0 ? count : fromJs(this.ctx, count, prov);
  }

  // Vector type-predicate — a borrowed JS array answers `(vector? x)` #t (it IS a vector).
  ["arrival/tagless-final/vector?"](): boolean {
    return true;
  }

  // Indexed access — boxes JUST element k (no full materialize), the same lazy crossing as
  // `vec()` below and the AJSObject.get sibling: `jsToScheme` carrying THIS container's
  // provenance, so `(vector-ref borrowed k)` stamps the element identically to
  // `(vector->list borrowed)` (the Option-C discipline — a raw element inherits the
  // container's lineage, an already-AValue element keeps its own). `jsToScheme` is typed
  // `any` (rosetta legacy debt) but its contract is a boxed Scheme value → annotate to the
  // honest union so the `SchemeValue` return type-checks without a cast. (`fromJS` would
  // drop provenance instead, via CONSTANT_CTX/EMPTY_PROVENANCE.)
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue {
    this.freezeSource();
    let boxed: SchemeValue = jsToScheme(this.ctx, this.source[k], {}, this.provenance);
    // Attestation inheritance (stamp site 2): the plucked element box is attested iff
    // this borrowed container is — same discipline as the provenance threading above
    // (`freshIfSingleton`: a raw boolean element surfaces as an attested clone, never
    // the shared flyweight).
    if (isAttested(this)) boxed = attestDeep(freshIfSingleton(boxed));
    return boxed;
  }

  // Freezes the borrowed source on first Scheme read so the host can't mutate it afterward —
  // prevention by construction, replacing the dev-only purity assert. Idempotent.
  // `freezeRosettaReturns: false` on the run ctx opts out (host keeps it mutable).
  private freezeSource(): void {
    if (this.ctx.freezeRosettaReturns !== false && !Object.isFrozen(this.source)) {
      Object.freeze(this.source);
    }
  }

  // Box the borrowed source into an owned AVector through the membrane, once. The vector
  // algebra above DELEGATES here — AJSArray implements the contract without inheriting it.
  // `new AVector` runs only at call time, so AVector need not be defined when THIS module
  // evaluates (the cycle-avoidance the "implements, not extends" shape buys).
  private vec(): AVector {
    this.freezeSource();
    // Box each element through jsToScheme carrying THIS borrowed container's provenance — so
    // elements inherit the crossing's lineage (parallel to AJSObject.get, which threads
    // this.provenance to its fields), and nested arrays/objects re-borrow faithfully.
    if (this.boxedVec === undefined) {
      // Attestation inheritance (stamp site 2, values/attestation.ts): the materialized
      // elements are attested iff the borrowed container is — parallel to AJSObject.get.
      // `freshIfSingleton` per element: a raw boolean boxes to the shared #t/#f flyweight
      // on the empty-provenance path, and the singletons never attest — the clone does.
      const inherit = isAttested(this);
      this.boxedVec = new AVector(
        this.ctx,
        this.source.map((v) => {
          const boxed: SchemeValue = jsToScheme(this.ctx, v, {}, this.provenance);
          return inherit ? attestDeep(freshIfSingleton(boxed)) : boxed;
        }),
        this.provenance,
      );
      if (inherit) attestDeep(this.boxedVec);
    }
    return this.boxedVec;
  }
}

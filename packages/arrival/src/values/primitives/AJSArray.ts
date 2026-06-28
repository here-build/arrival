/**
 * AJSArray — the AValue term that re-presents a borrowed JS array as a vector inside the
 * Scheme value space. It carries the run ctx + provenance and its own tagless-final (vector)
 * algebra, so it lives here in primitives/ with the rest of the term family. Split from its
 * membrane sibling AJSObject (AJSObject.ts) so each borrowed-value wrapper is its own file
 * (it was lifted out of membrane.ts in Stage B). See the class doc below for the
 * implements-not-extends-AVector cycle rationale.
 *
 * IMPORT CYCLE (benign): `fromJS` (membrane.ts) and `jsToScheme` (rosetta.ts) are hoisted
 * `export function` declarations whose modules statically import this class — so importing them
 * here closes a runtime import cycle, safe because the wrapper methods call them only at runtime
 * and a hoisted function binding is never in TDZ.
 *
 * SANDBOX BOUNDARY (`static [INTEROP_BOUNDARY] = true`): marked like its membrane siblings so the
 * sandbox symbol-to-field walk stops at this prototype before it can reach `source` (or the
 * delegated vector / its `vec()` builder).
 */

import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./AValue.js";
import { fromJs } from "./boxing.js";
import { AVector } from "./AVector.js";
import { printValue } from "../print.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import { type SchemeValue } from "../types.js";
// Runtime import cycle (benign — see header): both are hoisted `export function` declarations,
// called only inside wrapper methods at runtime.
import { jsToScheme } from "../../rosetta.js";
import { fromJS } from "../../membrane.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// (same rationale as AVector.ts / ABytevector.ts — a module-local const resolving
// the same `Symbol.for("scheme.toJS")` keeps the membrane's `export const TO_JS`
// off this value-class import graph, since `[TO_JS]()` is a computed key).
const TO_JS = Symbol.for("scheme.toJS");

/**
 * A borrowed JS array, re-presented as a vector. It is an `AValue` (a sibling of
 * AJSObject) that *implements* the vector algebra — it does NOT inherit
 * `AVector`. Inheriting (`extends AVector`) would force the AVector class to be DEFINED
 * at this module's eval time, closing a module-init cycle
 * (js-wrappers → AVector → … → js-wrappers → `extends AVector(undefined)`). Implementing
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

  // Freeze the borrowed source the FIRST time Scheme reads it, so the host can't mutate this
  // borrowed/returned value afterward — prevention by construction, replacing the dev-only purity
  // assert. Idempotent (Object.freeze no-ops when already frozen); `freezeRosettaReturns:false` in
  // the run ctx opts out (host keeps it mutable).
  private freezeSource(): void {
    if (this.ctx.freezeRosettaReturns !== false && !Object.isFrozen(this.source)) {
      Object.freeze(this.source);
    }
  }

  // Box the borrowed source into an owned AVector through the membrane, once. The vector
  // algebra below DELEGATES here — AJSArray implements the contract without inheriting it.
  // `new AVector` runs only at call time, so AVector need not be defined when THIS module
  // evaluates (the cycle-avoidance the "implements, not extends" shape buys).
  private vec(): AVector {
    this.freezeSource();
    // Box each element through jsToScheme carrying THIS borrowed container's provenance — so
    // elements inherit the crossing's lineage (parallel to AJSObject.get, which threads
    // this.provenance to its fields), and nested arrays/objects re-borrow faithfully.
    return (this.boxedVec ??= new AVector(
      this.ctx,
      this.source.map((v) => jsToScheme(this.ctx, v, {}, this.provenance)),
      this.provenance,
    ));
  }

  // Cheap read stays lazy — `.length` (and `(vector-length it)`) never boxes the array.
  get length(): number {
    this.freezeSource();
    return this.source.length;
  }

  // Materialized element array — the vector surface the printer (and asVector) read.
  get __vector__(): SchemeValue[] {
    return this.vec().__vector__;
  }

  // Crosses back OUT to JS as the RAW borrowed source (not the boxed materialization) —
  // the lazy unwrap rosetta's schemeToJs reads off `.source`.
  [TO_JS](): readonly unknown[] {
    return this.source;
  }

  toJs(): readonly unknown[] {
    return this.source;
  }

  valueOf(): readonly unknown[] {
    return this.source;
  }

  withProvenance(p: ReadonlySet<number>): AJSArray {
    return new AJSArray(this.ctx, this.source, p);
  }

  // ── Vector algebra — DELEGATED to the materialized vector (no duplicated logic) ──
  ["arrival/tagless-final/map"](
    fn: (x: unknown) => unknown | Promise<unknown>,
    runCtx?: RunContext,
  ): AValue | Promise<AValue> {
    return this.vec()["arrival/tagless-final/map"](fn, runCtx);
  }

  ["arrival/tagless-final/filter"](
    pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx?: RunContext,
  ): AValue | Promise<AValue> {
    return this.vec()["arrival/tagless-final/filter"](pred, runCtx);
  }

  ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx?: RunContext,
  ): Acc | Promise<Acc> {
    return this.vec()["arrival/tagless-final/reduce"](fn, initial, runCtx);
  }

  ["arrival/tagless-final/sort"](comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): AValue {
    return this.vec()["arrival/tagless-final/sort"](comparator, runCtx);
  }

  // car/cdr — loose-mode list-like reading of the borrowed array (strict throws via the
  // vector's gate); delegated so `(car borrowed-array)` works again in non-strict mode.
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    return this.vec()["arrival/tagless-final/car"](runCtx);
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AVector {
    return this.vec()["arrival/tagless-final/cdr"](runCtx);
  }

  // Print protocol — the same #(...) vector repr as AVector (the __vector__ getter materializes the
  // borrowed source); matches the printer's get_instances AJSArray entry at quote=false.
  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Setoid — reference identity (SAME borrowed source), matching the opaque-view sibling
  // AJSObject. A borrowed foreign array is a read-only view; deep-comparing
  // its source is the deep semantics the membrane exists to avoid.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSArray && other.source === this.source;
  }

  // Element-count carrying the borrowed elements' provenance, read straight off `source`
  // (no materialize) — over the raw source where provenance-bearing AValue elements still
  // live (post-box they'd be empty-provenance JS-natives).
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

  // Indexed access — boxes JUST element k through the membrane (no full materialize), the
  // same lazy crossing as the per-element path; `(vector-ref borrowed k)` dispatches here.
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue {
    this.freezeSource();
    return fromJS(this.source[k]);
  }
}

/**
 * JS membrane value-wrappers — the AValue terms that re-present a borrowed JS
 * object/function/array inside the Scheme value space.
 *
 * These three classes are AValue terms (they carry the run ctx + provenance and
 * their own tagless-final algebra), so they live here in primitives/ with the
 * rest of the term family (ANil/APair/AVector). They were lifted out of
 * membrane.ts in Stage B of the membrane-wrapper unification.
 *
 * IMPORT CYCLE (benign): interop-access.ts is a true LEAF (imports only an external pkg), so the
 * member-access primitives below are a clean direct import. `fromJS` (membrane.ts) and `jsToScheme`
 * (rosetta.ts) are hoisted `export function` declarations whose modules statically import these
 * wrapper classes — so importing them here closes a runtime import cycle. It is safe: the wrapper
 * methods call them only at runtime (long after every module finishes loading), and a hoisted
 * function binding is never in TDZ. Mirrors membrane.ts's own `jsToScheme` runtime-cycle import —
 * no late-bind ceremony needed (the former `setMembraneBridge` bridge is gone).
 */

import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./AValue.js";
import { fromJs } from "./boxing.js";
import { AVector } from "./AVector.js";
import { nil } from "./ANil.js";
import { printValue } from "../print.js";
import {
  accessHas,
  accessKeys,
  accessMember,
  InteropAccessError,
  INTEROP_BOUNDARY,
  NOT_FOUND,
} from "../../interop-access.js";
import { type SchemeValue } from "../types.js";
// Runtime import cycle (benign — see header): both are hoisted `export function` declarations,
// called only inside wrapper methods at runtime. Replaces the former setMembraneBridge late-bind.
import { jsToScheme } from "../../rosetta.js";
import { fromJS } from "../../membrane.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// (same rationale as AVector.ts / ABytevector.ts — a module-local const resolving
// the same `Symbol.for("scheme.toJS")` keeps the membrane's `export const TO_JS`
// off this value-class import graph, since `[TO_JS]()` is a computed key).
const TO_JS = Symbol.for("scheme.toJS");

// ============================================================================
// WRAPPER LAYER: General JS↔Scheme Value Crossing
// ============================================================================

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

/**
 * Module-level entry cache keyed by wrapper identity. WeakMap rather than an
 * instance field for two reasons: (1) true encapsulation — the Map never
 * appears on the wrapper's own properties so sandbox symbol-to-field auto-
 * resolution can't reach it; (2) the tslib-helper avoidance the workspace
 * `importHelpers: true` triggers on TS6 `#`-private slots in this build.
 * GC-correct: cache entry disappears with the wrapper.
 */
const entryCaches = new WeakMap<AJSObject, Map<string, AValue>>();

/**
 * Thin wrapper for JS objects. Lazy property access — entries box on
 * demand through `jsToScheme` (rosetta.ts), carrying the wrapper's provenance.
 *
 * All property access is sandboxed - see interop-access.ts for security model.
 *
 * War story (Option C — 2026-05-28): `get(key)` used to call `fromJS(result)`,
 * which passed JS primitives through unboxed and threw away any chance of
 * the entry carrying the container's provenance. With the rosetta deep-stamp
 * (jsToScheme passes provenance into every constructed AValue), the wrapper's
 * own surface needs the same discipline: entries must box through the boxer
 * registry stamped with `this.provenance`, so `(@ obj :x)` on a wrapper that
 * came from an `(infer …)` result carries infer's id at the access point,
 * not just at the container level. Identity stability is preserved via the
 * module-level cache: the same `.get("x")` twice returns the same AValue, so
 * `(eq? (@ obj :x) (@ obj :x))` holds.
 */
export class AJSObject extends AValue {
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "js-object";
  readonly kind = "object" as const;

  constructor(
    ctx: RunContext,
    readonly source: object,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  // Freeze the borrowed source the FIRST time Scheme reads it (parallel to AJSArray.freezeSource) —
  // prevention by construction, replacing the dev-only purity assert. Idempotent;
  // `freezeRosettaReturns:false` in the run ctx opts out (host keeps it mutable).
  private freezeSource(): void {
    if (this.ctx.freezeRosettaReturns !== false && !Object.isFrozen(this.source)) {
      Object.freeze(this.source);
    }
  }

  /** Unwrap to original JS object (TO_JS protocol). */
  [TO_JS](): object {
    return this.source;
  }

  toJs(): Record<string, unknown> {
    return this.source as Record<string, unknown>;
  }

  withProvenance(p: ReadonlySet<number>): AJSObject {
    // New wrapper = new identity = empty cache. Provenance-variant entries
    // would otherwise leak between wrappers; cleaner to let each lineage
    // build its own cache the first time it's queried.
    return new AJSObject(this.ctx, this.source, p);
  }

  /**
   * Read a property as a security-validated, provenanced, cached AValue.
   * Single dispatch point for `dict-ref` / `@` / `:key` consumers — they
   * route here, getting boundary checks + provenance flow + identity
   * stability (`(eq? (@ obj :x) (@ obj :x))` returns #t because the cached
   * AValue is reused).
   *
   * Missing key returns `nil` (matches dict-ref's existing semantics).
   * `accessMember` filters the boundary; `NOT_FOUND` → either blocked
   * or absent — same `nil` from this surface either way.
   *
   * Cycle protection lives in `jsToScheme`'s WeakSet: if `source` participates
   * in a JS-side cycle that surfaces through a property access, the inner
   * traversal terminates before re-entering this wrapper.
   */
  get(key: string | symbol): SchemeValue {
    this.freezeSource();
    // Cache keyed by stringified key — symbol keys are an edge case (the
    // sandbox boundary blocks most symbol access anyway) and skipping the
    // cache for them keeps the Map<string, AValue> shape clean.
    const cacheKey = typeof key === "string" ? key : undefined;
    let cache = cacheKey !== undefined ? entryCaches.get(this) : undefined;
    if (cacheKey !== undefined && cache !== undefined) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    let raw: unknown;
    try {
      raw = accessMember(this.source, key);
    } catch (e) {
      // Boundary violations (Object.prototype methods, dangerous names,
      // boundary-marked prototypes) collapse to `nil` — same shape as
      // "absent." Spec §5.3 says `(@ obj "key")` returns the value at key
      // or nil; the wrapper doesn't expose error detail to the sandbox.
      if (e instanceof InteropAccessError) return nil;
      throw e;
    }
    if (raw === NOT_FOUND) return nil;

    // A function-valued property is a foreign method. It used to vanish to `nil` (invisible);
    // now it falls through to jsToScheme, which materializes it to #void + a membrane warning —
    // the violation is VISIBLE, and #void is not callable so the sandbox still cannot invoke
    // foreign JS. (The generalized rosetta narrowing: a borrowed JS function is not a portable
    // Scheme value. Getter/accessor reads are unaffected — `accessMember` already invoked the
    // getter to a value above, so only an actual function RESULT lands here.)

    // Box through jsToScheme so primitives become AValue subtypes stamped with
    // this wrapper's provenance. SchemeJSObject's instance was constructed
    // through rosetta deep-stamping for the common case (jsToScheme reached
    // here on the way down); direct construction with empty provenance keeps
    // the empty-provenance fast-path everywhere.
    const boxed = jsToScheme(this.ctx, raw, {}, this.provenance);
    if (cacheKey !== undefined && boxed instanceof AValue) {
      if (cache === undefined) {
        cache = new Map();
        entryCaches.set(this, cache);
      }
      cache.set(cacheKey, boxed);
    }
    return boxed;
  }

  /**
   * Set property value, unwrapping through membrane. Cache invalidation for
   * the touched key keeps subsequent `.get(key)` consistent with the new
   * underlying value.
   */
  set(key: string | symbol, _value: SchemeValue): void {
    // Writes are banned. arrival is a pure-dataflow sandbox — mutating the
    // foreign peer is not dataflow, and the membrane exposes a read-only view
    // by design. (Silent no-op is worse than throwing: the program would
    // believe it wrote.)
    throw new InteropAccessError(
      "Cannot assign to a foreign object — writes are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  /**
   * Check if property exists (sandboxed - only own + safe inherited).
   * Returns false for blocked properties and boundary-protected inherited props.
   */
  has(key: string | symbol): boolean {
    this.freezeSource();
    return accessHas(this.source, key);
  }

  /**
   * Delete a property (sandboxed - only own properties).
   */
  delete(key: string | symbol): boolean {
    // Deletion is a mutation — banned for the same reason as `set` (pure
    // dataflow, read-only membrane).
    throw new InteropAccessError(
      "Cannot delete from a foreign object — mutations are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  /** Get own enumerable property keys (never includes inherited). */
  keys(): string[] {
    this.freezeSource();
    return accessKeys(this.source);
  }

  // Setoid (Fantasy Land) — two wrappers are `equal?` iff they wrap the SAME source
  // (reference identity). A SchemeJSObject is a transparent, read-only view over an
  // OPAQUE foreign object; deep-comparing the source is the "deep semantics" the membrane
  // exists to avoid (foreign getters/cycles). The abstract AValue Setoid forces this; the
  // reference compare is the faithful minimal choice and preserves pre-B2 equal? behavior.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSObject && this.source === other.source;
  }

  toString(): string {
    return "#<js-object>";
  }

  // Print protocol — opaque foreign-object tag (matches both toString and the printer's CLASS-name
  // path, which resolves AJSObject's static [CLASS] = "js-object" to `#<js-object>`).
  ["arrival/print"](): string {
    return this.toString();
  }

  valueOf(): object {
    return this.source;
  }
}

// ============================================================================
// SANDBOX BOUNDARIES — SchemeJSObject
// ============================================================================
// War story (2026-05-28 audit): this wrapper is explicitly the JS↔Scheme
// membrane — every JS object crossing into the sandbox becomes one. Its own
// `get/set/has/delete/keys` already route through `accessMember` for the
// WRAPPED value, but the WRAPPER's prototype itself is reachable via
// symbol-to-field auto-resolution. Without a boundary marker, sandbox code
// could read the wrapper's `get` or `toString` to reach the underlying
// `source` Object. Marking the wrapper class ensures the prototype chain
// stops here — only own sandbox-safe properties on the wrapped value flow
// through. (The borrowed-function wrapper that once lived alongside it is
// retired: a borrowed JS function crosses the membrane as #void, never a
// callable — so there is no `apply`/`call` escape shape left to fence.)
// ============================================================================
// AJSArray wraps a borrowed foreign array (`source`) — mark it like its membrane
// siblings so the sandbox symbol-to-field walk stops at this prototype before it can
// reach `source` (or the delegated vector / its `vec()` builder).

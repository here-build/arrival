/**
 * JS membrane value-wrappers — the AValue terms that re-present a borrowed JS
 * object/function/array inside the Scheme value space.
 *
 * These three classes are AValue terms (they carry the run ctx + provenance and
 * their own tagless-final algebra), so they live here in primitives/ with the
 * rest of the term family (ANil/APair/AVector). They were lifted out of
 * membrane.ts in Stage B of the membrane-wrapper unification.
 *
 * CYCLE-BREAK (the reason this file is not a trivial move):
 *   - interop-access.ts is a true LEAF (imports only an external pkg), so the
 *     member-access primitives are imported DIRECTLY below — no cycle.
 *   - fromJS/toJS live in membrane.ts and jsToScheme lives in rosetta.ts. Both
 *     of those modules statically import these wrapper classes, so importing
 *     them HERE would close a module-eval cycle. Instead they are LATE-BOUND:
 *     membrane.ts calls `setMembraneBridge({ fromJS, toJS, jsToScheme })` at its
 *     module init (after fromJS is defined and jsToScheme is imported from
 *     rosetta). The wrapper methods below only run at runtime — long after every
 *     module has finished loading — so the bridge is always populated by the
 *     time they fire. This mirrors the `setPairConstructor` late-bind in ANil.ts.
 */

import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./AValue.js";
import { fromJs } from "./boxing.js";
import { AVector } from "./AVector.js";
import { nil } from "./ANil.js";
import {
  accessHas,
  accessKeys,
  accessMember,
  InteropAccessError,
  markInteropBoundary,
  NOT_FOUND,
} from "../../interop-access.js";
import { type SchemeValue } from "../types.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// (same rationale as AVector.ts / ABytevector.ts — a module-local const resolving
// the same `Symbol.for("scheme.toJS")` keeps the membrane's `export const TO_JS`
// off this value-class import graph, since `[TO_JS]()` is a computed key).
const TO_JS = Symbol.for("scheme.toJS");

// ============================================================================
// Late-bound membrane bridge
// ============================================================================
//
// fromJS/toJS (membrane.ts) and jsToScheme (rosetta.ts) all statically import
// these wrapper classes, so they cannot be imported here without a module-eval
// cycle. membrane.ts populates this bridge at its module init (see
// setMembraneBridge call there); wrapper methods read it only at runtime.

interface MembraneBridge {
  fromJS(value: unknown): SchemeValue;
  toJS(value: unknown): unknown;
  jsToScheme(
    ctx: RunContext,
    value: unknown,
    options: Record<string, unknown>,
    provenance: ReadonlySet<number>,
  ): SchemeValue;
}

let membraneBridge: MembraneBridge | undefined;

/** Wire the membrane↔rosetta functions into the wrappers (called by membrane.ts at init). */
export function setMembraneBridge(bridge: MembraneBridge): void {
  membraneBridge = bridge;
}

function bridge(): MembraneBridge {
  // Defensive: the bridge is set at membrane.ts module init, long before any
  // wrapper method can run. An undefined bridge here means membrane.ts never
  // loaded — a programmer error (a wrapper reached without the membrane), not a
  // runtime condition.
  if (membraneBridge === undefined) {
    throw new Error(
      "js-wrappers: membrane bridge not set — membrane.ts must call setMembraneBridge() at module init before any wrapper method runs",
    );
  }
  return membraneBridge;
}

// ============================================================================
// WRAPPER LAYER: General JS↔Scheme Value Crossing
// ============================================================================

/**
 * A borrowed JS array, re-presented as a vector. It is an `AValue` (a sibling of
 * AJSObject / AJSFunction) that *implements* the vector algebra — it does NOT inherit
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
 * reference-identity, matching its opaque-view siblings AJSObject / AJSFunction.
 * (`source` is kept as the borrowed reference so rosetta's `schemeToJs` crosses it back
 * out raw without materializing.)
 */
export class AJSArray extends AValue {
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

  // Box the borrowed source into an owned AVector through the membrane, once. The vector
  // algebra below DELEGATES here — AJSArray implements the contract without inheriting it.
  // `new AVector` runs only at call time, so AVector need not be defined when THIS module
  // evaluates (the cycle-avoidance the "implements, not extends" shape buys).
  private vec(): AVector {
    return (this.boxedVec ??= new AVector(this.ctx, this.source.map((v) => bridge().fromJS(v)), this.provenance));
  }

  // Cheap read stays lazy — `.length` (and `(vector-length it)`) never boxes the array.
  get length(): number {
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

  // Setoid — reference identity (SAME borrowed source), matching the opaque-view siblings
  // AJSObject / AJSFunction. A borrowed foreign array is a read-only view; deep-comparing
  // its source is the deep semantics the membrane exists to avoid.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSArray && other.source === this.source;
  }

  // Element-count carrying the borrowed elements' provenance, read straight off `source`
  // (no materialize) — over the raw source where provenance-bearing AValue elements still
  // live (post-box they'd be empty-provenance JS-natives).
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
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
    return bridge().fromJS(this.source[k]);
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
  static [CLASS] = "js-object";
  readonly kind = "object" as const;

  constructor(
    ctx: RunContext,
    readonly source: object,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
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

    // Method-call ban: a function-valued property IS a method. The pure-dataflow
    // sandbox has no representation for a foreign invocation, and returning a
    // callable would let Scheme escape into uncontrolled JS — so methods are
    // invisible (same `nil` as absent). Getter/accessor reads are unaffected:
    // `accessMember` (via `Reflect.get`) has already INVOKED the getter to a
    // value above, so a getter that yields data passes through here; only an
    // actual function result (a method, or the rare getter-returns-a-function)
    // is blocked.
    if (typeof raw === "function") return nil;

    // Box through jsToScheme so primitives become AValue subtypes stamped with
    // this wrapper's provenance. SchemeJSObject's instance was constructed
    // through rosetta deep-stamping for the common case (jsToScheme reached
    // here on the way down); direct construction with empty provenance keeps
    // the empty-provenance fast-path everywhere.
    const boxed = bridge().jsToScheme(this.ctx, raw, {}, this.provenance);
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

  valueOf(): object {
    return this.source;
  }
}

/**
 * Wrapper for JS functions. Handles boundary crossing on invocation.
 */
export class AJSFunction extends AValue {
  static [CLASS] = "js-function";
  readonly kind = "procedure" as const;

  constructor(
    ctx: RunContext,
    readonly source: (...args: unknown[]) => unknown,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  /** Unwrap to original JS function (TO_JS protocol). */
  [TO_JS](): (...args: unknown[]) => unknown {
    return this.source;
  }

  /** Procedures are not serializable. */
  toJs(): never {
    throw new Error("SchemeJSFunction: not serializable");
  }

  withProvenance(p: ReadonlySet<number>): AJSFunction {
    return new AJSFunction(this.ctx, this.source, p);
  }

  /** Invoke the wrapped function with Scheme values. */
  apply(thisArg: unknown, args: SchemeValue[]): SchemeValue {
    const b = bridge();
    const jsThis = b.toJS(thisArg);
    const jsArgs = args.map(b.toJS);
    const result = this.source.apply(jsThis, jsArgs);
    return b.fromJS(result);
  }

  /** Call with no this binding. */
  call(...args: SchemeValue[]): SchemeValue {
    return this.apply(undefined, args);
  }

  // Setoid (Fantasy Land) — two wrappers are `equal?` iff they wrap the SAME function
  // (reference identity); functions have no structural equality. The abstract AValue
  // Setoid forces this; reference compare is faithful, minimal, and matches pre-B2 equal?.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSFunction && this.source === other.source;
  }

  toString(): string {
    return `#<js-function ${this.source.name || "anonymous"}>`;
  }

  valueOf(): (...args: unknown[]) => unknown {
    return this.source;
  }
}

// ============================================================================
// SANDBOX BOUNDARIES — SchemeJSObject, SchemeJSFunction
// ============================================================================
// War story (2026-05-28 audit): these two wrappers are explicitly the
// JS↔Scheme membrane — every JS value crossing into the sandbox becomes one
// of them. Their own `get/set/has/delete/keys` already route through
// `accessMember` for the WRAPPED value, but the WRAPPER's prototype
// itself is reachable via symbol-to-field auto-resolution. Without a boundary
// marker, sandbox code could read the wrapper's `apply`, `call`, or
// `toString` to reach the underlying `source` Function or Object. (`apply`
// taking the wrapped source and running it with sandbox-controlled args is
// the canonical escape shape.) Marking the wrapper classes ensures the
// prototype chain stops here — only own sandbox-safe properties on the
// wrapped value flow through.
// ============================================================================
markInteropBoundary(AJSObject);
markInteropBoundary(AJSFunction);
// AJSArray wraps a borrowed foreign array (`source`) — mark it like its membrane
// siblings so the sandbox symbol-to-field walk stops at this prototype before it can
// reach `source` (or the delegated vector / its `vec()` builder).
markInteropBoundary(AJSArray);

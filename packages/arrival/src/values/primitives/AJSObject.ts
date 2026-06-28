/**
 * AJSObject — the AValue term that re-presents a borrowed JS object as a thin, read-only
 * view inside the Scheme value space. It carries the run ctx + provenance and its own
 * tagless-final algebra, so it lives here in primitives/ with the rest of the term family
 * (ANil/APair/AVector). Split from its membrane sibling AJSArray (AJSArray.ts) so each
 * borrowed-value wrapper is its own file (it was lifted out of membrane.ts in Stage B).
 *
 * IMPORT CYCLE (benign): `jsToScheme` (rosetta.ts) statically imports this class, so importing
 * it here closes a runtime import cycle — safe because `get()` calls it only at runtime (long
 * after every module loads) and a hoisted `export function` binding is never in TDZ.
 * interop-access.ts is a true LEAF, so its member-access primitives are a clean direct import.
 *
 * SANDBOX BOUNDARY (`static [INTEROP_BOUNDARY] = true`): this wrapper IS the JS↔Scheme membrane —
 * every JS object crossing into the sandbox becomes one. get/set/has/delete/keys route through
 * accessMember for the WRAPPED value, but the WRAPPER's own prototype is reachable via
 * symbol-to-field auto-resolution; the boundary marker stops the prototype walk here so sandbox
 * code can't read `get`/`toString` to reach the underlying `source`.
 */

import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { nil } from "./ANil.js";
import {
  accessHas,
  accessKeys,
  accessMember,
  InteropAccessError,
  INTEROP_BOUNDARY,
  NOT_FOUND,
} from "../../interop-access.js";
import { type SchemeValue } from "../types.js";
// Runtime import cycle (benign — see header): jsToScheme is a hoisted `export function`,
// called only inside get() at runtime.
import { jsToScheme } from "../../rosetta.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// (same rationale as AVector.ts / ABytevector.ts — a module-local const resolving
// the same `Symbol.for("scheme.toJS")` keeps the membrane's `export const TO_JS`
// off this value-class import graph, since `[TO_JS]()` is a computed key).
const TO_JS = Symbol.for("scheme.toJS");

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

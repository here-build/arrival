/**
 * AJSObject — thin, read-only view of a borrowed JS object inside the Scheme value space.
 * Own file (split from AJSArray) since each borrowed-value wrapper carries its own
 * tagless-final algebra alongside the rest of the term family (ANil/APair/AVector).
 *
 * IMPORT CYCLE (benign): `jsToScheme` (rosetta.ts) statically imports this class, closing a
 * runtime import cycle — safe because `get()` calls it only at runtime, and a hoisted
 * `export function` binding is never in TDZ. interop-access.ts is a true leaf, imported directly.
 *
 * INTEROP BOUNDARY: this wrapper IS the JS↔Scheme membrane. get/set/has/delete/keys route
 * through accessMember for the WRAPPED value, but the wrapper's own prototype is reachable
 * via symbol-to-field auto-resolution; the arrival-family rule in interop-access.ts (own
 * `[CLASS]` brand on the constructor = boundary) stops the prototype walk here so sandbox
 * code can't read `get`/`toString` to reach `source`.
 */

import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { nil } from "./ANil.js";
import { accessHas, accessKeys, accessMember, NOT_FOUND } from "../../interop-access.js";
import { InteropAccessError } from "../../errors.js";
import { attestDeep, freshIfSingleton, isAttested } from "../attestation.js";
import { type SchemeValue } from "../types.js"; // Runtime import cycle (benign — see header): jsToScheme is a hoisted `export function`,
// called only inside get() at runtime.
import { jsToScheme } from "../../rosetta.js";

/**
 * Entry cache keyed by wrapper identity. WeakMap, not an instance field: keeps the cache off
 * the wrapper's own properties (sandbox symbol-to-field resolution can't reach it) and avoids
 * the tslib helper this workspace's `importHelpers: true` needs for TS `#`-private slots.
 * GC-correct — cache entry disappears with the wrapper.
 */
const entryCaches = new WeakMap<AJSObject, Map<string, SchemeValue>>();

/**
 * Thin wrapper for JS objects. Property access is lazy — entries box on demand through
 * `jsToScheme` (rosetta.ts), stamped with the wrapper's own provenance, so e.g. an entry
 * read off an `(infer …)` result carries infer's id at the access point, not just at the
 * container level. Identity is stable via the module-level cache: `.get("x")` twice returns
 * the same AValue, so `(eq? (@ obj :x) (@ obj :x))` holds.
 *
 * All property access is sandboxed — see interop-access.ts for the security model.
 */
export class AJSObject extends AValue {
  static [CLASS] = "js-object";
  readonly kind = "object" as const;

  /** `{…}` reader dict-literal payload: keys read as `:keyword` symbols/strings/unquote forms,
   *  values UNEVALUATED. Present ⇒ node is a reader-minted dict literal (evaluator lowers to
   *  `(dict …)` in code position; under `quote`, the node is the datum itself). Absent on a
   *  membrane-boxed wrapper. See values/dict-literal.ts. */
  dictForms?: readonly SchemeValue[];

  constructor(
    ctx: RunContext,
    readonly source: object,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  /** Unwrap to original JS object (TO_JS protocol). */
  ["arrival/toJS"](): Record<string, unknown> {
    return this.source as Record<string, unknown>;
  }

  withProvenance(p: ReadonlySet<number>): AJSObject {
    // New wrapper = new identity = empty cache. Provenance-variant entries
    // would otherwise leak between wrappers; cleaner to let each lineage
    // build its own cache the first time it's queried.
    const w = new AJSObject(this.ctx, this.source, p);
    // Same-identity re-stamp: a `{…}` literal node stays a `{…}` literal node.
    if (this.dictForms !== undefined) w.dictForms = this.dictForms;
    return w;
  }

  /**
   * Read a property as a security-validated, provenanced, cached AValue. Single dispatch
   * point for `dict-ref` / `@` / `:key` — boundary checks + provenance flow + identity
   * stability (repeated `.get` on the same key returns the cached AValue).
   *
   * Missing key → nil (dict-ref semantics); `accessMember`'s NOT_FOUND (blocked or absent)
   * collapses to the same nil.
   *
   * Cycle protection is in `jsToScheme`'s WeakSet: a JS-side cycle surfacing through a
   * property read terminates before re-entering this wrapper.
   */
  get(key: string | symbol): SchemeValue {
    this.freezeSource();
    // Symbol keys skip the cache (sandbox already blocks most symbol access) — keeps
    // the Map<string, SchemeValue> shape clean.
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
      // Boundary violations collapse to nil — same shape as "absent" (spec §5.3:
      // (@ obj "key") returns the value or nil; no error detail leaks to the sandbox).
      if (e instanceof InteropAccessError) return nil;
      throw e;
    }
    if (raw === NOT_FOUND) return nil;

    // A function-valued property (foreign method) boxes through jsToScheme to #void + a
    // membrane warning — visible rather than silently vanishing to nil, and #void isn't
    // callable so the sandbox still can't invoke foreign JS. Getter reads are unaffected
    // (accessMember already invoked the getter to a value above).

    // Box through jsToScheme so primitives become AValue subtypes stamped with this
    // wrapper's provenance. jsToScheme is typed `any` (legacy debt in rosetta.ts) but its
    // contract is to return a boxed Scheme value; annotate to the honest union so the
    // cache store below type-checks without a cast.
    let boxed: SchemeValue = jsToScheme(this.ctx, raw, {}, this.provenance);
    // Attestation inherits from container (values/attestation.ts stamp site 2).
    // `freshIfSingleton` first: a raw boolean boxes to the shared #t/#f flyweight on the
    // empty-provenance path, and singletons never attest — the clone does, and the
    // per-(wrapper, key) cache keeps it stable.
    if (isAttested(this)) boxed = attestDeep(freshIfSingleton(boxed));
    if (cacheKey !== undefined && boxed instanceof AValue) {
      if (cache === undefined) {
        cache = new Map();
        entryCaches.set(this, cache);
      }
      cache.set(cacheKey, boxed);
    }
    return boxed;
  }

  /** Always throws — writes are banned (pure-dataflow sandbox, read-only membrane). */
  set(key: string | symbol, _value: SchemeValue): void {
    // Throwing rather than a silent no-op: the program would otherwise believe it wrote.
    throw new InteropAccessError(
      "Cannot assign to a foreign object — writes are banned in the pure-dataflow sandbox",
      typeof key === "symbol" ? key : String(key),
      "write-banned",
    );
  }

  has(key: string | symbol): boolean {
    this.freezeSource();
    return accessHas(this.source, key);
  }

  /** Always throws — deletion is a mutation, banned for the same reason as `set`. */
  delete(key: string | symbol): boolean {
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

  // Setoid (Fantasy Land): two wrappers are equal? iff same source (reference identity) —
  // deep-comparing would defeat the membrane's opacity (foreign getters/cycles).
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSObject && this.source === other.source;
  }

  // `@`/`dict-ref`/`:key` are one protocol, several syntaxes, over the same underlying
  // `.get`; the `:`-strip mirrors readMember's convention (membrane.ts).
  ["arrival/tagless-final/get"](key: SchemeValue): SchemeValue {
    let name = String((key as { valueOf?: () => unknown } | null | undefined)?.valueOf?.() ?? key);
    if (name.startsWith(":")) name = name.slice(1);
    return this.get(name);
  }

  toString(): string {
    return "#<js-object>";
  }

  // Delegates to toString — matches the printer's CLASS-name path
  // (static [CLASS] = "js-object" → `#<js-object>`).
  ["arrival/print"](): string {
    return this.toString();
  }

  valueOf(): object {
    return this.source;
  }

  // Freezes the borrowed source on first Scheme read — prevention by construction (replaces
  // a dev-only purity assert). Idempotent. `freezeRosettaReturns: false` on the run ctx opts out.
  private freezeSource(): void {
    if (this.ctx.freezeRosettaReturns !== false && !Object.isFrozen(this.source)) {
      Object.freeze(this.source);
    }
  }
}

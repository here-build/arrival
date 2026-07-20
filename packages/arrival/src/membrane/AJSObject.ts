/**
 * AJSObject — thin, read-only view of a borrowed JS object inside the Scheme value space.
 * Its own term with its own tagless-final algebra; the array sibling AJSArray carries a
 * separate vector algebra.
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

import { CLASS } from "../well-known-symbols.js";
import { type RunContext } from "../run/RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { nil } from "../values/primitives/ANil.js";
import { accessHas, accessKeys, accessMember, NOT_FOUND } from "./interop-access.js";
import { InteropAccessError } from "../errors.js";
import { attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js";
import { type SchemeValue } from "../values/types.js"; // Runtime import cycle (benign — see header): jsToScheme is a hoisted `export function`,
// called only inside get() at runtime.
import { jsToScheme } from "./rosetta.js";
import { is_promise } from "../eval/guards.js";
import { settleEntry } from "../values/primitives/pending-entry.js";

/**
 * Entry cache keyed by wrapper identity. WeakMap, not an instance field: keeps the cache off
 * the wrapper's own properties (sandbox symbol-to-field resolution can't reach it) and avoids
 * the tslib helper this workspace's `importHelpers: true` needs for TS `#`-private slots.
 * GC-correct — cache entry disappears with the wrapper.
 */
const entryCaches = new WeakMap<AJSObject, Map<string, SchemeValue | Promise<SchemeValue>>>();

/** The borrowed-wrapper member-name fold: a face-normalized string passes through; a
 *  SchemeValue key (keyword symbol, boxed string) unwraps via valueOf with the `:`
 *  accessor sigil stripped. Shared by AJSObject's and AJSArray's member terms. */
export function foldMemberName(key: SchemeValue | string): string {
  let name = typeof key === "string" ? key : String((key as { valueOf?: () => unknown } | null | undefined)?.valueOf?.() ?? key);
  if (name.startsWith(":")) name = name.slice(1);
  return name;
}

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
    return new AJSObject(this.ctx, this.source, p);
  }

  /**
   * Read a property as a security-validated, provenanced, cached AValue. Single dispatch
   * point for `dict-ref` / `@` / `:key` — boundary checks + provenance flow + identity
   * stability (repeated `.get` on the same key returns the cached AValue).
   *
   * Missing key → nil (dict-ref semantics); `accessMember`'s NOT_FOUND (blocked or absent)
   * collapses to the same nil.
   *
   * A Promise-valued property is a LAZY PENDING CELL (pending-entry.ts): the first read
   * mints one settle chain (cached, so concurrent readers share it), settlement replaces
   * the cache slot with the settled box — later reads are synchronous. A raw Promise
   * never leaks into scheme space from here.
   *
   * Cycle protection is in `jsToScheme`'s WeakSet: a JS-side cycle surfacing through a
   * property read terminates before re-entering this wrapper.
   */
  get(key: string | symbol): SchemeValue | Promise<SchemeValue> {
    this.freezeSource();
    if (this.isHostErrorStackKey(key)) return nil;
    // Symbol keys skip the cache (sandbox already blocks most symbol access) — keeps
    // the Map<string, …> shape clean.
    const cacheKey = typeof key === "string" ? key : undefined;
    if (cacheKey !== undefined) {
      const cached = entryCaches.get(this)?.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    const writeCache = (entry: SchemeValue | Promise<SchemeValue>): void => {
      if (cacheKey === undefined) return;
      let cache = entryCaches.get(this);
      if (cache === undefined) {
        cache = new Map();
        entryCaches.set(this, cache);
      }
      cache.set(cacheKey, entry);
    };

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
    // wrapper's provenance; attestation inherits from container (values/attestation.ts
    // stamp site 2). `freshIfSingleton` first: a raw boolean boxes to the shared #t/#f
    // flyweight on the empty-provenance path, and singletons never attest — the clone
    // does, and the per-(wrapper, key) cache keeps it stable.
    const boxEntry = (settled: unknown): SchemeValue => {
      const b: SchemeValue = jsToScheme(this.ctx, settled, {}, this.provenance);
      return isAttested(this) ? attestDeep(freshIfSingleton(b)) : b;
    };

    // Pending cell: cache the settle chain itself, then overwrite with the settled box.
    if (is_promise(raw)) {
      const cell = settleEntry(raw, boxEntry, writeCache);
      writeCache(cell);
      return cell;
    }

    const boxed = boxEntry(raw);
    if (boxed instanceof AValue) writeCache(boxed);
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
    if (this.isHostErrorStackKey(key)) return false;
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
    const ks = accessKeys(this.source);
    return this.source instanceof Error ? ks.filter((k) => k !== "stack") : ks;
  }

  /**
   * A host Error crosses borrowed (rosetta's exotic-object row): its `stack` is a
   * host-internals confession (file paths, call sites) the sandbox has no use for —
   * the read collapses to absent (nil / not-has / unlisted), the same shape as a
   * boundary violation. `message` / `name` / `cause` stay readable: they are the data
   * face of an error, and `cause`'s chained Errors re-apply this rule on their own
   * reads.
   */
  private isHostErrorStackKey(key: string | symbol): boolean {
    return key === "stack" && this.source instanceof Error;
  }

  // Setoid (Fantasy Land): two wrappers are equal? iff same source (reference identity) —
  // deep-comparing would defeat the membrane's opacity (foreign getters/cycles).
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSObject && this.source === other.source;
  }

  // `@`/`dict-ref`/`:key` are one protocol, several syntaxes, over the same underlying
  // `.get` — the membrane face (`readMember`) and the keyword accessor both dispatch to
  // this term. The `:`-strip is the receiver's own fold (a keyword symbol arrives raw).
  // A Promise-valued entry surfaces as its pending cell (Promise of the settled box) —
  // the evaluator's async seams await it; sync after settlement.
  ["arrival/tagless-final/get"](key: SchemeValue | string): SchemeValue | Promise<SchemeValue> {
    return this.get(foldMemberName(key));
  }

  ["arrival/tagless-final/has"](key: SchemeValue | string): boolean {
    return this.has(foldMemberName(key));
  }

  ["arrival/tagless-final/keys"](): string[] {
    return this.keys();
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

  // The freeze contract — docs/membrane.md §BOXING. Idempotent (guarded by `Object.isFrozen`);
  // `freezeRosettaReturns: false` opts out.
  private freezeSource(): void {
    if (this.ctx.freezeRosettaReturns !== false && !Object.isFrozen(this.source)) {
      Object.freeze(this.source);
    }
  }
}

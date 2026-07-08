/**
 * Boxes a raw Uint8Array into the AValue kernel so it carries provenance and
 * hosts Fantasy Land algebra instances. Modeled on SchemeString.
 *
 * Bytevectors are IMMUTABLE — the env is immutable by design and
 * bytevector-u8-set!/bytevector-copy!/bytevector-fill! are all notImplemented
 * stubs, so the payload is never written after construction; every
 * "mutator" instead returns a fresh ABytevector. The ArrayBuffer/DataView/
 * Buffer coercion is co-located in the constructor, so a SchemeBytevector
 * always normalizes to a single Uint8Array payload.
 *
 * Boxing track: docs/plan-2026-06-10-boxing-track.md (S1).
 *
 * Lineage: R7RS-small §6.9 bytevectors; the Setoid/Ord/Semigroup instances are
 * Fantasy Land (fantasyland/fantasy-land).
 */
import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import { withInputProvenance } from "../op-helpers.js";


/**
 * Anything that can seed a bytevector. Coerced to a Uint8Array payload in the
 * constructor (the old `asBytevector` coercion surface, now co-located here).
 */
export type BytevectorSource =
  | Uint8Array
  | ArrayBuffer
  | DataView
  | ABytevector
  | readonly number[];

function toUint8(source: BytevectorSource): Uint8Array {
  switch (true) {
    case source instanceof ABytevector:
      return source.__bytevector__;
    case source instanceof Uint8Array:
      return source;
    case source instanceof ArrayBuffer:
      return new Uint8Array(source);
    case source instanceof DataView:
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    case typeof Buffer !== "undefined" && source instanceof Buffer:
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    case Array.isArray(source):
      return Uint8Array.from(source);
    default:
      throw new TypeError(`SchemeBytevector: cannot coerce ${typeof source} to bytevector`);
  }
}

export class ABytevector extends AValue {
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "bytevector";
  readonly kind = "bytevector" as const;

  readonly __bytevector__: Uint8Array;

  constructor(ctx: RunContext, source: BytevectorSource, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    this.__bytevector__ = toUint8(source);
  }

  get length(): number {
    return this.__bytevector__.byteLength;
  }

  static isBytevector(x: unknown): x is ABytevector {
    return x instanceof ABytevector;
  }

  ref(i: number): number {
    return this.__bytevector__[i];
  }

  copy(start = 0, end = this.__bytevector__.byteLength): ABytevector {
    return new ABytevector(this.ctx, this.__bytevector__.slice(start, end));
  }

  // Membrane unwrap (membrane.ts toJS, TO_JS protocol): a boxed bytevector
  // crosses to JS as its raw Uint8Array, never as an opaque Scheme object.
  ["arrival/toJS"](): Uint8Array {
    return this.__bytevector__;
  }

  valueOf(): Uint8Array {
    return this.__bytevector__;
  }

  withProvenance(p: ReadonlySet<number>): ABytevector {
    return new ABytevector(this.ctx, this.__bytevector__, p);
  }

  // Print protocol — R7RS external repr `#u8(byte …)` (matches the printer's get_instances
  // ABytevector entry; bytes are raw numbers, no element recursion).
  ["arrival/print"](): string {
    return `#u8(${Array.from(this.__bytevector__).join(" ")})`;
  }

  // Setoid — byte-wise value equality. structuralEqual consults this first, so
  // (equal? (bytevector 1 2) (bytevector 1 2)) → #t. Non-ABytevector → false.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    if (!(other instanceof ABytevector)) return false;
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Ord (extends Setoid) — lexicographic over unsigned bytes. A proper prefix is ≤ its
  // extension; antisymmetry holds against the Setoid above. Non-ABytevector → false.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    if (!(other instanceof ABytevector)) return false;
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return a.length <= b.length;
  }

  // A boxed bytevector is iterable from JS — spread / for-of / Array.from yield
  // its bytes (numbers), like a Pair yields its elements. Delegates to the raw
  // Uint8Array's iterator. The membrane never exposes this (Symbol.iterator is a
  // BLOCKED_WELL_KNOWN_SYMBOL), so this is a host-JS-interop affordance only.
  [Symbol.iterator](): Iterator<number> {
    return this.__bytevector__[Symbol.iterator]();
  }

  // Semigroup — byte concatenation. Associative; equality via the Setoid above.
  ["arrival/tagless-final/concat"](other: ABytevector): ABytevector {
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return new ABytevector(this.ctx, result);
  }

  // Element-count over a bytevector (byte length). Like AString (and UNLIKE the Pair/Vector
  // element-union), bytes carry NO element ids, so this carries the BYTEVECTOR's OWN
  // provenance via `withInputProvenance([this], count)` — boxed when non-empty, else the
  // bare count. No heap-charge / no strict-gating.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    return withInputProvenance([this], this.__bytevector__.byteLength);
  }
}

// NOTE: producer-minted (bytevector/make-bytevector/string->utf8/Parser #u8(...)),
// NOT boxed from JS — fromJs's "object" arm maps a JS array/object to AJSArray/AJSObject,
// never a bytevector. Boxing is producer-driven.

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// Same rationale as SchemeString (SchemeString.ts): block inherited-method exposure
// when interop symbol-to-field resolution walks the prototype chain. Own
// properties (the algebra methods) remain the intended API.

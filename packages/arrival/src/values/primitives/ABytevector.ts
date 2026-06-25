/**
 * Boxes a raw Uint8Array into the AValue kernel so it carries provenance and
 * hosts Fantasy Land algebra instances. Modeled on SchemeString.
 *
 * Bytevectors are MUTABLE (bytevector-u8-set!/copy!) — the payload stays
 * writable, unlike a frozen string literal. The ArrayBuffer/DataView/Buffer
 * coercion is co-located in the constructor, so a SchemeBytevector always
 * normalizes to a single Uint8Array payload.
 *
 * Boxing track: docs/plan-2026-06-10-boxing-track.md (S1).
 *
 * Lineage: R7RS-small §6.9 bytevectors; the Setoid/Ord/Semigroup instances are
 * Fantasy Land (fantasyland/fantasy-land).
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../../interop-access.js";

// The membrane's TO_JS protocol key, resolved from the global symbol registry
// rather than imported from membrane.js. `Symbol.for` returns the SAME symbol as
// membrane's `export const TO_JS = Symbol.for("scheme.toJS")`, so the protocol is
// identical — but importing it would make membrane.js → SchemeBytevector.ts (added in
// S3 so the membrane recognizes boxed bytevectors) a cycle, and `[TO_JS]()` is a
// class-definition-time computed key (TDZ hazard). Local resolution breaks the edge.
const TO_JS = Symbol.for("scheme.toJS");

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
  static [CLASS] = "bytevector";
  readonly kind = "bytevector" as const;

  /** Mutable raw payload — bytevector-u8-set!/copy! write through this. */
  __bytevector__: Uint8Array;

  /** R7RS: a #u8(...) literal is immutable. Parser freezes literals; the
   *  bytevector mutators reject a frozen target. (Object.freeze can't be used —
   *  it throws on a non-empty typed array — so a flag is the uniform mechanism.) */
  frozen = false;

  constructor(ctx: RunContext, source: BytevectorSource, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    this.__bytevector__ = toUint8(source);
  }

  /** Mark immutable (a literal). Idempotent. */
  freeze(): void {
    this.frozen = true;
  }

  static isBytevector(x: unknown): x is ABytevector {
    return x instanceof ABytevector;
  }

  get length(): number {
    return this.__bytevector__.byteLength;
  }

  ref(i: number): number {
    return this.__bytevector__[i];
  }

  copy(start = 0, end = this.__bytevector__.byteLength): ABytevector {
    return new ABytevector(this.ctx, this.__bytevector__.slice(start, end));
  }

  // Membrane unwrap (membrane.ts toJS, TO_JS protocol): a boxed bytevector
  // crosses to JS as its raw Uint8Array, never as an opaque Scheme object.
  [TO_JS](): Uint8Array {
    return this.__bytevector__;
  }

  toJs(): Uint8Array {
    return this.__bytevector__;
  }

  valueOf(): Uint8Array {
    return this.__bytevector__;
  }

  withProvenance(p: ReadonlySet<number>): ABytevector {
    const bv = new ABytevector(this.ctx, this.__bytevector__, p);
    if (this.frozen) bv.freeze();
    return bv;
  }

  // Setoid (Fantasy Land) — byte-wise value equality. structuralEqual consults
  // arrival/tagless-final/equals first, so (equal? (bytevector 1 2) (bytevector 1 2)) → #t.
  // Non-SchemeBytevector → false.
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

  // Ord (Fantasy Land, extends Setoid) — lexicographic over unsigned bytes.
  // A proper prefix is ≤ its extension; antisymmetry holds against the Setoid
  // above (equal iff same bytes AND same length). Non-SchemeBytevector → false.
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

  // Semigroup (Fantasy Land) — byte concatenation. Associative; equality via the
  // Setoid above.
  ["arrival/tagless-final/concat"](other: ABytevector): ABytevector {
    const a = this.__bytevector__;
    const b = other.__bytevector__;
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return new ABytevector(this.ctx, result);
  }
}

// NOTE: producer-minted (bytevector/make-bytevector/string->utf8/Parser #u8(...)),
// NOT registered via AValue.registerBoxer — the "object" typeof tag is taken by
// the membrane's list-conser (R6). Boxing is producer-driven.

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// Same rationale as SchemeString (SchemeString.ts): block inherited-method exposure
// when interop symbol-to-field resolution walks the prototype chain. Own
// properties (the algebra methods) remain the intended API.
markInteropBoundary(ABytevector);

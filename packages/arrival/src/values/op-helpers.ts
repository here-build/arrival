/**
 * op-helpers — the cross-cutting leaf shared by every primitive cluster.
 *
 * These are the type-coercion + provenance + allocation-guard helpers that the
 * value-domain capability packs (numbers / strings / chars / lists / vectors /
 * bytevectors / control / core) all reach for. They live in their OWN leaf module
 * — importing only value-type classes, never `bridge` / `stdlib` / `env` — so a
 * cluster pack can import them without the cycle a `bridge.ts` import would create
 * (bridge re-assembles `wrappedOps` FROM the clusters, so cluster→bridge inverts).
 *
 * Dependency direction is down only: clusters → op-helpers → value-type classes.
 */

import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "./primitives/RunContext.js";

import { AValue, unionProvenance } from "./primitives/AValue.js";
import { ABytevector } from "./primitives/ABytevector.js";
import { AString } from "./primitives/AString.js";
import { AVector } from "./primitives/AVector.js";
import { AExact, AInexact, type ANumeric } from "./numbers.js";
import { type SchemeValue } from "./types.js";
import { ACharacter } from "./primitives/ACharacter.js";
import "../errors.js";

// ============================================================================
// Allocation cap — DoS defense for size-parameterized constructors
// ============================================================================

// `make-string` / `make-vector` / `make-bytevector` take an unbounded length `k`.
// V8 throws RangeError only above its own ceiling (~2^29 chars, ~2^32 slots), but
// that's the ENGINE's limit, not OUR policy, and the attack window is BELOW it:
// `(make-string 1e8)` allocates 200MB of UTF-16 in ~1ms and succeeds, `(make-vector
// 1e8)` spins >10s on 100M slots — one sandbox call drives host memory pressure. So
// we check length O(1) BEFORE allocation.
//
// Default: 2^24 (16,777,216). Large enough that no legitimate Scheme program hits
// it (a 16M-char string / 16M-slot vector is already pathological for an in-memory
// AST language), small enough that the worst case is ~32MB UTF-16 / one 16M-slot
// array — recoverable, not a host-killer. Host-overridable via `setAllocationLimit`
// so a tighter sandbox (or a looser trusted batch job) can retune without forking.
let allocationLimit = 1 << 24; // 16,777,216

/** Current per-call allocation cap for size-parameterized constructors. */
export function getAllocationLimit(): number {
  return allocationLimit;
}

/**
 * Override the per-call allocation cap (`make-string` / `make-vector` length).
 * Pass `Infinity` to disable (trusted contexts only). Negative / NaN is
 * rejected — the cap must be a meaningful upper bound.
 */
export function setAllocationLimit(limit: number): void {
  invariant(
    typeof limit === "number" && !Number.isNaN(limit) && limit >= 0,
    `setAllocationLimit: expected a non-negative number, got ${limit}`,
  );
  allocationLimit = limit;
}

/**
 * Throw a Scheme-surfaceable error (O(1), pre-allocation) when a requested
 * length exceeds the cap or is otherwise not a usable count. `len` is read
 * once by the caller; we validate it here so both constructors share one
 * message shape and one policy.
 */
export function assertAllocatable(len: number, fnName: string): void {
  invariant(
    Number.isFinite(len) && len >= 0,
    `${fnName}: length must be a non-negative integer, got ${len}`,
  );
  invariant(
    len <= allocationLimit,
    `${fnName}: requested length ${len} exceeds allocation limit ${allocationLimit}`,
  );
}

// ============================================================================
// Value-type coercion
// ============================================================================

/** Extract character value from SchemeCharacter */
export function charValue(char: unknown): string {
  return (char as ACharacter).__char__;
}

/** Extract string value from SchemeString or convert to string */
export function stringValue(str: unknown): string {
  return str instanceof AString ? str.valueOf() : String(str);
}

/** Convert unknown to index number (for vector/string operations) */
export function toIndex(v: unknown): number {
  return typeof v === "number" ? v : Number((v as AExact).valueOf());
}

/**
 * Resolve a vector argument to its raw element array (read/mutate view).
 * Accepts a boxed SchemeVector (returns __vector__ by reference, so in-place
 * mutators write through) or a raw JS array (transition: raw vectors still flow
 * until S7 producers + S10 tighten). Throws on anything else.
 */
export function asVector(obj: unknown, fnName: string, forMutation = false): SchemeValue[] {
  if (obj instanceof AVector) {
    TypeError.invariant(!forMutation || !obj.frozen, `${fnName}: cannot mutate an immutable vector literal`);
    return obj.__vector__;
  } else if (Array.isArray(obj)) {
    return obj;
  } else {
    throw new TypeError(`${fnName}: expected vector`);
  }
}

/**
 * Convert bytevector-like value to Uint8Array view.
 * Accepts Uint8Array, ArrayBuffer, DataView, Node Buffer.
 * Preserves identity for Uint8Array, creates view for others.
 */
export function asBytevector(obj: unknown, fnName: string, forMutation = false): Uint8Array {
  switch (true) {
    case obj instanceof ABytevector:
      // Unwrap by reference so in-place mutators (bytevector-u8-set!,
      // bytevector-copy!) write through to the boxed payload.
      TypeError.invariant(!forMutation || !obj.frozen, `${fnName}: cannot mutate an immutable bytevector literal`);
      return obj.__bytevector__;
    case obj instanceof Uint8Array:
      // FFI coercion: a raw Uint8Array handed to byte vector op (e.g., from a
      // JS function) is coerced in place. Stays permanently — it's the FFI
      // adapter. (bytevector? tightens to instanceof-only in S4; asBytevector
      // keeps coercing raw forms.)
      return obj;
    case obj instanceof ArrayBuffer:
      return new Uint8Array(obj);
    case obj instanceof DataView:
      return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    case typeof Buffer !== "undefined" && obj instanceof Buffer:
      return new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
    default:
      throw new TypeError(`${fnName}: expected bytevector, got ${typeof obj}`);
  }
}

// ============================================================================
// Fantasy Land Ord — the type-agnostic ordered-comparison chain
// ============================================================================

// The comparison operators consult `arrival/tagless-final/lte` when their operands are
// ordered ENTITIES (a DateTime, a Version, a SchemeCharacter, a SchemeString …),
// exactly as equal? consults a Setoid's `arrival/tagless-final/equals`. All four relations
// derive from the single `lte`; a chain `(< a b c)` holds iff each adjacent pair
// does. The per-type order lives in the entity's instance, so the string<? /
// char<? families are type-agnostic chains over it — adding a new ordered type
// needs no new comparison builtin. Numeric operands take the numeric/speculative
// path (bridge's `wrapOrd`) — the FL check is one inexpensive property read.
export interface AOrd {
  "arrival/tagless-final/lte"(other: unknown): boolean;
}
export const isOrd = (x: unknown): x is AOrd =>
  x != null && typeof (x as Partial<AOrd>)["arrival/tagless-final/lte"] === "function";
const lte = (a: AOrd, b: unknown): boolean => Boolean(a["arrival/tagless-final/lte"](b));
/** The four relations of a total order, all derived from the single `lte`. */
export const ORD_REL: Record<"<" | ">" | "<=" | ">=", (a: AOrd, b: AOrd) => boolean> = {
  "<": (a, b) => !lte(b, a),
  ">": (a, b) => !lte(a, b),
  "<=": (a, b) => lte(a, b),
  ">=": (a, b) => lte(b, a),
};
/** n-ary ordered comparison derived purely from the operands' `arrival/tagless-final/lte`. */
export function deriveOrd(sym: "<" | ">" | "<=" | ">="): (...args: unknown[]) => boolean {
  const rel = ORD_REL[sym];
  return (...args: unknown[]): boolean => {
    let verdict = true;
    for (let i = 0; i < args.length - 1; i++) {
      if (!rel(args[i] as AOrd, args[i + 1] as AOrd)) {
        verdict = false;
        break;
      }
    }
    // Plumbing: the ordering verdict carries its operands' provenance (forward, never
    // mint) — the same grounding string-contains? and the numeric comparisons give a bool.
    return withInputProvenance(args, verdict);
  };
}

// ============================================================================
// Numeric coercion into the SchemeExact / SchemeInexact tower
// ============================================================================

export function coerceNumeric(value: unknown): ANumeric {
  switch (true) {
    case value instanceof AExact:
    case value instanceof AInexact:
      return value;
    case typeof value === "bigint":
      return new AExact(CONSTANT_CTX, value);
    // Safe integers become exact (likely from Scheme integer literals)
    // Non-safe integers and floats become inexact
    case typeof value === "number":
      return Number.isSafeInteger(value) ? new AExact(CONSTANT_CTX, BigInt(value)) : new AInexact(CONSTANT_CTX, value);
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      switch (true) {
        case typeof val === "bigint":
          return new AExact(CONSTANT_CTX, val);
        case typeof val === "number":
          return Number.isSafeInteger(val) ? new AExact(CONSTANT_CTX, BigInt(val)) : new AInexact(CONSTANT_CTX, val);
        default:
          throw new TypeError(`Cannot convert to SchemeNumeric: ${val}`);
      }
      break;
    }
    default:
      throw new TypeError( `Cannot convert to SchemeNumeric: ${value}`);
  }
}

/** Check if a value can be converted to SchemeNumeric (without throwing) */
export function isSchemeNumber(value: unknown): boolean {
  switch (true) {
    case value instanceof AExact:
    case value instanceof AInexact:
      return true;
    case typeof value === "bigint":
    case typeof value === "number":
      return true;
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      switch (true) {
        case typeof val === "bigint":
        case typeof val === "number":
          return true;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

// ============================================================================
// Provenance stamping (the bridge twin of lips.ts withInputProvenance)
// ============================================================================

/**
 * Stamp `result` with the union of `args`' provenances. Parallel to lips.ts's
 * `withInputProvenance` (same algebra): the builtins that live in the cluster
 * packs — `string-append`, `string-copy`, `list-copy`, `vector`, etc. — all
 * produce fresh AValue / array / Uint8Array results whose provenance must
 * inherit from their inputs.
 *
 * Like the lips.ts twin, in provenanced mode (`prov.size > 0`) every scalar is
 * boxed — string/number/bigint/boolean — so no derived scalar drops its grounding.
 * The old bool/number/bigint exclusion (it "broke `!== false` callers") is retired
 * along with its twin: the HOFs route truthiness through `is_false`, which is blind
 * to a boxed `SchemeBool`. Non-scalars (Pair / vector / object) stay raw — they
 * carry provenance structurally and `AValue.fromJs` would double-wrap them.
 */
export function withInputProvenance<T>(args: readonly unknown[], result: T): T {
  const inputs = args.filter((a): a is AValue => a instanceof AValue);
  if (inputs.length === 0) return result;
  const prov = unionProvenance(inputs);
  if (prov.size === 0) return result;
  if (result instanceof AValue) return result.withProvenance(prov) as T;
  const t = typeof result;
  if (t === "string" || t === "number" || t === "bigint" || t === "boolean") {
    return AValue.fromJs(CONSTANT_CTX, result, prov) as T;
  }
  return result;
}

// Re-export the provenance singletons cluster ops occasionally need for direct
// boolean boxing, so a cluster need only import from this one leaf.

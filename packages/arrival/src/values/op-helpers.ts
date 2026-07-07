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
import { applyCallback } from "./primitives/ACallable.js";

import { AValue, unionProvenance } from "./primitives/AValue.js";
import { type ABool, schemeFalse, schemeTrue } from "./primitives/ABool.js";
import { fromJs } from "./primitives/boxing.js";
import { ABytevector } from "./primitives/ABytevector.js";
import { AString } from "./primitives/AString.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { is_false } from "./value-guards.js";
import { type ANumeric } from "./numbers.js";
import { type SchemeValue } from "./types.js";
import { ACharacter } from "./primitives/ACharacter.js";
import "../errors.js";
import { tf } from "./tagless-final.js";

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
  invariant(Number.isFinite(len) && len >= 0, `${fnName}: length must be a non-negative integer, got ${len}`);
  invariant(len <= allocationLimit, `${fnName}: requested length ${len} exceeds allocation limit ${allocationLimit}`);
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

/** Structural guard for the vector PROTOCOL — a boxed AVector or a borrowed AJSArray, both
 *  answering `arrival/tagless-final/vector?` and exposing their element payload via `__vector__`
 *  (a literal also carries `frozen`). Honest duck-narrowing — no `instanceof AVector` reach-around,
 *  no operand cast in `asVector`'s body. */
interface VectorLike {
  "arrival/tagless-final/vector?"(): boolean;
  __vector__: SchemeValue[];
  frozen?: boolean;
}
// todo smell, eliminate
function isVectorLike(obj: unknown): obj is VectorLike {
  return obj != null && typeof (obj as Record<string, unknown>)["arrival/tagless-final/vector?"] === "function";
}

/**
 * Resolve a vector argument to its raw element array (read/mutate view).
 *
 * PROTOCOL dispatch — anything answering `arrival/tagless-final/vector?` (a boxed AVector OR a
 * borrowed AJSArray, which IS a vector) exposes its element payload via `__vector__`. For an
 * owned vector that's the writable payload by reference (in-place mutators write through); for a
 * borrowed view the getter materializes its source on first read. No `instanceof AVector`
 * reach-around. The `frozen` check guards a literal's payload from in-place writes (a borrowed
 * view has no `frozen` field, and a writable source it never had — the mutators are doored
 * regardless). A raw JS array is still tolerated (transition; S10 will remove it). Throws otherwise.
 */
export function asVector(obj: unknown, fnName: string, forMutation = false): SchemeValue[] {
  if (isVectorLike(obj)) {
    TypeError.invariant(!forMutation || !obj.frozen, `${fnName}: cannot mutate an immutable vector literal`);
    return obj.__vector__;
  }
  if (Array.isArray(obj)) return obj; // transitional raw-array tolerance (S10 will remove this)
  throw new TypeError(`${fnName}: expected vector`);
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
export const isOrd = (x: unknown): x is AOrd => x != null && typeof (x as Partial<AOrd>)[tf("lte")] === "function";
const lte = (a: AOrd, b: unknown): boolean => Boolean(a[tf("lte")](b));
// Nil is the BOTTOM of the universal order (V's F2: nil-as-bottom, matching SRFI-128's
// "the empty list is ordered before all pairs" and Clojure's `compare`). Detected
// structurally (null / undefined / ANil — by constructor name, so no value-class import
// and no cycle). Returns the 3-way verdict when EITHER side is nil (both nil ⇒ 0/equal;
// one nil ⇒ it is the lesser), else `undefined` — meaning "neither is nil, compare
// normally". Shared by `deriveSortCompare` here AND the loose comparison ops in
// fl-interop, so `<` and `sort` agree on where nil sorts.
const isNilValue = (x: unknown): boolean =>
  x == null || (x as { constructor?: { name?: string } })?.constructor?.name === "ANil";
export function nilOrderCompare(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const aN = isNilValue(a);
  const bN = isNilValue(b);
  if (!aN && !bN) return undefined;
  return aN && bN ? 0 : aN ? -1 : 1;
}
/** The four relations of a total order, all derived from the single `lte`. */
export const ORD_REL: Record<"<" | ">" | "<=" | ">=", (a: AOrd, b: AOrd) => boolean> = {
  "<": (a, b) => !lte(b, a),
  ">": (a, b) => !lte(a, b),
  "<=": (a, b) => lte(a, b),
  ">=": (a, b) => lte(b, a),
};
/** n-ary ordered comparison derived purely from the operands' `arrival/tagless-final/lte`. */
export function deriveOrd(sym: "<" | ">" | "<=" | ">="): (...args: unknown[]) => ABool {
  const rel = ORD_REL[sym];
  return (...args: unknown[]): ABool => {
    let verdict = true;
    for (let i = 0; i < args.length - 1; i++) {
      if (!rel(args[i] as AOrd, args[i + 1] as AOrd)) {
        verdict = false;
        break;
      }
    }
    // The verdict is the boxed scheme face (flyweight; Face split). Plumbing: it carries
    // its operands' provenance (forward, never mint — withInputProvenance clones the
    // flyweight with the union when provenance rides, hands back the shared one when not).
    return withInputProvenance(args, schemeBool(verdict));
  };
}

/** Human kind-name of an element that can't be ordered — its scheme `kind` (an AValue:
 *  "pair"/"vector"/…) else the JS shape. Mirrors symbol.ts describeReceiver. */
const describeOrdElement = (v: unknown): string =>
  v instanceof AValue ? v.kind : v === null || v === undefined ? String(v) : Array.isArray(v) ? "array" : typeof v;

/** Derive the JS `Array.prototype.sort` comparator (a (a,b)=>number) used by every
 *  primitive's `arrival/tagless-final/sort`. The container-shape decision lives on the
 *  term; this is the SHARED element-ordering both APair and AVector reach for.
 *
 *  • No comparator → the operand's OWN total order via `arrival/tagless-final/lte`: for a
 *    pair a,b — `aLE = a≤b`, `bLE = b≤a` ⇒ aLE ? (bLE ? 0 : -1) : (bLE ? 1 : 0). This is
 *    correct for EVERY Ord-bearing type (numbers/strings/chars/symbols/bytevectors all carry
 *    lte), and fixes the prior JS-lexicographic default (`(sort '(2 10))` → `(10 2)`). An
 *    element lacking `lte` (a pair, with no user comparator) → a totalic "cannot order"
 *    throw — never a silent mis-order.
 *  • Comparator present → BOTH supported comparator shapes (wrong-state-impossible across
 *    the two conventions the ecosystem actually uses), ASSUMED SYNC (ES Array.sort is sync):
 *      – a JS-style NUMBER comparator (the harvested .d.ts contract: `(a b) → number`,
 *        <0 ⇒ a-before-b) — used DIRECTLY (this is what the localeCompare test fixture and
 *        every model-following-the-published-type sends); a boxed Scheme numeric is unboxed.
 *      – else a `less?` predicate (SRFI-95 / a Scheme `<=`-style boolean) — truthy iff a
 *        precedes b: `!is_false(cmp(a,b)) ? -1 : (!is_false(cmp(b,a)) ? 1 : 0)`.
 *    The number branch is REQUIRED: reading a number comparator's positive verdict through
 *    `!is_false` (every nonzero number is scheme-truthy) would mis-order (it did, in the
 *    first cut) — so a number is consulted as a number, not coerced to a less?-truthiness. */
export function deriveSortCompare(
  comparator?: (a: unknown, b: unknown) => unknown,
): (a: unknown, b: unknown) => number {
  if (comparator !== undefined && comparator !== null) {
    // The comparator is a callable VALUE now (ANativeProcedure) — invoke through the seam, not
    // as a bare fn. Sort is synchronous; a native comparator returns a settled value (a lambda
    // comparator would return a promise, the pre-existing async-comparator limitation).
    const call = (a: unknown, b: unknown): unknown => applyCallback(comparator, [a, b], CONSTANT_CTX);
    return (a, b) => {
      const v = call(a, b);
      if (typeof v === "number") return v;
      if (v instanceof AExact || v instanceof AInexact) return Number(v.valueOf());
      // `less?` predicate: a truthy verdict means a precedes b.
      return is_false(v) ? (is_false(call(b, a)) ? 0 : 1) : -1;
    };
  }
  return (a, b) => {
    const nilCmp = nilOrderCompare(a, b);
    if (nilCmp !== undefined) return nilCmp; // nil is the order's bottom (shared with the comparison ops)
    if (!isOrd(a))
      throw new TypeError(
        `sort: cannot order a ${describeOrdElement(a)} (it declares no arrival/tagless-final/lte; supply a comparator).`,
      );
    if (!isOrd(b))
      throw new TypeError(
        `sort: cannot order a ${describeOrdElement(b)} (it declares no arrival/tagless-final/lte; supply a comparator).`,
      );
    const aLE = lte(a, b);
    const bLE = lte(b, a);
    return aLE ? (bLE ? 0 : -1) : bLE ? 1 : 0;
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
      throw new TypeError(`Cannot convert to SchemeNumeric: ${value}`);
  }
}

/** Check if a value can be converted to SchemeNumeric (without throwing). NOT a closed type guard:
 *  the `valueOf` arm admits any object exposing a number/bigint `valueOf()` (the same legacy-boxed
 *  coercion `coerceNumeric` accepts), so a true verdict does NOT prove `ANumeric | number | bigint`.
 *  Narrowing it to that union would be a lie; callers that need the boxed value go through
 *  `coerceNumeric` (which takes `unknown`), so no operand cast hangs off this predicate. */
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
 *
 * RETURN-TYPE CAST — `<T>(…): T` with two `as T`, and the second (`fromJs(…) as T`)
 * is INHERENT, not laziness. This is the seam between two layers that model values
 * differently:
 *   • the provenance layer BOXES a raw scalar (`fromJs`) to carry lineage, so a
 *     `boolean`/`number` input can come back as a `SchemeBool`/`AExact` AValue;
 *   • the symbol-contract layer (`output: [z.boolean]` ⇒ `DecodedReturn = boolean`)
 *     and the tagless ops type their result by its DECODED JS shape, BLIND to the box
 *     (a `SchemeBool` decodes back to `boolean` downstream).
 * The impl-side contract DELIBERATELY wants the unboxed type (`string=?` is `: boolean`).
 * Surfacing the box (return `T | AValue`) doesn't fix the cast — it pushes the same
 * widening into ~11 predicate/projection contracts that are intentionally boxing-blind
 * (`string=?`, `string-ci=?`, the order chains, `car`/`cdr`), each a value-model
 * decision about whether a provenanced boolean is "still a boolean." That belongs to
 * the provenance/contract design, not this leaf. So the cast stays AS the asserted
 * fact "the box is transparent to the contract"; the AValue-branch `as T` is sound
 * (`withProvenance` preserves the subtype) and rides the same signature.
 */
export function withInputProvenance<T>(args: readonly unknown[], result: T): T {
  const inputs = args.filter((a): a is AValue => a instanceof AValue);
  if (inputs.length === 0) return result;
  const prov = unionProvenance(inputs);
  if (prov.size === 0) return result;
  if (result instanceof AValue) return result.withProvenance(prov) as T;
  const t = typeof result;
  if (t === "string" || t === "number" || t === "bigint" || t === "boolean") {
    return fromJs(inputs[0].ctx, result, prov) as T;
  }
  return result;
}

// Re-export the provenance singletons cluster ops occasionally need for direct
// boolean boxing, so a cluster need only import from this one leaf.
export { schemeTrue, schemeFalse } from "./primitives/ABool.js";

/** The scheme face of a predicate verdict — the shared flyweights (eq?-stable, empty
 *  provenance). The one boxing point every env pack's boolean-returning native uses
 *  under the Face split (a `z.boolean` output demands an ABool, never a raw JS boolean). */
export const schemeBool = (v: boolean): ABool => (v ? schemeTrue : schemeFalse);

/**
 * op-helpers — cross-cutting leaf shared by every primitive cluster.
 *
 * Type-coercion + provenance + allocation-guard helpers the value-domain capability
 * packs (numbers/strings/chars/lists/vectors/bytevectors/control/core) reach for. OWN
 * leaf module (imports only value-type classes, never env layer) so a cluster pack
 * (`env/r7rs/*`, which assembles its `wrappedOps` from these helpers) imports without a cycle.
 *
 * Dependency direction: clusters → op-helpers → value-type classes.
 */

import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "./primitives/RunContext.js";
import { applyCallback } from "./primitives/ACallable.js";
import { currentRegionScope, isSilentRegion, recordHostScheduleVerdict } from "./primitives/region-scope.js";

import { AValue, EMPTY_PROVENANCE, unionProvenance } from "./primitives/AValue.js";
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

// Eager-stamp oracle flag (PROVENANCE-PLAN.md Q9 read seam + Q20a/Q20b write wiring;
// docs/PROVENANCE.md §4 C12, §7 W1 agreement). `withInputProvenance`/`mintVerdict` below
// are the accumulation path production ran unconditionally pre-Q20, and that the CI
// oracle (`wireframe-agreement.law.test.ts`, the Q16 replay laws' recorded-ground-truth
// side, and every pre-Q20b test written against the old always-on default) still needs
// on demand. Q20a wired the flag INSIDE `withInputProvenance`: OFF skips stamp
// accumulation (the filter + union-set allocations) while R1 boxing discipline stays
// intact. Q20b (this default) FLIPS it: production hot paths no longer accumulate by
// default — C12's "eager stamp path is a TEST-ONLY oracle... compiled out of production
// hot paths" is now the actual default, not an opt-out. Flag is module-GLOBAL — right
// granularity for a whole process (the sampler's own runner, or a test file's
// beforeAll/afterAll); the upgrade path if a single process ever needs stamped AND
// unstamped envs simultaneously is a RunContext-carried flag, not a second global.
let eagerProvenanceOracleEnabled = false;

/** Is the eager-stamp oracle (this file's `withInputProvenance`/`mintVerdict`
 *  accumulation) live? Default FALSE since Q20b; `withInputProvenance` branches on it
 *  (Q20a wiring). Reports the raw AMBIENT flag only — NOT the effective in-γ state
 *  {@link withInputProvenance} also consults (see its own doc): a caller inside a
 *  silent region sees `false` here even though accumulation is in fact running for
 *  that call, because replay-correctness is a property of WHERE the call runs, not of
 *  this module-global switch. Existing readers (Q9's wireframe-agreement.law.test.ts)
 *  depend on this function mirroring exactly what `setEagerProvenanceOracleEnabled`
 *  last wrote — do not fold the OR in here. */
export function isEagerProvenanceOracleEnabled(): boolean {
  return eagerProvenanceOracleEnabled;
}

/** Opt out of (or back into) eager stamp accumulation process-wide (Q20a/Q20b). Values
 *  still box per R1; OFF means they carry EMPTY provenance (outside a silent region —
 *  see {@link withInputProvenance}). Intended for provenance non-consumers (sampler
 *  runners) to opt OUT, and for the CI agreement oracle / pre-Q20b test suites to opt
 *  back IN for their own lifetime; tests restore the ambient default afterward. */
export function setEagerProvenanceOracleEnabled(enabled: boolean): void {
  eagerProvenanceOracleEnabled = enabled;
}

/**
 * The EFFECTIVE accumulation switch {@link withInputProvenance}/`mintVerdict` actually
 * branch on: the ambient module flag OR "we are inside a silent region right now"
 * ({@link isSilentRegion}, `values/primitives/region-scope.ts`, Q15).
 *
 * WHY the OR is load-bearing, not a convenience: every γ/replay face
 * (`provenance/gamma.ts`'s `hermeticApply`/`applyWireInEnv`, and therefore all three of
 * `provenance/replay.ts`'s drivers) re-executes a wire's body through this SAME
 * interpreter, wrapped in `withSilentRegion` for its entire dynamic extent. A wire body
 * is ordinary pure-op composition (`(+ a b)`, `string-append`, …) over ingress values
 * that were boxed with their RECORDED stamp ids (`replay.ts`'s `boxPayload`) — the
 * only mechanism that unions those ids through the wire's arithmetic into the egress's
 * OWN `.provenance` is this file's accumulation. If the ambient production default is
 * OFF (Q20b) and γ did not force it back on for its own execution, replay would
 * silently reproduce an EGRESS VALUE with the right JS payload but EMPTY provenance —
 * correct-looking, wrong lineage — breaking the wire-γ adjunction and the I1/I3 replay
 * laws (docs/PROVENANCE.md §7) in PRODUCTION, not just in a test. Gating on
 * `isSilentRegion()` here (rather than γ explicitly flipping the module flag around its
 * own call) means every replay path is correct BY CONSTRUCTION — there is no second
 * call site to remember to wrap, and nothing outside a silent region is affected: a
 * production hot path with the ambient flag OFF and no silent region ambient behaves
 * exactly as Q20b intends (zero accumulation).
 *
 * EXPORTED (not file-private) because the sweep this node's brief required found TWO
 * hand-rolled `unionProvenance(...)` call sites that never went through
 * `withInputProvenance` in the first place, and therefore never respected the oracle
 * flag even under Q20a: `env/r7rs/numeric.ts`'s `nativeNumericOp`/`applyNumeric` (EVERY
 * arithmetic op — `+`/`-`/`*`/`/`/comparisons/…) and its `numberToStringFn`. Those two
 * sites now import this function instead of duplicating the OR — see their own
 * call-site comments. This is the ONE production-correctness gap the sweep found that
 * was both (a) genuinely load-bearing for Q20b's "production hot paths stop
 * accumulating" claim (arithmetic is the hot path) and (b) trivially gateable; every
 * OTHER hand-rolled site the sweep found (`rosetta.ts`'s `argProvenance`,
 * `common/symbols/rosetta.ts`'s pipe-role mint) is lower-traffic and documented,
 * unfixed, in the Q20b report instead of touched here.
 */
export function isEagerAccumulationActive(): boolean {
  return eagerProvenanceOracleEnabled || isSilentRegion();
}

// Allocation cap — DoS defense for size-parameterized constructors

// `make-string`/`make-vector`/`make-bytevector` take unbounded `k`. V8's ceiling
// (~2^29 chars / ~2^32 slots) is the ENGINE limit, not our policy: `(make-string 1e8)`
// allocates 200MB UTF-16 in ~1ms and succeeds, `(make-vector 1e8)` spins >10s on 100M
// slots — one sandbox call drives host memory pressure. Length checked O(1) pre-alloc.
//
// Default 2^24: worst case (~32MB UTF-16 / one 16M-slot array) is recoverable. Host-
// overridable via `setAllocationLimit` for tighter sandbox or trusted batch.
let allocationLimit = 1 << 24; // 16,777,216

/** Per-call allocation cap for size-parameterized constructors. */
export function getAllocationLimit(): number {
  return allocationLimit;
}

/**
 * Override per-call allocation cap (`make-string`/`make-vector` length).
 * `Infinity` disables (trusted contexts only). Negative/NaN rejected — cap must
 * be a meaningful upper bound.
 */
export function setAllocationLimit(limit: number): void {
  invariant(
    typeof limit === "number" && !Number.isNaN(limit) && limit >= 0,
    `setAllocationLimit: expected a non-negative number, got ${limit}`,
  );
  allocationLimit = limit;
}

/**
 * Throw Scheme-surfaceable error (O(1), pre-allocation) when len exceeds cap or
 * is not a usable count. `len` read once by caller; validated here so both
 * constructors share one message shape and one policy.
 */
export function assertAllocatable(len: number, fnName: string): void {
  invariant(Number.isFinite(len) && len >= 0, `${fnName}: length must be a non-negative integer, got ${len}`);
  invariant(len <= allocationLimit, `${fnName}: requested length ${len} exceeds allocation limit ${allocationLimit}`);
}

// Value-type coercion

/** Unwrap SchemeCharacter → string */
export function charValue(char: unknown): string {
  return (char as ACharacter).__char__;
}

/** Unwrap AString.valueOf() or String(str) */
export function stringValue(str: unknown): string {
  return str instanceof AString ? str.valueOf() : String(str);
}

/** Coerce to index number for vector/string ops */
export function toIndex(v: unknown): number {
  return typeof v === "number" ? v : Number((v as AExact).valueOf());
}

/** Vector PROTOCOL guard: boxed AVector or borrowed AJSArray — both answer
 *  `arrival/tagless-final/vector?` and expose `__vector__`. Honest duck-narrowing —
 *  no `instanceof AVector` reach-around, no operand cast in `asVector`. */
interface VectorLike {
  "arrival/tagless-final/vector?"(): boolean;
  __vector__: SchemeValue[];
}
// todo smell, eliminate
function isVectorLike(obj: unknown): obj is VectorLike {
  return obj != null && typeof (obj as Record<string, unknown>)["arrival/tagless-final/vector?"] === "function";
}

/**
 * Resolve vector arg to raw element array (read view).
 *
 * PROTOCOL dispatch — anything answering `arrival/tagless-final/vector?` exposes
 * `__vector__`. No `instanceof AVector` reach-around. Raw JS array tolerated (transition;
 * S10 removes). Throws otherwise.
 */
export function asVector(obj: unknown, fnName: string): SchemeValue[] {
  if (isVectorLike(obj)) {
    return obj.__vector__;
  }
  if (Array.isArray(obj)) return obj; // transitional raw-array tolerance (S10 will remove this)
  throw new TypeError(`${fnName}: expected vector`);
}

/**
 * Coerce bytevector-like value to Uint8Array view.
 * Accepts Uint8Array / ArrayBuffer / DataView / Node Buffer.
 * Identity preserved for Uint8Array, view created for others.
 */
export function asBytevector(obj: unknown, fnName: string): Uint8Array {
  switch (true) {
    case obj instanceof ABytevector:
      // Unwrap by reference: env is immutable (vector-set!/bytevector-u8-set!/etc.
      // are notImplemented stubs — no in-place writer to guard against).
      return obj.__bytevector__;
    case obj instanceof Uint8Array:
      // FFI coercion: raw Uint8Array from a JS fn coerced in place. Stays permanently —
      // it's the FFI adapter. (bytevector? tightens instanceof-only in S4; asBytevector
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

// Ordered ENTITIES consult `arrival/tagless-final/lte` (like Setoid's equals for equal?).
// All four relations derive from the single `lte`; a chain `(< a b c)` holds iff each
// adjacent pair does. Per-type order in entity instance — string<?/char<? families are
// type-agnostic chains. Adding new ordered type needs no new builtin. Numeric operands
// take numeric path (`env/r7rs/numeric.ts`'s `wrapOrd`); FL check is one cheap property read.
export interface AOrd {
  "arrival/tagless-final/lte"(other: unknown): boolean;
}
export const isOrd = (x: unknown): x is AOrd => x != null && typeof (x as Partial<AOrd>)[tf("lte")] === "function";
const lte = (a: AOrd, b: unknown): boolean => Boolean(a[tf("lte")](b));
// Nil = universal-order BOTTOM (V's F2: nil-as-bottom, matching SRFI-128 + Clojure).
// Detected structurally (null/undefined/ANil — by constructor name, no value-class import/
// no cycle). Returns 3-way verdict when EITHER side nil (both nil ⇒ 0/equal; one nil ⇒ lesser),
// else undefined ("neither nil, compare normally"). Shared: `deriveSortCompare` here AND
// fl-interop loose ops — `<` and `sort` agree on nil position.
const isNilValue = (x: unknown): boolean =>
  x == null || (x as { constructor?: { name?: string } })?.constructor?.name === "ANil";
export function nilOrderCompare(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const aN = isNilValue(a);
  const bN = isNilValue(b);
  if (!aN && !bN) return undefined;
  return aN && bN ? 0 : aN ? -1 : 1;
}
/** Four total-order relations, all derived from the single `lte`. */
export const ORD_REL: Record<"<" | ">" | "<=" | ">=", (a: AOrd, b: AOrd) => boolean> = {
  "<": (a, b) => !lte(b, a),
  ">": (a, b) => !lte(a, b),
  "<=": (a, b) => lte(a, b),
  ">=": (a, b) => lte(b, a),
};
/** n-ary ordered comparison from operands' `arrival/tagless-final/lte`. */
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
    // R8 mint (`op-helpers.mintVerdict`) — withInputProvenance + schemeBool is the ORIGINAL
    // of the law mintVerdict names for every site.
    return mintVerdict(args, verdict);
  };
}

/** Kind-name of un-orderable element — scheme `kind` (AValue "pair"/"vector"/…) else JS shape.
 *  Mirrors `common/symbols/_bake.ts`'s describeReceiver. */
const describeOrdElement = (v: unknown): string =>
  v instanceof AValue ? v.kind : v === null || v === undefined ? String(v) : Array.isArray(v) ? "array" : typeof v;

/** Derive JS `Array.prototype.sort` comparator ((a,b)=>number) for every primitive's
 *  `arrival/tagless-final/sort`. SHARED element-ordering both APair and AVector reach for.
 *
 *  • No comparator → operand's OWN total order via `arrival/tagless-final/lte`: a,b —
 *    `aLE = a≤b`, `bLE = b≤a` ⇒ aLE ? (bLE ? 0 : -1) : (bLE ? 1 : 0). Correct for EVERY
 *    Ord-bearing type. Element lacking `lte` (e.g. pair, no user cmp) → "cannot order"
 *    throw — never silent mis-order.
 *  • Comparator present → BOTH supported shapes (ASSUMED SYNC):
 *      – NUMBER comparator ((a,b)→number, <0 ⇒ a-before-b) — used DIRECTLY; boxed Scheme
 *        numeric unboxed.
 *      – else `less?` predicate (SRFI-95) — truthy iff a precedes b.
 *    Number branch REQUIRED: reading number verdict through `!is_false` mis-orders (every
 *    nonzero is scheme-truthy) — a number must be consulted as a number. */
export function deriveSortCompare(
  comparator?: (a: unknown, b: unknown) => unknown,
): (a: unknown, b: unknown) => number {
  if (comparator !== undefined && comparator !== null) {
    // Comparator is a callable VALUE (ANativeProcedure) — invoke through the seam, not bare fn.
    // Sort sync; native cmp returns settled value (lambda cmp → promise, pre-existing limitation).
    const call = (a: unknown, b: unknown): unknown => applyCallback(comparator, [a, b], CONSTANT_CTX);
    // Q11b/Q20b: host-schedule wiring (docs/PROVENANCE.md §5 D5; region-scope.ts's own
    // header names this exact gap as "op-helpers.ts territory, Q20's"). `sort`'s
    // comparator is the canonical order-dependent selector host — its verdict SEQUENCE
    // (not any single verdict) is the record (§5 A6: "the sequence IS the record").
    // `recordHostScheduleVerdict` already no-ops under emission-off/silent-region/no-
    // coordinate (region-scope.ts's own gates) — the only thing THIS call site adds is
    // reading the ambient scope and attributing a triple to it. No ambient RegionScope
    // (today's entire production call graph outside a tracked crossing — see
    // `currentRegionScope`'s own doc) ⇒ one `undefined` check, zero further cost.
    //
    // ELEMENT ORDINALS: `Array.prototype.sort`'s comparator signature carries no
    // element INDEX, only the two VALUES — true per-element `OrdinalPath`s are not
    // threadable through it without a deeper host-sort rewrite (out of this node's
    // scope, per region-scope.ts's own note). Falls back to comparator CALL ORDER as
    // the ordinal proxy: the n-th comparator invocation this sort performs is recorded
    // as `([n], [n+1])` — a real, monotonic, per-sort-call attribution (never reused
    // across two different `deriveSortCompare` calls, since `callOrdinal` is closed
    // over fresh per call), just not a positional index into the original array. §5 D5
    // only requires SOME attributable path, not the true element position.
    let callOrdinal = 0;
    return (a, b) => {
      const v = call(a, b);
      let verdict: number;
      if (typeof v === "number") verdict = v;
      else if (v instanceof AExact || v instanceof AInexact) verdict = Number(v.valueOf());
      // `less?` predicate: truthy ≡ a precedes b.
      else verdict = is_false(v) ? (is_false(call(b, a)) ? 0 : 1) : -1;

      const scope = currentRegionScope();
      if (scope !== undefined) {
        recordHostScheduleVerdict(scope, [callOrdinal], [callOrdinal + 1], verdict);
        callOrdinal++;
      }
      return verdict;
    };
  }
  return (a, b) => {
    const nilCmp = nilOrderCompare(a, b);
    if (nilCmp !== undefined) return nilCmp; // nil = order's bottom (shared with comparison ops)
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

// Numeric coercion into SchemeExact/SchemeInexact tower

export function coerceNumeric(value: unknown): ANumeric {
  switch (true) {
    case value instanceof AExact:
    case value instanceof AInexact:
      return value;
    case typeof value === "bigint":
      return new AExact(CONSTANT_CTX, value);
    // Safe ints exact (likely Scheme int literals); non-safe + floats inexact
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

/** Convertible to SchemeNumeric without throwing. NOT a closed type guard: `valueOf` arm admits
 *  any object exposing number/bigint valueOf(), so true ≠ `ANumeric | number | bigint`. Callers
 *  needing boxed value go through `coerceNumeric` (takes unknown); no operand cast off this. */
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

// Provenance stamping

/**
 * Stamp `result` with union of `args`' provenances. Cluster-pack builtins
 * (`string-append`, `string-copy`, `list-copy`, `vector`, …) produce fresh results whose
 * provenance must inherit from inputs.
 *
 * Scalars boxed UNCONDITIONALLY (bare-value purge, DAG A4, RULINGS.md R1/P4): inside the
 * membrane only boxed AValues — a raw JS scalar handed back is unexecutable (P0/P4).
 * Empty-provenance flyweight exists (`fromJs` `EMPTY_PROVENANCE` branch reuses schemeTrue/
 * schemeFalse — allocation-free for booleans; strings/numbers correctly boxed; see
 * `mintVerdict`). Non-scalars stay raw — structural provenance, `AValue.fromJs` double-wraps.
 *
 * RETURN-TYPE CAST — `fromJs(…) as T` is INHERENT: seam between layers modeling values
 * differently. Provenance layer boxes raw scalar; boolean/number → SchemeBool/AExact — but
 * symbol-contract layer (`output: [z.boolean]` ⇒ `DecodedReturn = boolean`) types by DECODED
 * shape, blind to box. Impl-side contract wants unboxed type (`string=?` is `: boolean`).
 * Surfacing box pushes widening into ~11 boxing-blind predicate/projection contracts —
 * value-model decision for provenance/contract design, not this leaf. AValue-branch `as T`
 * separately sound (`withProvenance` preserves subtype).
 */
export function withInputProvenance<T>(args: readonly unknown[], result: T): T {
  // Q20a/Q20b: oracle inactive skips accumulation (filter + union allocations), NOT
  // boxing — R1's boxed-value discipline is semantics; provenance is the payload being
  // skipped. ctx still propagates from the first AValue operand (heap-metering
  // channel, independent of provenance) via an allocation-free scan. "Inactive" is the
  // EFFECTIVE switch (ambient flag OR silent-region γ, see `isEagerAccumulationActive`'s
  // doc) — Q20b's production default is OFF, but a replay running inside a silent
  // region still accumulates regardless of the ambient default.
  if (!isEagerAccumulationActive()) {
    if (result instanceof AValue) return result;
    const t = typeof result;
    if (t === "string" || t === "number" || t === "bigint" || t === "boolean") {
      let ctx = CONSTANT_CTX;
      for (const a of args) {
        if (a instanceof AValue) {
          ctx = a.ctx;
          break;
        }
      }
      return fromJs(ctx, result, EMPTY_PROVENANCE) as T;
    }
    return result;
  }
  const inputs = args.filter((a): a is AValue => a instanceof AValue);
  if (result instanceof AValue) {
    if (inputs.length === 0) return result;
    const prov = unionProvenance(inputs);
    return (prov.size === 0 ? result : result.withProvenance(prov)) as T;
  }
  const t = typeof result;
  if (t === "string" || t === "number" || t === "bigint" || t === "boolean") {
    const ctx = inputs.length > 0 ? inputs[0].ctx : CONSTANT_CTX;
    const prov = inputs.length > 0 ? unionProvenance(inputs) : EMPTY_PROVENANCE;
    return fromJs(ctx, result, prov) as T;
  }
  return result;
}

// Re-export singletons cluster ops need for direct boolean boxing — single import source.
export { schemeTrue, schemeFalse } from "./primitives/ABool.js";

/** Scheme face of predicate verdict — shared flyweights (eq?-stable, empty provenance).
 *  Every env pack's boolean-returning native boxes here under the Face split (`z.boolean`
 *  output demands ABool, never raw JS boolean). */
export const schemeBool = (v: boolean): ABool => (v ? schemeTrue : schemeFalse);

/**
 * THE ONE boolean-VERDICT boxing point (RULINGS.md R8, two-tier-exec-api.md §6):
 * provenance-free operands → eq?-stable flyweight (schemeTrue/schemeFalse — allocation-free
 * hot loops); stamped operands → fresh ABool carrying union. Verdict from lineage carries it;
 * from constants doesn't. This composition lived ad hoc in `deriveOrd` — naming here makes it
 * the law every boolean-verdict site (equal?/eqv?/eq?, numeric comparison wrappers, predicate
 * natives returning boolean through wrap layer) routes through, replacing the raw-boolean
 * fast-path sites used on empty-provenance operands.
 */
export function mintVerdict(operands: readonly unknown[], verdict: boolean): ABool {
  return withInputProvenance(operands, schemeBool(verdict));
}

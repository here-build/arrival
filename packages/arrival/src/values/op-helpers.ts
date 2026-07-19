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
import { CONSTANT_CTX, type RunContext } from "./primitives/RunContext.js";
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
import { is_promise } from "../eval/guards.js";
import { type ANumeric } from "./numbers.js";
import { type SchemeValue } from "./types.js";
import { ACharacter } from "./primitives/ACharacter.js";
import { attachOffendingValue, ComparatorRequiredError } from "../errors.js";
import { tf } from "./tagless-final.js";

// Eager-stamp oracle flag: `withInputProvenance`/`mintVerdict` below are the
// accumulation path production used to run unconditionally, and that the CI
// agreement oracle (`wireframe-agreement.law.test.ts`, the replay laws' recorded-
// ground-truth side, and older tests written against the always-on default) still
// need on demand. OFF skips stamp accumulation (the filter + union-set allocations)
// while the boxed-value discipline stays intact — production hot paths no longer
// accumulate by default: the eager stamp path is a TEST-ONLY oracle, compiled out
// of production hot paths by default, not an opt-out. Flag is module-GLOBAL — right
// granularity for a whole process (the sampler's own runner, or a test file's
// beforeAll/afterAll); the upgrade path if a single process ever needs stamped AND
// unstamped envs simultaneously is a RunContext-carried flag, not a second global.
let eagerProvenanceOracleEnabled = false;

/** Is the eager-stamp oracle (this file's `withInputProvenance`/`mintVerdict`
 *  accumulation) live? Default FALSE; `withInputProvenance` branches on it.
 *  Reports the raw AMBIENT flag only — NOT the effective in-γ state
 *  {@link withInputProvenance} also consults (see its own doc): a caller inside a
 *  silent region sees `false` here even though accumulation is in fact running for
 *  that call, because replay-correctness is a property of WHERE the call runs, not of
 *  this module-global switch. Existing readers (`wireframe-agreement.law.test.ts`)
 *  depend on this function mirroring exactly what `setEagerProvenanceOracleEnabled`
 *  last wrote — do not fold the OR in here. */
export function isEagerProvenanceOracleEnabled(): boolean {
  return eagerProvenanceOracleEnabled;
}

/** Opt out of (or back into) eager stamp accumulation process-wide. Values still
 *  box per the boxed-value discipline; OFF means they carry EMPTY provenance
 *  (outside a silent region — see {@link withInputProvenance}). Intended for
 *  provenance non-consumers (sampler runners) to opt OUT, and for the CI agreement
 *  oracle / older test suites to opt back IN for their own lifetime; tests restore
 *  the ambient default afterward. */
export function setEagerProvenanceOracleEnabled(enabled: boolean): void {
  eagerProvenanceOracleEnabled = enabled;
}

/**
 * The EFFECTIVE accumulation switch {@link withInputProvenance}/`mintVerdict` actually
 * branch on: the ambient module flag OR "we are inside a silent region right now"
 * ({@link isSilentRegion}, `values/primitives/region-scope.ts`).
 *
 * WHY the OR is load-bearing, not a convenience: every γ/replay face
 * (`provenance/gamma.ts`'s `hermeticApply`/`applyWireInEnv`, and therefore all three of
 * `provenance/replay.ts`'s drivers) re-executes a wire's body through this SAME
 * interpreter, wrapped in `withSilentRegion` for its entire dynamic extent. A wire body
 * is ordinary pure-op composition (`(+ a b)`, `string-append`, …) over ingress values
 * that were boxed with their RECORDED stamp ids (`replay.ts`'s `boxPayload`) — the
 * only mechanism that unions those ids through the wire's arithmetic into the egress's
 * OWN `.provenance` is this file's accumulation. If the ambient production default is
 * OFF and γ did not force it back on for its own execution, replay would silently
 * reproduce an EGRESS VALUE with the right JS payload but EMPTY provenance —
 * correct-looking, wrong lineage — breaking the wire-γ adjunction and the replay laws
 * in PRODUCTION, not just in a test. Gating on `isSilentRegion()` here (rather than γ
 * explicitly flipping the module flag around its own call) means every replay path is
 * correct BY CONSTRUCTION — there is no second call site to remember to wrap, and
 * nothing outside a silent region is affected: a production hot path with the ambient
 * flag OFF and no silent region ambient sees zero accumulation.
 *
 * EXPORTED (not file-private) because two hand-rolled `unionProvenance(...)` call
 * sites never went through `withInputProvenance` in the first place, and therefore
 * never respected the oracle flag: `env/r7rs/numeric.ts`'s `nativeNumericOp`/
 * `applyNumeric` (EVERY arithmetic op — `+`/`-`/`*`/`/`/comparisons/…) and its
 * `numberToStringFn`. Those two sites import this function instead of duplicating
 * the OR — see their own call-site comments. Arithmetic is the hot path, so this is
 * the load-bearing correctness gap for "production hot paths stop accumulating by
 * default"; other hand-rolled sites (`rosetta.ts`'s `argProvenance`,
 * `common/symbols/rosetta.ts`'s pipe-role mint) are lower-traffic and left alone.
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
// Default 2^24: worst case (~32MB UTF-16 / one 16M-slot array) is recoverable.
const allocationLimit = 1 << 24; // 16,777,216

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
/**
 * Unwrap an `ACharacter`. Refuses anything else — it does NOT silently mint a wrong value.
 *
 * B1-SIBLING (found by the cross-chart divergence gate, 2026-07-14). This was a BLIND CAST:
 * `(char as ACharacter).__char__`. Handed anything that is not a character — an `AString`, a
 * number, `nil` — it read `undefined` off a value that has no such field, and the caller then
 * did `chars.join("")`, which turns `undefined` into `""` and swallows the evidence whole. So
 * `(list->string '(1 2))` answered `""`. Not an error. Not a wrong string. THE EMPTY STRING —
 * indistinguishable from a correct answer over an empty list.
 *
 * It is exactly the failure `stringValue` above was hardened against a few hours earlier — a
 * coercion helper minting a plausible-looking wrong value instead of a door — and it survived that
 * audit because the audit swept `stringValue`'s call sites and never turned to look at its
 * neighbour. The class, not the instance, is the thing to fix: a coercion helper in this tree may
 * never answer with a value it had to invent.
 */
export function charValue(char: unknown): string {
  if (char instanceof ACharacter) return char.__char__;
  throw attachOffendingValue(
    new TypeError(`expected a character, got ${char instanceof AValue ? char.kind : typeof char}: ${previewOf(char)}`),
    char,
  );
}

// B1 (benchmark-defect-register.md) — container/nil kinds `stringValue` refuses to
// silently coerce. `String(nil)` → `"()"` (a plausible-looking but WRONG string)
// propagated through all 51 string ops (`(string-length nil)` → 2, `(string-append "x"
// nil)` → `"x()"`, `(string=? nil "()")` → `#t`); one model saw the length-2 result,
// concluded "probably truncated," and fled to Python. AUDITED (all ~40 call sites in
// strings.ts/srfi-13.ts/srfi-28.ts/bytevectors.ts/vectors.ts/equality.ts): every one
// declares a `z.string`-typed argument and expects a genuine AString — none depends on
// coercing a container. `symbol.native`'s contracts are TYPE-ONLY (never runtime-
// validated, `_bake.ts`'s own doctrine) — a container reaching here is exactly the
// unchecked-native-tier hole the register calls out, not a caller doing it on purpose.
// Leaf/scalar kinds (character, symbol, number, boolean) KEEP the `String(x)` fallback —
// narrower than "throw on anything non-AString" per the register's explicit ruling.
const STRING_COERCION_REFUSED_KINDS = new Set(["pair", "nil", "vector", "object", "dict"]);

/** Best-effort short preview for a door message — never throws, truncated. */
function previewOf(v: unknown): string {
  let s: string;
  try {
    s = String(v);
  } catch {
    s = "<unprintable>";
  }
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Unwrap AString.valueOf(); String(str) for leaf/scalar kinds; throws for container/nil
 *  kinds instead of minting a plausible-looking wrong string (B1). */
export function stringValue(str: unknown): string {
  if (str instanceof AString) return str.valueOf();
  if (str instanceof AValue && STRING_COERCION_REFUSED_KINDS.has(str.kind)) {
    throw attachOffendingValue(new TypeError(`expected a string, got ${str.kind}: ${previewOf(str)}`), str);
  }
  return String(str);
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
  throw attachOffendingValue(new TypeError(`${fnName}: expected vector`), obj);
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
      throw attachOffendingValue(new TypeError(`${fnName}: expected bytevector, got ${typeof obj}`), obj);
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
  comparator: ((a: unknown, b: unknown) => unknown) | undefined,
  runCtx: RunContext,
): (a: unknown, b: unknown) => number {
  if (comparator !== undefined && comparator !== null) {
    // Comparator is a callable VALUE (ANativeProcedure) — invoke through the seam, not bare fn.
    // Sort sync; native cmp returns settled value (lambda cmp → promise, pre-existing limitation).
    // `runCtx` threaded (Wave 1, arrival-constant-ctx-audit-2026-07-11.md §2.5 — was the
    // audit's own top-5 row): both callers (APair/AVector's own `sort` term) already hold a
    // required, live `runCtx` one hop away. NOTE: this closes the ctx-honesty gap only —
    // region-scope.ts's own header names a SEPARATE, still-open gap (no `RegionScope` opens
    // around this comparator loop, so host-schedule/order-attribution provenance isn't
    // recorded here); that needs `withRegionCall` wiring, a distinct Wave-4 design task this
    // fix does not invent.
    const call = (a: unknown, b: unknown): unknown => applyCallback(comparator, [a, b], runCtx);
    // Host-schedule wiring: `sort`'s comparator is the canonical order-dependent
    // selector host — its verdict SEQUENCE (not any single verdict) is the record
    // ("the sequence IS the record"). `recordHostScheduleVerdict` already no-ops
    // under emission-off/silent-region/no-coordinate (region-scope.ts's own gates) —
    // the only thing THIS call site adds is reading the ambient scope and attributing
    // a triple to it. No ambient RegionScope (today's entire production call graph
    // outside a tracked crossing — see `currentRegionScope`'s own doc) ⇒ one
    // `undefined` check, zero further cost.
    //
    // ELEMENT ORDINALS: `Array.prototype.sort`'s comparator signature carries no
    // element INDEX, only the two VALUES — true per-element ordinal paths are not
    // threadable through it without a deeper host-sort rewrite. Falls back to
    // comparator CALL ORDER as the ordinal proxy: the n-th comparator invocation this
    // sort performs is recorded as `([n], [n+1])` — a real, monotonic, per-sort-call
    // attribution (never reused across two different `deriveSortCompare` calls, since
    // `callOrdinal` is closed over fresh per call), just not a positional index into
    // the original array. Only SOME attributable path is required, not the true
    // element position.
    let callOrdinal = 0;
    return (a, b) => {
      const v = call(a, b);
      // S1 (benchmark-defect-register.md) — a LAMBDA comparator's settled value is a
      // Promise (lambda bodies run through the trampolined async evaluator; a native/
      // rosetta comparator never is). None of the three verdict branches below recognize
      // a Promise, so the `is_false` fallthrough minted a CONSTANT -1 for every pair —
      // TimSort then emits a deterministic wrong order (= reverse(input)) with NO error.
      // Interim honest door (full async threading is a Wave-4-sized rework of `sort`'s
      // own term algebra — see the register): throw instead of silently mis-sorting.
      if (is_promise(v)) {
        throw attachOffendingValue(
          new TypeError(
            "sort: a lambda comparator is not supported yet (its result resolves " +
              "asynchronously) — use a native comparator directly, e.g. `(sort xs <)`, " +
              "or sort by a derived key instead of comparing with a lambda.",
          ),
          v,
        );
      }
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
    if (!isOrd(a)) throw new ComparatorRequiredError(describeOrdElement(a));
    if (!isOrd(b)) throw new ComparatorRequiredError(describeOrdElement(b));
    const aLE = lte(a, b);
    const bLE = lte(b, a);
    return aLE ? (bLE ? 0 : -1) : bLE ? 1 : 0;
  };
}

// Numeric coercion into SchemeExact/SchemeInexact tower

/**
 * THREADING GAP, confessed (arrival-constant-ctx-audit-2026-07-11.md §2.5): the boxed-operand
 * arm below correctly preserves the operand's OWN `.ctx`; the raw JS bigint/number arms have
 * no operand ctx to preserve and mint fresh under `ctx`. `ctx` is OPTIONAL, defaulting to
 * `CONSTANT_CTX` — every current caller (`env/r7rs/numeric.ts`'s `applyNumeric`,
 * `env/r7rs/strings.ts`, `env/r7rs/chars.ts`) lives in the env/r7rs cluster (a parallel
 * agent's file scope, out of bounds here) and does not yet pass one. The honest completion —
 * each of those call sites threading its own live `runCtx`/`ctxOf(value)` — is THAT cluster's
 * job; this signature exists so it can be wired without a second signature change.
 */
export function coerceNumeric(value: unknown, ctx: RunContext = CONSTANT_CTX): ANumeric {
  switch (true) {
    case value instanceof AExact:
    case value instanceof AInexact:
      return value;
    // §2.3's opaque-host-value law (docs/design-history/arrival-one-number-rework.md):
    // a bigint is NOT a scheme number — never silently minted into a (possibly
    // out-of-range) exact. Door here, the arithmetic-coercion entry point, naming the
    // explicit escape hatch (`bigint->number`, the safe-range-checked conversion).
    case typeof value === "bigint":
      throw new TypeError(
        "host bigint is not a scheme number — use bigint->number (safe-range checked) to convert explicitly",
      );
    // Safe ints exact (likely Scheme int literals); non-safe + floats inexact
    case typeof value === "number":
      return Number.isSafeInteger(value) ? new AExact(ctx, value) : new AInexact(ctx, value);
    case value && typeof value === "object" && "valueOf" in value && typeof value.valueOf === "function": {
      const val = value.valueOf();
      switch (true) {
        case typeof val === "bigint":
          throw new TypeError(
            "host bigint is not a scheme number — use bigint->number (safe-range checked) to convert explicitly",
          );
        case typeof val === "number":
          return Number.isSafeInteger(val) ? new AExact(ctx, val) : new AInexact(ctx, val);
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
 * Scalars boxed UNCONDITIONALLY (bare-value purge, RULINGS.md R1/P4): inside the
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
  // Oracle inactive skips accumulation (filter + union allocations), NOT boxing — the
  // boxed-value discipline is semantics; provenance is the payload being skipped. ctx
  // still propagates from the first AValue operand (heap-metering channel, independent
  // of provenance) via an allocation-free scan. "Inactive" is the EFFECTIVE switch
  // (ambient flag OR silent-region γ, see `isEagerAccumulationActive`'s doc) — the
  // production default is OFF, but a replay running inside a silent region still
  // accumulates regardless of the ambient default.
  if (!isEagerAccumulationActive()) {
    if (result instanceof AValue) return result;
    const t = typeof result;
    if (t === "string" || t === "number" || t === "bigint" || t === "boolean") {
      // PRE-RUN LEGITIMATE, re-verified (arrival-constant-ctx-audit-2026-07-11.md §2.5):
      // scans `args` for the first boxed operand and inherits ITS ctx — CONSTANT_CTX only
      // when literally no boxed operand exists among `args` (a genuinely ctx-less call),
      // the correct `ctxOf`-style idiom already inlined here.
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
    // PRE-RUN LEGITIMATE, re-verified — same idiom as the inactive-oracle branch above:
    // CONSTANT_CTX only when `inputs` is empty (no boxed operand to inherit from).
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
 * THE ONE boolean-VERDICT boxing point (RULINGS.md R8):
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

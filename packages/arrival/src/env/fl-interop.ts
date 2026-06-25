/**
 * Array-interop overlay — the genuine interop members of the inference-plane base
 * env (`inferenceEnv`), carved out of the hand-built overlay in `inference-env.ts`.
 * These are the members with NO equivalent in the assembled base: the AJSArray-
 * aware `car`/`cdr` and the term-dispatching, nil-tolerant `filter`/`map`/`reduce`.
 *
 * Why a separate capability and not an inline spread: this overlay bridges interop
 * mismatches the base env does NOT — lazy JS-array wrappers (`AJSArray`) that
 * must unwrap before LIPS car/cdr, and the nil tolerance the sequence ops
 * need at the inference boundary.
 *
 * SEQUENCE OPS ARE ON THE TERM. `filter`/`map`/`reduce` no longer DISPATCH a borrowed
 * Fantasy-Land algebra through a collect→apply→reconstruct bridge: each arrival sequence
 * primitive (APair, AVector) carries its OWN async-aware `arrival/tagless-final/{map,
 * filter,reduce}` method (provenance-aware, awaiting the user fn — live LIPS lambdas
 * return Promises), and this overlay is a thin program that delegates to it, blind to
 * which term implements it (Carette, Kiselyov & Shan, "Finally Tagless, Partially
 * Evaluated", 2009). A Pair's map PRESERVES element boxes (it stays an arrival list); a
 * SchemeVector's map STRIPS them (it crosses OUT to a foreign Functor — the DR4 box-strip).
 * The box discipline lives on each term, not here.
 *
 * LAZY BUILTIN CAPTURE (load-order discipline): the `car`/`cdr`/`filter`/`map`/
 * `reduce` it overrides delegate (in their fallback arm) to the assembled base versions
 * (`builtinCar` …). Those are read from `global_env` LAZILY — at first symbol invocation,
 * never eagerly at module top-level. Eager `global_env.get("car")` at module load races
 * the async assembly of the value-domain clusters onto global_env: a load-order miss
 * captures `undefined` (the exact bug a prior `SAFE_BUILTINS` eager snapshot hit). At call
 * time global_env is fully assembled, so the read is safe — and this pack is assembled onto
 * inferenceEnv only AFTER global_env's native assembly + the base packs, so the builtins are
 * live before any symbol here can fire.
 */

import { EnvCapability } from "../common/capability.js";
import { type RunContext } from "../values/primitives/RunContext.js";
import { symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import { global_env } from "../stdlib.js";
import { AJSArray } from "../values/primitives/js-wrappers.js";
import { AExact, AInexact, type ANumeric } from "../values/numbers.js";
import { APair } from "../values/primitives/APair.js";
import { AVector } from "../values/primitives/AVector.js";
import { AValue, unionProvenance } from "../values/primitives/AValue.js";
import { isOrd, nilOrderCompare, withInputProvenance, type AOrd } from "../values/op-helpers.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { heapBudgetMessage } from "../heap-budget.js";
import { SchemeError } from "../eval/evaluator.js";

type Callable = (...args: unknown[]) => unknown;

// ── Lazy builtin capture ────────────────────────────────────────────────────
// Read once on first use, after bootstrap, when global_env is fully assembled.
let builtinMap: Callable | undefined;

// Comparison builtins — bridged Operators (=/</>/<=/>=). Captured lazily for the
// nil-tolerant overrides below (the operator membrane throws on a nil operand at
// codec-match time, before the op body runs; we intercept that one case).
let builtinNumEq: Callable | undefined;
let builtinLt: Callable | undefined;
let builtinGt: Callable | undefined;
let builtinLte: Callable | undefined;
let builtinGte: Callable | undefined;

function captureBuiltins(): void {
  if (builtinMap !== undefined) return;
  builtinMap = global_env.get("map", { throwError: false }) as Callable;
  builtinNumEq = global_env.get("=", { throwError: false }) as Callable;
  builtinLt = global_env.get("<", { throwError: false }) as Callable;
  builtinGt = global_env.get(">", { throwError: false }) as Callable;
  builtinLte = global_env.get("<=", { throwError: false }) as Callable;
  builtinGte = global_env.get(">=", { throwError: false }) as Callable;
}

// nil/'() is truthy in Scheme, so `is_false` does NOT catch it — a nil operand must
// be detected structurally. A null/undefined JS value or a Scheme Nil counts as the
// "absent value" that should compare to #f rather than crash the whole proof.
function isNilOperand(v: unknown): boolean {
  return v == null || (v as { constructor?: { name?: string } })?.constructor?.name === "ANil";
}

// ── Numeric Ord chain (plane-local) ─────────────────────────────────────────
// The 5 comparisons below derive PURELY from the operands' numeric `arrival/tagless-final/lte`
// (SchemeExact/SchemeInexact, added value-side) when EVERY operand is a number — no
// `global_env.get("=")` env-read. NaN ⇒ both `lte` directions are #f ⇒ every relation
// collapses to #f, exactly like the numeric Operators. A non-number operand (or arity 0)
// can't be served by `lte` without diverging from the Operator's membrane type-error, so
// it routes to the kept builtin (which IS that Operator — identical throw). nil is
// short-circuited to #f first (the plane's nil-tolerance, see filter/map).
const isNumberOperand = (v: unknown): v is ANumeric =>
  v instanceof AExact || v instanceof AInexact;
const flLteNum = (a: ANumeric, b: ANumeric): boolean => a["arrival/tagless-final/lte"](b);
// Each relation of the (partial — NaN-incomparable) numeric order, from the single `lte`.
// Strict </> use the CONJUNCTIVE form (`lte(a,b) && !lte(b,a)`), NOT `!lte(b,a)`: the
// latter is the total-order shortcut and would wrongly yield #t for a NaN pair.
const NUM_PAIR: Record<"=" | "<" | ">" | "<=" | ">=", (a: ANumeric, b: ANumeric) => boolean> = {
  "=": (a, b) => flLteNum(a, b) && flLteNum(b, a),
  "<": (a, b) => flLteNum(a, b) && !flLteNum(b, a),
  ">": (a, b) => flLteNum(b, a) && !flLteNum(a, b),
  "<=": (a, b) => flLteNum(a, b),
  ">=": (a, b) => flLteNum(b, a),
};
// Adjacent-pair chain — matches the Operators' `prev`-walk. (`=`'s Operator is
// first-vs-each, equivalent for an equivalence relation: with no NaN, transitivity makes
// adjacent ≡ first-vs-each; with a NaN, both forms hit a failing pair → #f.)
function numericChain(sym: "=" | "<" | ">" | "<=" | ">=", args: ANumeric[]): boolean {
  const rel = NUM_PAIR[sym];
  for (let i = 0; i < args.length - 1; i++) {
    if (!rel(args[i], args[i + 1])) return false;
  }
  return true;
}
// Stamp the verdict with the operands' provenance union — byte-identical to bridge.ts's
// wrapOperator (out: Bool): box to schemeTrue/schemeFalse ONLY when provenance is non-empty
// (empty ⇒ raw bool, to keep the `!== false`/find landmine callers alive), else withProvenance.
function numericCompare(sym: "=" | "<" | ">" | "<=" | ">=", args: ANumeric[]): unknown {
  const verdict = numericChain(sym, args);
  // Every operand is a SchemeExact/SchemeInexact (subtype of AValue), so union directly.
  const provenance = unionProvenance(args);
  if (provenance.size > 0) return (verdict ? schemeTrue : schemeFalse).withProvenance(provenance);
  return verdict;
}

// ── Loose universal order (nil-as-bottom) ───────────────────────────────────
// The four ordering relations, each derived from the two `lte` directions of a non-numeric
// Ord pair. Conjunctive </> (NOT the `!lte(b,a)` total-order shortcut) so they stay correct
// even if a NaN-incomparable value ever slipped through (it can't — numbers take the
// all-number fast path first — but the conjunctive form is the honest derivation).
const ORD_FROM_LE: Record<"<" | ">" | "<=" | ">=", (le_ab: boolean, le_ba: boolean) => boolean> = {
  "<": (ab, ba) => ab && !ba,
  ">": (ab, ba) => ba && !ab,
  "<=": (ab) => ab,
  ">=": (_ab, ba) => ba,
};
const describeOperand = (v: unknown): string =>
  v instanceof AValue ? v.kind : v === null || v === undefined ? String(v) : typeof v;
// One pair of the LOOSE universal order, nil-as-bottom aware. nil is the floor
// (nilOrderCompare); two numbers use the NaN-safe NUM_PAIR; two non-number Ord values use
// their `arrival/tagless-final/lte`. A pair that shares no order — one side not Ord, or BOTH
// lte directions false (cross-type incomparable, e.g. string vs number) — THROWS (V:
// "crashes on incompatible types, not the JS '' > [] coercion"). The both-false ⟺ cross-type
// test is sound here: numbers (the only NaN-incomparable Ord) already took the all-number
// fast path before we reach this.
function loosePairOrder(sym: "<" | ">" | "<=" | ">=", a: unknown, b: unknown): boolean {
  const nilCmp = nilOrderCompare(a, b);
  if (nilCmp !== undefined) return sym === "<" ? nilCmp < 0 : sym === ">" ? nilCmp > 0 : sym === "<=" ? nilCmp <= 0 : nilCmp >= 0;
  if (isNumberOperand(a) && isNumberOperand(b)) return NUM_PAIR[sym](a, b);
  if (!isOrd(a) || !isOrd(b)) throw new TypeError(`${sym}: cannot compare ${describeOperand(a)} and ${describeOperand(b)} — no shared order.`);
  const le_ab = Boolean((a as AOrd)["arrival/tagless-final/lte"](b));
  const le_ba = Boolean((b as AOrd)["arrival/tagless-final/lte"](a));
  if (!le_ab && !le_ba) throw new TypeError(`${sym}: cannot compare ${describeOperand(a)} and ${describeOperand(b)} — incompatible types.`);
  return ORD_FROM_LE[sym](le_ab, le_ba);
}
// n-ary loose ordering with nil-as-bottom — chains adjacent pairs (matches the Operators'
// prev-walk), forwarding the operands' provenance onto the verdict (never minting).
function looseOrderChain(sym: "<" | ">" | "<=" | ">=", args: unknown[]): unknown {
  let verdict = true;
  for (let i = 0; i < args.length - 1; i++) {
    if (!loosePairOrder(sym, args[i], args[i + 1])) {
      verdict = false;
      break;
    }
  }
  return withInputProvenance(args, verdict);
}
// The lazily-captured numeric builtin per symbol (read AFTER captureBuiltins()).
const NUM_BUILTIN: Record<"=" | "<" | ">" | "<=" | ">=", () => Callable | undefined> = {
  "=": () => builtinNumEq,
  "<": () => builtinLt,
  ">": () => builtinGt,
  "<=": () => builtinLte,
  ">=": () => builtinGte,
};
// The shared comparison impl, strict/loose-gated (V's F1/F2). STRICT = R7RS-faithful (the
// negative-test probe): numeric only — a non-number operand is rejected, so every cell where
// loose answers but strict throws is one documented divergence. LOOSE (default) = the friendly
// superset: numbers compute NaN-safely (numericCompare), nil is the order's BOTTOM (nil-punning
// for `=`, looseOrderChain for the orderings), and non-numeric Ord types route to the bridged
// operator's universal `wrapOrd` chain (which itself throws on a genuine cross-type pair). `=`
// stays NUMERIC equality (structural equality is `equal?`); its only nil concession is nil = nil.
function comparisonImpl(sym: "=" | "<" | ">" | "<=" | ">="): (args: unknown[], runCtx: RunContext) => unknown {
  return (args, runCtx) => {
    if (runCtx.strict) {
      if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare(sym, args);
      throw new TypeError(`${sym}: strict mode is R7RS-numeric — a non-number operand is rejected (use string<? / char<? / equal? for non-numbers).`);
    }
    if (args.some(isNilOperand)) {
      if (sym === "=") return withInputProvenance(args, args.every(isNilOperand)); // nil-punning: nil = nil only
      return looseOrderChain(sym, args);
    }
    if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare(sym, args);
    captureBuiltins();
    return NUM_BUILTIN[sym]()!(...args);
  };
}


// Materialize a collection's elements — a LIPS pair spine, a SchemeVector, a lazy
// AJSArray wrapper, or a raw JS array — to a flat element array. Used by
// `length` to see the full element set. As lenient as the old length: an
// unrecognized input yields `[]` (an empty collection).
//
// G6 (carrier-coercion soundness): the SchemeVector branch mirrors its twin
// `collapseProvenance` (provenance-collapse.ts), which already deep-walks
// `__vector__`. Without it a SchemeVector matched none of the branches and
// silently collected `[]` — so `(length vec)` counted 0, dropping every
// element's provenance with no error.
function collectElements(collection: any): unknown[] {
  const elements: unknown[] = [];
  if (collection && typeof collection === "object" && "car" in collection) {
    let current = collection; // LIPS list — walk the spine.
    while (current?.constructor && current.constructor.name !== "ANil") {
      elements.push(current.car);
      current = current.cdr;
    }
  } else if (collection instanceof AVector) {
    elements.push(...collection.__vector__); // boxed vector — its elements carry provenance
  } else if (collection instanceof AJSArray) {
    elements.push(...collection.source); // lazy JS-array wrapper from `@`/membrane
  } else if (Array.isArray(collection)) {
    elements.push(...collection);
  }
  return elements;
}

// chargeAndDispatch — the sequence ops' thin program: charge the run's allocation meter, then
// dispatch to the receiver's OWN arrival/tagless-final/<op>. The EAGER materializers (APair/
// AVector) charge runCtx.heapMeter by element count BEFORE walking — a native pass emits no
// trampoline TICK, so without it a `(map f huge)`/O(K²) churn runs unbounded (heap-budget.ts);
// ANil is empty. The per-primitive box discipline + fold convention all live ON the term. A
// receiver with NO such algebra
// (a AJSArray, a number) is TOTALIC — "does not support <op>", the uniform DR4 wrong-carrier
// throw, never a silent coercion. Heap stays holder-free here (runCtx, not currentRunEnv).
function chargeAndDispatch(
  method: "map" | "filter" | "reduce" | "sort",
  receiver: unknown,
  leading: unknown[],
  runCtx: RunContext,
): unknown {
  if (receiver instanceof APair || receiver instanceof AVector) {
    const meter = runCtx.heapMeter;
    if (meter !== undefined) {
      let count = 0;
      if (receiver instanceof AVector) {
        count = receiver.__vector__.length;
      } else {
        let cur: unknown = receiver;
        while (cur instanceof APair) {
          count++;
          cur = cur.cdr;
        }
      }
      meter.used += count;
      if (meter.used > meter.max) throw new SchemeError(heapBudgetMessage(meter.max), []);
    }
  }
  const m = (receiver as Record<string, unknown> | null | undefined)?.[`arrival/tagless-final/${method}`];
  if (typeof m !== "function") {
    const kind = receiver instanceof AValue ? receiver.kind : receiver == null ? String(receiver) : typeof receiver;
    throw new TypeError(
      `${method}: the ${kind} primitive does not support ${method} (no arrival/tagless-final/${method}).`,
    );
  }
  return (m as (...a: unknown[]) => unknown).call(receiver, ...leading);
}

// ── The interop overlay symbols ──────────────────────────────────────────────

export default new EnvCapability("scheme/fl-interop", {
  symbols: {
    // map/filter/reduce — the inference-plane sequence ops, DISSOLVED onto the term protocol.
    // The per-primitive semantics live ON the terms (APair/AVector eager + box-discipline, ANil
    // empty); the binding is a thin ctx-aware program (chargeAndDispatch) that charges
    // runCtx.heapMeter and dispatches, TOTALIC for a non-sequence receiver. The old null/#f→nil
    // tolerance is DROPPED: mapping a non-sequence is a type error, not an empty result — only '()
    // is empty (via ANil). The box discipline (Pair preserves boxes, Vector strips — the DR4
    // box-strip), the keep-rule, and the element-first fold all live on the terms.
    filter: symbol.sequence`filter: keep elements matching a pred/regex — term-dispatch, totalic`(
      { input: [z.unknown(), z.unknown()], output: [z.unknown()] },
      (args, runCtx) => chargeAndDispatch("filter", args[1], [args[0]], runCtx),
    ),
    map: symbol.sequence`map: fn over one list (term-dispatch) or zip over several`(
      { input: z.tuple([z.unknown()], z.unknown()), output: [z.unknown()] },
      (args, runCtx) => {
        const [fn, ...lists] = args;
        if (lists.length === 1) return chargeAndDispatch("map", lists[0], [fn], runCtx);
        // A multi-list map is a ZIP, not a Functor op — delegate to the base scheme `map` (zip +
        // pair|nil typecheck). builtinMap resolves through global_env (the base, NOT this inference
        // override), so there is no recursion.
        captureBuiltins();
        return builtinMap!(fn, ...lists);
      },
    ),
    reduce: symbol.sequence`reduce: left fold in scheme convention fn(element, acc) — term-dispatch`(
      { input: [z.unknown(), z.unknown(), z.unknown()], output: [z.unknown()] },
      (args, runCtx) => chargeAndDispatch("reduce", args[2], [args[0], args[1]], runCtx),
    ),

    // ── Nil-tolerant comparisons (plane-local) ──────────────────────────────────
    // The operator membrane rejects a nil operand at codec-match time (the `=`/`<`/…
    // Operators declare `in: [SchemeNum]`), so a comparison against an absent value
    // (a nil PID, an unmatched lookup) throws before the body runs — forcing models
    // to write defensive `(if (nil? x) … (= x …))` guards. Completing the plane's
    // existing nil-tolerance grain (see filter/map): a nil operand resolves the
    // comparison to #f rather than crashing the proof. Non-nil NUMBER operands compute
    // by-value via their `arrival/tagless-final/lte` (numericChain — no env-read, byte-identical
    // to the =/</>/<=/>= Operators incl. NaN/cross-type); a non-number (or arity-0) operand
    // falls back to the kept bridged builtin, which is that Operator (identical throw).
    "=": symbol.sequence`=: numeric equality — loose: nil-punning (nil = nil); strict: R7RS-numeric`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      comparisonImpl("="),
    ),
    "<": symbol.sequence`<: order — loose: universal via lte + nil-as-bottom; strict: R7RS-numeric`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      comparisonImpl("<"),
    ),
    ">": symbol.sequence`>: order — loose: universal via lte + nil-as-bottom; strict: R7RS-numeric`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      comparisonImpl(">"),
    ),
    "<=": symbol.sequence`<=: order — loose: universal via lte + nil-as-bottom; strict: R7RS-numeric`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      comparisonImpl("<="),
    ),
    ">=": symbol.sequence`>=: order — loose: universal via lte + nil-as-bottom; strict: R7RS-numeric`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      comparisonImpl(">="),
    ),

    // sort — SRFI-95 `(sort seq comparator?)`, DISSOLVED onto the term protocol (like
    // map/filter/reduce). The per-primitive semantics live ON the terms: APair → sorted
    // LIST (boxes preserved, container box dropped), AVector → fresh sorted VECTOR, ANil →
    // nil — container-preserving by each term returning its own shape. The DEFAULT order is
    // the operand's own `arrival/tagless-final/lte` (deriveSortCompare on the term), NOT JS
    // lexicographic: `(sort '(2 10))` is now (2 10), the lte-default bug-fix; sort is
    // total-order-correct for every Ord-bearing type. A comparator is a SRFI-95 `less?`
    // predicate, ASSUMED SYNC. Routed through chargeAndDispatch so it charges runCtx.heapMeter
    // before materializing the full array (it allocates the whole spine), TOTALIC for a
    // non-sequence receiver. The comparator is the single leading arg.
    sort: symbol.sequence`sort: a sorted sequence (list→list, vector→vector); default order is the elements' own ≤`(
      { input: [z.unknown(), z.unknown().optional()], output: [z.unknown()] },
      (args, runCtx) => chargeAndDispatch("sort", args[0], [args[1]], runCtx),
    ),

    length: symbol.native`length: element count carrying the elements' provenance`(
      { input: [z.unknown()], output: [z.unknown()] },
      (collection: any) => {
        // Collect elements so the count can carry their provenance (V: "provenance
        // everything; exclusion should not be possible in teleological mode"). A
        // `(count …)`/`(length …)` the seal can't sign — even though every row that
        // produced it was grounded — is exactly the hole the teleological seal forbids.
        const elements = collectElements(collection);
        const count = elements.length;
        const inputs = elements.filter((e): e is AValue => e instanceof AValue);
        if (inputs.length === 0) return count;
        const prov = unionProvenance(inputs);
        return prov.size === 0 ? count : AValue.fromJs(inputs[0].ctx, count, prov);
      },
    ),

  },
});

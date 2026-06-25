/**
 * Array-interop overlay — the genuine interop members of the inference-plane base
 * env (`inferenceEnv`), carved out of the hand-built overlay in `inference-env.ts`.
 * These are the members with NO equivalent in the assembled base: the SchemeJSArray-
 * aware `car`/`cdr` and the term-dispatching, nil-tolerant `filter`/`map`/`reduce`.
 *
 * Why a separate capability and not an inline spread: this overlay bridges interop
 * mismatches the base env does NOT — lazy JS-array wrappers (`SchemeJSArray`) that
 * must unwrap before LIPS car/cdr, and the nil/LazySeq tolerance the sequence ops
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

import { EnvCapability } from "./capability.js";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";
import { symbol } from "./symbol.js";
import * as z from "./scheme-zod.js";
import { global_env } from "../stdlib.js";
import { nil } from "../values/primitives/ANil.js";
import { SchemeJSArray } from "../membrane.js";
import { AExact, AInexact, type ANumeric } from "../values/numbers.js";
import { APair } from "../values/primitives/APair.js";
import { AVector } from "../values/primitives/AVector.js";
import { AValue, unionProvenance, EMPTY_PROVENANCE, ctxOf } from "../values/primitives/AValue.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { ALazySeq, is_lazy_seq } from "../values/primitives/ALazySeq.js";
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


// Materialize a collection's elements — a LIPS pair spine, a SchemeVector, a lazy
// SchemeJSArray wrapper, or a raw JS array — to a flat element array. Shared by
// `length` and the `lazy-seq` constructor so both see the same element set. As
// lenient as the old length: an unrecognized input yields `[]` (an empty collection).
//
// G6 (carrier-coercion soundness): the SchemeVector branch mirrors its twin
// `collapseProvenance` (provenance-collapse.ts), which already deep-walks
// `__vector__`. Without it a SchemeVector matched none of the branches and
// silently collected `[]` — so `(length vec)` counted 0 and `(lazy-seq vec)` held
// an empty plan, dropping every element's provenance with no error.
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
  } else if (collection instanceof SchemeJSArray) {
    elements.push(...collection.source); // lazy JS-array wrapper from `@`/membrane
  } else if (Array.isArray(collection)) {
    elements.push(...collection);
  }
  return elements;
}

// A18d — un-forced egress is a programmer error (LazySeq.ts header). An accessor
// the first cut hasn't taught to force a LazySeq throws LOUD here, never returns a
// silent nil/empty. The lazy plane is map/filter (extend) → length/iterate/reduce
// (force); everything else forces explicitly or waits for a later slice.
function unforcedLazyEgress(op: string): never {
  throw new Error(
    `\`${op}\` received an un-forced lazy-seq — the first cut supports map/filter then ` +
      `length/iterate/reduce only. Force it to a list before \`${op}\` (a later slice may teach it to force).`,
  );
}

// chargeAndDispatch — the sequence ops' thin program: charge the run's allocation meter, then
// dispatch to the receiver's OWN arrival/tagless-final/<op>. The EAGER materializers (APair/
// AVector) charge runCtx.heapMeter by element count BEFORE walking — a native pass emits no
// trampoline TICK, so without it a `(map f huge)`/O(K²) churn runs unbounded (heap-budget.ts); a
// LazySeq extends a plan (no materialize → no charge) and ANil is empty. The per-primitive box
// discipline + fold convention + lazy plan all live ON the term. A receiver with NO such algebra
// (a SchemeJSArray, a number) is TOTALIC — "does not support <op>", the uniform DR4 wrong-carrier
// throw, never a silent coercion. Heap stays holder-free here (runCtx, not currentRunEnv).
function chargeAndDispatch(
  method: "map" | "filter" | "reduce",
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
    // The per-primitive semantics live ON the terms (APair/AVector eager + box-discipline, ALazySeq
    // lazy, ANil empty); the binding is a thin ctx-aware program (chargeAndDispatch) that charges
    // runCtx.heapMeter and dispatches, TOTALIC for a non-sequence receiver. The old null/#f→nil
    // tolerance is DROPPED: mapping a non-sequence is a type error, not an empty result — only '()
    // is empty (via ANil). The box discipline (Pair preserves boxes, Vector strips — the DR4
    // box-strip), the keep-rule, the element-first fold, and the lazy plan all live on the terms.
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
    "=": symbol.native`=: numeric =, nil-tolerant (a nil operand ⇒ #f)`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      function numEq(...args: unknown[]) {
        if (args.some(isNilOperand)) return false;
        if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare("=", args);
        captureBuiltins();
        return builtinNumEq!(...args);
      },
    ),
    "<": symbol.native`<: numeric <, nil-tolerant`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      function lt(...args: unknown[]) {
        if (args.some(isNilOperand)) return false;
        if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare("<", args);
        captureBuiltins();
        return builtinLt!(...args);
      },
    ),
    ">": symbol.native`>: numeric >, nil-tolerant`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      function gt(...args: unknown[]) {
        if (args.some(isNilOperand)) return false;
        if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare(">", args);
        captureBuiltins();
        return builtinGt!(...args);
      },
    ),
    "<=": symbol.native`<=: numeric <=, nil-tolerant`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      function lte(...args: unknown[]) {
        if (args.some(isNilOperand)) return false;
        if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare("<=", args);
        captureBuiltins();
        return builtinLte!(...args);
      },
    ),
    ">=": symbol.native`>=: numeric >=, nil-tolerant`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      function gte(...args: unknown[]) {
        if (args.some(isNilOperand)) return false;
        if (args.length >= 1 && args.every(isNumberOperand)) return numericCompare(">=", args);
        captureBuiltins();
        return builtinGte!(...args);
      },
    ),

    // ── Array-aware list accessors ───────────────────────────────────────────────
    // Nil-tolerant accessors that work over both JS arrays (what `@`/SchemeJSArray
    // hand the inference plane) and LIPS pairs. Self-contained — no builtin capture.

    // ── List aliases (models expect these) ──
    // Each guards against an un-forced lazy-seq (A18d): without it these silently
    // return nil for a LazySeq (no `.car`, not an array), masking the misuse.
    first: symbol.native`first: the first element — array- and pair-aware`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: any) => {
        if (is_lazy_seq(list)) unforcedLazyEgress("first");
        return list?.car ?? (Array.isArray(list) ? list[0] : nil);
      },
    ),
    last: symbol.native`last: the last element — array- and pair-aware`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: any) => {
        if (is_lazy_seq(list)) unforcedLazyEgress("last");
        if (Array.isArray(list)) return list.at(-1) ?? nil;
        let current = list;
        while (current?.cdr?.constructor?.name !== "ANil" && current?.cdr != null) {
          current = current.cdr;
        }
        return current?.car ?? nil;
      },
    ),
    second: symbol.native`second: the second element — array- and pair-aware`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: any) => {
        if (is_lazy_seq(list)) unforcedLazyEgress("second");
        return list?.cdr?.car ?? (Array.isArray(list) ? list[1] : nil);
      },
    ),
    third: symbol.native`third: the third element — array- and pair-aware`(
      { input: [z.unknown()], output: [z.unknown()] },
      (list: any) => {
        if (is_lazy_seq(list)) unforcedLazyEgress("third");
        return list?.cdr?.cdr?.car ?? (Array.isArray(list) ? list[2] : nil);
      },
    ),

    // ── Association lists ──
    assoc: symbol.native`assoc: the alist entry whose key equals key, else nil`(
      { input: [z.unknown(), z.unknown()], output: [z.unknown()] },
      (key: any, alist: any) => {
        if (is_lazy_seq(alist)) unforcedLazyEgress("assoc");
        if (!alist) return nil;
        const items = Array.isArray(alist) ? alist : [];
        // Convert LIPS pairs to traversable
        if (!Array.isArray(alist) && alist?.car) {
          let current = alist;
          while (current?.car) {
            const pair = current.car;
            if (pair?.car?.valueOf?.() === key?.valueOf?.() || pair?.car === key) return pair;
            current = current.cdr;
          }
          return nil;
        }
        return items.find((pair: any) => pair?.[0] === key || pair?.car === key) ?? nil;
      },
    ),

    // ── Sort ──
    sort: symbol.native`sort: a sorted scheme list (optional comparator)`(
      { input: [z.unknown(), z.unknown().optional()], output: [z.unknown()] },
      (list: any, comparator?: any) => {
        if (is_lazy_seq(list)) unforcedLazyEgress("sort");
        const arr = Array.isArray(list) ? [...list] : [];
        if (!Array.isArray(list) && list?.car) {
          let current = list;
          while (current?.car) {
            arr.push(current.car);
            current = current.cdr;
          }
        }
        if (comparator) {
          arr.sort((a: any, b: any) => comparator(a, b));
        } else {
          arr.sort();
        }
        // Return a Scheme LIST, not a raw JS array — a Lisp `sort` whose result the sibling
        // `map`/`filter` reject ("Expecting pair or nil, got array") is an inconsistency. The elements
        // are already Scheme values (we just reordered them), so build the list shallow (no re-boxing);
        // an empty result is nil.
        return APair.fromArray(ctxOf(list), arr, false);
      },
    ),

    length: symbol.native`length: element count carrying the elements' provenance — forces a lazy-seq`(
      { input: [z.unknown()], output: [z.unknown()] },
      (collection: any) => {
        // LazySeq fast-path — the demand cone IS the provenance cone: refine under a
        // `length` observation runs only the ops the count depends on (a pure-map
        // chain runs NOTHING — `(length (map f xs))` never touches f) and stamps the
        // minimal cone from the same walk. Returns a Promise only here; the eager
        // path below stays sync and byte-identical (the speculate discipline).
        if (is_lazy_seq(collection)) {
          return collection.refine({ kind: "length" }).then((r) => {
            const { count, provenance } = r as { count: number; provenance: ReadonlySet<number> };
            return provenance.size === 0 ? count : AValue.fromJs(collection.ctx, count, provenance);
          });
        }
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

    // A18c — the scheme-surface entry into the lazy plane. `(lazy-seq xs)` wraps a
    // collection's elements into an un-run plan; `map`/`filter` then EXTEND it and
    // `length`/`reduce`/iterate FORCE it. The collection's own provenance is the
    // grouping fact (cheap, eager); per-element provenance rides the elements and
    // is distributed only on materialization. Conservative by design: laziness is
    // opt-in, so a plain Pair stays eager and byte-identical (the speculate
    // discipline) — flipping map's default to lazy is a separate, deliberate call.
    "lazy-seq": symbol.native`lazy-seq: wrap a collection's elements into an un-run lazy plan`(
      { input: [z.unknown()], output: [z.unknown()] },
      (collection: any) =>
        new ALazySeq(collection instanceof AValue ? collection.ctx : CONSTANT_CTX, 
          collectElements(collection),
          [],
          collection instanceof AValue ? collection.provenance : EMPTY_PROVENANCE,
        ),
    ),
  },
});

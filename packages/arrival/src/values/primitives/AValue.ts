/**
 * Provenance lives on the value, not in a sidecar WeakMap. A WeakMap keyed by
 * object identity snaps the instant any builtin produces a fresh value
 * (`string-append`, `car`, `+`, hundreds more) — every builtin would have to
 * remember to re-stamp. On-value means a builtin can only forget to *propagate*
 * (visible: empty result-set), never to *carry*.
 *
 * Propagation algebra: `docs/spec/arrival-chain.md` §5.
 *
 * The JS→Scheme boxing membrane (`fromJs` + the boxer registry) lives in
 * `boxing.ts`, NOT here — see that file for why the registry's writer is kept off
 * this (leakable) class.
 *
 * Lineage (claimed: none — see docs/working-proposals/confluent-dataflow-graph-ir-2026-06-17.md §1,§11):
 * provenance-on-the-value is how-provenance — provenance as an expression/circuit
 * over operators, not a flat trace (Green, Karvounarakis & Tannen, "Provenance
 * Semirings", PODS 2007). Its dual — a demanded slice of the output induces the
 * minimal slice of the input — is Galois slicing (Perera, Acar, Cheney & Levy,
 * "Functional Programs That Explain Their Work", ICFP 2012).
 */

import { INTEROP_BOUNDARY } from "../../interop-access.js";
import type { SeenMap } from "../structural-equal.js";
import type { SchemeBounceMarker, SchemeValue } from "../types.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";

export const EMPTY_PROVENANCE: ReadonlySet<number> = new Set<number>();

/**
 * The run-context of a maybe-boxed operand. At the membrane an operand often
 * arrives typed `unknown` (scheme-zod decode); when it IS an AValue its ctx is
 * the run-correct source for any value derived from it, else there is no run to
 * inherit (raw JS input) and the run-neutral CONSTANT_CTX is correct. An honest
 * instanceof narrowing — never a cast — so it stays sound when the input is raw.
 */
export function ctxOf(x: SchemeValue): RunContext {
  return x instanceof AValue ? x.ctx : CONSTANT_CTX;
}

export type AKind =
  | "string"
  | "number"
  | "bool"
  | "pair"
  | "nil"
  | "symbol"
  | "character"
  | "procedure"
  | "lambda"
  | "object"
  | "js-array"
  | "vector"
  | "bytevector"
  | "halfbaked"
  | "void"
  | "keyword"
  | "dict";

export abstract class AValue {
  static [INTEROP_BOUNDARY] = true;
  abstract readonly kind: AKind;
  readonly provenance: ReadonlySet<number>;
  /** Per-run context (RunContext). REQUIRED — a ctx-less value cannot be constructed.
   *  Run-built values carry the run ctx; singletons/quoted-AST/bootstrap carry CONSTANT_CTX.
   *  UNREAD by ops in N1; readers turn on at N2. Clones (withProvenance) keep this.ctx. */
  readonly ctx: RunContext;

  protected constructor(ctx: RunContext, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    this.ctx = ctx;
    this.provenance = provenance;
  }

  /** Plain-JS representation for serialization (cache / log / HTTP). A global
   *  protocol key (like `arrival/tagless-final/*`/`arrival/print`), written as a
   *  literal at each use site rather than declared as a named constant. */
  abstract ["arrival/toJS"](): unknown;

  /** AValues are immutable — provenance updates mint a new instance. Returns the
   *  `SchemeValue` union (each concrete subclass overrides with its OWN narrower type, which
   *  is covariantly assignable to the union — so a statically-concrete receiver still gets the
   *  precise subtype; only an abstract-`AValue`-typed receiver falls back to the union here).
   *  NOT the abstract base `AValue`: abstract `AValue` is NOT assignable to `SchemeValue`, so an
   *  `AValue` return reds every `value.withProvenance(p)` that must flow back into a `SchemeValue`
   *  slot (e.g. a re-stamp of an `instanceof AValue`-narrowed arm result). NOT `this`: a clone
   *  mints `new ConcreteClass(...)`, which TS will not accept as `this` without a cast (`this`
   *  could be a narrower subtype), and a cast would re-mute the very signal this migration surfaces. */
  abstract withProvenance(p: ReadonlySet<number>): SchemeValue;

  // ── The tagless-final algebra — declared OPTIONAL on AValue, the single source of truth ──────
  // Every AValue (and subclass) MAY carry these `arrival/tagless-final/<op>` members; an entity
  // implements the SUBSET it can handle and omits the rest (the `symbol.taglessGuard` presence
  // check is what dispatches). The `undefined` lives in the `?` — declared METHOD-style on purpose:
  // a subclass may override an optional method, but overriding a function-typed *property*
  // (`?: (…) => …`) trips TS2425, so these stay methods. `equals` is additionally `abstract` on the
  // class above (required — every value is a Setoid). tagless-final.ts derives the op-name type +
  // runtime lock-step from `keyof AValue` — add an op by declaring it here.
  /**
   * Fantasy Land Setoid — structural equality, ON THE TERM. Making this abstract
   * forces EVERY subtype to own its `equal?` comparison (totality): a subtype
   * with no equals is a compile error, not a silent fall-through. `structuralEqual`
   * is the harness — it records the (this, other) co-induction pair, then dispatches
   * HERE, threading the shared `seen` so recursive terms (Pair/Vector) co-induct
   * through one visited set and mutual cycles terminate. The `seen` parameter is
   * optional: a direct `a["arrival/tagless-final/equals"](b)` call (no harness) starts a
   * fresh walk; leaf Setoids ignore it.
   */
  abstract ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean;
  /** Order — the ≤ of an Ord type (numbers, strings, chars, symbols, bytevectors). */
  ["arrival/tagless-final/lte"]?(other: unknown): boolean;
  /** Element count — the per-primitive divergence (elements' provenance) lives on the term. */
  ["arrival/tagless-final/length"]?(runCtx?: RunContext): AValue | number;
  /** Functor — map a fn over the elements (box-preserving or box-stripping per the term). */
  ["arrival/tagless-final/map"]?(
    fn: (x: unknown) => unknown | Promise<unknown>,
    runCtx?: RunContext,
  ): SchemeValue | Promise<SchemeValue>;
  /** Filterable — keep elements matching a pred (or RegExp). */
  ["arrival/tagless-final/filter"]?(
    pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx?: RunContext,
  ): SchemeValue | Promise<SchemeValue>;
  /** Foldable left-fold — scheme convention `fn(element, acc)`, seed last. */
  ["arrival/tagless-final/reduce"]?<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx?: RunContext,
  ): Acc | Promise<Acc>;
  /** Ordering — a sorted sequence (container-preserving); default order is the elements' own `lte`. */
  ["arrival/tagless-final/sort"]?(comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): SchemeValue;
  /** Applicable — INVOKE this value as a procedure. Callability IS declaring this term: the
   *  evaluator call-head, the R7RS `apply` builtin, and every HOF dispatch through it uniformly,
   *  the same `resolveMethod` path `map`/`car` use. `args` are the scheme-value operands, `runCtx`
   *  is threaded (never via `this` — `this` is the callable value itself, per the receiver
   *  convention), and `canBounce` opts a lambda into the TCO bounce protocol (native/rosetta
   *  ignore it, only a scheme lambda reads it). See docs/working-proposals/callable-as-value-run-ctx.md. */
  ["arrival/tagless-final/apply"]?(
    args: SchemeValue[],
    runCtx: RunContext,
    canBounce?: boolean,
  ): SchemeValue | SchemeBounceMarker | Promise<SchemeValue>;
  /** Keyed read — a dict-shaped term (`AJSObject`, `ADict`) answers a `:key`-style keyword
   *  accessor's `apply` by implementing this instead. The key travels as the caller's own
   *  SchemeValue (usually the keyword symbol itself), not a pre-folded string, so the
   *  receiver decides how to fold/match it. */
  ["arrival/tagless-final/get"]?(key: SchemeValue, runCtx?: RunContext): SchemeValue;
  /** Projection — the head of a pair-shaped term (APair computes on the term; ANil's is
   *  strict-gated: tolerant ⇒ nil, strict ⇒ the R7RS throw; AJSArray answers via its view). */
  ["arrival/tagless-final/car"]?(runCtx?: RunContext): SchemeValue;
  /** Projection — the tail (same family as `car`). */
  ["arrival/tagless-final/cdr"]?(runCtx?: RunContext): SchemeValue;
  /** Indexed read — the element at k (vector-shaped terms; a borrowed AJSArray answers too). */
  ["arrival/tagless-final/vector-ref"]?(k: number): SchemeValue;
  /** Semigroup — `this ⋄ other`: container-preserving PURE append (list/vector/bytevector
   *  concat builds a fresh spine, never mutates an operand). */
  ["arrival/tagless-final/concat"]?(other: unknown): SchemeValue;
  /** Chain (Monad) — map then flatten (the re-homed fantasy-land `chain`). */
  ["arrival/tagless-final/chain"]?(f: (x: unknown) => unknown): SchemeValue;
  /** Traversable — effectful traversal; `of` lifts into the applicative. Return stays
   *  `unknown` honestly: the traversal's carrier is the applicative's, not the term's. */
  ["arrival/tagless-final/traverse"]?(of: (x: unknown) => unknown, f: (x: unknown) => unknown): unknown;
  /** Apply (Applicative) — accumulate through an applicative carrier (APair's traverse
   *  machinery probes it on mapped elements; optional — a carrier that implements it opts in). */
  ["arrival/tagless-final/ap"]?(other: unknown): unknown;
  // ── Type-predicate GUARDS (symbol.taglessGuard): the receiver answers its own kind; a value
  // lacking the method answers #f (the guard's graceful default — no instanceof reach-around).
  ["arrival/tagless-final/vector?"]?(): boolean;
  ["arrival/tagless-final/pair?"]?(): boolean;
  ["arrival/tagless-final/symbol?"]?(): boolean;
  ["arrival/tagless-final/char?"]?(): boolean;
}

/** Per `docs/spec/arrival-chain.md` §5.1: distinct-by-reference, forward singleton, union ≥2. */
export function unionProvenance(args: readonly AValue[]): ReadonlySet<number> {
  const distinct = new Set<ReadonlySet<number>>();
  for (const arg of args) {
    if (arg.provenance.size > 0) distinct.add(arg.provenance);
  }
  switch (true) {
    case distinct.size === 0:
      return EMPTY_PROVENANCE;
    case distinct.size === 1:
      return distinct.values().next().value!;
    default: {
      const merged = new Set<number>();
      for (const s of distinct) for (const x of s) merged.add(x);
      return merged;
    }
  }
}

export function pointProvenance(callId: number): ReadonlySet<number> {
  return new Set([callId]);
}

// ============================================================================
// INTEROP BOUNDARY (defensive on the abstract base)
// ============================================================================
// War story (2026-05-28 audit): the symbol-to-field auto-resolution in
// `accessMember` walks the prototype chain of any object reachable from
// inference-plane scheme. Subtypes (SchemeString, Pair, …) graft methods onto their
// own prototypes — those subtypes are individually marked at their definition
// sites — but marking the abstract `AValue` base is a defensive belt: any
// future AValue subtype that forgets its own marker still inherits the
// boundary from the base prototype chain, so accidental method exposure
// degrades to "blocked" rather than "exposed."
// ============================================================================

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
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";

const EMPTY_PROVENANCE: ReadonlySet<number> = new Set<number>();

/**
 * The run-context of a maybe-boxed operand. At the membrane an operand often
 * arrives typed `unknown` (scheme-zod decode); when it IS an AValue its ctx is
 * the run-correct source for any value derived from it, else there is no run to
 * inherit (raw JS input) and the run-neutral CONSTANT_CTX is correct. An honest
 * instanceof narrowing — never a cast — so it stays sound when the input is raw.
 */
export function ctxOf(x: unknown): RunContext {
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
  | "object"
  | "js-array"
  | "vector"
  | "bytevector"
  | "halfbaked"
  | "void"
  | "keyword";

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

  /** Plain-JS representation for serialization (cache / log / HTTP). */
  abstract toJs(): unknown;

  /** AValues are immutable — provenance updates mint a new instance. */
  abstract withProvenance(p: ReadonlySet<number>): AValue;

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

export { EMPTY_PROVENANCE };

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

// ── The tagless-final algebra — declared OPTIONAL on AValue, the single source of truth ──────
// Every AValue (and subclass) MAY carry these `arrival/tagless-final/<op>` members; an entity
// implements the SUBSET it can handle and omits the rest (the `symbol.taglessGuard` presence
// check is what dispatches). The `undefined` lives in the `?` — declared METHOD-style on purpose:
// a subclass may override an optional method, but overriding a function-typed *property*
// (`?: (…) => …`) trips TS2425, so these stay methods. `equals` is additionally `abstract` on the
// class above (required — every value is a Setoid). tagless-final.ts derives the op-name type +
// runtime lock-step from `keyof AValue` — add an op by declaring it here.
export interface AValue {
  /** Order — the ≤ of an Ord type (numbers, strings, chars, symbols, bytevectors). */
  ["arrival/tagless-final/lte"]?(other: unknown): boolean;
  /** Element count — the per-primitive divergence (elements' provenance) lives on the term. */
  ["arrival/tagless-final/length"]?(runCtx?: RunContext): AValue | number;
  /** Functor — map a fn over the elements (box-preserving or box-stripping per the term). */
  ["arrival/tagless-final/map"]?(fn: (x: unknown) => unknown | Promise<unknown>, runCtx?: RunContext): AValue | Promise<AValue>;
  /** Filterable — keep elements matching a pred (or RegExp). */
  ["arrival/tagless-final/filter"]?(pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp, runCtx?: RunContext): AValue | Promise<AValue>;
  /** Foldable left-fold — scheme convention `fn(element, acc)`, seed last. */
  ["arrival/tagless-final/reduce"]?<Acc>(fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>, initial: Acc, runCtx?: RunContext): Acc | Promise<Acc>;
  /** Ordering — a sorted sequence (container-preserving); default order is the elements' own `lte`. */
  ["arrival/tagless-final/sort"]?(comparator?: (a: unknown, b: unknown) => unknown, runCtx?: RunContext): AValue;
}

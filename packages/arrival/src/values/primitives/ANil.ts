/**
 * Nil — the empty list singleton (extracted from values/types.ts).
 * Carries the late-bound Pair constructor that `Nil.append` uses to build a
 * Pair without a circular import. `setPairConstructor` is called by Pair.ts.
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import type { APairLike } from "../types.js";

// Pair constructor type - will be set by Pair.ts
let PairConstructor: new (ctx: RunContext, car: unknown, cdr: unknown) => APairLike;

export function setPairConstructor(ctor: new (ctx: RunContext, car: unknown, cdr: unknown) => APairLike) {
  PairConstructor = ctor;
}

export class ANil extends AValue {
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "nil";
  readonly kind = "nil" as const;

  constructor(ctx: RunContext, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
  }

  toString(): string {
    return "()";
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  valueOf(): undefined {
    return undefined;
  }

  serialize(): 0 {
    return 0;
  }

  to_object(): Record<string, never> {
    return {};
  }

  append(x: unknown): APairLike {
    return new PairConstructor(CONSTANT_CTX, x, nil);
  }

  to_array(): [] {
    return [];
  }

  toJs(): null {
    return null;
  }

  withProvenance(p: ReadonlySet<number>): ANil {
    return new ANil(this.ctx, p);
  }

  // Setoid (Fantasy Land). Every Nil — including provenance clones — is equal,
  // matching eq's instanceof check. structuralEqual / equal? consult this first.
  // (algebras-in-entities migration — plan-2026-06-10-algebras-in-entities.md.)
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ANil;
  }

  // Semigroup/Monoid (Fantasy Land) — Nil is the EMPTY LIST, the identity of
  // the list monoid. `nil ⋄ other = other`. Co-declared with Pair's list-append
  // Semigroup so the algebra is total over all lists (wave 2,
  // plan-2026-06-10-algebras-in-entities.md). Returns `other` as-is — the
  // identity does not allocate.
  ["arrival/tagless-final/concat"]<T>(other: T): T {
    return other;
  }

  // Head/tail projection of the EMPTY list — the nil-tolerance algebra (dissolved from
  // fl-interop's nil-branch ONTO the term). nil is a global constant bearing no run-state,
  // so the run's mode rides the THREADED runCtx (RunContext.ts's corrected plan: car-of-nil's
  // strict is read from the active run, never nil.ctx): strict ⇒ the R7RS "() is not a pair"
  // throw; tolerant ⇒ nil, so a multi-leaf proof grounds its OTHER leaves rather than crashing
  // on one absent read.
  ["arrival/tagless-final/car"](runCtx: RunContext): unknown {
    if (runCtx.strict) throw new TypeError("car: () is not a pair");
    return nil;
  }

  ["arrival/tagless-final/cdr"](runCtx: RunContext): unknown {
    if (runCtx.strict) throw new TypeError("cdr: () is not a pair");
    return nil;
  }

  // Sequence ops over the EMPTY list — the identity cases (the fl-interop dissolution:
  // the empty case lives ON the term, not a dispatch branch). map/filter of nothing is
  // nothing (nil); reduce of nothing is the seed, fn never called.
  ["arrival/tagless-final/map"](_fn: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/filter"](_arg: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/reduce"]<A>(_fn: unknown, initial: A): A {
    return initial;
  }

  // sort of the EMPTY list is the empty list — the identity case (mirrors map/filter
  // above). The comparator is never consulted; nil is the canonical empty singleton.
  ["arrival/tagless-final/sort"](_comparator?: unknown, _runCtx?: unknown): ANil {
    return nil;
  }

  // length of the EMPTY list is 0 — the authoritative empty-count (mirrors the map/filter/
  // reduce empty cases above; the fl-interop `length` overlay's nil-branch dissolved ONTO the
  // term). No elements ⇒ no provenance to carry: a bare `0`. NO heap-charge / NO strict-gating,
  // so the trailing runCtx `symbol.tagless` threads is ignored.
  ["arrival/tagless-final/length"](_runCtx?: unknown): number {
    return 0;
  }

  // Monoid empty — the identity is Nil itself (the canonical singleton).
  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
  }
}

export const nil = new ANil(CONSTANT_CTX, );


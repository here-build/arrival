/**
 * Nil — the empty list singleton (extracted from values/types.ts).
 * Carries the late-bound Pair constructor that `Nil.append` uses to build a
 * Pair without a circular import. `setPairConstructor` is called by Pair.ts.
 */
import { CLASS } from "../../well-known-symbols.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../../interop-access.js";
import type { PairLike } from "../types.js";

// Pair constructor type - will be set by Pair.ts
let PairConstructor: new (car: unknown, cdr: unknown) => PairLike;

export function setPairConstructor(ctor: new (car: unknown, cdr: unknown) => PairLike) {
  PairConstructor = ctor;
}

export class Nil extends AValue {
  static [CLASS] = "nil";
  readonly kind = "nil" as const;

  constructor(provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(provenance);
  }

  toString(): string {
    return "()";
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

  append(x: unknown): PairLike {
    return new PairConstructor(x, nil);
  }

  to_array(): [] {
    return [];
  }

  toJs(): null {
    return null;
  }

  withProvenance(p: ReadonlySet<number>): Nil {
    return new Nil(p);
  }

  // Setoid (Fantasy Land). Every Nil — including provenance clones — is equal,
  // matching eq's instanceof check. structuralEqual / equal? consult this first.
  // (algebras-in-entities migration — plan-2026-06-10-algebras-in-entities.md.)
  ["fantasy-land/equals"](other: unknown): boolean {
    return other instanceof Nil;
  }

  // Semigroup/Monoid (Fantasy Land) — Nil is the EMPTY LIST, the identity of
  // the list monoid. `nil ⋄ other = other`. Co-declared with Pair's list-append
  // Semigroup so the algebra is total over all lists (wave 2,
  // plan-2026-06-10-algebras-in-entities.md). Returns `other` as-is — the
  // identity does not allocate.
  ["fantasy-land/concat"]<T>(other: T): T {
    return other;
  }

  // Monoid empty — the identity is Nil itself (the canonical singleton).
  static ["fantasy-land/empty"](): Nil {
    return nil;
  }
}

export const nil = new Nil();

// null/undefined → nil (empty list).
AValue.registerBoxer("null", (_v, p) => new Nil(p));
AValue.registerBoxer("undefined", (_v, p) => new Nil(p));

markInteropBoundary(Nil);

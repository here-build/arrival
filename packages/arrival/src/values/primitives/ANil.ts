/**
 * Nil — the empty list singleton (extracted from values/types.ts).
 * `Nil.append` builds a Pair via a plain `import { APair }`. ANil extends AValue
 * (not APair) and touches APair ONLY inside the `append` method body, so the
 * resulting ANil↔APair cycle is call-only on both sides — no module-eval edge,
 * no TDZ — and ESM live-bindings resolve APair at call-time regardless of which
 * file loads first. (The former `setPairConstructor` late-bound DI is dissolved.)
 */
import { type SchemeValue } from "../types.js";
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";
import { APair } from "./APair.js";
import { AExact } from "./AExact.js";

export class ANil extends AValue {
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "nil";
  readonly kind = "nil" as const;

  constructor(ctx: RunContext, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
  }

  // Monoid empty — the identity is Nil itself (the canonical singleton).
  static ["arrival/tagless-final/empty"](): ANil {
    return nil;
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

  append<T extends SchemeValue>(x: T): APair<T, ANil> {
    return new APair<T, ANil>(CONSTANT_CTX, x, nil);
  }

  to_array(): never[] {
    return [];
  }

  ["arrival/toJS"](): null {
    return null;
  }

  withProvenance(p: ReadonlySet<number>): ANil {
    return new ANil(this.ctx, p);
  }

  // Setoid — every Nil (including provenance clones) is equal, matching eq?'s instanceof
  // check. structuralEqual/equal? consult this first.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ANil;
  }

  // Semigroup/Monoid — Nil is the EMPTY LIST, the identity of the list monoid. `nil ⋄ other
  // = other`. Co-declared with Pair's list-append Semigroup so the algebra is total over all
  // lists. Returns `other` as-is — the identity does not allocate.
  ["arrival/tagless-final/concat"]<T extends SchemeValue>(other: T): T {
    return other;
  }

  // Head/tail projection of the EMPTY list — the nil-tolerance algebra. nil is a global
  // constant bearing no run-state, so the run's mode rides the THREADED runCtx
  // (RunContext.ts's corrected plan: car-of-nil's strict is read from the active run, never
  // nil.ctx): strict ⇒ the R7RS "() is not a pair" throw; tolerant ⇒ nil, so a multi-leaf
  // proof grounds its OTHER leaves rather than crashing on one absent read.
  ["arrival/tagless-final/car"](runCtx: RunContext): ANil {
    if (runCtx.strict) throw new TypeError("car: () is not a pair");
    return nil;
  }

  ["arrival/tagless-final/cdr"](runCtx: RunContext): ANil {
    if (runCtx.strict) throw new TypeError("cdr: () is not a pair");
    return nil;
  }

  // Sequence ops over the EMPTY list — the identity cases (the fl-interop dissolution: the
  // empty case lives ON the term, not a dispatch branch). map/filter of nothing is nothing
  // (nil); reduce of nothing is the seed, fn never called.
  ["arrival/tagless-final/map"](_fn: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/filter"](_arg: unknown): ANil {
    return nil;
  }

  ["arrival/tagless-final/reduce"]<A>(_fn: unknown, initial: A): A {
    return initial;
  }

  // Sort of the EMPTY list is the empty list — the identity case (mirrors map/filter above).
  // The comparator is never consulted; nil is the canonical empty singleton.
  ["arrival/tagless-final/sort"](_comparator?: unknown, _runCtx?: unknown): ANil {
    return nil;
  }

  // Length of the EMPTY list is 0 — the authoritative empty-count (mirrors the map/filter/
  // reduce empty cases above; the fl-interop `length` overlay's nil-branch dissolved ONTO
  // the term). No elements ⇒ no provenance to carry, but P4 still requires a boxed AValue
  // (a raw `0` is a bare-value-purge violation — the sibling of the `number->string` bug,
  // c0852b879c): a fresh empty-provenance `AExact`. No heap-charge / no strict-gating, so
  // the trailing runCtx `symbol.tagless` threads is ignored.
  ["arrival/tagless-final/length"](_runCtx?: unknown): AExact {
    return new AExact(CONSTANT_CTX, 0n);
  }
}

export const nil = new ANil(CONSTANT_CTX);

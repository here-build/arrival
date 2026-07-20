import { ABool } from "./primitives/ABool.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { AExact } from "./primitives/AExact.js";
import { AInexact } from "./primitives/AInexact.js";
import { ANil } from "./primitives/ANil.js";
import { ACharacter } from "./primitives/ACharacter.js";
import { tf } from "./tagless-final.js";

/**
 * Cycle-safe structural deep-equality for Scheme values — the ONE `equal?`
 * implementation (R7RS-small §6.1). Routed to by every surface (`env/r7rs/equality.ts`'s
 * `equal?`, `env/r7rs/lists.ts`'s `member`/`assoc`, and each term's own Setoid recursion)
 * — a single walker so every caller agrees on cycles, SchemeCharacter, and
 * Scheme numeric/provenance types.
 *
 * Walks the two values in lock-step, tracking visited `(a, b)` reference pairs
 * so cycles terminate co-inductively (a node already being compared against its
 * partner is assumed equal — the standard occurs-check). Never throws a native
 * serialization error; always returns a boolean.
 *
 * Equality dispatches through each value's Fantasy Land Setoid
 * (`arrival/tagless-final/equals`).
 */
/**
 * The co-induction visited set threaded through a single `equal?` walk. Maps each
 * visited `a`-reference to the SET of `b`-partners it has been compared against on
 * the current path; a re-encountered `(a, b)` short-circuits to true. Shared by the
 * harness AND by each term's `arrival/tagless-final/equals` (Pair/Vector recurse
 * through `structuralEqual` threading this map), so mutually-cyclic structures
 * terminate. Exported so AValue's abstract Setoid can type its optional `seen`
 * parameter identically.
 */
export type SeenMap = Map<object, Set<object>>;

export function structuralEqual(a: any, b: any, seen: SeenMap = new Map()): boolean {
  // Fast paths: identity, then valueOf-equality (covers SchemeExact/Inexact,
  // boxed primitives, SchemeCharacter's __char__ via valueOf) and SchemeString's
  // `__string__`.
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  // Co-induction bookkeeping — record the (a, b) partner pair BEFORE descending,
  // generically for any object pair. A re-encountered (a, b) short-circuits to
  // true, so cyclic structures (Pair/Vector/array/plain object) terminate.
  // Recording here, before the Setoid dispatch, lets each term's
  // `arrival/tagless-final/equals` recurse through `structuralEqual` with a
  // shared `seen` and never re-record. Primitives can't carry cycles; they fall
  // straight through to the leaf fallbacks.
  if (typeof a === "object" && typeof b === "object") {
    const partners = seen.get(a);
    if (partners?.has(b)) return true;
    if (partners) partners.add(b);
    else seen.set(a, new Set([b]));
  }

  // Setoid (Fantasy Land): a value that defines its own equality OWNS the comparison.
  // Now total over every AValue (the abstract method forces it) — Pair and SchemeVector
  // route HERE, each threading the shared `seen` so cyclic terms terminate. Opaque
  // entities (IP/hash/SID) whose canonical match differs from structural key comparison
  // also own it; an entity compared to a non-entity (a bare literal) returns false.
  // Symmetric. The `seen` is forwarded so a Setoid's element recursion co-inducts
  // through the SAME visited set this harness just recorded into.
  if (typeof a[tf("equals")] === "function") return Boolean(a[tf("equals")](b, seen));
  if (typeof b[tf("equals")] === "function") return Boolean(b[tf("equals")](a, seen));

  const av = a?.valueOf?.();
  const bv = b?.valueOf?.();
  if (av === bv && (typeof av !== "object" || av === null)) return true;
  if (a.__string__ != null && b.__string__ != null) return a.__string__ === b.__string__;

  // Both must be objects to recurse; otherwise they're unequal primitives.
  if (typeof a !== "object" || typeof b !== "object") return false;

  // Arrays (incl. AJSArray sources are raw arrays by this point).
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  // Plain objects: same own-enumerable key set, structurally-equal values.
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!structuralEqual(a[k], b[k], seen)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// R7RS § 6.1 — the lower two tiers of the equivalence hierarchy (`eq?`/`eqv?`).
// `equal?` (structuralEqual, above) is the third. Co-located here so the three
// grades live in one equality leaf — and so a future Setoid (arrival/tagless-final/
// equals) consolidation has a single home.
//
// Must stay three distinct functions, not two-plus-an-alias: a single
// structural-ish `equal` helper aliased to both `eq?`/`eqv?` collapses distinct
// heap SchemeString instances to #t via a `.valueOf() === .valueOf()` branch —
// flattening the three-tier hierarchy and breaking `memq`/`assv`/`case` dispatch
// and the atom-grade contract that `(eqv? (string-copy "a") (string-copy "a"))`
// MUST be #f.
//
// The three grades:
//   - `eq?` — pointer-grade. R7RS lets implementations make immediates (numbers,
//     chars, interned symbols, nil, booleans) answer #t across distinct heap
//     copies; we lean inclusive because the provenance clone machinery
//     (AValue.withProvenance) routinely mints copies of canonically-identifying
//     values that should still compare eq? — else `(eq? (if #t #f #t) (if #f #t #f))`
//     would surprise readers (both arms produce a SchemeBool(false) clone with a
//     different provenance heap-id, but the canonical answer is #t).
//   - `eqv?` — eq? plus explicit number/char value equality. eq? above already
//     covers SchemeExact/SchemeInexact (via .equals) and chars (__char__), so
//     eqv? reduces to eq? today. Kept distinct so any future divergence (NaN/±0,
//     exact/inexact crossing) lands in one named place.
//   - `equal?` — structural recursion (structuralEqual).
//
// Provenance-clone trap: `x === y` is NOT sufficient for symbols/nil/booleans —
// every withProvenance() call mints a fresh heap object. Use instance-aware
// checks so clones still compare eq? (else an `if`-induced clone of nil/#f fails
// eq? against the singleton, breaking `(eq? x '())`).
// ----------------------------------------------------------------------
export function eq(x: unknown, y: unknown): boolean {
  // Identity first — also the only true-answer for the pointer-grade types below
  // (Pair / vector / SchemeString / plain object). Then the SCALAR types route
  // their value-comparison THROUGH their own Setoid (`arrival/tagless-final/equals`): the
  // single comparison impl now lives on each term, not inlined here. Post-B2 each
  // scalar's Setoid is exactly the compare this used to inline.
  //
  // SchemeBool is the one guarded exception: its Setoid is representation-BLIND
  // (it also equals a RAW JS boolean, `this.value === other`), but `eq?`/`eqv?`
  // are pointer/scalar-grade over BOXED scheme values — a bare `true` is NOT eq?
  // to a boxed SchemeBool. The `y instanceof SchemeBool` guard keeps that boundary
  // (raw-boolean `y` ⇒ #f) while still routing the boxed×boxed compare through the
  // term (the Setoid's ternary reads `other.value` when `other` IS a SchemeBool).
  if (x === y) return true;
  if (
    x instanceof ASymbol ||
    x instanceof ANil ||
    x instanceof ACharacter ||
    x instanceof AExact ||
    x instanceof AInexact
  ) {
    return x[tf("equals")](y);
  }
  if (x instanceof ABool) return y instanceof ABool && x[tf("equals")](y);
  // Everything else (Pair, vector/Array, SchemeString, plain objects) keeps
  // strict pointer-grade — distinct heap instances answer #f (the === above is
  // the only true case).
  return false;
}

export function eqv(x: unknown, y: unknown): boolean {
  // eqv? = eq? + explicit number/char equality, both already in eq() above.
  return eq(x, y);
}

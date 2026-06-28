// Value / symbol representation helpers — shared by the stdlib forms, the
// genMacroWrapper bridge, and the macro engine (syntax-rules.ts:
// macro_expand / extract_patterns / transform_syntax).
//
// Extracted from the original monolith (the since-split lips.ts) so the macro
// engine imports them from this sibling LEAF rather than back-edging into the
// stdlib — the cycle the module split exists to prevent. syntax-rules.ts now
// imports directly from here.
//
// `is_promise` comes from guards.ts (a *false leaf*: it carries a pre-existing
// transitive path to Environment), which is type-only at the values-repr edge,
// so no runtime cycle. Promoting is_promise into the value-guards true-leaf is
// a separate task.
// ----------------------------------------------------------------------
import { is_promise } from "../eval/guards.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact, AInexact } from "../values/numbers.js";
import { DATA } from "../well-known-symbols.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import type { SchemeValue } from "../values/types.js";
import { is_nil, is_pair } from "../values/value-guards.js";

/** Non-enumerable, non-writable Symbol-keyed slot — used for metadata that must
 *  not surface in enumeration or be clobbered (e.g. a gensym's `__literal__`). */
export function hidden_prop(obj: SchemeValue, name: string, value: SchemeValue): void {
  Object.defineProperty(obj, Symbol.for(name), {
    get: () => value,
    set: () => {},
    configurable: false,
    enumerable: false,
  });
}

/** Gensym JS symbols are recognized by the `#:` name prefix — the marker
 *  `gensym` stamps below. (Mirrors SchemeSymbol.is_gensym.) */
export function is_gensym(symbol: SchemeValue): boolean {
  if (typeof symbol === "symbol") {
    return !!/^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

/** Mint a hygienic SchemeSymbol backed by a unique ES6 Symbol (uniqueness is
 *  what guarantees no capture in macro expansion). Idempotent on an already-gensym
 *  input — avoids double-gensym in nested syntax-rules. */
export const gensym = (function () {
  let count = 0;

  function with_props(name: SchemeValue, sym: symbol) {
    const symbol = new ASymbol(CONSTANT_CTX, sym);
    hidden_prop(symbol, "__literal__", name);
    return symbol;
  }

  return function (name: SchemeValue = null) {
    if (name instanceof ASymbol) {
      if (name.is_gensym()) {
        return name;
      }
      name = name.valueOf();
    }
    if (is_gensym(name)) {
      // don't do double gynsyms in nested syntax-rules
      return new ASymbol(CONSTANT_CTX, name);
    }
    // use ES6 symbol as name for lips symbol (they are unique)
    if (name !== null) {
      return with_props(name, Symbol(`#:${name}`));
    }
    count++;
    return with_props(count, Symbol(`#:g${count}`));
  };
})();

// ----------------------------------------------------------------------
// :: mark a value as quoted data so the evaluator won't re-evaluate it.
// :: Pairs/symbols carry the __data__ flag; promises thread through.
// ----------------------------------------------------------------------
export function quote(value: SchemeValue): SchemeValue {
  if (is_promise(value)) {
    return value.then(quote);
  }
  if (is_pair(value) || value instanceof ASymbol) {
    (value as SchemeValue)[DATA] = true;
  }
  return value;
}

// ----------------------------------------------------------------------
// :: box — lift a raw JS primitive to its Scheme value-type so member reads
// :: return Scheme-typed values, not bare JS. Only strings/bigints/numbers
// :: need boxing; objects/arrays are handled by the membrane at access time,
// :: so they pass through. Relocated here (the value-representation leaf, next
// :: to `quote`) from stdlib so `patch_value` — and Environment's member walk —
// :: can reach it without importing the stdlib monolith (the legacy cycle).
// ----------------------------------------------------------------------
export function box(object: unknown): SchemeValue {
  switch (typeof object) {
    case "string":
      return new AString(CONSTANT_CTX, object);
    case "bigint":
      return new AExact(CONSTANT_CTX, object);
    case "number":
      if (Number.isNaN(object)) return new AInexact(CONSTANT_CTX, Number.NaN);
      // Safe integers become exact, floats become inexact.
      if (Number.isSafeInteger(object)) {
        return new AExact(CONSTANT_CTX, BigInt(object));
      }
      return new AInexact(CONSTANT_CTX, object);
  }
  return object as SchemeValue;
}

// ----------------------------------------------------------------------
// :: patch_value — settle a value read out of a binding/member for handing
// :: back to Scheme: a Pair is cycle-marked then quoted (so the evaluator
// :: treats it as data, not a call); everything else is boxed. Relocated here
// :: from stdlib alongside `box`/`quote` so Environment.get can settle members
// :: through this leaf instead of the deferred stdlib runtime slot.
// ----------------------------------------------------------------------
export function patch_value(value: unknown): SchemeValue {
  if (is_pair(value)) {
    value.mark_cycles();
    return quote(value);
  }
  return box(value);
}

// ----------------------------------------------------------------------
// :: an atom is any self-evaluating leaf (symbol, string, nil, char,
// :: number, boolean) — i.e., not a compound pair/structure.
// ----------------------------------------------------------------------
export function is_atom(obj: SchemeValue): boolean {
  return (
    obj instanceof ASymbol ||
    AString.isString(obj) ||
    is_nil(obj) ||
    obj === null ||
    obj instanceof ACharacter ||
    obj instanceof AExact ||
    obj instanceof AInexact ||
    obj === true ||
    obj === false
  );
}

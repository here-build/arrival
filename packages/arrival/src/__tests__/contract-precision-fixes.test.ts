// contract-precision-fixes.test.ts — RUNTIME proof that the 2026-07-05 declaration-
// precision audit's five fixes (for-each / string-map / string-for-each / filter /
// typecheck) actually land on the REAL exported ops — not a synthetic mirror (see
// symbol.test-d.ts for the type-level mechanism proofs, which must stay synthetic
// because NativeSymbolDef/SequenceSymbolDef erase `I`/`O` on any real export).
//
// Mirrors numeric-contract-precision.test.ts's established pattern: a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native/sequence
// ops never run this validation during evaluation, so this is a HARVEST/type-surface
// proof, not a behavior change. The behavior-unchanged proof is the full existing
// suite run byte-identical before/after (see the report).
//
// Each probe below was calibrated empirically against zod 4.3.6's actual tuple
// semantics (a `.optional()` trailing slot DOES allow a shorter array; a bare
// `z.custom<T>()`/`z.unknown()` slot accepts anything INCLUDING a missing/undefined
// slot — neither by itself creates an arity floor). The genuine, testable signal in
// every case is: a value that used to slip through an unconstrained `z.value`/
// `z.unknown()` rest (or an unbounded `z.tuple(fixed, rest)` tail) now correctly fails.
import { describe, expect, it } from "vitest";
import listsPack from "../env/r7rs/lists.js";
import stringsPack from "../env/r7rs/strings.js";
import srfi1Pack from "../env/srfi/srfi-1.js";
import equalityPack from "../env/r7rs/equality.js";
import type { AEntity } from "../common/symbol.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { ABool } from "../values/primitives/ABool.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AExact } from "../values/primitives/AExact.js";

/** A pack's `.spec.symbols` map, generically — mirrors numeric-contract-precision.test.ts's
 *  `numericPack.spec.symbols as Record<string, AEntity>` access pattern. */
function symbolsOf(pack: { spec: { symbols?: unknown } }): Record<string, AEntity> {
  return pack.spec.symbols as Record<string, AEntity>;
}

/** Resolve a named symbol and narrow it to a contract-bearing def (native or sequence —
 *  the two kinds `filter`/`typecheck`/`for-each`/`string-map`/`string-for-each` span —
 *  both of which expose `.in`/`.out`). */
function contractDef(pack: { spec: { symbols?: unknown } }, name: string) {
  const def = symbolsOf(pack)[name];
  if (def === undefined) throw new Error(`pack: no symbol named ${name}`);
  if (def.kind !== "native" && def.kind !== "sequence") {
    throw new Error(`${name}: expected a native or sequence def (got ${def.kind})`);
  }
  return def;
}

const fn = () => {};
const properList = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), nil);
const realString = new AString(CONSTANT_CTX, "abc");

describe("2026-07-05 audit — runtime Contract precision on the REAL exported ops", () => {
  // INVARIANT: for-each's rest-argument schema requires a proper list (Pair|Nil); a non-list is rejected
  it("for-each: rest elements must now be a proper list (Pair|Nil) — a non-list used to slip through the old z.array(z.value)", () => {
    const def = contractDef(listsPack, "for-each");
    expect(def.in.safeParse([fn, properList]).success).toBe(true);
    expect(def.in.safeParse([fn, nil]).success).toBe(true);
    expect(def.in.safeParse([fn, "not-a-list"]).success).toBe(false);
  });

  // INVARIANT: string-map's rest-argument schema requires a real AString; a raw JS string is rejected
  it("string-map: rest elements must now be a real SchemeString (AString) — a raw JS string used to slip through the old z.array(z.unknown())", () => {
    const def = contractDef(stringsPack, "string-map");
    expect(def.in.safeParse([fn, realString]).success).toBe(true);
    expect(def.in.safeParse([fn, "raw-js-string"]).success).toBe(false);
  });

  // INVARIANT: string-for-each's rest-argument schema requires a real AString; a raw JS string is rejected
  it("string-for-each: same rest-precision fix as string-map", () => {
    const def = contractDef(stringsPack, "string-for-each");
    expect(def.in.safeParse([fn, realString]).success).toBe(true);
    expect(def.in.safeParse([fn, "raw-js-string"]).success).toBe(false);
  });

  // INVARIANT: filter's input schema is a fixed 2-tuple; a 3rd element is rejected
  it("filter: input is now a fixed 2-tuple — a 3rd element used to slip through the old z.tuple([u], u) unbounded rest", () => {
    const def = contractDef(srfi1Pack, "filter");
    expect(def.in.safeParse([fn, properList]).success).toBe(true);
    expect(def.in.safeParse([fn, properList, "extra"]).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-05 audit — scheme/equality review (equality.ts). This file was already
// migrated (the Phase-1 symbol.native pilot) and a prior pass found it correctly
// representation-blind BY DESIGN throughout. Two ops (`boolean=?`/`symbol=?`) were
// flagged as borderline — both share the `z.array(z.unknown())` input shape, and the
// question for each was: does the impl actually branch on boxed-vs-raw representation
// (blindness load-bearing, leave it), or is `z.unknown()` just an imprecise stand-in for
// a scalar domain that has no dual representation in practice (imprecision, fix it)?
//
// `boolean=?`'s own impl answers the question directly — its local `unwrap()` closure
// explicitly branches `typeof b === "boolean"` OR `b instanceof ABool`, so a raw JS
// boolean is a genuine, load-bearing second representation (booleans cross the rosetta
// membrane unboxed — see scheme-zod.ts's `boolean` codec). `z.array(z.unknown())` stays.
//
// `symbol=?`'s impl has NO such unwrap step — it is a bare `instanceof ASymbol` check,
// with no raw-JS-symbol branch. The representation test (`laws/equality.law.test.ts`)
// independently confirms this for the whole scalar pair: "CHARACTERS & SYMBOLS — always
// boxed in practice (no plain-JS counterpart)". There is no codec for symbols in
// scheme-zod.ts either (only string/boolean/char/number/integer/bigint have one) — so no
// sanctioned raw-JS-symbol shape ever crosses the membrane. `z.array(z.unknown())` here was
// imprecision, not blindness — tightened to `z.array(z.symbol)` (the SAME identity primitive
// `symbol->string`/`string->symbol` already use two symbols down in this very file).
describe("2026-07-05 audit — scheme/equality: symbol=? input precision (boolean=? deliberately unchanged)", () => {
  // INVARIANT: symbol=?'s input schema requires both arguments to be real ASymbols; a mix of
  // symbol/non-symbol or two non-symbols is rejected
  it("symbol=?: input is now z.array(z.symbol) — a non-symbol used to slip through the old z.array(z.unknown())", () => {
    const def = contractDef(equalityPack, "symbol=?");
    const a = new ASymbol(CONSTANT_CTX, "a");
    const b = new ASymbol(CONSTANT_CTX, "b");
    expect(def.in.safeParse([a, b]).success).toBe(true);
    expect(def.in.safeParse([a, "not-a-symbol"]).success).toBe(false); // mixed: one real symbol, one raw string
    expect(def.in.safeParse(["not-a-symbol", 42]).success).toBe(false); // no symbols at all — was true before the fix
  });

  // REBASELINE: the uniform-scheme-zod-vocabulary migration retired z.unknown() from this env
  // layer entirely (scheme-zod.ts v2 doesn't re-export it — see srfi-95.ts's own note: "z.value
  // is the typed replacement for z.unknown() at exactly this kind of native scheme-value slot").
  // boolean=?'s contract is `inputRest: z.value` (isSchemeValue: instanceof AValue or a
  // function) — genuinely NOT host-blind at the schema level (a raw JS boolean fails it), even
  // though the impl's own unwrap() still handles both representations at RUNTIME (native ops
  // never validate — see this file's own header note). The mixed-representation runtime
  // behavior stays load-bearing (equality.ts's unwrap()); only the zod schema's acceptance
  // domain is now honestly "boxed scheme value," matching every other slot this migration
  // touched.
  // INVARIANT: boolean=?'s input schema is z.value (a raw JS boolean is rejected at the schema
  // level); the impl's own unwrap() still branches on boxed ABool vs raw JS boolean and accepts
  // both at runtime, since native ops never validate against their own schema (pins implementation, not behavior —
  // supersedes the historical "schema deliberately stays z.unknown()" shape)
  it("boolean=?: input is z.value — a raw JS boolean is genuinely rejected by the schema (though the impl's own unwrap() still accepts both representations at runtime)", () => {
    const def = contractDef(equalityPack, "boolean=?");
    expect(def.in.safeParse([true, false]).success).toBe(false);
    expect(def.in.safeParse([new ABool(CONSTANT_CTX, true), new ABool(CONSTANT_CTX, false)]).success).toBe(true);
    expect(def.in.safeParse([true, new ABool(CONSTANT_CTX, true)]).success).toBe(false);
  });
});

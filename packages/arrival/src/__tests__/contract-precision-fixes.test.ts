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
import corePack from "../env/core/core.js";
import type { SymbolDef } from "../common/symbol.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { AString } from "../values/primitives/AString.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

/** A pack's `.spec.symbols` map, generically — mirrors numeric-contract-precision.test.ts's
 *  `numericPack.spec.symbols as Record<string, SymbolDef>` access pattern. */
function symbolsOf(pack: { spec: { symbols?: unknown } }): Record<string, SymbolDef> {
  return pack.spec.symbols as Record<string, SymbolDef>;
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
const properList = new APair(CONSTANT_CTX, 1, nil);
const realString = new AString(CONSTANT_CTX, "abc");
const valuable = { valueOf: () => 1 };

describe("2026-07-05 audit — runtime Contract precision on the REAL exported ops", () => {
  it("for-each: rest elements must now be a proper list (Pair|Nil) — a non-list used to slip through the old z.array(z.value)", () => {
    const def = contractDef(listsPack, "for-each");
    expect(def.in.safeParse([fn, properList]).success).toBe(true);
    expect(def.in.safeParse([fn, nil]).success).toBe(true);
    expect(def.in.safeParse([fn, "not-a-list"]).success).toBe(false);
  });

  it("string-map: rest elements must now be a real SchemeString (AString) — a raw JS string used to slip through the old z.array(z.unknown())", () => {
    const def = contractDef(stringsPack, "string-map");
    expect(def.in.safeParse([fn, realString]).success).toBe(true);
    expect(def.in.safeParse([fn, "raw-js-string"]).success).toBe(false);
  });

  it("string-for-each: same rest-precision fix as string-map", () => {
    const def = contractDef(stringsPack, "string-for-each");
    expect(def.in.safeParse([fn, realString]).success).toBe(true);
    expect(def.in.safeParse([fn, "raw-js-string"]).success).toBe(false);
  });

  it("filter: input is now a fixed 2-tuple — a 3rd element used to slip through the old z.tuple([u], u) unbounded rest", () => {
    const def = contractDef(srfi1Pack, "filter");
    expect(def.in.safeParse([fn, properList]).success).toBe(true);
    expect(def.in.safeParse([fn, properList, "extra"]).success).toBe(false);
  });

  it("typecheck: input is now a fixed 4-tuple (3 required + 1 genuinely optional) — a 5th arg used to slip through the old unbounded rest", () => {
    const def = contractDef(corePack, "typecheck");
    expect(def.in.safeParse([valuable, 1, valuable]).success).toBe(true); // 3 — 4th omitted, allowed by .optional()
    expect(def.in.safeParse([valuable, 1, valuable, 2]).success).toBe(true); // 4 — all positions present
    expect(def.in.safeParse([valuable, 1, valuable, 2, "extra"]).success).toBe(false); // 5 — was true before the fix
  });
});

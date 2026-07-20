/**
 * LAW N1b — PARSE_CTX: parse-origin ctx carries the SourceLocation the Parser computes
 * (arrival-parse-ctx-consumer-map-2026-07-11.md; arrival-constant-ctx-audit §3).
 *
 * Three rows, per the ruling:
 *   (a) A parsed LEAF literal's ctx carries its source span — the new capability. Only
 *       APair has a `[LOCATION]` slot; strings/numbers/chars/vectors/bytevectors/dicts
 *       were provenance-blind on BOTH channels until this wave. SYMBOLS are the one
 *       adjudicated carve-out: ASymbol's flyweight interning is keyed by ctx, and raw
 *       `===` on interned symbols is load-bearing (memq/assq, the specials table), so
 *       parsed symbols stay on CONSTANT_CTX byte-identical — their per-occurrence span
 *       is blocked on the `===` sites delegating to `eq()` (see parse_argument's note).
 *   (b) The span channel is a derived MIRROR: every located APair's `[LOCATION]` slot and
 *       its ctx agree exactly (same loc), and the mirror SET did not grow — the quote-family
 *       INNER cell rides the ctx channel only, so the evaluator tap gate (`LOCATION in code`,
 *       evaluator.ts) sees a byte-identical membership. (The full behavioral pin is the
 *       existing wireframe/provenance/replay suites.)
 *   (c) Parse-minted values never carry a run's heap charge — parse is pre-run; the parse
 *       family is run-neutral by charter (no meter/cache/effects/reads/signal).
 *
 * Plus the two boundary pins the audit calls out:
 *   - the NOT-subsumed singletons (#t/#f/±inf/nan, the specials quote-symbol table) stay
 *     shared-by-reference across parses — never per-occurrence;
 *   - per-occurrence symbol identity (the accepted allocation cost) is semantics-preserving
 *     because eq?/eqv?/equals compare `__name__`, never reference.
 */
import { describe, expect, it } from "vitest";
import { parse } from "../../reader/parse.js";
import {
  CONSTANT_CTX,
  PARSE_CTX,
  isParseCtx,
  makeParseCtx,
  makeRunContext,
} from "../../values/primitives/RunContext.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { chargeHeap } from "../../heap-budget.js";
import { eq } from "../../values/structural-equal.js";
import { APair } from "../../values/primitives/APair.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { AVector } from "../../values/primitives/AVector.js";
import { ABytevector } from "../../values/primitives/ABytevector.js";
import { ADict } from "../../values/primitives/ADict.js";
import type { SchemeValue } from "../../values/types.js";

/** The parse-origin assertion: ctx is the parse family and pins the leaf's offset. */
function expectParsedAt(value: SchemeValue, src: string, token: string, source?: string) {
  const ctx = ctxOf(value);
  expect(isParseCtx(ctx)).toBe(true);
  expect(ctx.location).toBeDefined();
  expect(ctx.location!.offset).toBe(src.indexOf(token));
  if (source !== undefined) expect(ctx.location!.source).toBe(source);
}

/** Collect every reachable APair (spine + nested), cycle-safe. */
function allPairs(value: unknown, out: APair<any, any>[] = [], seen = new Set<unknown>()): APair<any, any>[] {
  if (!(value instanceof APair) || seen.has(value)) return out;
  seen.add(value);
  out.push(value);
  allPairs(value.car, out, seen);
  allPairs(value.cdr, out, seen);
  return out;
}

describe("law (a) — parsed leaf literals carry their source span on the ctx channel", () => {
  it("atoms: string, integer, float, character (symbols: see the interning carve-out row)", async () => {
    const src = String.raw`(foo "bar" 42 3.14 #\c)`;
    const [form] = await parse(src, "test.scm");
    const items: SchemeValue[] = [];
    for (let n: unknown = form; n instanceof APair; n = n.cdr) items.push(n.car);
    const [sym, str, int, flt, chr] = items;

    expect(sym).toBeInstanceOf(ASymbol);
    expect(str).toBeInstanceOf(AString);
    expectParsedAt(str, src, '"bar"', "test.scm");
    expect(int).toBeInstanceOf(AExact);
    expectParsedAt(int, src, "42", "test.scm");
    expect(flt).toBeInstanceOf(AInexact);
    expectParsedAt(flt, src, "3.14", "test.scm");
    expect(chr).toBeInstanceOf(ACharacter);
    expectParsedAt(chr, src, String.raw`#\c`, "test.scm");
  });

  it("container literals: [] vector, #() vector, #u8() bytevector, {} dict", async () => {
    const src = "[1 2] #(3 4) #u8(5 6) {:a 7}";
    const [sq, hashVec, bytes, dict] = await parse(src);

    expect(sq).toBeInstanceOf(AVector);
    expectParsedAt(sq, src, "[");
    expect(hashVec).toBeInstanceOf(AVector);
    expectParsedAt(hashVec, src, "#(");
    expect(bytes).toBeInstanceOf(ABytevector);
    expectParsedAt(bytes, src, "#u8(");
    expect(dict).toBeInstanceOf(ADict);
    expectParsedAt(dict, src, "{");
  });

  it("elements INSIDE container literals carry their own leaf spans", async () => {
    const src = "[10 20]";
    const [vec] = await parse(src);
    const elements = (vec as AVector).valueOf() as SchemeValue[];
    expectParsedAt(elements[0], src, "10");
    expectParsedAt(elements[1], src, "20");
  });

  it("dict keys: string keys carry their span; keyword keys (symbols) stay interned-shared", async () => {
    const src = '{:a 1 b: 2 "c" 3}';
    const [dict] = await parse(src);
    const forms = (dict as ADict & { literalForms: readonly SchemeValue[] }).literalForms;
    // "c" — string key leaf carries its exact span.
    expectParsedAt(forms[4], src, '"c"');
    // b: — the flip canonicalizes to the keyword twin under the ORIGINAL token's ctx
    // (symbol carve-out: CONSTANT_CTX interning), so the flipped key is THE interned
    // `:b` — reference-shared with any other parse of `:b`.
    expect(String(forms[2])).toBe(":b");
    const [kb] = await parse(":b");
    expect(forms[2]).toBe(kb);
  });

  it("quote-family expansion pairs carry the prefix span on both channels", async () => {
    const src = "'x";
    const [form] = await parse(src);
    expect(form).toBeInstanceOf(APair);
    const outer = form as APair<any, any>;
    expectParsedAt(outer, src, "'");
    expect(outer.getLocation()?.offset).toBe(0); // the mirror
  });
});

describe("law (b) — setLocation is a derived mirror: both channels agree, the mirror set did not grow", () => {
  it("every located APair's [LOCATION] slot equals its ctx.location", async () => {
    const [form] = await parse("(a (b c) '(d . e) [f] {:g h})");
    for (const pair of allPairs(form)) {
      const mirror = pair.getLocation();
      if (mirror === undefined) continue;
      const ctx = ctxOf(pair);
      expect(isParseCtx(ctx)).toBe(true);
      expect(ctx.location).toBe(mirror); // the SAME loc object — one fact, two channels
    }
  });

  it("list head cells carry the OPEN-PAREN loc (the pre-existing final overwrite), on both channels", async () => {
    const src = "(a (b c))";
    const [form] = await parse(src);
    const outer = form as APair<any, any>;
    expect(outer.getLocation()?.offset).toBe(0);
    expect(ctxOf(outer).location?.offset).toBe(0);
    const inner = outer.cdr.car as APair<any, any>;
    expect(inner.getLocation()?.offset).toBe(src.indexOf("(b"));
    expect(ctxOf(inner).location?.offset).toBe(src.indexOf("(b"));
  });

  it("the quote-family INNER cell stays OFF the mirror (tap-gate membership unchanged) while its ctx carries the span", async () => {
    const [form] = await parse("'x");
    const inner = (form as APair<any, any>).cdr as APair<any, any>;
    expect(inner.getLocation()).toBeUndefined(); // NOT tapped — byte-identical to pre-PARSE_CTX
    expect(isParseCtx(ctxOf(inner))).toBe(true);
    expect(ctxOf(inner).location?.offset).toBe(0); // …but the ctx channel knows where it came from
  });

  it("every spine cell of a parsed list is located on both channels", async () => {
    const [form] = await parse("(a b c)");
    for (const pair of allPairs(form)) {
      expect(pair.getLocation()).toBeDefined();
      expect(ctxOf(pair).location).toBe(pair.getLocation());
    }
  });
});

describe("law (c) — parse is pre-run: the parse family is run-neutral, never heap-charged", () => {
  it("parse ctxs carry no run state whatsoever", async () => {
    const [form] = await parse('(x "y" 1)');
    for (const leaf of [form, (form as APair<any, any>).cdr.car]) {
      const ctx = ctxOf(leaf as SchemeValue);
      expect(isParseCtx(ctx)).toBe(true);
      expect(ctx.heapMeter).toBeUndefined();
      expect(ctx.cache).toBeUndefined();
      expect(ctx.effects).toBeUndefined();
      expect(ctx.reads).toBeUndefined();
      expect(ctx.signal).toBeUndefined();
      expect(ctx.strict).toBe(false);
      expect(Object.isFrozen(ctx)).toBe(true);
    }
  });

  it("chargeHeap is a no-op against a parse ctx (the meter distinction stays honest)", () => {
    expect(() => chargeHeap(PARSE_CTX, 10_000_000)).not.toThrow();
    expect(() => chargeHeap(makeParseCtx({ line: 1, col: 0, offset: 0 }), 10_000_000)).not.toThrow();
  });

  it("family discrimination: parse ctxs are neither CONSTANT_CTX nor a live run", () => {
    expect(isParseCtx(PARSE_CTX)).toBe(true);
    expect(isParseCtx(makeParseCtx({ line: 1, col: 0, offset: 0 }))).toBe(true);
    expect(isParseCtx(CONSTANT_CTX)).toBe(false);
    expect(isParseCtx(makeRunContext())).toBe(false);
    // No-location mints share the singleton — zero per-node allocation without a loc.
    expect(makeParseCtx(undefined)).toBe(PARSE_CTX);
  });
});

describe("boundary pins — what PARSE_CTX deliberately does NOT subsume", () => {
  it("the true singletons stay shared by reference across parses (never per-occurrence)", async () => {
    const [t1, inf1] = await parse("#t +inf.0");
    const [t2, inf2] = await parse("#t +inf.0");
    expect(t1).toBe(t2);
    expect(inf1).toBe(inf2);
    expect(isParseCtx(ctxOf(t1))).toBe(false);
    expect(isParseCtx(ctxOf(inf1))).toBe(false);
  });

  it("the specials quote-symbol table stays shared (dispatch identity preserved)", async () => {
    const [q1] = await parse("'a");
    const [q2] = await parse("'b");
    expect((q1 as APair<any, any>).car).toBe((q2 as APair<any, any>).car);
  });

  it("parsed symbols stay flyweight-shared across parses (the interning carve-out — memq/assq's `===` depends on it)", async () => {
    const [a1] = await parse("foo");
    const [a2] = await parse("foo");
    expect(a1).toBe(a2); // ONE interned instance — reference identity preserved
    expect(isParseCtx(ctxOf(a1))).toBe(false); // CONSTANT_CTX, byte-identical to pre-wave
    expect(eq(a1, a2)).toBe(true);
  });
});

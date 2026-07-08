/**
 * LAW F3 — the membrane converts everything, once, uniformly (P4/P5/P9).
 *
 * Driven entirely by _tables/crossings.ts: entry form, exit form (ONE convention
 * column — R1-gated), round-trip promise. Plus the violation table: every
 * forbidden crossing throws its teaching door.
 *
 * BODY PHASE: titles stay data-driven off the table (row.entryForm / row.exitForm /
 * row.roundTrip decide the TEXT); bodies are per-row because the table doesn't carry
 * a sample JS value. The exitForm column is still "R1-PENDING" on every boxed-type
 * row — those exit cells stay `it.todo` (bodies land after V's exit-convention
 * ruling; filling one now would re-pin one side of the P4 contradiction). Everything
 * else (entry, round-trip, provenance) is fillable today and doesn't depend on that
 * ruling — provenance-stripping on exit is universal regardless of what shape the
 * final exit convention takes.
 */
import { describe, expect, it, vi } from "vitest";
import { CROSSINGS, VIOLATIONS } from "../laws/_tables/crossings.js";
import { fromJS, toJS, isSchemeValue } from "../../membrane.js";
import { jsToScheme, schemeToJs } from "../../rosetta.js";
import { setMembraneWarnings } from "../../membrane-warn.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { ABool } from "../../values/primitives/ABool.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import { APair } from "../../values/primitives/APair.js";
import { AJSArray } from "../../values/primitives/AJSArray.js";
import { AJSObject } from "../../values/primitives/AJSObject.js";
import { is_half_baked } from "../../values/primitives/AHalfBaked.js";
import { exec } from "../../eval/generator-exec.js";
import type { SchemeValue } from "../../values/types.js";

const PROV = new Set<number>([777]);

/** P4: nothing that crosses OUT carries a stray `provenance` own-property — a raw
 *  JS value (a primitive, or a wrapper's original `.source`) never had one to begin
 *  with; this is the negative half of "exit leaves lineage in the trace, none on
 *  the JS value." */
function expectNoProvenanceProperty(x: unknown): void {
  if (x !== null && typeof x === "object") {
    expect(Object.prototype.hasOwnProperty.call(x, "provenance")).toBe(false);
  }
}

/**
 * `fromJS` is typed to return `FromJSResult` — a NAMED SUPERSET of `SchemeValue`
 * (control forms / raw FFI passthrough live outside the value-intent union, per
 * membrane.ts's own doc). `toJS` takes `SchemeValue`. Every value this grid feeds
 * back into `toJS` for a round-trip assertion is honestly a `SchemeValue` at
 * runtime — the mismatch is only in the declared union's width. membrane.spec.ts
 * pins the same gap with a repeated `@ts-expect-error`; centralized here once
 * instead of scattered per call site.
 */
const exitJS = (entered: unknown): unknown => toJS(entered as SchemeValue);

describe.each(CROSSINGS.map((r) => [r.type, r] as const))("crossing: %s", (_t, row) => {
  const entryTitle = `entry (JS→scheme): becomes ${row.entryForm}`;
  const exitTitle =
    row.exitForm === "R1-PENDING"
      ? "exit (scheme→JS): single exit convention [RULING-GATED: R1]"
      : `exit (scheme→JS): becomes ${row.exitForm}`;
  const roundTripTitle = row.roundTrip
    ? "round-trip: exact (promised, tested as a law — P9)"
    : "one-way: total honest projection, no reconstruction markers (P9)";
  const provenanceTitle = "provenance: entry deep-stamps; exit leaves lineage in the trace, none on the JS value (P4)";

  switch (row.type) {
    case "boolean": {
      it(entryTitle, () => {
        const entered = fromJS(true);
        expect(entered).toBeInstanceOf(ABool);
        expect((entered as ABool).valueOf()).toBe(true);
      });
      it.todo(exitTitle); // R1-PENDING
      it(roundTripTitle, () => {
        expect(exitJS(fromJS(true))).toBe(true);
        expect(exitJS(fromJS(false))).toBe(false);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, true, {}, PROV);
        expect(stamped).toBeInstanceOf(ABool);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "safe-int number": {
      it(entryTitle, () => {
        const entered = fromJS(42);
        expect(entered).toBeInstanceOf(AExact);
        expect((entered as AExact).num).toBe(42n);
      });
      it.todo(exitTitle); // R1-PENDING
      it(roundTripTitle, () => {
        expect(exitJS(fromJS(42))).toBe(42);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, 42, {}, PROV);
        expect(stamped).toBeInstanceOf(AExact);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "float number": {
      it(entryTitle, () => {
        const entered = fromJS(3.14);
        expect(entered).toBeInstanceOf(AInexact);
        expect((entered as AInexact).real).toBe(3.14);
      });
      it.todo(exitTitle); // R1-PENDING
      it(roundTripTitle, () => {
        expect(exitJS(fromJS(3.14))).toBe(3.14);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, 3.14, {}, PROV);
        expect(stamped).toBeInstanceOf(AInexact);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "bigint": {
      it(entryTitle, () => {
        const entered = fromJS(10n);
        expect(entered).toBeInstanceOf(AExact);
        expect((entered as AExact).num).toBe(10n);
      });
      it.todo(exitTitle); // R1-PENDING
      it(`${roundTripTitle} — normalizes to number in-range`, () => {
        // In-range: the exact integer surfaces as a plain JS number — no bigint tag survives.
        const inRange = exitJS(fromJS(10n));
        expect(inRange).toBe(10);
        expect(typeof inRange).toBe("number");
        // Out-of-range: still a total, honest projection — a real bigint, not a lossy
        // Number() cast and not a marker object.
        const huge = 12345678901234567890n;
        const outOfRange = exitJS(fromJS(huge));
        expect(typeof outOfRange).toBe("bigint");
        expect(outOfRange).toBe(huge);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, 10n, {}, PROV);
        expect(stamped).toBeInstanceOf(AExact);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "string": {
      it(entryTitle, () => {
        const entered = fromJS("hello");
        expect(entered).toBeInstanceOf(AString);
        expect((entered as AString).valueOf()).toBe("hello");
      });
      it.todo(exitTitle); // R1-PENDING
      it(roundTripTitle, () => {
        expect(exitJS(fromJS("hello"))).toBe("hello");
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, "hello", {}, PROV);
        expect(stamped).toBeInstanceOf(AString);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "null": {
      it(entryTitle, () => {
        expect(fromJS(null)).toBe(nil);
      });
      it(exitTitle, () => {
        expect(toJS(nil)).toBe(null);
      });
      // membrane's own fromJS/toJS round-trip fine (both reuse the `nil` singleton); the
      // asymmetry lives in the ROSETTA surface: jsToScheme(null) → nil, but
      // schemeToJs(nil) → the nil SINGLETON, not `null` (membrane-symmetry.test.ts pins
      // the same gap).
      // @ledger: null↔nil round-trip asymmetry
      it.fails(roundTripTitle, () => {
        expect(schemeToJs(jsToScheme(CONSTANT_CTX, null))).toBeNull();
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, null, {}, PROV);
        expect(stamped).toBeInstanceOf(ANil);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expect(toJS(stamped)).toBe(null);
      });
      break;
    }

    case "undefined": {
      it(entryTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          expect(fromJS(undefined)).toBe(theVoid);
          expect(spy).toHaveBeenCalledTimes(1);
          spy.mockClear();
          setMembraneWarnings(false);
          expect(fromJS(undefined)).toBe(theVoid);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          setMembraneWarnings(true);
          spy.mockRestore();
        }
      });
      it(exitTitle, () => {
        expect(toJS(theVoid)).toBe(undefined);
      });
      it(roundTripTitle, () => {
        expect(exitJS(fromJS(undefined))).toBe(undefined);
      });
      it(provenanceTitle, () => {
        // theVoid is a shared, data-free singleton (the "unspecified" marker) — jsToScheme
        // returns it unconditionally for every non-portable JS input, never a fresh
        // provenance-stamped clone. There is no payload here for a stamp to attach to.
        const stamped = jsToScheme(CONSTANT_CTX, undefined, {}, PROV);
        expect(stamped).toBe(theVoid);
        expect(stamped.provenance.size).toBe(0);
        expect(toJS(stamped)).toBe(undefined);
      });
      break;
    }

    case "registered symbol (Symbol.for)": {
      it(entryTitle, () => {
        const entered = fromJS(Symbol.for("test"));
        expect(entered).toBeInstanceOf(ASymbol);
        expect((entered as ASymbol).__name__).toBe(":test");
      });
      it.todo(exitTitle); // R1-PENDING
      it(`${roundTripTitle} — a symbol exits as a string, never the original JS Symbol`, () => {
        const out = exitJS(fromJS(Symbol.for("test")));
        expect(typeof out).toBe("string");
        expect(out).toBe("':test");
      });
      it(provenanceTitle, () => {
        // A DISTINCT name from the entry test above, deliberately: ASymbol's flyweight
        // intern table (per-ctx, keyed by NAME only — see ASymbol.ts's "Provenance ×
        // interning invariant" doc) would otherwise hand back the entry test's already-
        // cached empty-provenance ":test" instance instead of minting a fresh stamped one.
        const stamped = jsToScheme(CONSTANT_CTX, Symbol.for("test-provenance-row"), {}, PROV);
        expect(stamped).toBeInstanceOf(ASymbol);
        expect([...stamped.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "unique symbol": {
      it(entryTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          expect(fromJS(Symbol("test"))).toBe(theVoid);
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          spy.mockRestore();
        }
      });
      // exitForm: "n/a" — no exit cell for this row.
      it(roundTripTitle, () => {
        expect(exitJS(fromJS(Symbol("x")))).toBe(undefined);
      });
      it(provenanceTitle, () => {
        // Same theVoid-singleton shed as `undefined` above — a unique symbol has no
        // portable payload, so there is nothing for a provenance stamp to attach to.
        const stamped = jsToScheme(CONSTANT_CTX, Symbol("test"), {}, PROV);
        expect(stamped).toBe(theVoid);
        expect(stamped.provenance.size).toBe(0);
      });
      break;
    }

    case "array": {
      it(entryTitle, () => {
        const arr = [1, 2, 3];
        const entered = fromJS(arr);
        expect(entered).toBeInstanceOf(AJSArray);
        expect((entered as AJSArray).source).toBe(arr);
        expect((entered as AJSArray).kind).toBe("vector");
        expect(fromJS(arr)).toBe(entered); // identity cache
      });
      it(exitTitle, () => {
        const arr = [1, 2, 3];
        expect(exitJS(fromJS(arr))).toBe(arr);
      });
      it(roundTripTitle, () => {
        const arr = [1, 2, 3];
        expect(exitJS(fromJS(arr))).toBe(arr);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, ["a", "b"], {}, PROV);
        expect(stamped).toBeInstanceOf(AJSArray);
        expect([...stamped.provenance]).toEqual([...PROV]);
        const elems = (stamped as AJSArray).__vector__ as AString[];
        expect(elems[0]).toBeInstanceOf(AString);
        expect([...elems[0].provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "plain object": {
      it(entryTitle, () => {
        const obj = { a: 1 };
        const entered = fromJS(obj);
        expect(entered).toBeInstanceOf(AJSObject);
        expect((entered as AJSObject).source).toBe(obj);
        expect(fromJS(obj)).toBe(entered); // identity cache
      });
      it(exitTitle, () => {
        const obj = { a: 1 };
        expect(exitJS(fromJS(obj))).toBe(obj);
      });
      it(roundTripTitle, () => {
        const obj = { a: 1 };
        expect(exitJS(fromJS(obj))).toBe(obj);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, { name: "claude" }, {}, PROV);
        expect(stamped).toBeInstanceOf(AJSObject);
        expect([...stamped.provenance]).toEqual([...PROV]);
        const name = (stamped as AJSObject).get("name") as AString;
        expect(name).toBeInstanceOf(AString);
        expect([...name.provenance]).toEqual([...PROV]);
        expectNoProvenanceProperty(toJS(stamped));
      });
      break;
    }

    case "Uint8Array/ArrayBuffer/DataView": {
      it(entryTitle, () => {
        const u8 = new Uint8Array([1, 2, 3]);
        expect(fromJS(u8)).toBe(u8);
        expect(isSchemeValue(fromJS(u8))).toBe(false); // stays raw, never boxed
        const ab = new ArrayBuffer(10);
        expect(fromJS(ab)).toBe(ab);
        const dv = new DataView(new ArrayBuffer(10));
        expect(fromJS(dv)).toBe(dv);
      });
      it(exitTitle, () => {
        // Never boxed on entry, so there is nothing to unbox on exit. Use rosetta's
        // schemeToJs (not membrane.toJS): toJS's strict door refuses a value that never
        // crossed AS a scheme value in the first place — schemeToJs's generic fallback
        // just returns it unchanged, matching the "raw" exit form honestly.
        const u8 = new Uint8Array([1, 2, 3]);
        expect(schemeToJs(fromJS(u8))).toBe(u8);
      });
      it(roundTripTitle, () => {
        const u8 = new Uint8Array([1, 2, 3]);
        expect(schemeToJs(fromJS(u8))).toBe(u8);
      });
      it(provenanceTitle, () => {
        // FFI-identity named superset (P4): the binary never boxes, so a supplied
        // provenance has no carrier to attach to — jsToScheme's exotic-object fallback
        // returns it as-is.
        const u8 = new Uint8Array([1, 2, 3]);
        expect(jsToScheme(CONSTANT_CTX, u8, {}, PROV)).toBe(u8);
        expectNoProvenanceProperty(u8);
      });
      break;
    }

    case "Promise": {
      it(entryTitle, () => {
        const p = Promise.resolve(42);
        expect(fromJS(p)).toBe(p);
      });
      // exitForm: "n/a" — a Promise never crosses back out through toJS; the evaluator
      // trampoline awaits it before anything could exit.
      it(`${roundTripTitle} — identity pass-through is the whole projection`, () => {
        const p = Promise.resolve(42);
        expect(fromJS(p)).toBe(p);
        expect(isSchemeValue(fromJS(p))).toBe(false);
      });
      it(provenanceTitle, () => {
        // Never boxed — same FFI-identity shape as the binary types above.
        const p = Promise.resolve(1);
        expect(jsToScheme(CONSTANT_CTX, p, {}, PROV)).toBe(p);
      });
      break;
    }

    case "function (borrowed)": {
      it(entryTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          expect(fromJS(() => 42)).toBe(theVoid);
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          spy.mockRestore();
        }
      });
      it.todo(exitTitle); // [INVERTS: reverse-membrane/P6] — staged on the region-discipline
      // migration (region.law.test.ts owns its acceptance tests); today there is no
      // region-scoped wrapper to test, so filling this now would just re-pin the gap.
      it(`${roundTripTitle} — a borrowed function voids on entry and stays void through exit`, () => {
        expect(exitJS(fromJS(() => 42))).toBe(undefined);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, () => 42, {}, PROV);
        expect(stamped).toBe(theVoid);
        expect(stamped.provenance.size).toBe(0);
      });
      break;
    }

    case "proper list (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only — no JS value produces this entry form
      it(exitTitle, () => {
        const list = APair.fromArray(CONSTANT_CTX, [
          new AExact(CONSTANT_CTX, 1n),
          new AExact(CONSTANT_CTX, 2n),
          new AExact(CONSTANT_CTX, 3n),
        ]);
        expect(toJS(list)).toEqual([1, 2, 3]);
      });
      it(roundTripTitle, () => {
        const list = APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n)]);
        const out = toJS(list);
        expect(Array.isArray(out)).toBe(true);
        expect(Object.keys(out as object).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        // scheme→JS only — no entry side to check; exit must leave the array (and its
        // elements) with no stray `provenance` property.
        const list = APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
        const out = toJS(list) as unknown[];
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out[0]);
      });
      break;
    }

    case "dotted pair (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only
      it(exitTitle, () => {
        const dotted = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n));
        expect(toJS(dotted)).toEqual([1, 2]);
      });
      it(`${roundTripTitle} — no {__dotted__} escape shape`, () => {
        const dotted = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n));
        const out = toJS(dotted);
        expect(Array.isArray(out)).toBe(true);
        expect(Object.keys(out as object).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        const dotted = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n));
        const out = toJS(dotted) as unknown[];
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out[0]);
        expectNoProvenanceProperty(out[1]);
      });
      break;
    }

    default: {
      // Exhaustiveness guard: a row added to the table without a case here is a
      // design bug the stub grid should catch (F3 design note: "a stub grid that
      // can't express an invariant is a design bug caught free").
      throw new Error(`crossing.law.test.ts: unhandled crossing row type "${row.type}" — add a case above`);
    }
  }
});

describe.each(VIOLATIONS.map((v) => [v.name, v] as const))("forbidden crossing: %s", (_n, v) => {
  const title = `throws the teaching door: ${String(v.door)} (P5 — loud at the crossing, never later)`;

  switch (v.name) {
    case "boxed value into fromJS": {
      it(title, () => {
        const exact = new AExact(CONSTANT_CTX, 42n);
        // @ts-expect-error type-level: an AValue argument resolves to never — the point of
        // this row is the RUNTIME door, deliberately called past the type-level one.
        expect(() => fromJS(exact)).toThrow(v.door);
        const pair = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n));
        // @ts-expect-error see above
        expect(() => fromJS(pair)).toThrow(v.door);
      });
      break;
    }

    case "wrapper re-entry into fromJS": {
      it(title, () => {
        const obj = { a: 1 };
        const wrapped = fromJS(obj);
        // NOTE: no `@ts-expect-error` here (unlike the concrete-AValue row above) — `wrapped`'s
        // static type is the wide `FromJSResult` union, which the `[T] extends [AValue] ? never
        // : T` conditional does NOT collapse to `never` for (the union also contains non-AValue
        // members). The runtime door still fires — `isSchemeValue` narrows at runtime where the
        // type system can't narrow the union statically.
        expect(() => fromJS(wrapped)).toThrow(v.door);
      });
      break;
    }

    case "raw JS value into toJS": {
      it(title, () => {
        // Deliberately breach the type-level door: `toJS`'s parameter is `SchemeValue` —
        // passing a raw number requires an explicit unsound `never` cast. That breach IS
        // the test: the runtime invariant must catch what the type system alone would have
        // refused to compile.
        expect(() => toJS(42 as never)).toThrow(v.door);
      });
      break;
    }

    case "membrane write": {
      it(title, () => {
        const source: { a: number } = { a: 1 };
        const obj = new AJSObject(CONSTANT_CTX, source);
        expect(() => obj.set("a", new AExact(CONSTANT_CTX, 42n))).toThrow(v.door);
        expect(source.a).toBe(1); // nothing crossed the boundary
      });
      break;
    }

    case "membrane delete": {
      it(title, () => {
        const source: { a: number } = { a: 1 };
        const obj = new AJSObject(CONSTANT_CTX, source);
        expect(() => obj.delete("a")).toThrow(v.door);
        expect(source.a).toBe(1);
      });
      break;
    }

    default: {
      throw new Error(`crossing.law.test.ts: unhandled violation row "${v.name}" — add a case above`);
    }
  }
});

describe("egress of deferred carriers", () => {
  // Absorbs deferred-value-egress.test.ts's todos + flips its green leak (manifest B).
  // All three rows gate on the SAME migration (force-on-egress); the ledger names the
  // top-level escape explicitly ("live AHalfBaked escapes exec under speculate") — the
  // deep/ctx rows below are the identical gap observed at greater structural depth, so
  // they cite the same ledger id.

  // @ledger: live AHalfBaked escapes exec under speculate
  it.fails("[it.fails until force-on-egress] a live AHalfBaked never escapes exec, speculate on or off", async () => {
    const [result] = await exec("(filter (lambda (x) (> x 0)) (list 1 -2 3))", { speculate: true });
    expect(is_half_baked(result)).toBe(false);
  });

  // @ledger: live AHalfBaked escapes exec under speculate
  it.fails("force-on-egress is deep: a carrier nested in a returned pair/vector is materialized", async () => {
    // quasiquote builds its result pair directly (`new APair(...)` in evalQuasiquote /
    // processQuasiquote, evaluator.ts) rather than through a procedure call — so it
    // bypasses the force-on-unknown-boundary chokepoint entirely (that chokepoint only
    // forces a HalfBaked ARG immediately before a real `fn.apply`, evaluator.ts:3090).
    // A HalfBaked produced by the unquoted `filter` call rides straight into the built
    // pair unforced.
    //
    // The unquoted expression is the `filter` call directly — NOT a `let`-bound name.
    // Binding it via `let` first routes the value through `Environment.set` →
    // `membrane.fromJS`, which (a SEPARATE, real gap, ledgered as "isSchemeValue omits
    // AHalfBaked — Environment.set re-wraps live carriers") silently re-wraps the live
    // carrier in an `AJSObject`, confounding this row's own assertion. Reported
    // alongside this suite's other findings; not itself asserted by any row here (no
    // it.fails cites it) — the ledger row exists as an index entry for this documented
    // gap ahead of a dedicated test.
    const [result] = await exec(
      "`(wrapped ,(filter (lambda (x) (> x 0)) (list 1 -2 3)))",
      { speculate: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exploratory egress
    // inspection of a not-yet-materialized structure; the acceptance shape isn't typed yet.
    const nested = (result as any).cdr.car;
    expect(is_half_baked(nested)).toBe(false);
  });

  // @ledger: live AHalfBaked escapes exec under speculate
  it.fails("a forced-at-egress carrier's elements carry the producing run's ctx", async () => {
    const [result] = await exec(
      "`#(wrapped ,(filter (lambda (x) (> x 0)) (list 1 -2 3)))",
      { speculate: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const nested = (result as any).__vector__[1];
    // Desired end-state: force-on-egress already materialized `nested` into a Pair whose
    // elements carry THIS run's ctx (speculate:true). Today `nested` is still a live,
    // unforced AHalfBaked carrying the LIST LITERAL's ctx (CONSTANT_CTX, speculate:false)
    // rather than the run's — confirmed even after a manual `.force()`, so this is not
    // just "unforced", the ctx plumbing itself doesn't carry the producing run through.
    expect(is_half_baked(nested)).toBe(false);
    expect(nested.ctx.speculate).toBe(true);
  });
});

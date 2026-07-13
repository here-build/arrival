/**
 * LAW F3 — the membrane converts everything, once, uniformly (P4/P5/P9).
 *
 * Driven entirely by _tables/crossings.ts: entry form, exit form (ONE convention
 * column — R1-RULED), round-trip promise. Plus the violation table: every
 * forbidden crossing throws its teaching door.
 *
 * BODY PHASE: titles stay data-driven off the table (row.entryForm / row.exitForm /
 * row.roundTrip decide the TEXT); bodies are per-row because the table doesn't carry
 * a sample JS value. RULINGS.md R1 (two-tier-exec-api.md) settled the scalar exit
 * convention — `exec`'s SIMPLE tier fully unwraps via `toJS`, so the boolean/
 * safe-int/float/bigint/string exit cells are now live, asserted against REAL
 * `exec` output (end-to-end through the parser/evaluator, not just `toJS` directly
 * — the other cells in this file already exercise `toJS` in isolation). The
 * registered-symbol exit cell stays `it.todo` — ASymbol's opaque-exit mapping is
 * still design-pending (two-tier-exec-api.md §9), unrelated to this ruling.
 */
import { describe, expect, it, vi } from "vitest";
import { CROSSINGS, VIOLATIONS } from "../laws/_tables/crossings.js";
import { fromJS, toJS, isSchemeValue } from "../../membrane.js";
import { jsToScheme, schemeToJs, modeKeyOf } from "../../rosetta.js";
import { exec } from "../../eval/generator-exec.js";
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
import { AVector } from "../../values/primitives/AVector.js";
import { ADict } from "../../values/primitives/ADict.js";
import { ANativeProcedure } from "../../values/primitives/ACallable.js";
import { closeRegionScope, openRegionScope, withRegionScope } from "../../values/primitives/region-scope.js";
import { RegionEscapeError } from "../../errors.js";
import { AJSArray } from "../../values/primitives/AJSArray.js";
import { AJSObject } from "../../values/primitives/AJSObject.js";
import type { SchemeValue } from "../../values/types.js";
import { CLASS } from "../../well-known-symbols.js";

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
  // R1 (RULINGS.md) settled the single exit convention — every row's exitForm is
  // now the ruled text, no "gated" placeholder branch needed.
  const exitTitle = `exit (scheme→JS): becomes ${row.exitForm}`;
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
      it(exitTitle, async () => {
        // REAL exec output, end-to-end (RULINGS.md R1) — the SIMPLE tier's plain-JS exit.
        const [t] = await exec("#t");
        const [f] = await exec("#f");
        expect(t).toBe(true);
        expect(f).toBe(false);
      });
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
      it(exitTitle, async () => {
        const [n] = await exec("42");
        expect(n).toBe(42);
        expect(typeof n).toBe("number");
      });
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
      it(exitTitle, async () => {
        const [n] = await exec("3.14");
        expect(n).toBe(3.14);
        expect(typeof n).toBe("number");
      });
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
      it(exitTitle, async () => {
        // In-range: exits as a plain JS number — no bigint tag survives.
        const [inRange] = await exec("10");
        expect(inRange).toBe(10);
        expect(typeof inRange).toBe("number");
        // Out-of-range: a real bigint, not a lossy Number() cast or a marker object.
        const [huge] = await exec("12345678901234567890");
        expect(typeof huge).toBe("bigint");
        expect(huge).toBe(12345678901234567890n);
      });
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
      it(exitTitle, async () => {
        const [s] = await exec('"hello"');
        expect(s).toBe("hello");
        expect(typeof s).toBe("string");
      });
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
        // nil-as-array (V ruling 2026-07-13): '()'s JS face is [] — the empty case of
        // the ONE list projection; emptiness must not flip the list's JS type to null.
        expect(toJS(nil)).toEqual([]);
      });
      // Round-trip is asymmetric BY LAW: ingress is permissive (null → nil), egress is
      // canonical (nil → []). null → nil → [] — a JS null re-emerges as the empty
      // list's array face, matching what a non-empty list does and what the compiled
      // world emits for '() (the differential oracle compares through this face).
      it(roundTripTitle, () => {
        expect(schemeToJs(jsToScheme(CONSTANT_CTX, null))).toEqual([]);
      });
      it(provenanceTitle, () => {
        const stamped = jsToScheme(CONSTANT_CTX, null, {}, PROV);
        expect(stamped).toBeInstanceOf(ANil);
        expect([...stamped.provenance]).toEqual([...PROV]);
        const out = toJS(stamped);
        expect(out).toEqual([]);
        expectNoProvenanceProperty(out);
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
      // Not R1-gated (R1 is settled) — ASymbol's opaque-exit mapping is its OWN
      // deferred design (two-tier-exec-api.md §9, R1-doc'd separately); filling
      // this now would invent that unrelated decision.
      it.todo(exitTitle);
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
      // Regression, carried from rosetta-environment.test.ts (docs/test-suite-v2/
      // REMOVAL-MANIFEST.md §A): `Object.entries` in schemeToJs used to drop symbol keys, so
      // opaque/private backing data on objects crossing the membrane was silently lost.
      // String keys must be unchanged; symbol-keyed slots must survive the round-trip.
      it(`${roundTripTitle} — symbol-keyed properties survive alongside string keys`, () => {
        const SECRET = Symbol("secret");
        const original: Record<string | symbol, unknown> = { visible: 1 };
        original[SECRET] = [4, 5, 6];
        const roundTripped = exitJS(fromJS(original)) as Record<string | symbol, unknown>;
        expect(roundTripped.visible).toBe(1); // string key unchanged
        expect(roundTripped[SECRET]).toEqual([4, 5, 6]); // symbol key survives
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
        // Cast: `fromJS`'s `FromJSResult` (membrane.ts) is a boundary-wide union
        // (Uint8Array/ArrayBuffer/DataView/Function/Promise, none SchemeValue) —
        // `schemeToJs<T extends SchemeValue|null|undefined>` can't infer T from it. The
        // comment above already establishes the runtime-guaranteed shape: never boxed on
        // entry, schemeToJs's generic fallback returns it unchanged.
        expect(schemeToJs(fromJS(u8) as SchemeValue)).toBe(u8);
      });
      it(roundTripTitle, () => {
        const u8 = new Uint8Array([1, 2, 3]);
        // Cast: `fromJS`'s `FromJSResult` (membrane.ts) is a boundary-wide union
        // (Uint8Array/ArrayBuffer/DataView/Function/Promise, none SchemeValue) —
        // `schemeToJs<T extends SchemeValue|null|undefined>` can't infer T from it. The
        // comment above already establishes the runtime-guaranteed shape: never boxed on
        // entry, schemeToJs's generic fallback returns it unchanged.
        expect(schemeToJs(fromJS(u8) as SchemeValue)).toBe(u8);
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
        // fromJS keeps the raw passthrough (the evaluator trampoline awaits it)…
        const p = Promise.resolve(42);
        expect(fromJS(p)).toBe(p);
        // …but a bare Promise into jsToScheme DOORS (jsToSchemeAsyncDoor): the old
        // silent exotic passthrough is closed — settle first, or let the holding
        // structure's entry read settle it lazily (the inbound-registry law owns
        // the pending-cell rows).
        expect(() => jsToScheme(CONSTANT_CTX, Promise.resolve(42))).toThrow(/bare Promise cannot cross/);
      });
      // exitForm: "n/a" — a Promise never crosses back out through toJS; the evaluator
      // trampoline awaits it before anything could exit.
      it(`${roundTripTitle} — fromJS identity pass-through is the whole projection`, () => {
        const p = Promise.resolve(42);
        expect(fromJS(p)).toBe(p);
        expect(isSchemeValue(fromJS(p))).toBe(false);
      });
      it(provenanceTitle, () => {
        // No carrier to stamp: the crossing doors BEFORE any box could carry a
        // provenance set — loud at the crossing, never a stray stamped leak (P5).
        const p = Promise.resolve(1);
        expect(() => jsToScheme(CONSTANT_CTX, p, {}, PROV)).toThrow(/bare Promise cannot cross/);
      });
      break;
    }

    case "exotic object (class instance)": {
      class Widget {
        constructor(readonly size: number) {}
      }
      it(entryTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const w = new Widget(7);
          const entered = jsToScheme(CONSTANT_CTX, w);
          // The old exotic passthrough leaked `w` RAW into scheme space, silently.
          // Closed: it borrows as an AJSObject (source kept by reference), loudly.
          expect(entered).toBeInstanceOf(AJSObject);
          expect(entered.source).toBe(w);
          expect(spy).toHaveBeenCalledTimes(1);
          expect(String(spy.mock.calls[0]?.[0])).toMatch(/Widget instance/);
        } finally {
          spy.mockRestore();
        }
      });
      it(exitTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const w = new Widget(7);
          expect(exitJS(jsToScheme(CONSTANT_CTX, w))).toBe(w);
        } finally {
          spy.mockRestore();
        }
      });
      it(roundTripTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const w = new Widget(7);
          expect(exitJS(jsToScheme(CONSTANT_CTX, w))).toBe(w);
        } finally {
          spy.mockRestore();
        }
      });
      it(provenanceTitle, () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const w = new Widget(7);
          const stamped = jsToScheme(CONSTANT_CTX, w, {}, PROV);
          expect(stamped).toBeInstanceOf(AJSObject);
          expect([...stamped.provenance]).toEqual([...PROV]);
          expectNoProvenanceProperty(toJS(stamped));
        } finally {
          spy.mockRestore();
        }
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
        const out = toJS(list);
        // R9: the proxy is observationally a plain array — deep-equal to the eager
        // projection, native Array.isArray, JSON round-trips.
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2, 3]);
        expect(JSON.stringify(out)).toBe("[1,2,3]");
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        // Not just a synthetic toJS(hand-built-APair) call — a real parsed/evaluated
        // program's exec() result (RULINGS.md R1's actual end-to-end contract).
        const [out] = await exec("(list 1 2 3)");
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2, 3]);
        expect(JSON.stringify(out)).toBe("[1,2,3]");
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
      // RESOLVED (V ruling 2026-07-13, "nil-as-array"): the open design question closed —
      // the empty list exits as [] like every proper list exits as an array; emptiness no
      // longer flips the JS type. The feared "deep rewrite of runtime" was one method
      // (ANil["arrival/toJS"]). Reverse metadata is NOT preserved by design: ingress stays
      // permissive/borrowing (null → nil, [] → borrowed vector) — projection∘borrow, not id.
      it("exit: (list) — the empty list — as an empty array, not null (resolved: nil-as-array)", () => {
        expect(toJS(nil)).toEqual([]);
        expect(schemeToJs(nil)).toEqual([]);
      });
      break;
    }

    case "dotted pair (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only
      it(exitTitle, () => {
        const dotted = new APair(CONSTANT_CTX, new AExact(CONSTANT_CTX, 1n), new AExact(CONSTANT_CTX, 2n));
        expect(toJS(dotted)).toEqual([1, 2]);
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        const [out] = await exec("(cons 1 2)");
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, 2]);
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

    case "native vector (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only — fromJS(array) mints a BORROWED AJSArray, never an AVector
      it(exitTitle, () => {
        const vec = new AVector(CONSTANT_CTX, [
          new AExact(CONSTANT_CTX, 1n),
          new AString(CONSTANT_CTX, "two"),
          new AExact(CONSTANT_CTX, 3n),
        ]);
        const out = toJS(vec);
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, "two", 3]);
        expect(JSON.stringify(out)).toBe('[1,"two",3]');
        expect([...(out as unknown[])]).toEqual([1, "two", 3]); // spread/iteration
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        const [out] = await exec('#(1 "two" 3)');
        expect(Array.isArray(out)).toBe(true);
        expect(out).toEqual([1, "two", 3]);
        expect(JSON.stringify(out)).toBe('[1,"two",3]');
      });
      it(roundTripTitle, () => {
        const vec = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
        const out = toJS(vec) as object;
        expect(Object.keys(out).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        const stamped = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n, 1n, PROV)], PROV);
        const out = toJS(stamped) as unknown[];
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out[0]);
        expect(out[0]).toBe(1); // the element unwrapped, not a box
      });
      break;
    }

    case "native dict (scheme→JS only)": {
      it.todo(entryTitle); // scheme→JS only — fromJS(object) mints a BORROWED AJSObject, never an ADict
      it(exitTitle, () => {
        const dict = new ADict(CONSTANT_CTX, [
          [new ASymbol(CONSTANT_CTX, "a"), new AExact(CONSTANT_CTX, 1n)],
          [new ASymbol(CONSTANT_CTX, "b"), new AString(CONSTANT_CTX, "two")],
        ]);
        const out = toJS(dict);
        expect(Array.isArray(out)).toBe(false);
        expect(out).toEqual({ a: 1, b: "two" });
        expect(JSON.stringify(out)).toBe('{"a":1,"b":"two"}');
        expect(Object.keys(out as object)).toEqual(["a", "b"]);
        expect({ ...(out as object) }).toEqual({ a: 1, b: "two" }); // spread
      });
      it(`${exitTitle} — via REAL exec output`, async () => {
        const [out] = await exec('(dict "a" 1 "b" "two")');
        expect(Array.isArray(out)).toBe(false);
        expect(out).toEqual({ a: 1, b: "two" });
        expect(JSON.stringify(out)).toBe('{"a":1,"b":"two"}');
      });
      it(roundTripTitle, () => {
        const dict = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, "a"), new AExact(CONSTANT_CTX, 1n)]]);
        const out = toJS(dict) as object;
        expect(Object.keys(out).some((k) => k.startsWith("__"))).toBe(false);
      });
      it(provenanceTitle, () => {
        const dict = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, "a"), new AExact(CONSTANT_CTX, 1n, 1n, PROV)]], PROV);
        const out = toJS(dict) as Record<string, unknown>;
        expectNoProvenanceProperty(out);
        expectNoProvenanceProperty(out.a);
        expect(out.a).toBe(1);
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

describe("R9 lazy egress laws — containers exit as ref-tracking proxies (RULINGS.md R9)", () => {
  it("identity: the same box always egresses as the SAME proxy", () => {
    const vec = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    expect(toJS(vec)).toBe(toJS(vec));
    const list = APair.fromArray(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    expect(toJS(list)).toBe(toJS(list));
    const dict = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, "a"), new AExact(CONSTANT_CTX, 1n)]]);
    expect(toJS(dict)).toBe(toJS(dict));
  });

  it("aliasing: a child container shared by two parents egresses as ONE object (reference equality observable from JS)", () => {
    const child = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 42n)]);
    const parentA = new AVector(CONSTANT_CTX, [child]);
    const parentB = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, "kid"), child]]);
    const outA = toJS(parentA) as unknown[];
    const outB = toJS(parentB) as Record<string, unknown>;
    expect(outA[0]).toBe(outB.kid);
    expect(outA[0]).toBe(toJS(child));
  });

  it("cycles: a container reaching itself through an element egresses without recursion (WeakMap registration precedes materialization)", () => {
    // Immutable values can't self-reference through the language; build the knot on the
    // JS side, exactly how a host embedding could — the payload array is captured by
    // reference, so pushing after construction closes the cycle.
    const payload: SchemeValue[] = [];
    const vec = new AVector(CONSTANT_CTX, payload);
    payload.push(vec);
    const out = toJS(vec) as unknown[];
    expect(out[0]).toBe(out); // the reach-back resolves to the SAME proxy, structurally
    // …and the result behaves like a genuinely cyclic plain array (observationally
    // plain JS): JSON refuses it the same way it refuses any circular structure.
    expect(() => JSON.stringify(out)).toThrow(/circular/i);
  });

  it("laziness: an element's unwrap runs on first read, not at egress (second read is a cache hit — same materialized object)", () => {
    const inner = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 7n)]);
    const outer = new AVector(CONSTANT_CTX, [inner]);
    const out = toJS(outer) as unknown[];
    const first = out[0];
    expect(first).toBe(out[0]); // target-as-cache: one materialization, stable identity
    expect(first).toBe(toJS(inner)); // and it IS the child's own canonical proxy
  });

  it("write family throws the taught membrane door (P5 — the egressed value is a projection, not a mailbox)", () => {
    const vec = new AVector(CONSTANT_CTX, [new AExact(CONSTANT_CTX, 1n)]);
    const arr = toJS(vec) as unknown[];
    expect(() => {
      arr[0] = 99;
    }).toThrow(/writes are banned/);
    expect(() => {
      delete arr[0];
    }).toThrow(/mutations are banned/);
    expect(() => Object.defineProperty(arr, "0", { value: 99 })).toThrow(/mutations are banned/);
    expect(() => Object.setPrototypeOf(arr, null)).toThrow(/mutations are banned/);
    const dict = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, "a"), new AExact(CONSTANT_CTX, 1n)]]);
    const obj = toJS(dict) as Record<string, unknown>;
    expect(() => {
      obj.a = 99;
    }).toThrow(/writes are banned/);
    expect(() => {
      delete obj.a;
    }).toThrow(/mutations are banned/);
    // nothing crossed the boundary
    expect((toJS(vec) as unknown[])[0]).toBe(1);
    expect((toJS(dict) as Record<string, unknown>).a).toBe(1);
  });
});

describe.each(VIOLATIONS.map((v) => [v.name, v] as const))("forbidden crossing: %s", (_n, v) => {
  const title = `throws the teaching door: ${String(v.door)} (P5 — loud at the crossing, never later)`;

  switch (v.name) {
    case "bare Promise into jsToScheme": {
      it(title, () => {
        expect(() => jsToScheme(CONSTANT_CTX, Promise.resolve(1))).toThrow(v.door);
        // A non-plain thenable (async-shaped class instance) doors the same way —
        // only a PLAIN-prototype thenable stays a dict-shaped borrow (registry order:
        // the plain-object claim precedes the promise claim).
        class Deferred {
          then(res: (x: number) => void): void {
            res(1);
          }
        }
        expect(() => jsToScheme(CONSTANT_CTX, new Deferred())).toThrow(v.door);
      });
      break;
    }

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

describe("forgery guard: a borrowed object's own arrival/*-named key is DATA, never protocol (F3, key-taxonomy corollary — PRINCIPLES.md P7 / RULINGS.md 2026-07-09)", () => {
  // The key taxonomy puts algebra instruction keys ("arrival/class", "arrival/toJS", …) in
  // plain-string space so every static interpreter can read them as data — which means a
  // FOREIGN object crossing fromJS can carry an own data property with that exact name by
  // pure coincidence (or by a hostile actor deliberately probing the membrane). The guard
  // is structural, not a denylist: fromJS's object arm always wraps a plain object in an
  // AJSObject (membrane.ts), and every protocol read (type(), toJS(), the CLASS brand) is
  // read off the WRAPPER's own class or the wrapper's own methods — never off the wrapped
  // source's data keys. A forged "arrival/class"/"arrival/toJS" own key therefore has no
  // path to being mistaken for the brand or the method it names.
  it('fromJS({"arrival/class": "fake"}) crosses as plain data — the forged key never masquerades as the CLASS brand', () => {
    const forged = { "arrival/class": "fake" };
    const entered = fromJS(forged) as AJSObject;
    expect(entered).toBeInstanceOf(AJSObject);
    // The protocol identity is the WRAPPER's own static brand (js-object), never derived
    // from the wrapped source's data — CLASS is read off the wrapper class, not off
    // `entered`'s (i.e. the source's) own keys.
    expect(entered.constructor).toBe(AJSObject);
    expect(AJSObject[CLASS]).toBe("js-object");
    // The forged key round-trips as ordinary data through the read protocol.
    const read = entered.get("arrival/class");
    expect(read).toBeInstanceOf(AString);
    expect((read as AString).valueOf()).toBe("fake");
  });

  it('fromJS({"arrival/toJS": fn}) crosses as plain data — the forged key is never invoked as the toJS protocol method', () => {
    const forged = { "arrival/toJS": () => "pwned" };
    const entered = fromJS(forged) as AJSObject;
    expect(entered).toBeInstanceOf(AJSObject);
    // toJS(entered) invokes the WRAPPER's own `arrival/toJS` method (AJSObject.ts), which
    // reconstructs a plain object from the source's members — it never looks up (let alone
    // calls) a same-named key living ON the source.
    const out = toJS(entered) as Record<string, unknown>;
    expect(typeof out["arrival/toJS"]).toBe("function");
    expect(out["arrival/toJS"]).toBe(forged["arrival/toJS"]); // crosses back unchanged, uninvoked
  });
});

// "egress of deferred carriers" (the force-on-egress contract for a live AHalfBaked
// crossing exec's boundary) retired: AHalfBaked itself dissolved — VERDICT KILL, zero
// production reachability, superseded by R2/C3 struct-fact wires. See
// docs/working-proposals/halfbaked-existence-review.md. The three `it.fails` rows this
// block carried ("live AHalfBaked escapes exec under speculate", ledger GAPS) are gone
// because the gap became UNREACHABLE, not fixed — no carrier can exist anymore, so
// there is nothing left for force-on-egress to force. See REMOVAL-MANIFEST.md.

// ── Egress membrane exit laws (docs/working-proposals/arrival-egress-membrane-exit.md) ──
// The two-protocol split: `arrival/toJS` = SERIALIZATION (callables stringify — a law,
// not an accident), `arrival/toJSMembrane` = MEMBRANE crossing (options + reverse-membrane
// wrappers reach every depth). Identity: bare=(box); membrane=(box, mode, SCOPE).
describe("egress membrane exit — the two protocols and their identity laws", () => {
  const native = (tag: string): ANativeProcedure =>
    new ANativeProcedure({
      name: `test-${tag}`,
      arity: { min: 0, max: null },
      contract: undefined,
      impl: (_args, runCtx) => new AExact(runCtx, 7n),
    });
  const dictOf = (entries: ReadonlyArray<readonly [string, SchemeValue | Promise<SchemeValue>]>): ADict =>
    new ADict(
      CONSTANT_CTX,
      entries.map(([k, v]) => [new ASymbol(CONSTANT_CTX, k), v] as const),
    );

  it("nested callable crosses as a host FUNCTION via schemeToJs AND membrane.toJS (the flip, pinned)", async () => {
    const d = dictOf([["f", native("a")]]);
    const viaRosetta = schemeToJs(d) as Record<string, unknown>;
    expect(typeof viaRosetta.f).toBe("function");
    // Invoking round-trips through the reverse membrane (DETACHED scope — always open).
    await expect((viaRosetta.f as () => Promise<unknown>)()).resolves.toBe(7);
    // membrane.toJS (exec's exit) shares the default-mode slot — same face, same proxy.
    const viaToJS = toJS(d) as Record<string, unknown>;
    expect(typeof viaToJS.f).toBe("function");
    expect(viaToJS).toBe(viaRosetta);
  });

  it("depth ≥ 2: the innermost callable crosses as fn under membrane, as string under bare", () => {
    const inner = dictOf([["f", native("deep")]]);
    const outerDict = dictOf([["inner", inner]]);
    const outerVec = new AVector(CONSTANT_CTX, [inner]);
    const viaDict = schemeToJs(outerDict) as { inner: { f: unknown } };
    expect(typeof viaDict.inner.f).toBe("function");
    const viaVec = schemeToJs(outerVec) as ReadonlyArray<{ f: unknown }>;
    expect(typeof viaVec[0].f).toBe("function");
    // Bare protocol (serialization — what hostFace/faceOf call): string at every depth.
    const bare = outerDict["arrival/toJS"]() as { inner: { f: unknown } };
    expect(typeof bare.inner.f).toBe("string");
    expect(bare.inner.f).toMatch(/^#<procedure/);
  });

  it("nested forceBigInt: options reach container elements (the sibling defect, fixed)", () => {
    const d = dictOf([["n", new AExact(CONSTANT_CTX, 5n)]]);
    expect((schemeToJs(d, { forceBigInt: true }) as { n: unknown }).n).toBe(5n);
    expect((schemeToJs(d) as { n: unknown }).n).toBe(5);
  });

  it("mode isolation: bare / mem:0 / mem:1 are distinct slots; each is stable within itself", () => {
    const d = dictOf([["n", new AExact(CONSTANT_CTX, 1n)]]);
    const bare1 = d["arrival/toJS"]();
    const bare2 = d["arrival/toJS"]();
    expect(bare1).toBe(bare2);
    const mem1 = schemeToJs(d);
    const mem2 = schemeToJs(d);
    expect(mem1).toBe(mem2); // same DETACHED scope, same mode
    const big = schemeToJs(d, { forceBigInt: true });
    expect(big).not.toBe(mem1);
    expect(bare1).not.toBe(mem1);
    // Wrapper-call-only options do NOT split the mode (they never change projection).
    expect(modeKeyOf({})).toBe("mem:0");
    expect(modeKeyOf({ forceBigInt: true })).toBe("mem:1");
    expect(modeKeyOf({ returnEither: true })).toBe("mem:0");
    expect(modeKeyOf({ argProvenance: true })).toBe("mem:0");
  });

  it("membrane proxies are SCOPE-owned: a second invocation mints its own; the closed scope's wrapper doors", async () => {
    const d = dictOf([["f", native("scoped")]]);
    const scopeA = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const proxyA = withRegionScope(scopeA, () => schemeToJs(d)) as Record<string, unknown>;
    const fnA = proxyA.f as () => Promise<unknown>; // materializes lazily — under the PINNED scopeA
    closeRegionScope(scopeA);
    await expect(fnA()).rejects.toThrow(RegionEscapeError); // A's discipline, not silent CONSTANT_CTX
    const scopeB = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const proxyB = withRegionScope(scopeB, () => schemeToJs(d)) as Record<string, unknown>;
    expect(proxyB).not.toBe(proxyA); // (box, mode, SCOPE) — never resurrect A's projection
    await expect((proxyB.f as () => Promise<unknown>)()).resolves.toBe(7); // B is live
    closeRegionScope(scopeB);
    // Scope-less egress (DETACHED singleton) is a third, distinct identity.
    const detached = schemeToJs(d);
    expect(detached).not.toBe(proxyA);
    expect(detached).not.toBe(proxyB);
  });

  it("serialization law: bare toJS on a callable-bearing dict yields the print string", () => {
    const d = dictOf([["f", native("ser")]]);
    const bare = d["arrival/toJS"]() as Record<string, unknown>;
    expect(typeof bare.f).toBe("string");
    expect(bare.f).toMatch(/^#<procedure/);
  });

  it("ADict pending entry settling to a callable: membrane → function, bare → string", async () => {
    const membraneDict = dictOf([["f", Promise.resolve<SchemeValue>(native("pend-m"))]]);
    const viaMembrane = schemeToJs(membraneDict) as Record<string, unknown>;
    expect(typeof (await viaMembrane.f)).toBe("function");
    const bareDict = dictOf([["f", Promise.resolve<SchemeValue>(native("pend-b"))]]);
    const viaBare = bareDict["arrival/toJS"]() as Record<string, unknown>;
    expect(typeof (await viaBare.f)).toBe("string");
  });

  it("wrapper cache is (callable, scope, MODE)-keyed: option modes never share a wrapper; a mode is stable", () => {
    const f = native("wrap");
    const d = dictOf([["f", f]]);
    const scope = openRegionScope({ runCtx: CONSTANT_CTX, dynSite: undefined });
    const p0 = withRegionScope(scope, () => schemeToJs(d)) as Record<string, unknown>;
    const p1 = withRegionScope(scope, () => schemeToJs(d, { forceBigInt: true })) as Record<string, unknown>;
    const w0 = p0.f;
    const w0again = (withRegionScope(scope, () => schemeToJs(d)) as Record<string, unknown>).f;
    const w1 = p1.f;
    expect(typeof w0).toBe("function");
    expect(typeof w1).toBe("function");
    expect(w0).toBe(w0again); // same (callable, scope, mem:0)
    expect(w0).not.toBe(w1); // mem:0 vs mem:1 — the wrapper closes over options
    closeRegionScope(scope);
  });
});

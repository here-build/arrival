/**
 * LAW — the inbound claim registry (rosetta.ts INBOUND_CLAIMS) and the lazy
 * pending cells (values/primitives/pending-entry.ts).
 *
 * 1. REGISTRY ORDER IS LAW: jsToScheme's whole value-kind algebra is one declared,
 *    ordered table — first claiming row wins, and the order is semantic
 *    (null/undefined sentinels first, AValue identity before shapes, arrays before
 *    plain objects, plain objects before the promise door so a plain thenable stays
 *    a dict-shaped borrow). This file pins the names IN ORDER so a reorder (or a
 *    silently added/removed claim) is a diff in a law test, never an accident.
 *
 * 2. PENDING CELLS: a Promise VALUE inside a structure (AJSObject/ADict entry,
 *    AJSArray element) is held INERT and settles lazily on FIRST ACCESS (maybeThen
 *    discipline: one settle chain, shared by concurrent readers), the settled box
 *    replaces the cell (sync-after-settled), and the box carries the container's
 *    provenance. A bare Promise reaching jsToScheme directly DOORS
 *    (jsToSchemeAsyncDoor — crossing.law.test.ts owns that violation row).
 *
 * 3. THE EXOTIC LEAK IS CLOSED: a residual exotic object (class instance / Map /
 *    Date / Error) no longer passes through RAW — it borrows as an AJSObject,
 *    loudly (crossing.law.test.ts owns the crossing row; here we pin "nothing
 *    non-scheme escapes the router" over a sweep of exotic shapes).
 */
import { describe, expect, it, vi } from "vitest";
import { INBOUND_CLAIMS, jsToScheme } from "../rosetta.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { APair } from "../../values/primitives/APair.js";
import { ADict } from "../../values/primitives/ADict.js";
import { AJSObject } from "../AJSObject.js";
import { AJSArray } from "../AJSArray.js";
import { eof } from "../../values/primitives/EOF.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";

const PROV = new Set<number>([4242]);

/** Every warn-mute helper in one place — the exotic/function/undefined claims warn
 *  by design; these laws assert VALUES, the warn text is crossing.law's business. */
function muted<T>(body: () => T): T {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

describe("inbound registry — the declared, ordered claim table IS the law", () => {
  it("pins the claim names in their declared order (a reorder is a law diff, not an accident)", () => {
    expect(INBOUND_CLAIMS.map((c) => c.name)).toEqual([
      "null → nil",
      "undefined → #void (warn)",
      "AValue → identity / provenance re-stamp (class term)",
      "array → borrowed AJSArray",
      "plain object → borrowed AJSObject",
      "scalar → boxer table (fromJs)",
      "symbol → :keyword (registered) / #void (unique, warn)",
      "function → #void (warn)",
      "scheme orphan (EOF/Values/R7RSError) → identity",
      "bigint → raw passthrough (opaque host value, not a scheme number)",
      "binary (Uint8Array/ArrayBuffer/DataView/Buffer) → raw passthrough (declared)",
      "promise → door (settle first; container entries settle lazily)",
      "exotic object → borrowed AJSObject (warn)",
    ]);
  });

  it("order is semantic: a PLAIN-prototype thenable is claimed by the plain-object row, not the promise door", () => {
    const thenable = { then: 42, data: "not actually async" };
    const entered = jsToScheme(CONSTANT_CTX, thenable);
    expect(entered).toBeInstanceOf(AJSObject);
    expect(entered.source).toBe(thenable);
  });

  it("scheme orphans (EOF) pass by identity — a DECLARED claim, no longer smuggled through an exotic passthrough", () => {
    expect(jsToScheme(CONSTANT_CTX, eof)).toBe(eof);
    // …and a provenance stamp has no carrier on an orphan: still identity.
    expect(jsToScheme(CONSTANT_CTX, eof, {}, PROV)).toBe(eof);
  });

  it("nothing non-scheme escapes the router raw except the DECLARED binary passthrough (exotic sweep)", () => {
    muted(() => {
      for (const exotic of [new Date(0), new Map([["k", 1]]), new Set([1]), new Error("boom"), /re/]) {
        const entered: unknown = jsToScheme(CONSTANT_CTX, exotic);
        expect(entered).toBeInstanceOf(AJSObject);
        expect((entered as AJSObject).source).toBe(exotic);
      }
    });
    // The declared exception, by name: binary FFI identity.
    const u8 = new Uint8Array([1]);
    expect(jsToScheme(CONSTANT_CTX, u8)).toBe(u8);
  });

  it("deep re-stamp went CLASS-SIDE: a fresh stamp on a pair spine mints a fresh spine via arrival/withProvenanceDeep, children inherit the stamp; identity fast paths hold", () => {
    const car = new AString(CONSTANT_CTX, "a");
    const cdr = new AExact(CONSTANT_CTX, 1);
    const pair = new APair(CONSTANT_CTX, car, cdr);

    // Empty stamp → identity fast path (no clone).
    expect(jsToScheme(CONSTANT_CTX, pair)).toBe(pair);

    // Fresh stamp → the class's own deep re-stamp: fresh spine, fresh children, all
    // carrying the new lineage (spec §5.3 Interpretation A, byte-stable with the
    // dissolved router arms) — the original spine untouched.
    const stamped = jsToScheme(CONSTANT_CTX, pair, {}, PROV);
    expect(stamped).toBeInstanceOf(APair);
    expect(stamped).not.toBe(pair);
    expect([...stamped.provenance]).toEqual([...PROV]);
    expect([...(stamped.car as AString).provenance]).toEqual([...PROV]);
    expect([...(stamped.cdr as AExact).provenance]).toEqual([...PROV]);
    expect(car.provenance.size).toBe(0);

    // A leaf re-stamps shallowly (withProvenance — no deep term needed).
    const leaf = jsToScheme(CONSTANT_CTX, car, {}, PROV);
    expect(leaf).toBeInstanceOf(AString);
    expect(leaf).not.toBe(car);
    expect([...leaf.provenance]).toEqual([...PROV]);
  });
});

describe("pending cells — a Promise inside a structure settles lazily on first access (maybeThen discipline)", () => {
  it("promise-in-DICT: first read returns the settle chain; it resolves to the boxed value CARRYING the dict's provenance; the read is SYNC after settlement", async () => {
    const dict = new ADict(
      CONSTANT_CTX,
      [[new ASymbol(CONSTANT_CTX, ":answer"), Promise.resolve(42)]],
      PROV,
    );

    const first = dict.get("answer");
    expect(first).toBeInstanceOf(Promise);

    // Concurrent read during pendency shares the SAME chain — one settlement, ever.
    expect(dict.get("answer")).toBe(first);

    const settled = await (first as Promise<SchemeValue>);
    expect(settled).toBeInstanceOf(AExact);
    expect((settled as AExact).valueOf()).toBe(42);
    // Provenance carried: the raw settled value inherits the container's lineage.
    expect([...(settled as AExact).provenance]).toEqual([...PROV]);

    // Sync after settlement: the slot now holds the settled box itself.
    const second = dict.get("answer");
    expect(second).not.toBeInstanceOf(Promise);
    expect(second).toBe(settled);
  });

  it("promise-in-DICT: an already-AValue settlement passes through jsToScheme's fast path (same stamp → identity)", async () => {
    const boxed = new AString(CONSTANT_CTX, "ready", PROV);
    const dict = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, ":v"), Promise.resolve(boxed)]], PROV);
    const settled = await Promise.resolve(dict.get("v"));
    expect(settled).toBe(boxed);
    expect(dict.get("v")).toBe(boxed); // sync + identity thereafter
  });

  it("promise-in-AJSObject entry: settles on first .get, caches the box, sync after settlement", async () => {
    const source = { eager: "now", lazy: Promise.resolve("later") };
    const wrapper = new AJSObject(CONSTANT_CTX, source, PROV);

    // The sync entry stays sync — pendency of a SIBLING never taxes it.
    const eager = wrapper.get("eager");
    expect(eager).toBeInstanceOf(AString);

    const first = wrapper.get("lazy");
    expect(first).toBeInstanceOf(Promise);
    expect(wrapper.get("lazy")).toBe(first); // shared chain during pendency

    const settled = await (first as Promise<SchemeValue>);
    expect(settled).toBeInstanceOf(AString);
    expect((settled as AString).valueOf()).toBe("later");
    expect([...(settled as AString).provenance]).toEqual([...PROV]); // container lineage

    const second = wrapper.get("lazy");
    expect(second).toBe(settled); // sync-after-settled, stable identity
  });

  it("promise-in-AJSArray element: vector-ref settles on first access, sync after settlement, container provenance carried", async () => {
    const arr = new AJSArray(CONSTANT_CTX, [1, Promise.resolve(2)], PROV);

    // Sync element: unchanged, no pendency tax.
    const sync = arr[tf("vector-ref")](0);
    expect(sync).toBeInstanceOf(AExact);

    const first = arr[tf("vector-ref")](1);
    expect(first).toBeInstanceOf(Promise);
    expect(arr[tf("vector-ref")](1)).toBe(first); // shared chain during pendency

    const settled = await (first as Promise<SchemeValue>);
    expect(settled).toBeInstanceOf(AExact);
    expect((settled as AExact).valueOf()).toBe(2);
    expect([...(settled as AValue).provenance]).toEqual([...PROV]);

    const second = arr[tf("vector-ref")](1);
    expect(second).toBe(settled); // sync-after-settled
  });

  it("egress of a pending DICT entry: the proxy read hands JS a Promise of the UNWRAPPED value, never a boxed AValue", async () => {
    const dict = new ADict(CONSTANT_CTX, [[new ASymbol(CONSTANT_CTX, ":n"), Promise.resolve(7)]]);
    const out = dict["arrival/toJS"]();
    const pending = out.n;
    expect(pending).toBeInstanceOf(Promise);
    const value = await (pending as Promise<unknown>);
    expect(value).toBe(7); // plain JS — the box unwrapped through its own arrival/toJS
    expect(value instanceof AValue).toBe(false);
  });
});

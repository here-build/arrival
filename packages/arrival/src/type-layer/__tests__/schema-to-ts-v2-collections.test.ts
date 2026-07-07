// step-11b: named-generic printing for the v2 `list`/`cons` collections.
//
// schema-to-ts.ts's MAIN vocabulary import is still v1 (the atomic swap that repoints it is
// migration step 14/15). The named-generic pre-check sources the `list`/`cons` registry from
// v2 directly (transitional), so this suite imports v2 and drives `printType` on v2 schemas.
// Once the swap lands, these move alongside the v1 assertions in schema-to-ts.test.ts.
import { describe, expect, it } from "vitest";
import * as v2 from "../../common/scheme-zod-v2.js";
import { printType } from "../schema-to-ts.js";

describe("printType — v2 named-generic collections (List<T> / Pair<Car, Cdr>)", () => {
  it("prints list(string) as List<string>, not the structural Cons<string> | null", () => {
    expect(printType(v2.list(v2.string))).toBe("List<string>");
  });

  it("prints bare list() as List<unknown> (element defaults to `value`)", () => {
    expect(printType(v2.list())).toBe("List<unknown>");
  });

  it("prints list(char) as List<string> (char's JS image is a 1-char string)", () => {
    expect(printType(v2.list(v2.char))).toBe("List<string>");
  });

  it("prints cons(string, boolean) as Pair<string, boolean>, not the structural [string, boolean]", () => {
    expect(printType(v2.cons(v2.string, v2.boolean))).toBe("Pair<string, boolean>");
  });

  it("a fixed-heads list([A, B]) has no single element → falls through to structural tuple", () => {
    // No COLLECTION_ELEMENT registration for the fixed-heads form, so the pre-check skips it and
    // zod-to-ts decomposes the codec's tuple out-schema structurally.
    expect(printType(v2.list([v2.string, v2.boolean]))).toBe("[string, boolean]");
  });
});

describe("scheme-zod-v2 — COLLECTION_ELEMENT registry (name + element lookup)", () => {
  it("registers list's element schema, resolvable by identity", () => {
    const l = v2.list(v2.char);
    expect(v2.lookupName(l)).toBe("list");
    expect(v2.lookupCollectionElement(l)).toBe(v2.char);
  });

  it("registers cons's [car, cdr] pair", () => {
    const c = v2.cons(v2.string, v2.boolean);
    expect(v2.lookupName(c)).toBe("cons");
    expect(v2.lookupCollectionElement(c)).toEqual([v2.string, v2.boolean]);
  });

  it("resolves the name + element THROUGH a .optional() wrapper (core walk)", () => {
    const wrapped = v2.list(v2.string).optional();
    expect(v2.lookupName(wrapped)).toBe("list");
    expect(v2.lookupCollectionElement(wrapped)).toBe(v2.string);
  });

  it("returns undefined for a fixed-heads list (no single element)", () => {
    expect(v2.lookupCollectionElement(v2.list([v2.string, v2.boolean]))).toBeUndefined();
  });
});

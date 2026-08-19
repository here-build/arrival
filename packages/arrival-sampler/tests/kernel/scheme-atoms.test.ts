// scheme-atoms.test.ts — Layer 0 of the guarantee stack: the pure atom primitives every gate
// builds on. Char-level, model-free, no oracle. These were exercised only indirectly through the
// gates until the module was split out (mask-compiler decomposition); this pins them in isolation so
// a primitive bug surfaces HERE, not as a confusing mis-mask three layers up.

import { describe, expect, it } from "vitest";

import { isLiteralValue, isLiveSymbolPrefix, leadingAtom, setDifference, trailingAtom } from "../../src/scheme-atoms.js";

describe("trailingAtom — the in-progress atom at the cursor", () => {
  it("is the run from the last delimiter/whitespace to the end", () => {
    expect(trailingAtom("(foo")).toBe("foo");
    expect(trailingAtom("(set-name bar")).toBe("bar");
    expect(trailingAtom("car")).toBe("car");
  });

  it("is empty at a token boundary (trailing whitespace or delimiter)", () => {
    expect(trailingAtom("(foo ")).toBe(""); // whitespace boundary
    expect(trailingAtom("(foo)")).toBe(""); // delimiter boundary
    expect(trailingAtom("")).toBe("");
  });

  it("stops at the string quote (a break char), so it reads the in-string run", () => {
    expect(trailingAtom('(f "str')).toBe("str");
  });
});

describe("isLiteralValue — a value literal (#-form or number), INCLUDING a partial number", () => {
  it("accepts complete numbers (signed, decimal)", () => {
    for (const n of ["1", "-1", "+3", ".5", "-.5", "1.5"]) expect(isLiteralValue(n)).toBe(true);
  });

  // LOAD-BEARING for constrained decode: a tokenizer splits `-11` into `-` + `11`, so the lone leading
  // `-` must read as a number-in-progress, not the (here unbound) subtraction identifier — else the gate
  // eats the sign on every negative argument. See negative-number-literal.test.ts for the e2e of this.
  it("accepts a bare sign / sign-dot / dot as a number in progress", () => {
    for (const partial of ["-", "+", "-.", "+.", "."]) expect(isLiteralValue(partial)).toBe(true);
  });

  it("accepts any #-literal prefix", () => {
    for (const h of ["#", "#t", "#f", String.raw`#\a`, "#("]) expect(isLiteralValue(h)).toBe(true);
  });

  it("rejects pure identifiers — they stay under the Σ bound-symbol gate", () => {
    for (const id of ["car", "->", "...", "list-ref", "x"]) expect(isLiteralValue(id)).toBe(false);
  });
});

describe("isLiveSymbolPrefix — is the fragment a live prefix of any bound symbol?", () => {
  it("matches a proper prefix and an exact symbol", () => {
    const valid = new Set(["network", "car"]);
    expect(isLiveSymbolPrefix("net", valid)).toBe(true); // proper prefix
    expect(isLiveSymbolPrefix("network", valid)).toBe(true); // exact
  });

  it("rejects a non-prefix", () => {
    expect(isLiveSymbolPrefix("xyz", new Set(["network"]))).toBe(false);
  });

  it("an empty fragment is a prefix of everything; an empty set matches nothing", () => {
    expect(isLiveSymbolPrefix("", new Set(["network"]))).toBe(true);
    expect(isLiveSymbolPrefix("net", new Set())).toBe(false);
  });
});

describe("leadingAtom — the atom run starting at an index, stopping at the first terminator", () => {
  it("reads the atom from `from` up to the next terminator", () => {
    expect(leadingAtom("foo bar", 0)).toBe("foo");
    expect(leadingAtom("foo bar", 4)).toBe("bar");
    expect(leadingAtom("foo)", 0)).toBe("foo");
  });

  it("is empty when `from` sits on a terminator, and at end of string", () => {
    expect(leadingAtom("(foo", 0)).toBe(""); // on `(`
    expect(leadingAtom("(foo", 1)).toBe("foo");
    expect(leadingAtom("", 0)).toBe("");
  });
});

describe(String.raw`setDifference — a \ b`, () => {
  it("keeps elements of a not in b", () => {
    expect([...setDifference(new Set(["a", "b", "c"]), new Set(["b"]))]).toEqual(["a", "c"]);
  });

  it("is empty when a ⊆ b, and is a copy of a when b is empty", () => {
    expect(setDifference(new Set(["x", "y"]), new Set(["x", "y"])).size).toBe(0);
    expect([...setDifference(new Set(["x"]), new Set())]).toEqual(["x"]);
  });
});

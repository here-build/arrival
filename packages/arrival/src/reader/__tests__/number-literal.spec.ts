import { describe, expect, it } from "vitest";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { type ANumeric } from "../../values/numbers.js";
import { ParseError } from "../../errors.js";
import { parse } from "../parse.js";

// Number-literal syntax, read through the reader's own parser (the one number-literal path).
async function read(src: string): Promise<ANumeric> {
  const [n] = await parse(src);
  return n as ANumeric;
}

describe("number literals", () => {
  it("reads integers", async () => {
    const n = await read("42");
    expect(n).toBeInstanceOf(AExact);
    expect(n.toString()).toBe("42");
  });

  it("reads rationals", async () => {
    const n = await read("3/4");
    expect(n).toBeInstanceOf(AExact);
    expect(n.toString()).toBe("3/4");
  });

  it("reads floats", async () => {
    const n = await read("3.14");
    expect(n).toBeInstanceOf(AInexact);
    expect((n as AInexact).real).toBeCloseTo(3.14);
  });

  it("reads special values", async () => {
    expect((await read("+inf.0")).toString()).toBe("+inf.0");
    expect((await read("-inf.0")).toString()).toBe("-inf.0");
    expect((await read("+nan.0")).isNaN).toBe(true);
  });

  it("handles exactness prefixes", async () => {
    const inexact = await read("#i42");
    expect(inexact).toBeInstanceOf(AInexact);
    expect(inexact.toString()).toBe("42.0");

    const exact = await read("#e3.0");
    expect(exact).toBeInstanceOf(AExact);
    expect(exact.isInteger).toBe(true);
  });

  it("handles radix prefixes", async () => {
    expect((await read("#xff")).toString()).toBe("255");
    expect((await read("#xBEEF")).toString()).toBe("48879");
    expect((await read("#b1010")).toString()).toBe("10");
    expect((await read("#o77")).toString()).toBe("63");
  });

  it("doors an exact literal beyond safe-integer range", async () => {
    await expect(parse("9007199254740993")).rejects.toBeInstanceOf(ParseError);
  });
});

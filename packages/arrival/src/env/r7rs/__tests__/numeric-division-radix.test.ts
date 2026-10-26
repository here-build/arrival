// floor/ truncate/ 1+ 1- and number->string's radix argument. Expected values are R7RS §6.2.6
// results. floor/ and truncate/ answer one (quotient . remainder) pair here, not two values.
import { describe, expect, it } from "vitest";

import { exec } from "../../../eval/generator-exec.js";

const run = async (src: string) => (await exec(src))[0];

/** `(q . r)` of a division op as [q, r, exact-q?, exact-r?]. */
const qr = (op: string, a: string, b: string) =>
  run(`(let ((p (${op} ${a} ${b}))) (list (car p) (cdr p) (exact? (car p)) (exact? (cdr p))))`);

describe("floor/ — quotient rounds toward -∞, remainder takes the divisor's sign", () => {
  it.each([
    ["5", "2", [2, 1]],
    ["-5", "2", [-3, 1]],
    ["5", "-2", [-3, -1]],
    ["-5", "-2", [2, -1]],
  ])("(floor/ %s %s)", async (a, b, [q, r]) => {
    expect(await qr("floor/", a, b)).toEqual([q, r, true, true]);
  });

  it("an inexact operand makes both results inexact", async () => {
    expect(await qr("floor/", "7.0", "2")).toEqual([3, 1, false, false]);
  });
});

describe("truncate/ — quotient rounds toward zero, remainder takes the dividend's sign", () => {
  it.each([
    ["5", "2", [2, 1]],
    ["-5", "2", [-2, -1]],
    ["5", "-2", [-2, 1]],
    ["-5", "-2", [2, -1]],
  ])("(truncate/ %s %s)", async (a, b, [q, r]) => {
    expect(await qr("truncate/", a, b)).toEqual([q, r, true, true]);
  });

  it("an inexact operand makes both results inexact", async () => {
    expect(await qr("truncate/", "-7.0", "2")).toEqual([-3, -1, false, false]);
  });
});

describe("1+ / 1- keep the operand's exactness", () => {
  it("exact in, exact out", async () => {
    expect(await run("(list (1+ 5) (exact? (1+ 5)) (1- 0) (exact? (1- 0)))")).toEqual([6, true, -1, true]);
  });

  it("a rational stays an exact rational", async () => {
    expect(await run("(equal? (1+ 1/2) 3/2)")).toBe(true);
  });

  it("inexact in, inexact out", async () => {
    expect(await run("(list (1+ 2.5) (exact? (1+ 2.5)) (1- 2.5))")).toEqual([3.5, false, 1.5]);
  });
});

describe("number->string with a radix", () => {
  it.each([
    ["255", "16", "ff"],
    ["-255", "16", "-ff"],
    ["10", "2", "1010"],
    ["8", "8", "10"],
    ["1/3", "3", "1/10"],
    ["2.5", "2", "10.1"],
  ])("(number->string %s %s) is %s", async (n, radix, expected) => {
    expect(String(await run(`(number->string ${n} ${radix})`))).toBe(expected);
  });

  it("radix 10 and no radix agree", async () => {
    expect(String(await run("(number->string 42 10)"))).toBe("42");
    expect(String(await run("(number->string 42)"))).toBe("42");
  });
});

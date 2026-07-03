/**
 * SRFI-151 bitwise operations (env/srfi/srfi-151.ts).
 *
 * The base `scheme/numeric` pack ALREADY binds `bitwise-and` / `bitwise-ior` /
 * `bitwise-xor` / `bitwise-not` / `arithmetic-shift` (with the SRFI sign
 * convention: positive count = left shift). The srfi-151 pack therefore adds only
 * the one genuinely-absent verb, `bit-count`. This suite pins `bit-count` across
 * both signs and the inexact-rejection contract, and confirms the base five remain
 * reachable by inheritance (documenting why the pack is bit-count-only).
 *
 * Assembles srfi-151 EXPLICITLY onto a fresh inference env (the pack is not
 * registered globally this round); the base bitwise verbs arrive by inheritance.
 */

import { exec, sandboxedEnv } from "../index.js";
import { assembleEnv } from "../common/kernel.js";
import { type SchemeEnv } from "../common/scheme-env.js";
import { describe, expect, it } from "vitest";
import srfi151 from "../env/srfi/srfi-151.js";

const evalScheme = (e: SchemeEnv, src: string) => exec(src, { env: e as never });

async function mk() {
  const env = sandboxedEnv.inherit(`s151-${Math.random().toString(36).slice(2)}`);
  await assembleEnv(env as unknown as SchemeEnv, [srfi151.lower({ evalScheme }) as never]);
  const num = async (src: string) => Number((await exec(src, { env }))[0]);
  const raw = (src: string) => exec(src, { env });
  return { num, raw };
}

describe("bit-count — SRFI-151 population count", () => {
  it("counts 1 bits of non-negative exact integers", async () => {
    const { num } = await mk();
    expect(await num("(bit-count 0)")).toBe(0);
    expect(await num("(bit-count 1)")).toBe(1);
    expect(await num("(bit-count 7)")).toBe(3); // 0b111
    expect(await num("(bit-count 255)")).toBe(8); // 0b1111_1111
    expect(await num("(bit-count 256)")).toBe(1); // 0b1_0000_0000
  });

  it("counts 0 bits of negative integers (infinite two's-complement, SRFI-151)", async () => {
    const { num } = await mk();
    // -1 is …1111 → zero 0-bits.
    expect(await num("(bit-count -1)")).toBe(0);
    // -2 is …1110 → one 0-bit.
    expect(await num("(bit-count -2)")).toBe(1);
    // -8 is …11111000 → three 0-bits; ~(-8) = 7 → popcount 3.
    expect(await num("(bit-count -8)")).toBe(3);
    // -256 is …1_0000_0000 → eight 0-bits.
    expect(await num("(bit-count -256)")).toBe(8);
  });

  it("handles big (beyond 53-bit) exact integers precisely", async () => {
    const { num } = await mk();
    // (arithmetic-shift 1 100) has exactly one 1-bit — leans on bigint, not float.
    expect(await num("(bit-count (arithmetic-shift 1 100))")).toBe(1);
    // (- (arithmetic-shift 1 100) 1) is 100 one-bits.
    expect(await num("(bit-count (- (arithmetic-shift 1 100) 1))")).toBe(100);
  });

  it("rejects an inexact argument with a clear type error", async () => {
    const { raw } = await mk();
    await expect(raw("(bit-count 3.0)")).rejects.toThrow(/expected an exact integer.*inexact/);
  });

  it("rejects a rational (non-integer exact) argument", async () => {
    const { raw } = await mk();
    await expect(raw("(bit-count 1/2)")).rejects.toThrow(/expected an exact integer.*rational/);
  });
});

describe("base bitwise verbs remain reachable (already bound in scheme/numeric)", () => {
  it("bitwise-and / ior / xor / not and arithmetic-shift work by inheritance", async () => {
    const { num } = await mk();
    expect(await num("(bitwise-and 12 10)")).toBe(8);
    expect(await num("(bitwise-ior 12 10)")).toBe(14);
    expect(await num("(bitwise-xor 12 10)")).toBe(6);
    expect(await num("(bitwise-not 5)")).toBe(-6);
    // negative operands are well-defined on bigints (two's-complement).
    expect(await num("(bitwise-and -1 6)")).toBe(6);
    expect(await num("(bitwise-xor -1 0)")).toBe(-1);
    // shift: positive = left, negative = right, zero = identity.
    expect(await num("(arithmetic-shift 1 4)")).toBe(16);
    expect(await num("(arithmetic-shift 16 -4)")).toBe(1);
    expect(await num("(arithmetic-shift 5 0)")).toBe(5);
  });
});

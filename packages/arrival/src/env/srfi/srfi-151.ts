// SRFI-151 — bitwise operations. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via allSrfi) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// SCOPE (honest): SRFI-151's core bitwise verbs —
// `bitwise-and` / `bitwise-ior` / `bitwise-xor` / `bitwise-not` / `arithmetic-shift`
// — are ALREADY bound in the base `scheme/numeric` pack (env/r7rs/numeric.ts;
// `arithmetic-shift` already carries the SRFI sign convention, positive count =
// left shift). The inference base reaches them by inheritance, so re-binding them
// here would shadow the numeric core with a redundant, divergently-maintained copy
// — the model-design cut says derive/reuse, never duplicate. This pack therefore
// adds ONLY the one genuinely-absent verb models reach for after seeing the base
// five: `bit-count`. (`bitwise-shift` is NOT a real SRFI name and is intentionally
// omitted.)
//
// `bit-count` follows SRFI-151 EXACTLY, negatives included: for i ≥ 0 it counts the
// 1 bits; for i < 0 it counts the 0 bits of the infinite two's-complement rep, which
// with bigint is simply popcount(~i) — ~i = -i-1 is non-negative, so its 1-count IS
// i's 0-count. No approximation and no narrowing error is needed here — the honest
// full contract is cheap with arbitrary-precision integers. Exact-integer only: an
// inexact or a rational argument is a clear type error, mirroring numeric.ts's
// `toInteger` guard (bitwise ops are exact-integer-only, SRFI-151).

import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import * as z from "../../common/scheme-zod.js";
import { symbol, type CallCtx } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { withInputProvenance } from "../../values/op-helpers.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";

/** Exact-integer extraction — mirrors numeric.ts `toInteger`'s guard: an AExact whose
 *  denom is 1 yields its bigint numerator; an inexact or a rational is a clear type
 *  error (bitwise ops are exact-integer-only per SRFI-151). */
function exactIntArg(name: string, v: unknown): bigint {
  if (v instanceof AExact) {
    if (v.isInteger) return v.num;
    throw new TypeError(`${name}: expected an exact integer, got the rational ${v.toString()}`);
  }
  if (v instanceof AInexact) {
    throw new TypeError(`${name}: expected an exact integer, got the inexact ${v.toString()}`);
  }
  throw new TypeError(`${name}: expected an exact integer, got ${v === null ? "nil" : typeof v}`);
}

/** Population count over the two's-complement representation: the 1 bits for i ≥ 0,
 *  the 0 bits for i < 0 (SRFI-151). For i < 0, ~i = -i-1 ≥ 0 and its 1-count IS i's
 *  0-count, so one popcount covers both signs. */
function bitCount(i: bigint): bigint {
  let x = i < 0n ? ~i : i;
  let count = 0n;
  while (x > 0n) {
    count += x & 1n;
    x >>= 1n;
  }
  return count;
}

export default new EnvCapability("scheme/srfi-151", {
  symbols: {
    "bit-count":
      symbol.native`bit-count: number of 1 bits in a non-negative exact integer; for a negative one, the number of 0 bits in its two's-complement representation (SRFI-151)`(
        { input: [z.bigint], output: [z.exact] },
        function (this: CallCtx, i: unknown): AExact {
          const n = exactIntArg("bit-count", i);
          return withInputProvenance([i], new AExact(CONSTANT_CTX, bitCount(n)));
        },
      ),
  },
});

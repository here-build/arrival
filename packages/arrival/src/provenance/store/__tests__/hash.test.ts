/**
 * Content identity (`store/hash.ts`): SHA-256 truncated to 128 bits. Known-answer vectors run
 * against BOTH implementations — Node's crypto and the pure-JS fallback — which must be
 * bit-identical (the browser bundle runs the fallback; Node runs the builtin).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentHash, hex128, seed32, sha256Node, sha256Pure } from "../hash.js";

const enc = new TextEncoder();
const hexOf = (d: Uint8Array): string => [...d].map((b) => b.toString(16).padStart(2, "0")).join("");

// NIST FIPS 180-4 / CAVP vectors.
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const TWO_BLOCK = "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"; // "abcdbcde…nopq"
const MILLION_A = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"; // 1,000,000 × "a"

const impls: [string, (b: Uint8Array) => Uint8Array][] = [["pure-JS fallback", sha256Pure]];
const node = sha256Node();
if (node !== undefined) impls.push(["node:crypto via process.getBuiltinModule", node]);

describe.each(impls)("SHA-256 known answers — %s", (_name, sha) => {
  it("empty, abc, two-block", () => {
    expect(hexOf(sha(enc.encode("")))).toBe(EMPTY);
    expect(hexOf(sha(enc.encode("abc")))).toBe(ABC);
    expect(hexOf(sha(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(TWO_BLOCK);
  });

  it("1,000,000 × 'a' (many blocks)", () => {
    expect(hexOf(sha(enc.encode("a".repeat(1_000_000))))).toBe(MILLION_A);
  });

  it("non-ASCII input is hashed as UTF-8 (BMP, astral, combining)", () => {
    const text = "héllo wörld — 日本語 🦀 é";
    expect(hexOf(sha(enc.encode(text)))).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("padding boundaries 55/56/63/64/65 bytes agree with node:crypto", () => {
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const text = "x".repeat(n);
      expect(hexOf(sha(enc.encode(text))), `len ${n}`).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});

describe("contentHash / seed32", () => {
  it("is 32 lowercase hex = the first 16 bytes of SHA-256(domain NUL text)", () => {
    const h = contentHash("template-v1", "abc");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).toBe(createHash("sha256").update("template-v1\0abc").digest("hex").slice(0, 32));
    expect(hex128(sha256Pure(enc.encode("template-v1\0abc")))).toBe(h);
  });

  it("domain-separates identical text", () => {
    expect(contentHash("template-v1", "x")).not.toBe(contentHash("site-v1", "x"));
  });

  it("seed32 is the legacy FNV-1a32 (sampler seeds stay reproducible)", () => {
    expect(seed32("")).toBe(0x81_1c_9d_c5);
    expect(seed32("a")).toBe(0xe4_0c_29_2c);
    expect(seed32("foobar")).toBe(0xbf_9c_f9_68);
  });
});

/**
 * Content identity: SHA-256 truncated to 128 bits (32 lowercase hex) — payload hashes
 * (`emit.ts`), template/site hashes (`wireframe/hash.ts`). 128 bits makes accidental collision
 * negligible at any realistic corpus size; it is content ADDRESSING, not a signature scheme.
 *
 * ENVIRONMENT-NEUTRAL and SYNC: arrival is bundled for the browser too, so `node:crypto` is never
 * statically imported. Node (≥ 22, and workerd under `nodejs_compat`) hands it over through
 * `process.getBuiltinModule`; everywhere else a compact pure-JS SHA-256 runs. The two are
 * BIT-IDENTICAL (known-answer tests pin both).
 *
 * `seed32` is the old 32-bit FNV-1a: ONLY for deterministic PRNG seeds (`offload.ts`), where a
 * small non-cryptographic mix is the point and no identity is claimed.
 */

/** Hex content hash (32 lowercase hex digits). */
export type ContentHash = string;

const encoder = new TextEncoder();

// prettier-ignore
const K = new Uint32Array([
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5,
  0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74,
  0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47, 0x06_ca_63_51, 0x14_29_29_67,
  0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
  0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f, 0x68_2e_6f_f3,
  0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08, 0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

/* eslint-disable unicorn/prefer-math-trunc -- `| 0` is int32 WRAPPING (SHA-256 modular add), not truncation */
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Pure-JS SHA-256 of `bytes` → 32 digest bytes. Exported for the known-answer tests. */
export function sha256Pure(bytes: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c, 0x1f_83_d9_ab,
    0x5b_e0_cd_19,
  ]);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_00_00_00_00));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  /* eslint-enable unicorn/prefer-math-trunc */
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i]);
  return out;
}

type NodeCrypto = { createHash(algorithm: string): { update(data: Uint8Array): { digest(): Uint8Array } } };

/** Node's SHA-256 when the host exposes `node:crypto` synchronously, else `undefined`. */
export function sha256Node(): ((bytes: Uint8Array) => Uint8Array) | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  let crypto: NodeCrypto | undefined;
  try {
    crypto = proc?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;
  } catch {
    crypto = undefined;
  }
  if (crypto === undefined || typeof crypto.createHash !== "function") return undefined;
  const mod = crypto;
  return (bytes) => new Uint8Array(mod.createHash("sha256").update(bytes).digest());
}

const sha256: (bytes: Uint8Array) => Uint8Array = sha256Node() ?? sha256Pure;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** First 16 digest bytes as 32 lowercase hex. */
export function hex128(digest: Uint8Array): ContentHash {
  let out = "";
  for (let i = 0; i < 16; i++) out += HEX[digest[i]];
  return out;
}

/** Content hash of `${domain}\0${text}` (UTF-8): domain-separated SHA-256/128. */
export function contentHash(domain: string, text: string): ContentHash {
  return hex128(sha256(encoder.encode(`${domain}\0${text}`)));
}

/** 32-bit FNV-1a — deterministic PRNG seed ONLY (never identity). Walks UTF-16 indices with
 *  `codePointAt(i)`, as the sampler's reproducibility has always depended on. */
export function seed32(text: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return h >>> 0;
}

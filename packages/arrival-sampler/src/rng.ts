// rng.ts — a reproducible seeded PRNG (mulberry32). The decode loop (llama-cpp-generate) seeds its
// temperature sampling with it; the research A/B stats (bootstrap / permutation resampling) and their
// tests draw from it too — so a decode run (or a verdict) is deterministic given (seed). Pure function,
// no node deps, but the browser `.` kernel never samples: rng is unreachable from the browser entry
// (src/index.ts), so it ships only via dist-server (the node `./server` path imports it transitively).

/* eslint-disable unicorn/prefer-math-trunc -- mulberry32's `| 0` is INTENTIONAL 32-bit signed wrap (the
   algorithm depends on overflow). Math.trunc does not wrap to 32 bits, so the autofix would silently change
   the PRNG sequence and break the determinism the decode + research stats rely on. */

/** A reproducible PRNG (mulberry32) — seeded so output is deterministic given the seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * `strategyHash` — content hash of a `Strategy` record. Part of the interim
 * artifact identity `artifactId = f(programHash, strategyHash)` (design doc §2/§3);
 * `programHash` is `compile-project.ts`'s sibling concern, not this file's.
 */
import type { Strategy } from "./registry.js";

/** FNV-1a, 32-bit — the repo's idiom (see e.g.
 *  `foundations/arrival/arrival/src/provenance/wireframe/hash.ts::fnv1a`,
 *  `second-foundation/arrival-b/src/calligraphy.ts::fnv1a`). Deterministic,
 *  dependency-free, good enough for a content-addressed identity tag (not a
 *  security hash). */
function fnv1a(str: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return h >>> 0;
}

/** Content hash of the strategy record, hex-encoded (8 chars, zero-padded — same
 *  rendering as the wireframe hash idiom). `Strategy.opinions` is a declared-order
 *  array (registry.ts), so `JSON.stringify` is stable across runs for the SAME
 *  strategy — same input, same bytes, same hash, every time. */
export const strategyHash = (s: Strategy): string => fnv1a(JSON.stringify(s)).toString(16).padStart(8, "0");

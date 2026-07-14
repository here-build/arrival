/**
 * Witness generation — provenance-by-perturbation.md §2.3. A witness is a
 * type-admissible, MARKED replacement for one crossing's recorded value:
 * type-admissible so the probed chain answers instead of crashing; marked so
 * a leaf that comes to CONTAIN the witness's material is observable, not just
 * "moved" (§0's whole reason for retiring "grounding = sensitivity" — movement
 * alone proves influence, and influence includes selection among fabricated
 * constants; only content-flow proves a leaf is MADE OF what crossed).
 *
 * A witness generator that varies only CONTENT under-detects: `(length xs)`
 * is invariant under content-perturbation (swap one UUID for another, the
 * length is unchanged) and `(string-length (:id e))` is invariant across
 * same-length swaps (it measures format, not datum) — a content-only
 * generator would falsely read BOTH as "ungrounded". `witnessesFor` therefore
 * mints one witness per axis the value's TYPE admits — content, shape,
 * cardinality, key-set, presence — never just one witness overall (§2.3, and
 * P4's floor: "two witnesses minimum, and that is a floor, not a bound").
 */
import { randomUUID } from "node:crypto";

export type WitnessAxis = "content" | "shape" | "cardinality" | "key-set" | "presence";

export interface Witness {
  readonly axis: WitnessAxis;
  /** The replacement value `probe()` substitutes for the targeted crossing's
   *  recorded result. */
  readonly value: unknown;
  /** Fresh high-entropy tokens embedded in `value`'s material — verdict.ts's
   *  containment search hunts for these inside a probed leaf. Empty when this
   *  axis's perturbation carries no recognizable material at all (a boolean
   *  flip has nothing to embed a mark IN) — such a witness can prove
   *  "selection", or leave a leaf "ungrounded", but can never prove "content". */
  readonly marks: readonly string[];
  /** Human-readable — test failures and `LeafVerdict.reason` cite it, so a
   *  verdict is legible without re-deriving which witness produced it. */
  readonly label: string;
}

export interface WitnessOptions {
  /** Fresh high-entropy token minting, overridable for deterministic tests.
   *  Default: `randomUUID()`. Whatever it returns must be implausible as a
   *  value the program under test could have constructed itself. Every
   *  witness this module mints — including its numeric sentinels — derives
   *  from this ONE source, so overriding it makes a whole probe run
   *  reproducible, not just the string-shaped witnesses. */
  readonly mint?: () => string;
}

function isPlainObjectLike(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deterministic 32-bit hash of a mark string, folded into a large integer —
 *  so a numeric sentinel still traces back to the one `mint()` randomness
 *  source instead of calling `Math.random()` separately. */
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function stringWitnesses(mint: () => string): Witness[] {
  const contentMark = mint();
  const cardinalityMark = mint();
  return [
    { axis: "content", value: contentMark, marks: [contentMark], label: `content: fresh mark "${contentMark}"` },
    // Same KIND of material (still a mark), a DIFFERENT LENGTH — isolates
    // cardinality (`(string-length …)`-style dependence) from content: doubling
    // guarantees a length different from both the original and the content
    // witness, regardless of the original's own length.
    {
      axis: "cardinality",
      value: cardinalityMark + cardinalityMark,
      marks: [cardinalityMark],
      label: `cardinality: double-length mark "${cardinalityMark}${cardinalityMark}"`,
    },
  ];
}

function numberWitnesses(original: number, mint: () => string): Witness[] {
  const contentMark = mint();
  const contentSentinel = 1_000_000 + hashToInt(contentMark);
  const shapeMark = mint();
  const shapeMagnitude = 1_000_000 + hashToInt(shapeMark);
  // Flip the sign boundary many guards test (`(>= x 0)`) — still marked (a
  // bare sign flip alone would carry no material to detect; stringifying the
  // sentinel keeps this witness able to prove content, not merely
  // selection/ungrounded, the same way the content witness can).
  const shapeSentinel = original >= 0 ? -shapeMagnitude : shapeMagnitude;
  return [
    { axis: "content", value: contentSentinel, marks: [String(contentSentinel)], label: `content: sentinel ${contentSentinel}` },
    { axis: "shape", value: shapeSentinel, marks: [String(shapeSentinel)], label: `shape: sign-flipped sentinel ${shapeSentinel}` },
  ];
}

function booleanWitnesses(original: boolean): Witness[] {
  // The only variation a boolean admits. No material survives a flip to embed
  // a mark in — this witness can prove selection, or leave a leaf ungrounded,
  // but structurally never content (a boolean cannot BE a UUID).
  return [{ axis: "shape", value: !original, marks: [], label: `shape: flipped boolean (was ${String(original)})` }];
}

function presenceWitnesses(mint: () => string): Witness[] {
  const mark = mint();
  return [{ axis: "presence", value: mark, marks: [mark], label: `presence: replace null/absent with fresh mark "${mark}"` }];
}

function arrayWitnesses(original: readonly unknown[], mint: () => string): Witness[] {
  const contentMarks: string[] = [];
  const contentValue = original.map(() => {
    const m = mint();
    contentMarks.push(m);
    return m;
  });
  const cardinalityMark = mint();
  return [
    {
      axis: "content",
      value: contentValue,
      marks: contentMarks,
      label: `content: every element replaced by an independent fresh mark (length unchanged, ${original.length})`,
    },
    {
      axis: "cardinality",
      value: [...original, cardinalityMark],
      marks: [cardinalityMark],
      label: `cardinality: length ${original.length} → ${original.length + 1}, appended a fresh mark`,
    },
  ];
}

function objectWitnesses(original: Record<string, unknown>, mint: () => string): Witness[] {
  const keys = Object.keys(original);
  const contentMarks: string[] = [];
  const contentValue: Record<string, unknown> = {};
  for (const k of keys) {
    const m = mint();
    contentMarks.push(m);
    contentValue[k] = m;
  }
  const keyMark = mint();
  return [
    {
      axis: "content",
      value: contentValue,
      marks: contentMarks,
      label: `content: every value replaced by an independent fresh mark (same key-set: ${keys.length > 0 ? keys.join(", ") : "∅"})`,
    },
    {
      axis: "key-set",
      value: { ...original, [`__probe_witness_${keyMark}`]: keyMark },
      marks: [keyMark],
      label: `key-set: one extra fresh-marked key added, existing values untouched`,
    },
  ];
}

function genericWitnesses(mint: () => string): Witness[] {
  const mark = mint();
  return [
    { axis: "content", value: mark, marks: [mark], label: `content: fallback fresh-mark replacement (unrecognized original type)` },
  ];
}

/**
 * Mint the family of witnesses for `value` — one per axis its TYPE admits
 * (never just one overall; see the file header). `value` is a recorded
 * crossing's result (a `ProbeTableEntry.result` from `./session.js`), so its
 * runtime type is whatever shape a JS value crossing the membrane can take: a
 * primitive, an array, or a plain object (the shapes `schemeToJs`/`jsToScheme`
 * round-trip).
 */
export function witnessesFor(value: unknown, opts?: WitnessOptions): Witness[] {
  const mint = opts?.mint ?? randomUUID;
  if (typeof value === "string") return stringWitnesses(mint);
  if (typeof value === "number") return numberWitnesses(value, mint);
  if (typeof value === "boolean") return booleanWitnesses(value);
  if (value === null || value === undefined) return presenceWitnesses(mint);
  if (Array.isArray(value)) return arrayWitnesses(value, mint);
  if (isPlainObjectLike(value)) return objectWitnesses(value, mint);
  return genericWitnesses(mint);
}

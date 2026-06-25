/**
 * Char ops — the R7RS § 6.6 character cluster, carved VERBATIM out of
 * `wrappedOps` in `../bridge.ts`. These are behavior-preserving copies of the
 * interpreter's character predicates, comparisons, classification, case
 * conversion, and char/integer conversions. The only change from the bridge
 * originals is that cross-cutting helpers (`charValue`, `deriveOrd`,
 * `coerceNumeric`) are imported from `../op-helpers.js` rather than referenced
 * as bridge locals. The implementations — including inline comments — are
 * otherwise identical to the source.
 *
 * MIGRATED to the `symbol.native` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for TYPES purely") and an impl bound
 * raw, exactly as the old `{ value }` form was. Native means the schema choice
 * cannot change runtime behavior; the bodies are reproduced byte-for-byte.
 */

import foldCase from "fold-case";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import unicodeProperties from "unicode-properties";
import invariant from "tiny-invariant";

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { charValue, coerceNumeric, deriveOrd } from "../../values/op-helpers.js";
import { AExact } from "../../values/numbers.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { EnvCapability } from "../../common/capability.js";

export default new EnvCapability("scheme/chars", {
  symbols: {
    "char?": symbol.native`char?: #t iff the object is a character`(
      { input: [z.unknown()], output: [z.boolean] },
      (obj: unknown): boolean => {
        return obj instanceof ACharacter;
      },
    ),

    "char=?": symbol.native`char=?: typed equivalence over characters`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...chars: unknown[]): boolean => {
        if (chars.length < 2) return true;
        const first = charValue(chars[0]);
        return chars.slice(1).every((c) => charValue(c) === first);
      },
    ),

    // char</>/<=/>= derive from SchemeCharacter's arrival/tagless-final/lte (wave-1 Ord) via
    // the shared deriveOrd chain — see ORD_REL above.
    "char<?": symbol.native`char<?: strictly-increasing character order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd("<"),
    ),
    "char>?": symbol.native`char>?: strictly-decreasing character order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd(">"),
    ),
    "char<=?": symbol.native`char<=?: non-decreasing character order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd("<="),
    ),
    "char>=?": symbol.native`char>=?: non-increasing character order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd(">="),
    ),

    // Case-insensitive comparisons
    "char-ci=?": symbol.native`char-ci=?: case-insensitive character equivalence`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...chars: unknown[]): boolean => {
        if (chars.length < 2) return true;
        const first = charValue(chars[0]).toLowerCase();
        return chars.slice(1).every((c) => charValue(c).toLowerCase() === first);
      },
    ),

    "char-ci<?": symbol.native`char-ci<?: case-insensitive strictly-increasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...chars: unknown[]): boolean => {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() >= charValue(chars[i + 1]).toLowerCase()) return false;
        }
        return true;
      },
    ),

    "char-ci>?": symbol.native`char-ci>?: case-insensitive strictly-decreasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...chars: unknown[]): boolean => {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() <= charValue(chars[i + 1]).toLowerCase()) return false;
        }
        return true;
      },
    ),

    "char-ci<=?": symbol.native`char-ci<=?: case-insensitive non-decreasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...chars: unknown[]): boolean => {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() > charValue(chars[i + 1]).toLowerCase()) return false;
        }
        return true;
      },
    ),

    "char-ci>=?": symbol.native`char-ci>=?: case-insensitive non-increasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...chars: unknown[]): boolean => {
        for (let i = 0; i < chars.length - 1; i++) {
          if (charValue(chars[i]).toLowerCase() < charValue(chars[i + 1]).toLowerCase()) return false;
        }
        return true;
      },
    ),

    // Character classification
    // R7RS § 6.6: each predicate returns #t iff the character's Unicode general
    // category falls in the expected set. The previous round-trip-case heuristic
    // (`lower !== upper`) misses every category-Lo script (CJK, Hangul, Hebrew,
    // Arabic, …) because Lo has no case mapping → lower === upper → predicate
    // returns #f. `unicodeProperties.getCategory(codepoint)` is the source of
    // truth.
    "char-alphabetic?": symbol.native`char-alphabetic?: #t iff the character is a letter`(
      { input: [z.schemeChar], output: [z.boolean] },
      (char: unknown): boolean => {
        const cp = charValue(char).codePointAt(0)!;
        // Letter categories: Lu (upper), Ll (lower), Lt (title), Lm (modifier), Lo (other).
        switch (unicodeProperties.getCategory(cp)) {
          case "Lu":
          case "Ll":
          case "Lt":
          case "Lm":
          case "Lo":
            return true;
          default:
            return false;
        }
      },
    ),

    "char-numeric?": symbol.native`char-numeric?: #t iff the character is a numeric digit`(
      { input: [z.schemeChar], output: [z.boolean] },
      (char: unknown): boolean => {
        const cp = charValue(char).codePointAt(0)!;
        // Number categories: Nd (decimal digit), Nl (letter number), No (other).
        // The previous `isDigit` only matched Nd — CJK numerals (Nl) and Roman
        // numerals (Nl) were misclassified.
        switch (unicodeProperties.getCategory(cp)) {
          case "Nd":
          case "Nl":
          case "No":
            return true;
          default:
            return false;
        }
      },
    ),

    "char-whitespace?": symbol.native`char-whitespace?: #t iff the character is whitespace`(
      { input: [z.schemeChar], output: [z.boolean] },
      (char: unknown): boolean => {
        // JS \s ≈ Unicode White_Space property — covers ASCII tab/LF/CR/space
        // plus the Z* categories (Zs/Zl/Zp) plus a few format chars. Closer to
        // R7RS than getCategory alone (which would miss tab/LF as Cc).
        return /^\s$/.test(charValue(char));
      },
    ),

    "char-upper-case?": symbol.native`char-upper-case?: #t iff the character is uppercase`(
      { input: [z.schemeChar], output: [z.boolean] },
      (char: unknown): boolean => {
        const cp = charValue(char).codePointAt(0)!;
        return unicodeProperties.getCategory(cp) === "Lu";
      },
    ),

    "char-lower-case?": symbol.native`char-lower-case?: #t iff the character is lowercase`(
      { input: [z.schemeChar], output: [z.boolean] },
      (char: unknown): boolean => {
        const cp = charValue(char).codePointAt(0)!;
        return unicodeProperties.getCategory(cp) === "Ll";
      },
    ),

    "digit-value": symbol.native`digit-value: numeric value of a digit character, or #f`(
      { input: [z.schemeChar], output: [z.union([z.number, z.boolean])] },
      (char: unknown): number | false => {
        const c = charValue(char);
        const codePoint = c.codePointAt(0)!;
        if (!unicodeProperties.isDigit(codePoint)) return false;
        const numericValue = unicodeProperties.getNumericValue(codePoint);
        return numericValue === null ? false : numericValue;
      },
    ),

    // Case conversion
    "char-upcase": symbol.native`char-upcase: uppercase form of the character`(
      { input: [z.schemeChar], output: [z.schemeChar] },
      (char: unknown): ACharacter => {
        return new ACharacter(CONSTANT_CTX, charValue(char).toUpperCase());
      },
    ),

    "char-downcase": symbol.native`char-downcase: lowercase form of the character`(
      { input: [z.schemeChar], output: [z.schemeChar] },
      (char: unknown): ACharacter => {
        return new ACharacter(CONSTANT_CTX, charValue(char).toLowerCase());
      },
    ),

    "char-foldcase": symbol.native`char-foldcase: case-folded form of the character`(
      { input: [z.schemeChar], output: [z.schemeChar] },
      (char: unknown): ACharacter => {
        const c = charValue(char);
        const folded = foldCase(c);
        // R7RS § 6.6: char-foldcase returns a character (single Unicode scalar).
        // When fold would expand to MULTIPLE chars (Eszett ß → "ss", Greek final
        // sigma, etc.), there is no single-char result, so the operation MUST
        // return the input unchanged. Truncating to `folded[0]` produces a
        // different character (ß → s) which violates the round-trip identity.
        return [...folded].length === 1 ? new ACharacter(CONSTANT_CTX, folded) : (char as ACharacter);
      },
    ),

    // Character/integer conversion
    // R7RS § 6.6: return the Unicode SCALAR (code point), not the UTF-16 code unit.
    // `charCodeAt(0)` is wrong for non-BMP chars (e.g. emoji): it returns the high
    // surrogate (e.g. 0xD83D for 😀) instead of the full code point (0x1F600).
    // `codePointAt(0)` reads a full surrogate pair when present.
    "char->integer": symbol.native`char->integer: Unicode scalar value of the character`(
      { input: [z.schemeChar], output: [z.schemeExact] },
      (char: unknown): AExact => {
        return new AExact(CONSTANT_CTX, BigInt(charValue(char).codePointAt(0)!));
      },
    ),

    // R7RS § 6.6: inverse of char->integer over Unicode scalar range.
    // `fromCharCode` silently truncates above 0xFFFF (modulo 0x10000), corrupting
    // any non-BMP code point. `fromCodePoint` accepts up to U+10FFFF and emits
    // the correct surrogate pair. Surrogate code points themselves (D800..DFFF)
    // are NOT Unicode scalars per the standard; reject explicitly.
    "integer->char": symbol.native`integer->char: character for a Unicode scalar value`(
      { input: [z.schemeNumber], output: [z.schemeChar] },
      (n: unknown): ACharacter => {
        const num = coerceNumeric(n);
        const code = num instanceof AExact ? Number(num.num) : Math.floor(num.real);
        invariant(code >= 0 && code <= 0x10_ff_ff, `integer->char: code point ${code} out of Unicode range`);
        invariant(
          code < 0xd8_00 || code > 0xdf_ff,
          `integer->char: surrogate code point ${code.toString(16)} is not a Unicode scalar`,
        );
        return new ACharacter(CONSTANT_CTX, String.fromCodePoint(code));
      },
    ),
  },
});

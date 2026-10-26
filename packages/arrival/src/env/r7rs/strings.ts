/**
 * String ops — the R7RS § 6.7 string cluster: constructors, accessors,
 * comparisons (case-sensitive and case-insensitive), append, list conversions,
 * copy/slice, case conversion, and the higher-order `string-map` /
 * `string-for-each`. (`number->string` lives in numeric.ts, not here.)
 *
 * Each op declares a SCHEME-IDENTITY zod contract (no codec, no runtime
 * validation — "zod for TYPES purely") and an impl that receives Scheme values
 * as-is (bound as a first-class ANativeProcedure — capability.ts). Native means
 * the schema choice cannot change runtime behavior.
 */

import foldCase from "fold-case";
import dedent from "dedent";
import { applyCallback } from "../../values/primitives/ACallable.js";
import type { Impl } from "../../common/symbols/_bake.js";
import type * as Z from "../../common/scheme-zod/index.js";
import invariant from "tiny-invariant";

import {
  assertAllocatable,
  charValue,
  // Index/length paths unwrap immediately — the coerced box never escapes.
  // Mint sites (make-string, string-ref, …) stamp the escaping result instead.
  coerceNumeric,
  deriveOrd,
  schemeBool as bool,
  stringValue,
  withInputProvenance,
} from "../../values/op-helpers.js";
import { collapseProvenance, taintString } from "../../provenance/provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AInexact } from "../../values/primitives/AInexact.js";
import { APair } from "../../values/primitives/APair.js";
import { nil } from "../../values/primitives/ANil.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { attachOffendingValue } from "../../errors.js";
import { type } from "../../membrane/typecheck.js";
import { sliceRange, to_array } from "../pack-helpers.js";
import { is_promise } from "../../values/value-guards.js";
import { maybeThen, promise_all, settleAll } from "../../utils/promises.js";
import { EnvCapability } from "../../common/capability.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import {
  complex_bare_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  rational_bare_re,
  rational_re,
} from "../../reader/lexical-grammar.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "../../reader/parsing.js";
import type { AListAlike } from "../../values/types.js";

/** Body of the four string-ci ordering predicates: `holds` must pass between every
 *  adjacent pair of FOLDED strings (R7RS § 6.7 defines `string-ci…?` via
 *  `string-foldcase`, the same fold `string-foldcase` applies — `toLowerCase` is NOT a
 *  fold: "Straße" and "STRASSE" fold together but do not lowercase together). Mirrors
 *  `ciOrder` in chars.ts. */
function ciOrder(holds: (a: string, b: string) => boolean): Impl<[], [typeof Z.boolean], typeof Z.string, "scheme"> {
  return function (...strs) {
    let verdict = true;
    for (let i = 0; i < strs.length - 1; i++) {
      if (!holds(foldCase(stringValue(strs[i])), foldCase(stringValue(strs[i + 1])))) {
        verdict = false;
        break;
      }
    }
    return withInputProvenance(this.runCtx, strs, bool(verdict));
  };
}

/** A string-map result element must be a character (R7RS § 6.7: "proc must return a
 *  character") — a number/string/list is a taught error, never silently stringified. A
 *  host callback's bare one-code-point string is a character's image, so it passes. */
function mappedChar(c: unknown): string {
  if (c instanceof ACharacter) return charValue(c);
  if (typeof c === "string" && [...c].length === 1) return c;
  throw attachOffendingValue(
    new TypeError(
      `string-map: the procedure must return a character, got ${type(c)} (build strings with string-append)`,
    ),
    c,
  );
}

/** R7RS § 6.2.5 infinities and NaN — `string->number` accepts them (radix-independent). */
const SPECIAL_REALS: Record<string, number | undefined> = {
  "+inf.0": Number.POSITIVE_INFINITY,
  "-inf.0": Number.NEGATIVE_INFINITY,
  "+nan.0": Number.NaN,
  "-nan.0": Number.NaN,
};

export default EnvCapability.define("scheme/strings", {
  symbols: (symbol, z) => ({
    "make-string": symbol.native`make-string: a string of k copies of a fill character`(
      { input: [z.schemeNumber, z.char.optional()], output: [z.string] },
      function (k, char) {
        const len = Number(coerceNumeric(k).valueOf());
        // O(1) cap check BEFORE `.repeat(len)` allocates — see assertAllocatable.
        assertAllocatable(len, "make-string");
        const c = char ? charValue(char) : "\u0000";
        // Both the length and (when present) the filling char contribute lineage —
        // `(make-string n user-char)` should remember user-char as a source even
        // though the length is what dictates the result's size.
        return withInputProvenance(this.runCtx, char === undefined ? [k] : [k, char], new AString(c.repeat(len)));
      },
    ),

    string: symbol.native`string: a string built from the character arguments`(
      { input: [], inputRest: z.char, output: [z.string] },
      // Union of every character argument — same shape as `vector` below.
      function (...chars) {
        return withInputProvenance(this.runCtx, chars, new AString(chars.map(charValue).join("")));
      },
    ),

    "string-length": symbol.native`string-length: number of characters in the string`(
      { input: [z.string], output: [z.exact] },
      function (str) {
        return withInputProvenance(this.runCtx, [str], new AExact([...stringValue(str)].length));
      },
    ),

    "string-ref": symbol.native`string-ref: the character at index k`(
      { input: [z.string, z.schemeNumber], output: [z.char] },
      function (str, k) {
        // Bounds-checked (R7RS §6.7: "k must be a valid index") — an out-of-range index
        // raises a clean, catchable RangeError here, matching list-ref's error quality
        // (never a leaky internal "charValue is not iterable" from constructing
        // ACharacter(undefined) on an OOB index). Code-point indexing (the spread), not UTF-16.
        const chars = [...stringValue(str)];
        const idx = Number(coerceNumeric(k).valueOf());
        if (!Number.isInteger(idx) || idx < 0 || idx >= chars.length) {
          throw new RangeError(`string-ref: index ${idx} out of range for a string of length ${chars.length}`);
        }
        return withInputProvenance(this.runCtx, [str, k], new ACharacter(chars[idx]));
      },
    ),

    // ── PURITY DOORS — string mutators OMITTED by design (R7RS §6.7) ─────────────
    // A string is a frozen entity; an in-place write would falsify the construction-
    // site provenance it carries. Doored here (errors-as-doors), co-located with the
    // pack that owns the string type.
    "string-set!": symbol.notImplemented`string-set!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (string-append / substring / a fresh string)`,
    "string-fill!": symbol.notImplemented`string-fill!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (make-string with the fill)`,

    "string=?": symbol.native`string=?: typed equivalence over strings`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      function (...strs) {
        let verdict = true;
        if (strs.length >= 2) {
          const first = stringValue(strs[0]);
          verdict = strs.slice(1).every((s) => stringValue(s) === first);
        }
        return withInputProvenance(this.runCtx, strs, bool(verdict));
      },
    ),

    // string</>/<=/>= derive from SchemeString's arrival/tagless-final/lte via the
    // shared deriveOrd chain — same adapter as the char family.
    "string<?": symbol.native`string<?: strictly-increasing string order`(
      { input: z.array(z.string), output: [z.boolean] },
      deriveOrd("<"),
    ),
    "string>?": symbol.native`string>?: strictly-decreasing string order`(
      { input: z.array(z.string), output: [z.boolean] },
      deriveOrd(">"),
    ),
    "string<=?": symbol.native`string<=?: non-decreasing string order`(
      { input: z.array(z.string), output: [z.boolean] },
      deriveOrd("<="),
    ),
    "string>=?": symbol.native`string>=?: non-increasing string order`(
      { input: z.array(z.string), output: [z.boolean] },
      deriveOrd(">="),
    ),

    "string-ci=?": symbol.native`string-ci=?: case-insensitive string equivalence`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      function (...strs) {
        let verdict = true;
        if (strs.length >= 2) {
          const first = foldCase(stringValue(strs[0]));
          verdict = strs.slice(1).every((s) => foldCase(stringValue(s)) === first);
        }
        return withInputProvenance(this.runCtx, strs, bool(verdict));
      },
    ),

    "string-ci<?": symbol.native`string-ci<?: case-insensitive strictly-increasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      ciOrder((a, b) => a < b),
    ),

    "string-ci>?": symbol.native`string-ci>?: case-insensitive strictly-decreasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      ciOrder((a, b) => a > b),
    ),

    "string-ci<=?": symbol.native`string-ci<=?: case-insensitive non-decreasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      ciOrder((a, b) => a <= b),
    ),

    "string-ci>=?": symbol.native`string-ci>=?: case-insensitive non-increasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      ciOrder((a, b) => a >= b),
    ),

    "string-append": symbol.native`string-append: concatenation of all string arguments`(
      { input: [], inputRest: z.string, output: [z.union([z.string, z.string])] },
      // Collapsing op: the result inherits lineage from every input — and DEEP, so a
      // nested structure (a list/vector/array of inference-stamped values) is hoisted,
      // not just the top-level AValue args. Without this, `(string-append prefix
      // (string-join parts ""))` forgets where `parts` came from. See provenance-collapse.ts.
      function (...strs) {
        return taintString(strs.map(stringValue).join(""), collapseProvenance(...strs));
      },
    ),

    "string->list": symbol.native`string->list: list of the string's characters`(
      {
        input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()],
        output: [z.union([z.pair, z.nil])],
      },
      function (str, start, end) {
        const chars = [...stringValue(str)];
        const { start: startIdx, end: endIdx } = sliceRange("string->list", chars.length, start, end, "string");
        let result: AListAlike = nil;
        for (let i = endIdx - 1; i >= startIdx; i--) result = new APair(new ACharacter(chars[i]), result);
        return result;
      },
    ),

    "list->string": symbol.native`list->string: string built from a list of characters`(
      { input: [z.listAlike], output: [z.string] },
      function (list) {
        const chars = to_array("list->string")(list).map(charValue);
        return new AString(chars.join(""));
      },
    ),

    "string-copy": symbol.native`string-copy: a fresh copy of the string (or slice)`(
      { input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.string] },
      function (str, start, end) {
        const chars = [...stringValue(str)];
        const { start: startIdx, end: endIdx } = sliceRange("string-copy", chars.length, start, end, "string");
        // The copy is a fresh allocation but semantically the same lineage as `str`
        // (start/end indices don't carry meaning here, they shape the slice).
        return withInputProvenance(this.runCtx, [str], new AString(chars.slice(startIdx, endIdx).join("")));
      },
    ),

    // string-copy! — the mutating sibling of string-copy above; OMITTED by design
    // (mutates its destination), doored here. The non-mutating string-copy stays.
    "string-copy!": symbol.notImplemented`string-copy!: every value is frozen by design — mutating its destination would falsify the provenance lineage it carries; construct a new value instead (string-copy returns a fresh string)`,

    // Case conversion for strings — case is a presentation transform, not a
    // new origin; inherit the source's lineage so downstream `define` of the
    // result still traces to the original infer/query call.
    "string-upcase": symbol.native`string-upcase: uppercase form of the string`(
      { input: [z.string], output: [z.string] },
      function (str) {
        return withInputProvenance(this.runCtx, [str], new AString(stringValue(str).toUpperCase()));
      },
    ),

    "string-downcase": symbol.native`string-downcase: lowercase form of the string`(
      { input: [z.string], output: [z.string] },
      function (str) {
        return withInputProvenance(this.runCtx, [str], new AString(stringValue(str).toLowerCase()));
      },
    ),

    "string-foldcase": symbol.native`string-foldcase: case-folded form of the string`(
      { input: [z.string], output: [z.string] },
      function (str) {
        return withInputProvenance(this.runCtx, [str], new AString(foldCase(stringValue(str))));
      },
    ),

    // proc is the fixed HEAD; the spread strings are the variadic TAIL (inputRest) — mirrors
    // apply's head/rest split. The head uses the established callable-schema convention
    // (z.custom<(...args) => T>(), matching vector-map/vector-for-each/curry); the rest is
    // z.string (this file's own string-identity schema, not the representation-blind
    // z.schemeValue) so proc/strings arrive as real typed parameters — no manual destructure-
    // and-cast needed at the call site.
    "string-map": symbol.native`string-map: map a procedure across the strings' characters`(
      // The z.custom callable head collapses signatureOf to the catch-all `(...args: unknown[])
      // => unknown` (losing the `string[]` rest + the string return). `type` author-asserts the
      // real shape (callable → `(...args: unknown[]) => unknown`; the rest harvests z.string
      // as `string`), same convention as the sibling srfi curry/find overrides.
      {
        input: [z.lambda],
        inputRest: z.string,
        output: [z.string],
        type: dedent`
          {
            (f: (c: string) => string, s: string): string;
            (f: (...chars: string[]) => string, ...strings: string[]): string;
          }
        `,
        // callbackRoles DECLARED: the host is role `pipe` (string-map was never a
        // declared fan), so the fan default can't fire and shape underdetermines.
        // proc's return BECOMES the output character — `element-transformer`.
        callbackRoles: ["element-transformer"],
      },
      function (proc, ...strings) {
        invariant(strings.length > 0, "string-map: expected at least one string");
        // Code points, like string-length / string-ref — never UTF-16 units.
        const strs = strings.map((s) => [...stringValue(s)]);
        const minLen = Math.min(...strs.map((s) => s.length));
        // Seam-routed: `proc` is a callable VALUE (membrane-boxed), not a bare fn. `this` IS
        // the whole CallCtx dispatch built — thread it, not just `this.runCtx`.
        const results = Array.from({ length: minLen }, (_, i) =>
          applyCallback(
            proc,
            strs.map((s) => new ACharacter(s[i])),
            this,
          ),
        );
        // proc may be an async membrane callback → await before joining, so the result
        // is a real string, not "[object Promise][object Promise]…" (see vector-map).
        return maybeThen(settleAll(results), (chars) => new AString(chars.map(mappedChar).join("")));
      },
    ),

    // Same head/rest split as string-map above (callable head, z.string rest) — proc/
    // strings arrive as real typed parameters, no manual destructure-and-cast needed.
    "string-for-each": symbol.native`string-for-each: apply a procedure across the strings' characters`(
      // Same degrade + author-assertion as string-map (the for-effect twin) → `void` (R7RS
      // unspecified; bare `void` as in env/core/core.ts's own hand-written type).
      {
        input: [z.lambda],
        inputRest: z.string,
        output: [z.undefinedResult],
        // P18: fan of effect tracks (see for-each, r7rs/lists.ts).
        provenance: "fan",
        callbackRoles: ["effect"],
        type: dedent`
          {
            (f: (c: string) => unknown, s: string): void;
            (f: (...chars: string[]) => unknown, ...strings: string[]): void;
          }
        `,
      },
      function (proc, ...strings) {
        invariant(strings.length > 0, "string-for-each: expected at least one string");
        const strs = strings.map((s) => [...stringValue(s)]);
        const minLen = Math.min(...strs.map((s) => s.length));
        // `this` IS the whole CallCtx dispatch built — thread it, not just `this.runCtx`.
        const rets = Array.from({ length: minLen }, (_, i) =>
          applyCallback(
            proc,
            strs.map((s) => new ACharacter(s[i])),
            this,
          ),
        );
        const pending = rets.filter(is_promise);
        // R7RS "unspecified" is theVoid on the scheme face.
        if (pending.length > 0) return promise_all(pending).then(() => theVoid);
        return theVoid;
      },
    ),

    // `substring` is genuine R7RS. `string->number` is R7RS plus end-trim (see TRIM
    // on the impl). `native` means the (identity) zod contract never runs — the
    // impls receive Scheme values directly. String fold-with-separator is SRFI-13
    // `string-join` (list first); the sep-first polyglot spelling `join` lives in
    // scheme/polyglot. Substring search is SRFI-13 `string-contains` /
    // `string-contains?`.
    substring: symbol.native`substring: the slice of the string between start and end`(
      { input: [z.string, z.schemeNumber, z.schemeNumber.optional()], output: [z.string] },
      function (string, start, end) {
        // `string` is an AString (grafted String.prototype), the indices AExact/AInexact.
        // Code-point slice with a taught range error — JS `substring` would swap
        // reversed bounds and clamp/zero out-of-range ones.
        const chars = [...stringValue(string)];
        const range = sliceRange("substring", chars.length, start, end, "string");
        return new AString(chars.slice(range.start, range.end).join(""));
      },
    ),

    "string->number":
      symbol.native`string->number: parse the string as a number, or #f; surrounding whitespace is shed`(
        { input: [z.string, z.number.optional()], output: [z.union([z.number, z.boolean])] },
        function (arg, radix) {
          // TRIM (not R7RS §6.2.6): ends shed before the numeral match. Spec-faithful
          // `#f` on `" 42 "` is the worse teaching — padded digits are the common
          // paste. Internal whitespace (`"1 2"`) still `#f`. Not gated on strict: this
          // is procedure QoL, not a reader-literal portability control. Numerals
          // dispatch over the reader's leaf parsers (reader/parsing.ts); the
          // `+inf.0` / `-inf.0` / `+nan.0` constants are matched first because the
          // reader resolves them as self-evaluating constants, not numeral shapes.
          const str = stringValue(arg).trim();
          const special = SPECIAL_REALS[str.toLowerCase()];
          if (special !== undefined) return new AInexact(special);
          const base = radix === undefined ? 10 : Number(coerceNumeric(radix).valueOf());
          try {
            if (str.match(rational_bare_re) || str.match(rational_re)) {
              return parse_rational(str, base);
            } else if (str.match(complex_bare_re) || str.match(complex_re)) {
              // R7RS: pure imaginary must have explicit sign (+3i or -3i, not 3i)
              // Reject patterns like "3i", "33i", "3.3i" without leading sign
              if (/^#?[iexobd]*[0-9.]+i$/i.test(str)) {
                return bool(false);
              }
              return parse_complex(str, base);
            } else {
              const valid_bare = (base === 10 && !/e/i.test(str)) || base === 16;
              if ((str.match(int_bare_re) && valid_bare) || str.match(int_re)) {
                return parse_integer(str, base);
              }
              if (float_re.test(str)) {
                return parse_float(str);
              }
            }
          } catch {
            // Invalid number format - return #f per R7RS
            return bool(false);
          }
          return bool(false);
        },
      ),
  }),
});

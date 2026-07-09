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
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import { CallCtx } from "../../common/symbols/_bake.js";
import invariant from "tiny-invariant";

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import {
  assertAllocatable,
  charValue,
  coerceNumeric,
  deriveOrd,
  schemeBool as bool,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../../values/op-helpers.js";
import { collapseProvenance, taintString } from "../../provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { APair, isCircularList } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { is_promise } from "../../eval/guards.js";
import { promise_all } from "../../utils/promises.js";
import { EnvCapability } from "../../common/capability.js";
import { heapBudgetMessage } from "../../heap-budget.js";
import { ArrivalError } from "../../eval/evaluator.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { type AVoid, theVoid } from "../../values/primitives/AVoid.js";
import {
  complex_bare_re,
  complex_re,
  float_re,
  int_bare_re,
  int_re,
  rational_bare_re,
  rational_re,
} from "../../values/primitives.js";
import { parse_complex, parse_float, parse_integer, parse_rational } from "../../utils/parsing.js";
import type { AList, AListAlike, SchemeValue } from "../../values/types.js";

import { to_array } from "../pack-helpers.js";

export default new EnvCapability("scheme/strings", {
  symbols: {
    "make-string": symbol.native`make-string: a string of k copies of a fill character`(
      { input: [z.schemeNumber, z.char.optional()], output: [z.string] },
      (k, char) => {
        const len = Number(coerceNumeric(k).valueOf());
        // O(1) cap check BEFORE `.repeat(len)` allocates — see assertAllocatable.
        assertAllocatable(len, "make-string");
        const c = char ? charValue(char) : "\u0000";
        // Both the length and (when present) the filling char contribute lineage —
        // `(make-string n user-char)` should remember user-char as a source even
        // though the length is what dictates the result's size.
        return withInputProvenance(char === undefined ? [k] : [k, char], new AString(CONSTANT_CTX, c.repeat(len)));
      },
    ),

    string: symbol.native`string: a string built from the character arguments`(
      { input: [], inputRest: z.char, output: [z.string] },
      // Union of every character argument — same shape as `vector` below.
      (...chars) => withInputProvenance(chars, new AString(CONSTANT_CTX, chars.map(charValue).join(""))),
    ),

    "string-length": symbol.native`string-length: number of characters in the string`(
      { input: [z.string], output: [z.bigint] },
      (str) => withInputProvenance([str], new AExact(CONSTANT_CTX, BigInt([...stringValue(str)].length))),
    ),

    "string-ref": symbol.native`string-ref: the character at index k`(
      { input: [z.string, z.schemeNumber], output: [z.char] },
      (str, k) =>
        withInputProvenance(
          [str, k],
          new ACharacter(CONSTANT_CTX, [...stringValue(str)][Number(coerceNumeric(k).valueOf())]),
        ),
    ),

    // ── PURITY DOORS — string mutators OMITTED by design (R7RS §6.7) ─────────────
    // A string is a frozen entity; an in-place write would falsify the construction-
    // site provenance it carries. Doored here (errors-as-doors), co-located with the
    // pack that owns the string type — dissolved from the deleted core.ts manifesto.
    "string-set!": symbol.notImplemented`string-set!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (string-append / substring / a fresh string)`,
    "string-fill!": symbol.notImplemented`string-fill!: every value is frozen by design — mutating it after construction would falsify the provenance lineage it carries; construct a new value instead (make-string with the fill)`,

    // String comparison
    "string=?": symbol.native`string=?: typed equivalence over strings`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      (...strs) => {
        let verdict = true;
        if (strs.length >= 2) {
          const first = stringValue(strs[0]);
          verdict = strs.slice(1).every((s) => stringValue(s) === first);
        }
        return withInputProvenance(strs, bool(verdict));
      },
    ),

    // string</>/<=/>= derive from SchemeString's arrival/tagless-final/lte (wave-1 Ord) via
    // the shared deriveOrd chain — same adapter as the char family.
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

    // Case-insensitive string comparison
    "string-ci=?": symbol.native`string-ci=?: case-insensitive string equivalence`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      (...strs) => {
        let verdict = true;
        if (strs.length >= 2) {
          const first = stringValue(strs[0]).toLowerCase();
          verdict = strs.slice(1).every((s) => stringValue(s).toLowerCase() === first);
        }
        return withInputProvenance(strs, bool(verdict));
      },
    ),

    "string-ci<?": symbol.native`string-ci<?: case-insensitive strictly-increasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      (...strs) => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() >= stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, bool(verdict));
      },
    ),

    "string-ci>?": symbol.native`string-ci>?: case-insensitive strictly-decreasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      (...strs) => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() <= stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, bool(verdict));
      },
    ),

    "string-ci<=?": symbol.native`string-ci<=?: case-insensitive non-decreasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      (...strs) => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() > stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, bool(verdict));
      },
    ),

    "string-ci>=?": symbol.native`string-ci>=?: case-insensitive non-increasing order`(
      { input: [], inputRest: z.string, output: [z.boolean] },
      (...strs) => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() < stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, bool(verdict));
      },
    ),

    // Substring search. `string-contains` is SRFI-13: the index of the first
    // occurrence of `sub` in `str`, or #f when absent. (#f is the ONLY false value
    // in Scheme — an index of 0 is truthy — so `(if (string-contains h n) …)` reads
    // naturally.) `string-contains?` is its boolean-predicate twin (the `?`-suffix
    // predicate convention). Both carry the lineage of the strings they searched, so a
    // "this name contains 'Alloy'" decision over an evidence read stays grounded.
    "string-contains": symbol.native`string-contains: index of the first occurrence of sub, or #f`(
      { input: [z.string, z.string], output: [z.union([z.bigint, z.boolean])] },
      (str, sub) => {
        const i = stringValue(str).indexOf(stringValue(sub));
        return withInputProvenance([str, sub], i === -1 ? bool(false) : new AExact(CONSTANT_CTX, BigInt(i)));
      },
    ),

    "string-contains?": symbol.native`string-contains?: #t iff str contains sub`(
      { input: [z.string, z.string], output: [z.boolean] },
      (str, sub) => withInputProvenance([str, sub], bool(stringValue(str).includes(stringValue(sub)))),
    ),

    "string-append": symbol.native`string-append: concatenation of all string arguments`(
      { input: [], inputRest: z.string, output: [z.union([z.string, z.string])] },
      // Collapsing op: the result inherits lineage from every input — and DEEP, so a
      // nested structure (a list/vector/array of inference-stamped values) is hoisted,
      // not just the top-level AValue args. Without this, `(string-append prefix
      // (join "" parts))` forgets where `parts` came from. See provenance-collapse.ts.
      (...strs) => taintString(strs.map(stringValue).join(""), collapseProvenance(...strs)),
    ),

    "string->list": symbol.native`string->list: list of the string's characters`(
      {
        input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()],
        output: [z.union([z.pair, z.nil])],
      },
      (str, start, end) => {
        const chars = [...stringValue(str)];
        const startIdx = start === undefined ? 0 : toIndex(start);
        const endIdx = end === undefined ? chars.length : toIndex(end);
        let result: AListAlike = nil;
        for (let i = endIdx - 1; i >= startIdx; i--)
          result = new APair(CONSTANT_CTX, new ACharacter(CONSTANT_CTX, chars[i]), result);
        return result;
      },
    ),

    "list->string": symbol.native`list->string: string built from a list of characters`(
      { input: [z.union([z.pair, z.nil])], output: [z.string] },
      (list) => {
        const chars: string[] = [];
        let current: SchemeValue = list;
        while (current && current !== nil && current instanceof APair) {
          chars.push(charValue(current.car));
          current = current.cdr;
        }
        return new AString(CONSTANT_CTX, chars.join(""));
      },
    ),

    "string-copy": symbol.native`string-copy: a fresh copy of the string (or slice)`(
      { input: [z.string, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.string] },
      (str, start, end) => {
        const chars = [...stringValue(str)];
        const startIdx = start === undefined ? 0 : toIndex(start);
        const endIdx = end === undefined ? chars.length : toIndex(end);
        // The copy is a fresh allocation but semantically the same lineage as `str`
        // (start/end indices don't carry meaning here, they shape the slice).
        return withInputProvenance([str], new AString(CONSTANT_CTX, chars.slice(startIdx, endIdx).join("")));
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
      (str) => withInputProvenance([str], new AString(CONSTANT_CTX, stringValue(str).toUpperCase())),
    ),

    "string-downcase": symbol.native`string-downcase: lowercase form of the string`(
      { input: [z.string], output: [z.string] },
      (str) => withInputProvenance([str], new AString(CONSTANT_CTX, stringValue(str).toLowerCase())),
    ),

    "string-foldcase": symbol.native`string-foldcase: case-folded form of the string`(
      { input: [z.string], output: [z.string] },
      (str) => withInputProvenance([str], new AString(CONSTANT_CTX, foldCase(stringValue(str)))),
    ),

    // proc is the fixed HEAD; the spread strings are the variadic TAIL (inputRest) — mirrors
    // apply's head/rest split. The head is the established callable-schema convention
    // (z.custom<(...args) => T>(), matching vector-map/vector-for-each/curry), and the rest
    // is z.string (this file's own string-identity schema) rather than the
    // representation-blind z.value the old contract used. Once the declared signature
    // properly types the params, the old manual `const [proc, ...strings] = args as [...]`
    // destructure-and-cast is redundant — proc/strings arrive as real typed parameters.
    "string-map": symbol.native`string-map: map a procedure across the strings' characters`(
      // The z.custom callable head collapses signatureOf to the catch-all `(...args: unknown[])
      // => unknown` (losing the `string[]` rest + the string return). `type` author-asserts the
      // real shape (callable → `(...args: unknown[]) => unknown`; the rest harvests z.string
      // as `string`), same convention as the sibling srfi curry/find overrides.
      {
        input: [z.lambda],
        inputRest: z.string,
        output: [z.string],
        type: "(proc: (...args: unknown[]) => unknown, ...strings: string[]) => string",
        // callbackRoles DECLARED (docs/PROVENANCE.md §2, Q4): the host is role `pipe`
        // (string-map was never a declared fan — Q2 migrated only map/filter/vector-map's
        // `fanout` booleans), so the fan default can't fire and shape underdetermines.
        // proc's return BECOMES the output character — `element-transformer`.
        callbackRoles: ["element-transformer"],
      },
      function (this: CallCtx, proc: unknown, ...strings: AString[]) {
        invariant(strings.length > 0, "string-map: expected at least one string");
        const runCtx = this.runCtx;
        const strs = strings.map(stringValue);
        const minLen = Math.min(...strs.map((s) => s.length));
        const results: unknown[] = [];
        for (let i = 0; i < minLen; i++) {
          // Seam-routed: `proc` is a callable VALUE now, not a bare fn.
          results.push(applyCallback(proc, strs.map((s) => new ACharacter(CONSTANT_CTX, s[i])), runCtx));
        }
        const join = (chars: unknown[]) =>
          new AString(
            CONSTANT_CTX,
            chars.map((c) => (c instanceof ACharacter ? charValue(c) : typeof c === "string" ? c : String(c))).join(""),
          );
        // proc may be an async membrane callback → await before joining, so the result
        // is a real string, not "[object Promise][object Promise]…" (see vector-map).
        if (results.some(is_promise)) {
          return (promise_all(results) as Promise<unknown[]>).then(join);
        }
        return join(results);
      },
    ),

    // Same head/rest migration as string-map above (callable head, z.string rest);
    // the manual destructure-and-cast is likewise redundant once the signature is typed.
    "string-for-each": symbol.native`string-for-each: apply a procedure across the strings' characters`(
      // Same degrade + author-assertion as string-map (the for-effect twin) → `void` (R7RS
      // unspecified; bare `void` as in env/core/core.ts's own hand-written type).
      {
        input: [z.lambda],
        inputRest: z.string,
        output: [z.undefinedResult],
        type: "(proc: (...args: unknown[]) => unknown, ...strings: string[]) => void",
      },
      function (this: CallCtx, proc: unknown, ...strings: AString[]): AVoid | Promise<AVoid> {
        invariant(strings.length > 0, "string-for-each: expected at least one string");
        const runCtx = this.runCtx;
        const strs = strings.map(stringValue);
        const minLen = Math.min(...strs.map((s) => s.length));
        const pending: unknown[] = [];
        for (let i = 0; i < minLen; i++) {
          const ret = applyCallback(proc, strs.map((s) => new ACharacter(CONSTANT_CTX, s[i])), runCtx);
          if (is_promise(ret)) pending.push(ret);
        }
        // R7RS "unspecified" is theVoid on the scheme face (was a bare JS undefined).
        if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => theVoid);
        return theVoid;
      },
    ),

    // ---------------------------------------------------------------------
    // `concat`/`join` are LIPS-era names, kept as extensions (`split` is NOT bound
    // in this pack — `string-split` lives in srfi-13.ts); `substring`
    // and `string->number` are genuine R7RS. `native` means the (identity) zod
    // contract never runs — the impls receive Scheme values directly.
    // ---------------------------------------------------------------------
    substring: symbol.native`substring: the slice of the string between start and end`(
      { input: [z.string, z.schemeNumber, z.schemeNumber.optional()], output: [z.string] },
      (string, start, end) => {
        // `string` is an AString (grafted String.prototype), the indices AExact/AInexact —
        // unwrap to the JS string + numeric indices the slice operates on (byte-identical to
        // the old `string.substring(start.valueOf(), end?.valueOf())`). `substring(s,
        // undefined)` means "to the end", so a missing `end` stays undefined.
        return new AString(
          CONSTANT_CTX,
          stringValue(string).substring(
            Number(coerceNumeric(start).valueOf()),
            end === undefined ? undefined : Number(coerceNumeric(end).valueOf()),
          ),
        );
      },
    ),

    concat: symbol.rosetta`concat: the concatenation of all string arguments (LIPS extension)`(
      { input: [z.string], inputRest: z.string, output: [z.string] },
      (...args) => args.join(""),
    ),

    join: symbol.native`join: the list elements folded to one string with a separator (LIPS extension)`(
      { input: [z.string, z.union([z.pair, z.nil])], output: [z.union([z.string, z.string])] },
      (separator: SchemeValue, list: SchemeValue): AString => {
        // Collapsing op: fold the list to one string, then re-stamp the DEEP union of
        // every element's lineage (+ the separator's) — else `(join sep inferred-list)`
        // strips the provenance the trace wires on. See provenance-collapse.ts.
        const joined = to_array("list->array")(list).join(stringValue(separator));
        return taintString(String(joined), collapseProvenance(separator, list));
      },
    ),

    "string->number": symbol.native`string->number: parse the string as a number, or #f (R7RS)`(
      { input: [z.string, z.number.optional()], output: [z.union([z.number, z.boolean])] },
      (arg, radix) => {
        // `arg` is an AString, `radix` an AExact/AInexact (or absent → base 10) — unwrap
        // to the JS string + number the regex tests and parse_* helpers consume (byte-identical
        // to the old `arg = arg.valueOf(); radix = radix.valueOf()`).
        const str = stringValue(arg);
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
  },
});

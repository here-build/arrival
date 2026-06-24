/**
 * String ops — the R7RS § 6.7 string cluster, carved VERBATIM out of
 * `wrappedOps` in `../bridge.ts`. These are behavior-preserving copies of the
 * interpreter's string constructors, accessors, comparisons (case-sensitive and
 * case-insensitive), append, list conversions, copy/slice, case conversion, and
 * the higher-order `string-map` / `string-for-each`. The only change from the
 * bridge originals is that cross-cutting helpers (`assertAllocatable`,
 * `charValue`, `coerceNumeric`, `deriveOrd`, `stringValue`, `toIndex`,
 * `withInputProvenance`, and the provenance collapse pair `collapseProvenance` /
 * `taintString`) are imported rather than referenced as bridge locals. The
 * implementations — including inline comments — are otherwise identical to the
 * source. (`number->string` deliberately stays in the bridge.)
 *
 * MIGRATED to the `symbol.native` API: each op declares a SCHEME-IDENTITY zod
 * contract (no codec, no validation — "zod for TYPES purely") and an impl bound
 * raw, exactly as the old `{ value }` form was. Native means the schema choice
 * cannot change runtime behavior; the bodies are reproduced byte-for-byte.
 */

import foldCase from "fold-case";
import invariant from "tiny-invariant";

import * as z from "./scheme-zod.js";
import { symbol } from "./symbol.js";
import {
  assertAllocatable,
  charValue,
  coerceNumeric,
  deriveOrd,
  stringValue,
  toIndex,
  withInputProvenance,
} from "../values/op-helpers.js";
import { collapseProvenance, taintString } from "../provenance-collapse.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/numbers.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { is_promise } from "../eval/guards.js";
import { promise_all } from "../utils/promises.js";
import { EnvCapability } from "./capability.js";

export default new EnvCapability("scheme/strings", {
  symbols: {
    "make-string": symbol.native`make-string: a string of k copies of a fill character`(
      { input: [z.schemeNumber, z.schemeChar.optional()], output: [z.schemeString] },
      (k: unknown, char?: unknown): AString => {
        const len = Number(coerceNumeric(k).valueOf());
        // O(1) cap check BEFORE `.repeat(len)` allocates — see assertAllocatable.
        assertAllocatable(len, "make-string");
        const c = char ? charValue(char) : "\u0000";
        // Both the length and (when present) the filling char contribute lineage —
        // `(make-string n user-char)` should remember user-char as a source even
        // though the length is what dictates the result's size.
        return withInputProvenance(char === undefined ? [k] : [k, char], new AString(c.repeat(len)));
      },
    ),

    string: symbol.native`string: a string built from the character arguments`(
      { input: z.array(z.unknown()), output: [z.schemeString] },
      (...chars: unknown[]): AString => {
        // Union of every character argument — same shape as `vector` below.
        return withInputProvenance(chars, new AString(chars.map(charValue).join("")));
      },
    ),

    "string-length": symbol.native`string-length: number of characters in the string`(
      { input: [z.schemeString], output: [z.schemeExact] },
      (str: unknown): AExact => {
        return withInputProvenance([str], new AExact(BigInt([...stringValue(str)].length)));
      },
    ),

    "string-ref": symbol.native`string-ref: the character at index k`(
      { input: [z.schemeString, z.schemeNumber], output: [z.schemeChar] },
      (str: unknown, k: unknown): ACharacter => {
        const idx = Number(coerceNumeric(k).valueOf());
        return withInputProvenance([str, k], new ACharacter([...stringValue(str)][idx]));
      },
    ),

    // string-set! / string-fill! — OMITTED by the purity invariant (frozen
    // entities); doored in core.ts. See plan-2026-06-11-purity-pass.

    // String comparison
    "string=?": symbol.native`string=?: typed equivalence over strings`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...strs: unknown[]): boolean => {
        let verdict = true;
        if (strs.length >= 2) {
          const first = stringValue(strs[0]);
          verdict = strs.slice(1).every((s) => stringValue(s) === first);
        }
        return withInputProvenance(strs, verdict);
      },
    ),

    // string</>/<=/>= derive from SchemeString's fantasy-land/lte (wave-1 Ord) via
    // the shared deriveOrd chain — same adapter as the char family.
    "string<?": symbol.native`string<?: strictly-increasing string order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd("<"),
    ),
    "string>?": symbol.native`string>?: strictly-decreasing string order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd(">"),
    ),
    "string<=?": symbol.native`string<=?: non-decreasing string order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd("<="),
    ),
    "string>=?": symbol.native`string>=?: non-increasing string order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      deriveOrd(">="),
    ),

    // Case-insensitive string comparison
    "string-ci=?": symbol.native`string-ci=?: case-insensitive string equivalence`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...strs: unknown[]): boolean => {
        let verdict = true;
        if (strs.length >= 2) {
          const first = stringValue(strs[0]).toLowerCase();
          verdict = strs.slice(1).every((s) => stringValue(s).toLowerCase() === first);
        }
        return withInputProvenance(strs, verdict);
      },
    ),

    "string-ci<?": symbol.native`string-ci<?: case-insensitive strictly-increasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...strs: unknown[]): boolean => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() >= stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, verdict);
      },
    ),

    "string-ci>?": symbol.native`string-ci>?: case-insensitive strictly-decreasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...strs: unknown[]): boolean => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() <= stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, verdict);
      },
    ),

    "string-ci<=?": symbol.native`string-ci<=?: case-insensitive non-decreasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...strs: unknown[]): boolean => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() > stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, verdict);
      },
    ),

    "string-ci>=?": symbol.native`string-ci>=?: case-insensitive non-increasing order`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...strs: unknown[]): boolean => {
        let verdict = true;
        for (let i = 0; i < strs.length - 1; i++) {
          if (stringValue(strs[i]).toLowerCase() < stringValue(strs[i + 1]).toLowerCase()) {
            verdict = false;
            break;
          }
        }
        return withInputProvenance(strs, verdict);
      },
    ),

    // Substring search. `string-contains` is SRFI-13: the index of the first
    // occurrence of `sub` in `str`, or #f when absent. (#f is the ONLY false value
    // in Scheme — an index of 0 is truthy — so `(if (string-contains h n) …)` reads
    // naturally.) `string-contains?` is the boolean predicate the same way `member?`
    // pairs with `member`. Both carry the lineage of the strings they searched, so a
    // "this name contains 'Alloy'" decision over an evidence read stays grounded.
    "string-contains": symbol.native`string-contains: index of the first occurrence of sub, or #f`(
      { input: [z.schemeString, z.schemeString], output: [z.union([z.schemeExact, z.boolean])] },
      (str: unknown, sub: unknown): AExact | boolean => {
        const i = stringValue(str).indexOf(stringValue(sub));
        return withInputProvenance([str, sub], i < 0 ? false : new AExact(BigInt(i)));
      },
    ),

    "string-contains?": symbol.native`string-contains?: #t iff str contains sub`(
      { input: [z.schemeString, z.schemeString], output: [z.boolean] },
      (str: unknown, sub: unknown): boolean => {
        return withInputProvenance([str, sub], stringValue(str).includes(stringValue(sub)));
      },
    ),

    "string-append": symbol.native`string-append: concatenation of all string arguments`(
      { input: z.array(z.unknown()), output: [z.union([z.string, z.schemeString])] },
      (...strs: unknown[]): string | AString => {
        // Collapsing op: the result inherits lineage from every input — and DEEP, so a
        // nested structure (a list/vector/array of inference-stamped values) is hoisted,
        // not just the top-level AValue args. Without this, `(string-append prefix
        // (join "" parts))` forgets where `parts` came from. See provenance-collapse.ts.
        return taintString(strs.map(stringValue).join(""), collapseProvenance(...strs));
      },
    ),

    "string->list": symbol.native`string->list: list of the string's characters`(
      { input: [z.schemeString, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.unknown()] },
      (str: unknown, start?: unknown, end?: unknown): unknown => {
        const chars = [...stringValue(str)];
        const startIdx = start === undefined ? 0 : toIndex(start);
        const endIdx = end === undefined ? chars.length : toIndex(end);
        let result: unknown = nil;
        for (let i = endIdx - 1; i >= startIdx; i--) result = new APair(new ACharacter(chars[i]), result);
        return result;
      },
    ),

    "list->string": symbol.native`list->string: string built from a list of characters`(
      { input: [z.unknown()], output: [z.schemeString] },
      (list: unknown): AString => {
        const chars: string[] = [];
        let current = list;
        while (current && current !== nil && current instanceof APair) {
          chars.push(charValue(current.car));
          current = current.cdr;
        }
        return new AString(chars.join(""));
      },
    ),

    "string-copy": symbol.native`string-copy: a fresh copy of the string (or slice)`(
      { input: [z.schemeString, z.schemeNumber.optional(), z.schemeNumber.optional()], output: [z.schemeString] },
      (str: unknown, start?: unknown, end?: unknown): AString => {
        const chars = [...stringValue(str)];
        const startIdx = start === undefined ? 0 : toIndex(start);
        const endIdx = end === undefined ? chars.length : toIndex(end);
        // The copy is a fresh allocation but semantically the same lineage as `str`
        // (start/end indices don't carry meaning here, they shape the slice).
        return withInputProvenance([str], new AString(chars.slice(startIdx, endIdx).join("")));
      },
    ),

    // string-copy! — OMITTED by the purity invariant (mutates its destination);
    // doored in core.ts. The non-mutating `string-copy` stays.

    // Case conversion for strings — case is a presentation transform, not a
    // new origin; inherit the source's lineage so downstream `define` of the
    // result still traces to the original infer/query call.
    "string-upcase": symbol.native`string-upcase: uppercase form of the string`(
      { input: [z.schemeString], output: [z.schemeString] },
      (str: unknown): AString => {
        return withInputProvenance([str], new AString(stringValue(str).toUpperCase()));
      },
    ),

    "string-downcase": symbol.native`string-downcase: lowercase form of the string`(
      { input: [z.schemeString], output: [z.schemeString] },
      (str: unknown): AString => {
        return withInputProvenance([str], new AString(stringValue(str).toLowerCase()));
      },
    ),

    "string-foldcase": symbol.native`string-foldcase: case-folded form of the string`(
      { input: [z.schemeString], output: [z.schemeString] },
      (str: unknown): AString => {
        return withInputProvenance([str], new AString(foldCase(stringValue(str))));
      },
    ),

    "string-map": symbol.native`string-map: map a procedure across the strings' characters`(
      { input: z.array(z.unknown()), output: [z.string] },
      (...args: unknown[]): string | Promise<string> => {
        const [proc, ...strings] = args as [(...args: unknown[]) => unknown, ...unknown[]];
        invariant(strings.length > 0, "string-map: expected at least one string");
        const strs = strings.map(stringValue);
        const minLen = Math.min(...strs.map((s) => s.length));
        const results: unknown[] = [];
        for (let i = 0; i < minLen; i++) {
          results.push(proc(...strs.map((s) => new ACharacter(s[i]))));
        }
        const join = (chars: unknown[]) =>
          chars
            .map((c) => (c instanceof ACharacter ? charValue(c) : typeof c === "string" ? c : String(c)))
            .join("");
        // proc may be an async membrane callback → await before joining, so the result
        // is a real string, not "[object Promise][object Promise]…" (see vector-map).
        if (results.some(is_promise)) {
          return (promise_all(results) as Promise<unknown[]>).then(join);
        }
        return join(results);
      },
    ),

    "string-for-each": symbol.native`string-for-each: apply a procedure across the strings' characters`(
      { input: z.array(z.unknown()), output: [z.void()] },
      (...args: unknown[]): void | Promise<void> => {
        const [proc, ...strings] = args as [(...args: unknown[]) => unknown, ...unknown[]];
        invariant(strings.length > 0, "string-for-each: expected at least one string");
        const strs = strings.map(stringValue);
        const minLen = Math.min(...strs.map((s) => s.length));
        const pending: unknown[] = [];
        for (let i = 0; i < minLen; i++) {
          const ret = proc(...strs.map((s) => new ACharacter(s[i])));
          if (is_promise(ret)) pending.push(ret);
        }
        if (pending.length > 0) return (promise_all(pending) as Promise<unknown[]>).then(() => undefined);
      },
    ),
  },
});

// SRFI-13 — string library completion. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via allSrfi) and evals it
// (via initBridge's assembleEnv), so this module is the sole definition site.
//
// WHY: the base env already binds the SRFI-13 verbs `string-contains` and the
// R7RS case trio (`string-upcase` …) in `scheme/strings` — a model seeing those
// correctly extrapolates to the REST of the standard string library, then crashes
// on `Unbound variable 'string-split'`. This pack completes the platform's grain:
// the SRFI-13 subset agents actually reach for (predicates, slices, trim/pad,
// index/count, join/tokenize) plus SRFI-152's `string-split` (the #1 miss).
//
// SCOPE NARROWING (honest deltas from full SRFI-13):
//   • criteria are a CHAR or a one-arg PREDICATE — SRFI-13 char-sets are not
//     bound here (no charset type in this scheme), documented per-symbol;
//   • no optional start/end index arguments (use `substring` first);
//   • `string-split` is SRFI-152, not SRFI-13 — bound here because it is the
//     most-reached-for missing symbol; its docstring says so.
//
// PROVENANCE discipline mirrors `scheme/strings`: booleans/indices/counts derived
// from inputs stamp `withInputProvenance`; sliced/derived strings stamp the source
// string's lineage; the COLLAPSING op (`string-join`) re-stamps the DEEP union via
// `taintString(collapseProvenance(…))` (see string-append's comment); the SPLITTING
// ops (`string-split` / `string-tokenize`) taint EACH piece with the source's
// lineage so list elements stay grounded.

import invariant from "tiny-invariant";
import { type } from "../../utils/typecheck.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { applyCallback } from "../../values/primitives/ACallable.js";
import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { assertAllocatable, charValue, schemeBool, stringValue, toIndex, withInputProvenance } from "../../values/op-helpers.js";
import { type ABool } from "../../values/primitives/ABool.js";
import { collapseProvenance, taintString } from "../../provenance-collapse.js";
import { AString } from "../../values/primitives/AString.js";
import { AExact } from "../../values/primitives/AExact.js";
import { APair, isCircularList } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { is_false, is_promise } from "../../eval/guards.js";
import { promise_all } from "../../utils/promises.js";
import { heapBudgetMessage } from "../../heap-budget.js";
import { ArrivalError } from "../../eval/evaluator.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import type { AProcedure, SchemeValue } from "../../values/types.js";

// Pack-local copy of the list→array bridge helper `string-join` needs — byte-identical
// to the strings.ts/lists.ts copies (incl. the per-run heap-meter charge at the
// collection choke); pack isolation forbids a cross-pack import.
function to_array(name: string): (list: SchemeValue) => SchemeValue[] {
  return function recur(list: SchemeValue): SchemeValue[] {
    if (list instanceof ANil) {
      return [];
    }
    invariant(list instanceof APair, `${name}: can't convert a non-list`);
    invariant(!isCircularList(list), `${name}: can't convert a circular list`);
    // Heap meter off the operand's ctx — the designed operand-ctx read (RunContext.ts),
    // replacing the retired `currentRunEnv()` env back-channel.
    const meter = ctxOf(list).heapMeter;
    const result: SchemeValue[] = [];
    let node: unknown = list;
    while (true) {
      if (node instanceof APair) {
        if (node.have_cycles("cdr")) {
          break;
        }
        const car = node.car;
        result.push(car);
        if (meter !== undefined && ++meter.used > meter.max) {
          throw new ArrivalError(heapBudgetMessage(meter.max), []);
        }
        node = node.cdr;
      } else {
        invariant(node instanceof ANil, `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}

// ── criterion machinery ──────────────────────────────────────────────────────
// SRFI-13 criteria: we honestly support a CHAR (equality) or a ONE-ARG PREDICATE
// (a scheme callable, invoked exactly the way srfi-1's `find` invokes its matcher —
// truthiness is `!is_false && !is_nil`, and an async membrane callback is awaited).
// SRFI-13 char-sets are NOT supported (no charset type here).

const isWhitespace = (c: string): boolean => /\s/u.test(c);

/** Per-character match flags for a criterion; a promise when the predicate is async. */
function criterionFlags(
  criterion: unknown,
  chars: readonly string[],
): boolean[] | Promise<boolean[]> {
  if (criterion instanceof ACharacter) {
    const ch = charValue(criterion);
    return chars.map((c) => c === ch);
  }
  // Seam-routed: the criterion predicate is a callable VALUE now, not a bare fn.
  const results = chars.map((c) => applyCallback(criterion, [new ACharacter(CONSTANT_CTX, c)], CONSTANT_CTX));
  const collapse = (rs: unknown[]) => rs.map((v) => !is_false(v) && !(v instanceof ANil));
  // pred may be an async membrane callback → await before deciding (see string-map).
  if (results.some(is_promise)) {
    return (promise_all(results) as Promise<unknown[]>).then(collapse);
  }
  return collapse(results);
}

/** Sync-or-async continuation over the flags — keeps every op's happy path synchronous. */
function afterFlags<T>(flags: boolean[] | Promise<boolean[]>, fn: (f: boolean[]) => T): T | Promise<T> {
  return is_promise(flags) ? (flags as Promise<boolean[]>).then(fn) : fn(flags as boolean[]);
}

/** Shared body of the trim trio — `side` picks which end(s) shed matching chars. */
function trimImpl(name: string, side: "both" | "left" | "right") {
  return (str: unknown, criterion?: unknown): AString | Promise<AString> => {
    const chars = [...stringValue(str)];
    // Default criterion: whitespace (SRFI-13's char-set:whitespace, sans charsets).
    const flags = criterion === undefined ? chars.map(isWhitespace) : criterionFlags(criterion, chars);
    return afterFlags(flags, (f) => {
      let start = 0;
      let end = chars.length;
      if (side !== "right") while (start < end && f[start]) start++;
      if (side !== "left") while (end > start && f[end - 1]) end--;
      // A trim is a slice — same lineage rule as string-copy (the criterion shapes
      // the slice, but a char criterion is still a value input; include it).
      return withInputProvenance(
        criterion === undefined ? [str] : [str, criterion],
        new AString(CONSTANT_CTX, chars.slice(start, end).join("")),
      );
    });
  };
}

/** Shared body of take/drop and their -right twins — n out of range is an error (SRFI-13). */
function sliceImpl(name: string, pick: (chars: string[], k: number) => string[]) {
  return (str: unknown, n: unknown): AString => {
    const chars = [...stringValue(str)];
    const k = toIndex(n);
    invariant(
      Number.isInteger(k) && k >= 0 && k <= chars.length,
      `${name}: index ${k} out of range for a string of length ${chars.length}`,
    );
    // A slice — same lineage rule as string-copy (n shapes the slice, no meaning of its own).
    return withInputProvenance([str], new AString(CONSTANT_CTX, pick(chars, k).join("")));
  };
}

export default new EnvCapability("scheme/srfi-13", {
  symbols: {
    "string-null?": symbol.native`string-null?: #t iff the string is empty (SRFI-13)`(
      { input: [z.string], output: [z.boolean] },
      (str: unknown): ABool => {
        return withInputProvenance([str], schemeBool(stringValue(str).length === 0));
      },
    ),

    // SRFI-13 argument order: the AFFIX comes first — (string-prefix? prefix s).
    "string-prefix?": symbol.native`string-prefix?: #t iff s starts with prefix — (string-prefix? prefix s) (SRFI-13)`(
      { input: [z.string, z.string], output: [z.boolean] },
      (prefix: unknown, str: unknown): ABool => {
        return withInputProvenance([prefix, str], schemeBool(stringValue(str).startsWith(stringValue(prefix))));
      },
    ),

    "string-suffix?": symbol.native`string-suffix?: #t iff s ends with suffix — (string-suffix? suffix s) (SRFI-13)`(
      { input: [z.string, z.string], output: [z.boolean] },
      (suffix: unknown, str: unknown): ABool => {
        return withInputProvenance([suffix, str], schemeBool(stringValue(str).endsWith(stringValue(suffix))));
      },
    ),

    // Index-or-#f, like string-contains (#f is the ONLY false value — index 0 is truthy).
    "string-index":
      symbol.native`string-index: index of the first char matching a char or one-arg predicate, or #f (SRFI-13; no charsets)`(
        { input: [z.string, z.value], output: [z.union([z.bigint, z.boolean])] },
        (str: unknown, criterion: unknown): AExact | ABool | Promise<AExact | ABool> => {
          const chars = [...stringValue(str)];
          return afterFlags(criterionFlags(criterion, chars), (f) => {
            const i = f.indexOf(true);
            return withInputProvenance(
              [str, criterion],
              i === -1 ? schemeBool(false) : new AExact(CONSTANT_CTX, BigInt(i)),
            );
          });
        },
      ),

    "string-count":
      symbol.native`string-count: how many chars match a char or one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.value], output: [z.bigint] },
        (str: unknown, criterion: unknown): AExact | Promise<AExact> => {
          const chars = [...stringValue(str)];
          return afterFlags(criterionFlags(criterion, chars), (f) => {
            const n = f.reduce((acc, hit) => acc + (hit ? 1 : 0), 0);
            return withInputProvenance([str, criterion], new AExact(CONSTANT_CTX, BigInt(n)));
          });
        },
      ),

    "string-take":
      symbol.native`string-take: the first n characters of the string; n out of range is an error (SRFI-13)`(
        { input: [z.string, z.schemeNumber], output: [z.string] },
        sliceImpl("string-take", (chars, k) => chars.slice(0, k)),
      ),

    "string-drop":
      symbol.native`string-drop: the string without its first n characters; n out of range is an error (SRFI-13)`(
        { input: [z.string, z.schemeNumber], output: [z.string] },
        sliceImpl("string-drop", (chars, k) => chars.slice(k)),
      ),

    "string-take-right":
      symbol.native`string-take-right: the last n characters of the string; n out of range is an error (SRFI-13)`(
        { input: [z.string, z.schemeNumber], output: [z.string] },
        sliceImpl("string-take-right", (chars, k) => chars.slice(chars.length - k)),
      ),

    "string-drop-right":
      symbol.native`string-drop-right: the string without its last n characters; n out of range is an error (SRFI-13)`(
        { input: [z.string, z.schemeNumber], output: [z.string] },
        sliceImpl("string-drop-right", (chars, k) => chars.slice(0, chars.length - k)),
      ),

    "string-trim":
      symbol.native`string-trim: both ends shed of whitespace, or of chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.value.optional()], output: [z.string] },
        trimImpl("string-trim", "both"),
      ),

    "string-trim-left":
      symbol.native`string-trim-left: the left end shed of whitespace, or of chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.value.optional()], output: [z.string] },
        trimImpl("string-trim-left", "left"),
      ),

    "string-trim-right":
      symbol.native`string-trim-right: the right end shed of whitespace, or of chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        { input: [z.string, z.value.optional()], output: [z.string] },
        trimImpl("string-trim-right", "right"),
      ),

    // SRFI-13 pads to EXACTLY len: `string-pad` right-justifies (pads on the left,
    // TRUNCATES from the left when too long — keeps the string's tail);
    // `string-pad-right` left-justifies (pads/truncates on the right).
    "string-pad":
      symbol.native`string-pad: right-justified to exactly len — pads on the left with char (default space), truncates from the left when too long (SRFI-13)`(
        { input: [z.string, z.schemeNumber, z.char.optional()], output: [z.string] },
        (str: unknown, len: unknown, char?: unknown): AString => {
          const chars = [...stringValue(str)];
          const k = toIndex(len);
          // O(1) cap check BEFORE `.repeat` allocates — see assertAllocatable.
          assertAllocatable(k, "string-pad");
          const fill = char === undefined ? " " : charValue(char);
          const text =
            chars.length >= k ? chars.slice(chars.length - k).join("") : fill.repeat(k - chars.length) + chars.join("");
          // Like make-string: a present fill char contributes lineage; the length shapes only.
          return withInputProvenance(char === undefined ? [str] : [str, char], new AString(CONSTANT_CTX, text));
        },
      ),

    "string-pad-right":
      symbol.native`string-pad-right: left-justified to exactly len — pads on the right with char (default space), truncates on the right when too long (SRFI-13)`(
        { input: [z.string, z.schemeNumber, z.char.optional()], output: [z.string] },
        (str: unknown, len: unknown, char?: unknown): AString => {
          const chars = [...stringValue(str)];
          const k = toIndex(len);
          assertAllocatable(k, "string-pad-right");
          const fill = char === undefined ? " " : charValue(char);
          const text = chars.length >= k ? chars.slice(0, k).join("") : chars.join("") + fill.repeat(k - chars.length);
          return withInputProvenance(char === undefined ? [str] : [str, char], new AString(CONSTANT_CTX, text));
        },
      ),

    "string-reverse": symbol.native`string-reverse: a reversed copy of the string (SRFI-13)`(
      { input: [z.string], output: [z.string] },
      (str: unknown): AString => {
        return withInputProvenance([str], new AString(CONSTANT_CTX, [...stringValue(str)].reverse().join("")));
      },
    ),

    "string-join":
      symbol.native`string-join: the list of strings folded to one with a delimiter (default single space) (SRFI-13)`(
        {
          input: [z.union([z.pair, z.nil]), z.string.optional()],
          output: [z.union([z.string, z.string])],
          // scheme-zod has no element-typed list schema, so the list input is `z.value` (→ `unknown`)
          // and the output union images to the redundant `string | string`. Author-assert what the
          // impl proves by eye: it `to_array`s the input and typechecks each element is a string, and
          // folds to one string. `List<string>` (carriers.ts vocabulary) is the honest, informative image.
          type: "(list: List<string>, delimiter?: string) => string",
        },
        (list, delimiter) => {
          const parts = to_array("string-join")(list);
          const sep = delimiter === undefined ? " " : stringValue(delimiter);
          // Collapsing op: fold the list to one string, then re-stamp the DEEP union of
          // every element's lineage (+ the delimiter's) — see string-append/join.
          return taintString(parts.map(stringValue).join(sep), collapseProvenance(list, delimiter));
        },
      ),

    // NOTE the inversion vs trim: tokenize's criterion selects TOKEN chars (what to
    // KEEP), trim's selects what to SHED. Default: maximal non-whitespace runs.
    "string-tokenize":
      symbol.native`string-tokenize: the list of maximal runs of token chars — default non-whitespace, or chars matching a char/one-arg predicate (SRFI-13; no charsets)`(
        {
          input: [z.string, z.value.optional()],
          output: [z.value],
          // Output `z.value` images to `unknown`, but the impl `APair.fromArray`s the tokens — it
          // returns a proper list of token strings. Author-assert `List<string>`. criterion stays
          // `unknown` (a char OR a one-arg predicate — a char's `string` image would misread as "a
          // whole string"; the docstring teaches the domain), matching the sibling trim/index ops.
          type: "(str: string, criterion?: unknown) => List<string>",
        },
        (str: unknown, criterion?: unknown): APair | ANil | Promise<APair | ANil> => {
          const chars = [...stringValue(str)];
          const flags = criterion === undefined ? chars.map((c) => !isWhitespace(c)) : criterionFlags(criterion, chars);
          return afterFlags(flags, (f) => {
            // Splitting op: each token is a fresh derived string — taint each with the
            // source's lineage so list elements stay grounded (cf. string-split below).
            const prov = collapseProvenance(str, criterion);
            const tokens: (string | AString)[] = [];
            let current = "";
            for (const [i, char] of chars.entries()) {
              if (f[i]) {
                current += char;
              } else if (current !== "") {
                tokens.push(taintString(current, prov));
                current = "";
              }
            }
            if (current !== "") tokens.push(taintString(current, prov));
            return APair.fromArray(CONSTANT_CTX, tokens);
          });
        },
      ),

    // SRFI-152 (NOT SRFI-13 — string-split is absent there); bound in this pack anyway
    // because it is the #1 symbol models reach for after seeing string-contains.
    //
    // DIALECT PRECEDENT: Gauche, Guile, and MIT/GNU Scheme all accept a single
    // CHARACTER delimiter here (`(string-split "a,b,c" #\,)`), not just a string —
    // it is the idiom a model trained on those dialects reaches for by reflex, and
    // an MCP-Atlas error-corpus autopsy found it as a 9x-rate, cascade-seeding class
    // (`invariant-type-mismatch:string-split:expected-string-got-character`). Rather
    // than teach the string-only form, complete the grain: accept a character
    // delimiter, coerced to the single-char string it denotes — string-only
    // behavior (including the empty-subject/empty-list rule below) is unchanged.
    "string-split":
      symbol.native`string-split: the list of the string's pieces around a literal delimiter — a string, or a single character (Gauche/Guile/MIT accept a char delimiter too); empty string yields '() (SRFI-152)`(
        {
          input: [z.string, z.union([z.string, z.char])],
          output: [z.value],
          // Output `z.value` images to `unknown`, but the impl `APair.fromArray`s the pieces — a proper
          // list of strings (`List<string>`). The `string | char` delimiter images to the redundant
          // `string | string` (string and schemeChar both print `string`); the honest image is a
          // single `string` delimiter. Both recovered by the author assertion.
          type: "(str: string, delimiter: string) => List<string>",
        },
        (str, delimiter) => {
          const s = stringValue(str);
          // SRFI-152 refinement over plain JS `.split`: an empty subject is NO fields.
          if (s === "") return nil;
          // `symbol.native` contracts are TYPE-ONLY — never validated at runtime (native
          // doctrine: no codec, no validation). `stringValue`'s fallback (`String(x)`) would
          // silently coerce a non-string/char delimiter to SOME string instead of erroring, so
          // the type-mismatch door needs an explicit guard here.
          invariant(
            delimiter instanceof AString || delimiter instanceof ACharacter,
            () => `string-split: delimiter must be a string or character, got ${type(delimiter)}`,
          );
          const delimiterStr = delimiter instanceof ACharacter ? charValue(delimiter) : stringValue(delimiter);
          const prov = collapseProvenance(str, delimiter);
          return APair.fromArray(
            CONSTANT_CTX,
            s.split(delimiterStr).map((piece) => taintString(piece, prov)),
          );
        },
      ),
  },
});

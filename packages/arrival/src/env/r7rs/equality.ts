/**
 * Equality / identity predicates pack.
 *
 * Holds the R7RS equivalence-and-identity predicates extracted verbatim from
 * the interpreter's `wrappedOps` hot path: `boolean=?` and `symbol=?` (typed
 * equivalence over the boxed boolean/symbol towers), `equal?` (structural
 * recursion delegated to `structuralEqual`, the single representation-blind
 * equality home), and the `procedure?` type predicate. Op bodies are
 * reproduced byte-for-byte — this is a behavior-preserving mechanical
 * extraction.
 *
 * MIGRATED (Phase-1 pilot) to the `symbol.native` API: each op declares a zod
 * contract and an impl, replacing the inline `{ value }` form. Native means the
 * schemas are SCHEME-IDENTITY (no codec, no validation) — the impl IS the binding,
 * bound raw exactly as `{ value }` was, so the runtime behavior is unchanged. These
 * predicates are REPRESENTATION-BLIND by design (they accept a boxed SchemeBool /
 * SchemeSymbol OR a raw JS value that arrived via rosetta unwrapping — see
 * equality-representation.test.ts), so the honest input term is `z.unknown()`, and the
 * honest output is the `z.boolean` codec (DECODED type `boolean`) — the impl returns a JS
 * boolean, which native binds
 * and returns raw — downstream `structuralEqual` treats `true ≡ SchemeBool(true)`).
 *
 * ALSO HOLDS the R7RS TYPE predicates `string?` / `pair?` / `null?` / `boolean?` /
 * `symbol?` / `list?` — relocated VERBATIM from the legacy `stdlib.ts` global_env as
 * the stdlib-elimination POC. These are the value-domain-agnostic type tests (a
 * string/pair/symbol test belongs with `procedure?`, not in any one cluster). Bodies
 * are reproduced byte-for-byte; `list?` inlines the proper-list-with-cycle-detection
 * walk (stdlib's `isProperList`) over the canonical `is_pair`/`is_nil`/`isCircularList`
 * primitives. (`number?` / `real?` stay OUT — the numbers pack already binds them.)
 */

import * as z from "../../common/scheme-zod.js";
import { symbol } from "../../common/symbol.js";
import { ABool } from "../../values/primitives/ABool.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { structuralEqual } from "../../values/structural-equal.js";
import { EnvCapability } from "../../common/capability.js";
import { is_callable, is_macro, is_null } from "../../eval/guards.js";
import { is_nil, is_pair } from "../../values/value-guards.js";
import { AString } from "../../values/primitives/AString.js";
import { isCircularList } from "../../values/primitives/APair.js";

export default new EnvCapability("scheme/equality", {
  symbols: {
    // R7RS 6.3 Booleans
    "boolean=?": symbol.native`boolean=?: typed equivalence over booleans`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...bools: unknown[]): boolean => {
        if (bools.length < 2) return true;
        // L1 boxes `#t` / `#f` as SchemeBool — unwrap before comparing, otherwise
        // `(boolean=? #t #t)` would compare two distinct singletons and pass, but
        // the type-guard one line up would already have rejected the schemeTrue
        // singleton as `typeof !== "boolean"`. Mirror `boolean?`'s post-L1 fix.
        const unwrap = (b: unknown): boolean | undefined => {
          if (typeof b === "boolean") return b;
          if (b instanceof ABool) return b.value;
          return undefined;
        };
        const first = unwrap(bools[0]);
        if (first === undefined) return false;
        return bools.every((b) => unwrap(b) === first);
      },
    ),

    // R7RS 6.5 Symbols
    "symbol=?": symbol.native`symbol=?: typed equivalence over symbols`(
      { input: z.array(z.unknown()), output: [z.boolean] },
      (...syms: unknown[]): boolean => {
        if (syms.length < 2) return true;
        const first = syms[0];
        if (!(first instanceof ASymbol)) return false;
        const firstName = first.__name__;
        return syms.every((s) => s instanceof ASymbol && s.__name__ === firstName);
      },
    ),

    "procedure?": symbol.native`procedure?: callable, excluding macros`(
      { input: [z.unknown()], output: [z.boolean] },
      // A procedure is any callable EXCEPT a macro — this includes a membrane SchemeJSFunction
      // (typeof "object"), which the old `typeof obj === "function"` test wrongly excluded.
      (obj: unknown): boolean => {
        return is_callable(obj) && !is_macro(obj);
      },
    ),

    "equal?": symbol.native`equal?: representation-blind structural equality`(
      { input: [z.unknown(), z.unknown()], output: [z.boolean] },
      (a: unknown, b: unknown): boolean => {
        return structuralEqual(a, b);
      },
    ),

    // ── R7RS type predicates (relocated from stdlib.ts global_env, POC) ──────────
    // Reproduced byte-for-byte from the legacy global_env defs. Representation-blind
    // like the equivalence predicates above: each accepts a boxed AValue OR a raw JS
    // value that crossed the rosetta membrane.
    "string?": symbol.native`string?: boxed-or-raw string test`(
      { input: [z.unknown()], output: [z.boolean] },
      // L1 boxes string literals as SchemeString; AString.isString accepts BOTH the
      // boxed SchemeString and a raw JS string (representation-blind).
      (obj: unknown): boolean => {
        return AString.isString(obj);
      },
    ),

    "pair?": symbol.native`pair?: cons-cell test`(
      { input: [z.unknown()], output: [z.boolean] },
      (obj: unknown): boolean => {
        return is_pair(obj);
      },
    ),

    "null?": symbol.native`null?: empty-list test`(
      { input: [z.unknown()], output: [z.boolean] },
      // is_null is nil OR JS null/undefined — matches the legacy global_env body exactly.
      (obj: unknown): boolean => {
        return is_null(obj);
      },
    ),

    "boolean?": symbol.native`boolean?: boxed-or-raw boolean test`(
      { input: [z.unknown()], output: [z.boolean] },
      // L1 boxes parser literals as SchemeBool — JS `typeof` no longer catches them.
      // Mirrors the `number?` / `string?` pattern of accepting both raw and boxed forms.
      (obj: unknown): boolean => {
        return typeof obj === "boolean" || obj instanceof ABool;
      },
    ),

    "symbol?": symbol.native`symbol?: interned-symbol test`(
      { input: [z.unknown()], output: [z.boolean] },
      (obj: unknown): boolean => {
        return obj instanceof ASymbol;
      },
    ),

    "list?": symbol.native`list?: proper-list test (cycle-safe)`(
      { input: [z.unknown()], output: [z.boolean] },
      // Reproduces stdlib's `isProperList` body verbatim: a circular list is NOT a
      // proper list (R7RS). Detect runtime cycles (have_cycles below only catches
      // reader #0= cycles).
      (obj: unknown): boolean => {
        if (is_pair(obj) && isCircularList(obj)) {
          return false;
        }
        let node: unknown = obj;
        while (true) {
          if (is_nil(node)) {
            return true;
          }
          if (!is_pair(node)) {
            return false;
          }
          if (node.have_cycles("cdr")) {
            return false;
          }
          node = node.cdr;
        }
      },
    ),
  },
});

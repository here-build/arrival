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
 * contract and an impl, replacing the inline `{ value }` form. Native means the impl
 * works on the contract's SCHEME face (`Impl<…,"scheme">` — each schema's `z.input`;
 * the Face projection split): a `z.boolean` output demands an ABool, so every
 * predicate returns the shared `schemeTrue`/`schemeFalse` FLYWEIGHTS (eq?-stable,
 * empty-provenance — the boxed twin of the raw `true`/`false` these impls returned
 * under the LIPS-legacy raw-bind reading; `structuralEqual` treats them identically).
 * Inputs stay REPRESENTATION-BLIND by design (a boxed SchemeBool / SchemeSymbol OR a
 * raw JS value that arrived via rosetta unwrapping — see
 * equality-representation.test.ts), so the honest input term is `z.value`.
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
import { ABool, schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AJSObject } from "../../values/primitives/AJSObject.js";
import { ADict, isDictShaped } from "../../values/primitives/ADict.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { eq, eqv, structuralEqual } from "../../values/structural-equal.js";
import { EnvCapability } from "../../common/capability.js";
import { is_callable, is_false, is_macro } from "../../eval/guards.js";
import { ANil } from "../../values/primitives/ANil.js";
import { AString } from "../../values/primitives/AString.js";
import { APair, isCircularList } from "../../values/primitives/APair.js";
import { schemeBool as bool, stringValue, withInputProvenance } from "../../values/op-helpers.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { printValue } from "../../values/print.js";

export default new EnvCapability("scheme/equality", {
  symbols: {
    // R7RS 6.3 Booleans
    "boolean=?": symbol.native`boolean=?: typed equivalence over booleans`(
      // Input stays z.value (representation-blind), NOT z.boolean — the impl's own unwrap()
      // below branches on raw JS boolean vs boxed ABool, so blindness is load-bearing here
      // (unlike symbol=?, a bare instanceof check with no such branch). `z.boolean`'s codec
      // `safeParse`s ONLY its scheme face (ABool instances) regardless of native/rosetta Face
      // projection — using it here would silently reject the raw-JS-boolean half the impl
      // genuinely accepts. Output stays z.boolean: the RETURN is always a real ABool (the
      // schemeBool flyweight), never representation-blind.
      { input: [z.value, z.value], inputRest: z.value, output: [z.boolean] },
      (...bools) => {
        if (bools.length < 2) return schemeTrue;
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
        if (first === undefined) return schemeFalse;
        return bool(bools.every((b) => unwrap(b) === first));
      },
    ),

    // R7RS 6.5 Symbols. Unlike `boolean=?` above, this is NOT representation-blind: the
    // impl only ever checks `instanceof ASymbol` (no raw-JS-symbol unwrap branch), and
    // symbols have no plain-JS counterpart in this language (no codec for them in
    // scheme-zod.ts, unlike string/boolean/char/number — see equality-representation.test.ts's
    // own "always boxed in practice" note for characters & symbols). So `z.symbol` (the SAME
    // identity primitive `symbol->string`/`string->symbol` below already use) is the honest
    // domain, not `z.value` — this is a precision fix, not a blindness removal.
    "symbol=?": symbol.native`symbol=?: typed equivalence over symbols`(
      { input: [z.symbol, z.symbol], inputRest: z.symbol, output: [z.boolean] },
      (...syms) => {
        if (syms.length < 2) return schemeTrue;
        const first = syms[0];
        if (!(first instanceof ASymbol)) return schemeFalse;
        const firstName = first.__name__;
        return bool(syms.every((s) => s instanceof ASymbol && s.__name__ === firstName));
      },
    ),

    // R7RS 6.5 — symbol/string conversion. NATIVE (below the membrane): they touch the
    // SchemeSymbol host type directly. Relocated VERBATIM from arrival-extensions (husk
    // dissolution) — genuine R7RS 6.5 base, just misfiled, so they join symbol=? here.
    // Provenance PLUMBING: forward the input's provenance via withInputProvenance, never mint.
    "symbol->string": symbol.native`symbol->string: the symbol's name as a string`(
      { input: [z.symbol], output: [z.string] },
      (s) => {
        const name = s.__name__;
        const str = typeof name === "string" ? name : (name as symbol).toString();
        return withInputProvenance([s], new AString(CONSTANT_CTX, str));
      },
    ),
    "string->symbol": symbol.native`string->symbol: a symbol whose name is the string's characters`(
      { input: [z.string], output: [z.symbol] },
      (s) => {
        // Mint with the INPUT's ctx (value-carries-ctx), not CONSTANT_CTX: a runtime
        // symbol then interns in its run's per-run table (heap-charged, GC'd at run end)
        // rather than the permanent global one — closing the `(string->symbol unique)` DoS.
        return withInputProvenance([s], new ASymbol(ctxOf(s), stringValue(s)));
      },
    ),

    "procedure?": symbol.native`procedure?: callable, excluding macros`(
      { input: [z.lambda], output: [z.boolean] },
      // A procedure is any callable EXCEPT a macro — this includes a membrane SchemeJSFunction
      // (typeof "object"), which the old `typeof obj === "function"` test wrongly excluded.
      (obj: unknown): ABool => {
        return bool(is_callable(obj) && !is_macro(obj));
      },
    ),

    // `repr` — the scheme surface of the value→string PRINT protocol (values/print.ts:
    // `printValue` dispatches each AValue's own `["arrival/print"]()`, the leaf handles the
    // non-AValue residual). Representation-blind and value-domain-agnostic — it renders ANY
    // value to its R7RS external representation — so it belongs here with the other
    // value-agnostic natives relocated VERBATIM from the legacy stdlib.ts global_env, not in
    // any one type cluster. The output is the `z.string` codec (decoded type `string`),
    // matching `printValue`'s JS-string return, bound raw exactly as the old `{ value }` form.
    // (DEFERRED: the 2-arg `(repr x write?)` write-mode form exists only in skipped schemeSpec
    // .scm and was never honored — the prior stub ignored the 2nd arg and `printValue` has no
    // write-mode flag. Matches the current 1-arg behavior.)
    repr: symbol.native`repr: render a value to its external representation string`(
      { input: [z.value], output: [z.string] },
      (obj): AString => new AString(CONSTANT_CTX, printValue(obj)),
    ),

    "equal?": symbol.native`equal?: representation-blind structural equality`(
      { input: [z.value, z.value], output: [z.boolean] },
      (a, b) => bool(structuralEqual(a, b)),
    ),

    // R7RS 6.1 equivalence — the pointer/scalar-grade identity predicates, relocated
    // VERBATIM from stdlib.ts global_env (husk dissolution). `eqv?` reduces to `eq?`
    // today (`eqv` = `eq` + explicit number/char equality, both already routed
    // through each scalar's Setoid inside `eq`); both delegate to the single
    // comparison home in `structural-equal.ts`. Representation-blind like the
    // equivalence predicates above.
    "eq?": symbol.native`eq?: pointer/scalar-grade identity`(
      { input: [z.value, z.value], output: [z.boolean] },
      (x, y) => bool(eq(x, y)),
    ),

    "eqv?": symbol.native`eqv?: eq? plus explicit number/char equality`(
      { input: [z.value, z.value], output: [z.boolean] },
      (x, y) => bool(eqv(x, y)),
    ),

    // R7RS 6.3 — logical negation, relocated VERBATIM from stdlib.ts global_env
    // (husk dissolution). Native pack (Phase 1) binds onto global_env BEFORE the
    // scheme/core prelude (Phase 2) that calls `not` at macro-define time, so the
    // move is load-order-safe.
    not: symbol.native`not: #t iff value is #f (the only scheme-falsy)`(
      { input: [z.value], output: [z.boolean] },
      // R7RS: only #f is falsy. Post-L1 `#f` parses to `SchemeBool(false)`
      // (a truthy object in JS), so `!value` would wrongly return false here.
      // `is_false` is the canonical scheme-falsy predicate (`guards.ts`).
      (value) => bool(is_false(value)),
    ),

    // ── R7RS type predicates (relocated from stdlib.ts global_env, POC) ──────────
    // Reproduced byte-for-byte from the legacy global_env defs. Representation-blind
    // like the equivalence predicates above: each accepts a boxed AValue OR a raw JS
    // value that crossed the rosetta membrane.
    "string?": symbol.native`string?: boxed-or-raw string test`(
      { input: [z.value], output: [z.boolean] },
      (obj) => bool(obj instanceof AString),
    ),

    // `(pair? x)` asks the receiver's own `arrival/tagless-final/pair?` (APair answers #t); the
    // guard's graceful default (#f) covers everything else — no `instanceof APair` reach-around.
    "pair?": symbol.taglessGuard`pair?: #t iff obj is a pair (cons cell)`,

    "null?": symbol.native`null?: empty-list test`(
      { input: [z.value], output: [z.boolean] },
      // The empty list is the ANil singleton (and its provenance clones). Raw JS
      // null/undefined no longer reach here — the membrane boxes JS null→nil and
      // undefined→theVoid before any value enters the language — so the legacy
      // global_env's `|| null || undefined` nullish tolerance is dissolved.
      (obj) => bool(obj instanceof ANil),
    ),

    "boolean?": symbol.native`boolean?: boxed-or-raw boolean test`(
      { input: [z.value], output: [z.boolean] },
      // L1 boxes parser literals as SchemeBool — JS `typeof` no longer catches them.
      // Mirrors the `number?` / `string?` pattern of accepting both raw and boxed forms.
      (obj) => bool(obj instanceof ABool),
    ),

    "symbol?": symbol.taglessGuard`symbol?: #t iff obj is an interned symbol`,

    // `dict?` — Racket's dict predicate, the missing counterpart to our native `{…}` /
    // `(dict …)` open-key map (polyglot.ts). We ship the type but had no predicate for
    // it — a genuine gap, not a design omission (see `env/polyglot-rich-errors/stubs.ts`'s
    // header for that distinction). A native dict is an `ADict` instance
    // (native-dict-provenance.md); the fallback below still recognizes a genuinely
    // foreign, dict-SHAPED `AJSObject` (or a bare plain-proto object) — same
    // `readMember` (membrane.ts) disambiguation, kept so a dict-shaped value from a
    // tool result still answers `dict?` without being an `ADict`. An array, a scalar,
    // or any other foreign class instance is not a dict.
    "dict?":
      symbol.native`dict?: #t iff obj is a dict — a native open-key record ({…} / (dict …)), not a list, string, vector, or foreign class instance`(
        { input: [z.value], output: [z.boolean] },
        (obj: unknown): ABool => {
          if (obj instanceof ADict) return schemeTrue;
          if (obj == null) return schemeFalse;
          const source = obj instanceof AJSObject ? obj.source : obj;
          return bool(isDictShaped(source));
        },
      ),

    "list?": symbol.native`list?: proper-list test (cycle-safe)`(
      { input: [z.value], output: [z.boolean] },
      // Reproduces stdlib's `isProperList` body verbatim: a circular list is NOT a
      // proper list (R7RS). Detect runtime cycles (have_cycles below only catches
      // reader #0= cycles).
      (obj) => {
        if (obj instanceof APair && isCircularList(obj)) {
          return schemeFalse;
        }
        let node: unknown = obj;
        while (true) {
          if (node instanceof ANil) {
            return schemeTrue;
          }
          if (!(node instanceof APair)) {
            return schemeFalse;
          }
          if (node.have_cycles("cdr")) {
            return schemeFalse;
          }
          node = node.cdr;
        }
      },
    ),
  },
});

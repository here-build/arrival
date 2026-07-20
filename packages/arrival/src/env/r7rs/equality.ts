/**
 * Equality / identity predicates pack: the R7RS equivalence-and-identity
 * predicates — `boolean=?` and `symbol=?` (typed equivalence over the boxed
 * boolean/symbol towers), `equal?` (structural recursion delegated to
 * `structuralEqual`, the single representation-blind equality home), and the
 * `procedure?` type predicate.
 *
 * Each op declares a zod contract and an impl working on the contract's SCHEME
 * face (`Impl<…,"scheme">`): a `z.boolean` output demands an ABool, so every
 * predicate returns the shared `schemeTrue`/`schemeFalse` FLYWEIGHTS (eq?-stable,
 * empty-provenance; `structuralEqual` treats them identically). Inputs stay
 * REPRESENTATION-BLIND by design (a boxed SchemeBool/SchemeSymbol OR a raw JS
 * value that arrived via rosetta unwrapping — see laws/equality.law.test.ts),
 * so the honest input term is `z.value`.
 *
 * ALSO HOLDS the R7RS TYPE predicates `string?` / `pair?` / `null?` / `boolean?` /
 * `symbol?` / `list?` — the value-domain-agnostic type tests (a string/pair/symbol
 * test belongs with `procedure?`, not in any one cluster). `list?` inlines the
 * proper-list-with-cycle-detection walk over the canonical `is_pair`/`is_nil`/
 * `isCircularList` primitives. (`number?`/`real?` stay OUT — the numbers pack
 * already binds them.)
 */

import * as z from "../../common/scheme-zod.js";
import { AJSArray } from "../../membrane/AJSArray.js";
import dedent from "dedent";
import { symbol, type CallCtx } from "../../common/symbol.js";
import { ABool, schemeFalse, schemeTrue } from "../../values/primitives/ABool.js";
import { AJSObject } from "../../membrane/AJSObject.js";
import { ADict, isDictShaped } from "../../values/primitives/ADict.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { eq, eqv, structuralEqual } from "../../values/structural-equal.js";
import { EnvCapability } from "../../common/capability.js";
import { is_callable, is_false, is_macro } from "../../eval/guards.js";
import { ANil } from "../../values/primitives/ANil.js";
import { AString } from "../../values/primitives/AString.js";
import { APair, isCircularList } from "../../values/primitives/APair.js";
import { schemeBool as bool, mintVerdict, stringValue, withInputProvenance } from "../../values/op-helpers.js";
import { ctxOf } from "../../values/primitives/AValue.js";
import { printValue } from "../../values/print.js";
import { SchemeValue } from "../../values/types.js";
// TYPE-ONLY, one-directional (`common/symbols` → `emit`; emit-rule.ts imports nothing
// back from this tree): the compiler-facing rule surface a Contract may carry.
// Constitution §4.1/§4.5 (arrival-ts-transpiler-design.md) + registry-emit.md.
import type { EmitCtx, EmitRule } from "../../emit/emit-rule.js";
import { Bin, Call, Lit, Member, Un, type R } from "../../emit/residual-lite.js";

// ════════════════════════════════════════════════════════════════════════════
// Contract.emit — THE PHASE-2 RELOCATION DRILL (constitution §9): not / null? /
// pair? move here from the compiler-side phase1 table (`inhuman/foundations/
// arrival-mercury/src/rules/phase1.ts`) onto their OWN Contract's `emit` field — the
// same pattern numeric.ts's quotient/modulo/=/+/-/*// relocation and lists.ts's cons
// relocation established. Residual shapes are BYTE-FOR-BYTE identical to the table
// rules they replace (verified by diffing against phase1.ts's pre-relocation
// `notRule`/`nullQRule`/`pairQRule`), built via `@inhuman.tools/arrival/emit`'s
// residual-lite constructors (§4.5's seed of "residual types belong in arrival core
// eventually").
//
// `null?`/`pair?` carry the FULL package deal (constitution §5.3/Law N): the
// `narrows`/`refPolicy` fields move WITH the rule, not just the residual shape — the
// harvest now carries them (`registry/harvest.ts`'s `toRow` reads any baked def's
// `emit`/`narrows`/`refPolicy` uniformly, capability-agnostic), so
// `narrowsMembersOf(registry)` still returns `{null?, pair?}` once the phase1 table
// row is deleted (verified: `withRules`' fallthrough to the harvested base row).
// `pair?` is a `tagless-guard` def (no `Contract` param to thread these through) —
// its fields land via the SAME declaration-site object-spread `type` already uses.
// ════════════════════════════════════════════════════════════════════════════

/** Fixed-arity refusal — verbatim relocation of phase1.ts's own `exactly` helper (see
 *  numeric.ts's own copy of this same helper for the full rationale). */
function exactly<T>(ctx: EmitCtx<R>, sym: string, args: readonly T[], n: number): readonly T[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

// ─── Law T: not ────────────────────────────────────────────────────────────────────────
// Constitution §5.2: `!c` when the operand is provably boolean, `c === false` otherwise
// (exact Scheme truthiness — only `#f` is false; `0`/`""` are truthy).
const notEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [c] = exactly(ctx, "not", args, 1);
    return ctx.config.register === "read" || ctx.argFacts[0]?.boolean === true
      ? Un("!", c!)
      : Bin("===", c!, Lit(false));
  },
};

// ─── null? / pair? — FACT-GATED .length reads, Law-N self-witnessed ──────────────────
// Both are TOTAL predicates over ANY value — which is exactly why the bare `.length`
// read was wrong-code, not a deferred hazard: a JS string carries `.length` too, so
// `(null? "")` compiled to `true` where the interpreter says `#f`. The fuzzer found
// it on its first run (narrows-{null,pair}-string-collision corpus rows). Law F
// applied properly: the clean `.length` form emits only when argFacts PROVE the
// array representation; anything unproven rides the stage-0 shim, whose
// Array.isArray test is the honest total semantics.
const provesArray = (f: { list?: true; pair?: true; nonEmptyList?: true } | undefined): boolean =>
  f?.list === true || f?.pair === true || f?.nonEmptyList === true;

const nullQEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "null?", args, 1);
    return provesArray(ctx.argFacts[0])
      ? Bin("===", Member(xs!, "length"), Lit(0))
      : Call(ctx.runtime("null?"), [xs!]);
  },
};

const pairQEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [xs] = exactly(ctx, "pair?", args, 1);
    return provesArray(ctx.argFacts[0])
      ? Bin(">", Member(xs!, "length"), Lit(0))
      : Call(ctx.runtime("pair?"), [xs!]);
  },
};

// ── equal? — the PRIMITIVE-proven gate, Law-A soundness line ────────────────────────
// `equal?` is DEEP structural equality (structuralEqual), not `===` — for a COMPOUND
// value (list/pair/vector), `===` is reference identity and would wrongly say `#f` for
// two structurally-equal-but-distinct cells (`(equal? '(1) '(1))` is `#t`; the two
// compiled arrays are NOT the same reference). So `===` may NEVER be the residual when
// BOTH sides could be compound.
//
// But when EITHER side provably decodes to a bare JS primitive (`numeric`/`stringy`/
// `boolean` — §3.3's ∀-over-union derivation, same nil-excluding guarantee the
// comparisons in numeric.ts lean on), `===` agrees with `equal?` for ANY value on the
// other side, proven or not: a primitive can only `equal?`-match a value of the SAME
// primitive JS type and value, which is exactly what `===` tests, and it can never
// `equal?`-match a compound value — `===` between a primitive and an object is always
// `false`, and `structuralEqual` between a scalar and a compound is always `false` too
// (a type mismatch, never a coincidental deep-equal). So ONE side proving primitive is
// sufficient, not both — the check below is deliberately asymmetric (`||`, not `&&`).
//
// UNPROVEN on both sides (the common case for two arbitrary list operands) → the
// runtime shim (`structuralEqual`'s real deep walk) — collapsing that to `===` would
// silently flip every reference-distinct-but-equal compound pair to `#f` (the exact bug
// this gate exists to prevent; see equality-emit.test.ts's discriminating pair).
const provesPrimitive = (f: { numeric?: true; stringy?: true; boolean?: true } | undefined): boolean =>
  f?.numeric === true || f?.stringy === true || f?.boolean === true;

const equalQEmitRule: EmitRule<R> = {
  call: (args, ctx) => {
    const [a, b] = exactly(ctx, "equal?", args, 2);
    return provesPrimitive(ctx.argFacts[0]) || provesPrimitive(ctx.argFacts[1])
      ? Bin("===", a!, b!)
      : Call(ctx.runtime("equal?"), [a!, b!]);
  },
};

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
      { input: [], inputRest: z.value, output: [z.boolean] },
      function (this: CallCtx, ...bools) {
        if (bools.length < 2) return schemeTrue;
        // L1 boxes `#t` / `#f` as SchemeBool — unwrap before comparing, otherwise
        // `(boolean=? #t #t)` would compare two distinct singletons and pass, but
        // the type-guard one line up would already have rejected the schemeTrue
        // singleton as `typeof !== "boolean"`. Mirror `boolean?`'s post-L1 fix.
        // Both representations are load-bearing here (the contract's own `z.value`
        // input + this file's header doc both still document "booleans cross the
        // rosetta membrane unboxed"), so a raw JS boolean must unwrap too, not just
        // a boxed ABool.
        const unwrap = (b: SchemeValue): boolean | undefined => {
          if (typeof b === "boolean") return b;
          if (b instanceof ABool) return b.value;
          return undefined;
        };
        const first = unwrap(bools[0]);
        if (first === undefined) return schemeFalse;
        return new ABool(
          this.runCtx,
          bools.every((b) => unwrap(b) === first),
        );
      },
    ),

    // R7RS 6.5 Symbols. Unlike `boolean=?` above, this is NOT representation-blind: the
    // impl only ever checks `instanceof ASymbol` (no raw-JS-symbol unwrap branch), and
    // symbols have no plain-JS counterpart in this language (no codec for them in
    // scheme-zod.ts, unlike string/boolean/char/number — see laws/equality.law.test.ts's
    // own "always boxed in practice" note for characters & symbols). So `z.symbol` (the SAME
    // identity primitive `symbol->string`/`string->symbol` below already use) is the honest
    // domain, not `z.value` — this is a precision fix, not a blindness removal.
    "symbol=?": symbol.native`symbol=?: typed equivalence over symbols`(
      { input: [z.symbol, z.symbol], inputRest: z.symbol, output: [z.boolean] },
      function (this: CallCtx, ...syms) {
        if (syms.length < 2) return schemeTrue;
        const first = syms[0];
        if (!(first instanceof ASymbol)) return schemeFalse;
        const firstName = first.__name__;
        return new ABool(
          this.runCtx,
          syms.every((s) => s instanceof ASymbol && s.__name__ === firstName),
        );
      },
    ),

    // R7RS 6.5 — symbol/string conversion. NATIVE (below the membrane): they touch the
    // SchemeSymbol host type directly, so they join symbol=? here.
    // Provenance PLUMBING: forward the input's provenance via withInputProvenance, never mint.
    "symbol->string": symbol.native`symbol->string: the symbol's name as a string`(
      { input: [z.symbol], output: [z.string] },
      function (s) {
        const name = s.__name__;
        const str = typeof name === "string" ? name : (name as symbol).toString();
        // Mirror string->symbol below: mint with the INPUT's ctx (ctxOf(s)), not
        // CONSTANT_CTX — the sibling conversion already gets this right.
        return withInputProvenance([s], new AString(ctxOf(s), str));
      },
    ),
    "string->symbol": symbol.native`string->symbol: a symbol whose name is the string's characters`(
      { input: [z.string], output: [z.symbol] },
      function (s) {
        // Mint with the INPUT's ctx (value-carries-ctx), not CONSTANT_CTX: a runtime
        // symbol then interns in its run's per-run table (heap-charged, GC'd at run end)
        // rather than the permanent global one — closing the `(string->symbol unique)` DoS.
        return withInputProvenance([s], new ASymbol(ctxOf(s), stringValue(s)));
      },
    ),

    "procedure?": symbol.native`procedure?: callable, excluding macros`(
      // Total type predicate: any value in, #f on non-callables. Dual type-guard harvest.
      { input: [z.value], output: [z.boolean], type: dedent`
          {
            (x: unknown): x is (...args: unknown[]) => unknown;
            <T>(x: T): x is Extract<T, (...args: unknown[]) => unknown>;
          }
        ` },
      // A procedure is any callable EXCEPT a macro — this includes a membrane SchemeJSFunction
      // (typeof "object"), which the old `typeof obj === "function"` test wrongly excluded.
      function (this: CallCtx, obj) { return new ABool(ctxOf(obj), is_callable(obj) && !is_macro(obj)); },
    ),

    // `repr` — the scheme surface of the value→string PRINT protocol (values/print.ts:
    // `printValue` dispatches each AValue's own `["arrival/print"]()`, the leaf handles the
    // non-AValue residual). Representation-blind and value-domain-agnostic — it renders ANY
    // value to its R7RS external representation — so it belongs here, not in any one type
    // cluster. (DEFERRED: the 2-arg `(repr x write?)` write-mode form is not honored —
    // `printValue` has no write-mode flag. Matches the current 1-arg behavior.)
    repr: symbol.native`repr: render a value to its external representation string`(
      { input: [z.value], output: [z.string] },
      function (this: CallCtx, obj) { return new AString(ctxOf(obj), printValue(obj)); },
    ),

    // R8 mint (RULINGS.md R8): a verdict derived from lineage carries it — stamped
    // operands union into the result, provenance-free operands still get `bool`'s
    // shared flyweight (mintVerdict's allocation-free path).
    "equal?": symbol.native`equal?: representation-blind structural equality`(
      // Compiler-facing (constitution §4.1) — the primitive-proven gate (see
      // `equalQEmitRule`'s own doc comment above for the full soundness argument).
      { input: [z.value, z.value], output: [z.boolean], emit: equalQEmitRule },
      function (this: CallCtx, a, b) { return mintVerdict([a, b], structuralEqual(a, b)); },
    ),

    // R7RS 6.1 equivalence — the pointer/scalar-grade identity predicates. `eqv?`
    // reduces to `eq?` today (`eqv` = `eq` + explicit number/char equality, both
    // already routed through each scalar's Setoid inside `eq`); both delegate to
    // the single comparison home in `structural-equal.ts`.
    "eq?": symbol.native`eq?: pointer/scalar-grade identity`(
      { input: [z.value, z.value], output: [z.boolean] },
      function (this: CallCtx, x, y) { return mintVerdict([x, y], eq(x, y)); },
    ),

    "eqv?": symbol.native`eqv?: eq? plus explicit number/char equality`(
      { input: [z.value, z.value], output: [z.boolean] },
      function (this: CallCtx, x, y) { return mintVerdict([x, y], eqv(x, y)); },
    ),

    // R7RS 6.3 — logical negation. This native pack binds onto global_env BEFORE
    // the scheme/core prelude that calls `not` at macro-define time, so the
    // binding order is load-order-safe.
    not: symbol.native`not: #t iff value is #f (the only scheme-falsy)`(
      // Compiler-facing (constitution §4.1) — the Phase-2 relocation drill.
      { input: [z.value], output: [z.boolean], emit: notEmitRule },
      // R7RS: only #f is falsy. Post-L1 `#f` parses to `SchemeBool(false)`
      // (a truthy object in JS), so `!value` would wrongly return false here.
      // `is_false` is the canonical scheme-falsy predicate (`guards.ts`).
      function (this: CallCtx, value) { return bool(is_false(value)); },
    ),

    // ── R7RS type predicates ──────────────────────────────────────────────────
    // Runtime: representation-blind (boxed AValue OR raw membrane value).
    // Harvest: dual type-guards (inline type:) — unknown arm + Extract arm so
    // `string | List<number>` keeps List<number> after list?, not List<unknown>.
    "string?": symbol.native`string?: boxed-or-raw string test`(
      { input: [z.value], output: [z.boolean], type: dedent`
          {
            (x: unknown): x is string;
            <T>(x: T): x is Extract<T, string>;
          }
        ` },
      function (this: CallCtx, obj) { return bool(obj instanceof AString); },
    ),

    // `(pair? x)` asks the receiver's own `arrival/tagless-final/pair?` (APair answers #t); the
    // guard's graceful default (#f) covers everything else — no `instanceof APair` reach-around.
    "pair?": {
      ...symbol.taglessGuard`pair?: #t iff obj is a pair (cons cell)`,
      type: dedent`
          {
            (x: unknown): x is Pair<unknown, unknown>;
            <T>(x: T): x is Extract<T, Pair<any, any>>;
          }
        `,
      // Compiler-facing (constitution §4.1) — the Phase-2 relocation drill. Declaration-
      // site spread (a tagless-guard def has no `Contract` param to thread these
      // through — see `TaglessGuardSymbolDef.emit`/`.narrows` in _bake.ts). `pair?` is
      // its own Law-N witness — its runtime behavior PROVES the narrowing.
      emit: pairQEmitRule,
      narrows: { witness: "pair?" },
      refPolicy: "eta",
    },

    "null?": symbol.native`null?: empty-list test`(
      {
        input: [z.value],
        output: [z.boolean],
        type: dedent`
          {
            (x: unknown): x is null;
            <T>(x: T): x is Extract<T, null>;
          }
        `,
        // Compiler-facing (constitution §4.1) — the Phase-2 relocation drill. `null?`
        // is its own Law-N witness — its runtime behavior PROVES the narrowing.
        emit: nullQEmitRule,
        narrows: { witness: "null?" },
        refPolicy: "eta",
      },
      // The empty list is the ANil singleton (and its provenance clones). Raw JS
      // null/undefined never reach here — the membrane boxes JS null→nil and
      // undefined→theVoid before any value enters the language.
      //
      // ── PLUS one TOLERANCE, scoped to the BORROWED array ──────────────────────────────────
      //
      // An EMPTY tool-returned JSON array also answers #t.
      //
      // Why this is not a hole in R7RS disjointness: `(null? #())` on a genuine scheme vector stays
      // #f — that constraint is load-bearing and untouched. The tolerance applies ONLY to an
      // `AJSArray`, the borrowed value whose chart has not been chosen. Every CONTRACTED list verb
      // already sees `nil` for an empty array (adoption normalizes it at mint — adopt-spine.ts), so
      // this closes the one remaining path: a BARE `null?` on a raw tool result, where no contract
      // has spoken.
      //
      // Why tolerate rather than stay faithful: at the EMPTY value the two charts CONVERGE. An
      // empty list and an empty vector both mean "no elements", and a JSON `[]` is honestly both
      // until a contract picks one. Answering #f there is the membrane insisting on a reading the
      // caller never asked for — and it is the exact shape of lie this whole rework exists to kill:
      // a model writing `(if (null? results) "none" (car results))` over an empty tool result took
      // the ELSE branch, called `(car [])`, got a tolerant nil, and reported confident garbage. A
      // "nothing here" that will not admit it is nothing.
      //
      // Known deliberate ruling, not a mechanical fix: it buys seamlessness at the cost of one
      // value answering #t to both `null?` and `vector?`. Reverting it is a one-line change (drop
      // the second disjunct) plus the `null? on empty` row in listalike-divergence.law.test.ts.
      function (this: CallCtx, obj) {
        return bool(obj instanceof ANil || (obj instanceof AJSArray && obj.source.length === 0));
      },
    ),

    "boolean?": symbol.native`boolean?: boxed-or-raw boolean test`(
      { input: [z.value], output: [z.boolean], type: dedent`
          {
            (x: unknown): x is boolean;
            <T>(x: T): x is Extract<T, boolean>;
          }
        ` },
      // L1 boxes parser literals as SchemeBool — JS `typeof` no longer catches them.
      // Mirrors the `number?` / `string?` pattern of accepting both raw and boxed forms.
      function (this: CallCtx, obj) { return bool(obj instanceof ABool); },
    ),

    // Symbol prints as string in the harvest image (no separate ambient Symbol carrier).
    "symbol?": {
      ...symbol.taglessGuard`symbol?: #t iff obj is an interned symbol`,
      type: dedent`
          {
            (x: unknown): x is string;
            <T>(x: T): x is Extract<T, string>;
          }
        `,
    },

    // `dict?` — Racket's dict predicate, the missing counterpart to our native `{…}` /
    // `(dict …)` open-key map (polyglot.ts). We ship the type but had no predicate for
    // it — a genuine gap, not a design omission (see `env/polyglot/polyglot-stubs.ts`'s
    // header for that distinction). A native dict is an `ADict` instance
    // (native-dict-provenance.md); the fallback below still recognizes a genuinely
    // foreign `AJSObject` (a borrowed JS object — arrays box separately as `AJSArray`,
    // so they never reach this branch), kept so a dict-shaped value from a tool result
    // still answers `dict?` without being an `ADict`. A scalar, an array, or any other
    // non-object foreign value is not a dict.
    "dict?":
      symbol.native`dict?: #t iff obj is a dict — a native open-key record ({…} / (dict …)), not a list, string, vector, or foreign class instance`(
        { input: [z.value], output: [z.boolean], type: dedent`
          {
            (x: unknown): x is Record<string, unknown>;
            <T>(x: T): x is Extract<T, Record<string, unknown>>;
          }
        ` },
        // `obj` is the honest `SchemeValue` union, which includes non-AValue arms (EOF, Values,
        // a bare fn) with no `.ctx` — `ctxOf` (already imported) is the narrowing read: an AValue
        // yields its own ctx, anything else falls back to CONSTANT_CTX.
        function (this: CallCtx, obj): ABool { return new ABool(ctxOf(obj), obj instanceof AJSObject || obj instanceof ADict); },
      ),

    "list?": symbol.native`list?: proper-list test (cycle-safe)`(
      { input: [z.value], output: [z.boolean], type: dedent`
          {
            (x: unknown): x is List<unknown>;
            <T>(x: T): x is Extract<T, List<any>>;
          }
        ` },
      // A circular list is NOT a proper list (R7RS); detect runtime cycles too
      // (have_cycles below only catches reader #0= cycles).
      function (this: CallCtx, obj) {
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

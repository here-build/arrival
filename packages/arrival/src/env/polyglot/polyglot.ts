// @inhuman.tools/arrival/polyglot — the polyglot SHARED CORE.
//
// The cross-dialect idiom family is four sibling packs:
//   scheme/polyglot          (THIS file) — the shared core every dialect stands on.
//   scheme/polyglot-clojure  (polyglot-clojure.ts) — Clojure's threading (->/->>),
//                              its `comp` alias, and its stdlib completion (str,
//                              get-in/assoc-in/update-in, zipmap, frequencies,
//                              group-by, partial, juxt, mapv/filterv, conj, into,
//                              rest, empty?).
//   scheme/polyglot-lisp     (polyglot-lisp.ts) — Common Lisp's mapcar/remove-if/
//                              remove-if-not.
//   scheme/polyglot-racket   (polyglot-racket.ts) — Racket's threading (~>/~>>,
//                              aliases expanding to ->/->>) and its dict-library
//                              accessor family (dict-ref, dict-has-key?, …), plus
//                              the Guile/Emacs Lisp `assoc-ref` riding with it.
//
// WHAT STAYS HERE, AND WHY: the member-access protocol (@/@?/@keys/dict) and the
// universal composition family (compose/pipe/flow) are not any ONE dialect's
// idiom — compose/pipe are Racket/CL/Clojure-adjacent alike (only their ALIASES —
// `comp`, Clojure's spelling — are dialect-specific, and that alias lives in
// polyglot-clojure.ts). `nil` (the LIPS-dialect empty-list alias) stays here too:
// every dialect pack, and the racket dict family's "missing key" convention,
// reads it. `%interleave` (the dict/zipmap/alist->dict argument-shape helper)
// stays here because it is consumed CROSS-dialect (this pack's own `dict`,
// polyglot-clojure's `zipmap`/`%dict-set`, polyglot-racket's `alist->dict`) —
// the "private helpers travel with whichever pack keeps their sole consumers"
// rule doesn't apply once there's more than one consumer family.
// `%dict-guard` lives in polyglot-racket.ts instead, by that same rule: its sole
// consumers are racket's dict-* family. Core placement would force racket to
// declare a dep back on core for a helper it alone uses, for zero benefit (racket
// already deps on core for `@`/`@?`/`@keys`/`dict`) — same principle
// `%conj-list`/`%dict-set` follow in polyglot-clojure.ts.
//
// MEMBER ACCESS — the polyglot read protocol is part of this family. `@` / `@?` /
// `@keys` (the explicit read/has/keys surface) and `(:key obj)` (the keyword
// accessor, Clojure-style) are TWO SYNTAXES over ONE interop read (mirroring
// Graal's `InteropLibrary.readMember`), dispatching onto the receiver's own
// `arrival/tagless-final/get|has|keys` terms (AValue.ts). They are origin-agnostic:
// a dict, a membrane-exposed foreign
// value, and an array all read the same way (arrival is a polyglot runtime, not a
// host with a fenced guest). They thread with the idioms in the sibling packs:
// (->> p :versions last :state). The reads are NOT declarations in the define set
// because they are native member-access primitives — `@` is a base binding, a
// `:`-prefixed symbol is self-evaluating and carries its own `apply` (`ASymbol.ts`)
// — but both bottom out in the same `arrival/tagless-final/get` protocol. This
// pack is their conceptual home; the definition is lifted onto the capability via
// `symbol.native` — a raw env.set bind (NOT rosetta-wrapped), so the membrane
// primitive is not routed through the membrane it implements.
//
// FV LOCALITY (docs/ASSEMBLY.md §PRELUDE, the FV locality law): every cross-
// capability free name a define body reaches must be a declared `deps` edge, or
// bake doors — `car`/`cdr` are the one exception, the kernel-level cxr resolver
// family (see define-bake.ts's KEYWORD_SYNTAX_BASELINE/CXR_RE note). A pack's
// `deps` array ORDER is itself a C3 merge input (§ASSEMBLY; base-packs.ts's header
// carries the current tail order every dialect pack's `deps` must agree with).
//
// This shrunk core's own DEPS reduce to two cross-capability free names —
//   equality — null?
//   lists    — reverse apply cons
// Both are BASE_PACKS leaves (no `deps`), so no C3 ordering holds between them.
// `scheme/polyglot` is itself a deps TARGET (`scheme/srfi-235` needs `compose`)
// and a dependent of every dialect pack, so base-packs.ts positions it after all
// three dialect packs and before `lists`.
//
// Wiring-only (no resources) → pause-trivial. Scoped to the self-contained
// idiom family — cut/cute (which need gensym + JS interop) ship as SRFI-26 instead.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via initBridge's assembleEnv),
// so this module is the sole definition site.

import { EnvCapability } from "../../common/capability.js";
import { symbol, type CallCtx } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import dedent from "dedent";
import { schemeBool } from "../../values/op-helpers.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { ACharacter } from "../../values/primitives/ACharacter.js";
import { ADict, foldKeyName, type DictKey } from "../../values/primitives/ADict.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { chargeHeap } from "../../heap-budget.js";
import { type SchemeValue } from "../../values/types.js";
import { type AValue } from "../../values/primitives/AValue.js";
import equality from "../r7rs/equality.js";
import lists from "../r7rs/lists.js";

// The `@`/`@?`/`@keys` verbs ARE the member-access protocol's face: key
// normalization + direct dispatch onto the receiver's own
// `arrival/tagless-final/get|has|keys` terms (ADict structurally, AJSObject/
// AJSArray through the interop read policy over their borrowed source) — no
// intermediate membrane face.
// ABSENCE IS THE SEMANTICS: a term-less receiver (scheme leaf, raw FFI value,
// function) answers nil/false/() — never a value's internal provenance/kind.

/** The ONE home of member-key normalization (`@`/`@?` + the `:key` accessor's
 *  string route): valueOf-unwrap a boxed key, refuse nil/null keys, stringify,
 *  strip the leading `:` accessor sigil. Receivers fold the RESULT (ADict's
 *  `foldKeyName` handles the SchemeValue route the keyword accessor takes). */
function normalizeMemberKey(key: unknown): string | null {
  const rawKey = (key as { valueOf?: () => unknown })?.valueOf?.() ?? key;
  if (rawKey == null || rawKey instanceof ANil) return null;
  let keyStr = String(rawKey);
  if (keyStr.startsWith(":")) keyStr = keyStr.slice(1);
  return keyStr;
}

// ─── Contract vocabulary local to this pack ─────────────────────────────────────
//
// `applicable` — a function-position argument in THIS pack: a callable value OR a
// symbol. Keyword accessors are first-class functions in the polyglot family (a
// keyword is a real ASymbol carrying its own `apply`, keyword-tagless-apply.md) —
// NOT a member of the `ACallable` union `z.lambda` tests. A bare `z.lambda` on
// these positions would reject the family's own documented idiom, so every
// position this pack APPLIES directly is `z.lambda | z.symbol`. Duplicated (not
// imported) in each sibling pack that needs it — polyglot-clojure.ts,
// polyglot-lisp.ts — a one-line local const is cheaper than a cross-pack named
// export for a pure contract-vocabulary helper.
const applicable = z.union([z.lambda, z.symbol]);

export default new EnvCapability("scheme/polyglot", {
  // See the header's DEPS note: `equality` (null?) and `lists` (reverse/apply/
  // cons) are the only cross-capability free names this core's define bodies
  // reach.
  deps: [equality, lists],
  // `:`-prefixed symbols are self-evaluating (keyword-tagless-apply.md) — `ASymbol`
  // itself carries `apply` — so this pack contributes no resolvers, only symbols.
  // A PLAIN record — a builder-function form would make the pack statically
  // un-enumerable, hiding `compose` from srfi-235's own FV allowlist.
  symbols: {
    // ═══════════════════════════════════════════════════════════════════════════
    // MEMBER-ACCESS PROTOCOL (every dialect reads through this)
    // ═══════════════════════════════════════════════════════════════════════════
    // `obj`/`key` stay `z.value` on BOTH `@`/`@?`/`@keys` — genuinely host-blind inputs:
    // the verbs normalize the key (normalizeMemberKey, above) and dispatch DIRECTLY to
    // the receiver's own `arrival/tagless-final/get|has|keys` terms (ADict/AJSObject/
    // AJSArray); a term-less receiver answers nil/false/() — absence IS the semantics.
    // Each op below has a single, unconditional real OUTPUT type, so the output sides
    // are typed precisely, not left blind.
    "@": symbol.native`@: read a member — origin-agnostic (dict / membrane-foreign / array)`(
      // The get term always returns a real scheme value (nil / a boxed read / an
      // AJSArray-wrapped array) — never something OUTSIDE SchemeValue — or, for a
      // Promise-valued entry, its lazy pending cell (a Promise OF the settled box —
      // pending-entry.ts), which the async dispatch wrapper awaits before encoding.
      // `z.value` is the identity term for "a polymorphic accessor's operand"
      // (scheme-zod.ts's own worked example).
      { input: [z.value, z.value], output: [z.value] },
      function (this: CallCtx, obj: unknown, key: unknown): SchemeValue | Promise<SchemeValue> {
        if (obj == null) return nil;
        const keyStr = normalizeMemberKey(key);
        if (keyStr === null) return nil;
        const getter = (obj as Partial<AValue>)["arrival/tagless-final/get"];
        return typeof getter === "function" ? getter.call(obj, keyStr) : nil;
      },
    ),
    "@?": symbol.native`@?: #t iff obj has the member key`(
      // The verdict is the boxed scheme face (schemeBool flyweight — Face split; the
      // raw JS boolean the has term returns is a protocol-layer detail).
      { input: [z.value, z.value], output: [z.boolean] },
      function (this: CallCtx, obj: unknown, key: unknown) {
        if (obj == null) return schemeBool(false);
        const keyStr = normalizeMemberKey(key);
        if (keyStr === null) return schemeBool(false);
        const has = (obj as Partial<AValue>)["arrival/tagless-final/has"];
        return schemeBool(typeof has === "function" ? has.call(obj, keyStr) : false);
      },
    ),
    "@keys": symbol.native`@keys: the own member keys of obj`(
      // The keys term returns raw JS strings; the scheme face boxes each to AString
      // (z.array(z.string)'s scheme side — Face split).
      { input: [z.value], output: [z.array(z.string)] },
      function (this: CallCtx, obj: unknown) {
        const keys = obj == null ? undefined : (obj as Partial<AValue>)["arrival/tagless-final/keys"];
        const names = typeof keys === "function" ? keys.call(obj) : [];
        // Mint each key string under the live invocation ctx — `this.runCtx`,
        // carried by `this: CallCtx` (dispatch's `hostImpl.apply(makeCallCtx(runCtx),
        // args)`, common/capability.ts). Under CONSTANT_CTX the result strings mint
        // run-invisible: outside the run's heap meter, cache, and effect tracking.
        return names.map((k) => new AString(this.runCtx, k));
      },
    ),
    // `dict` — the Scheme-side companion to the `:key` accessor and the `@` read:
    // build an open-key map from interleaved `:key value` pairs. A keyword in arg
    // position self-evaluates to itself (a real ASymbol — keyword-tagless-apply.md),
    // so its key is read the same way a bare quoted symbol's would be: stringify and
    // strip a leading `:` if present. The serializer prints it back as `(dict …)`
    // and arrival-chain-view transpiles it to a JS/Python object literal. (Plain
    // `symbol.native`: dict reads no membrane primitive, so it needs no deferral.)
    dict: symbol.native`dict: an open-key map built from interleaved :key value pairs`(
      // Input stays flat `z.value` — each interleaved position is genuinely either a
      // key (a self-evaluating keyword symbol, a bare symbol, or a string) or an
      // arbitrary stored value; there's no well-typed way to express the alternation
      // over a flat variadic without a shape that no longer matches the real call
      // form. The OUTPUT is unconditional: this impl always builds (and only ever
      // builds) an ADict.
      // The output contract is `dict()` — the open/homogeneous ADict codec — because
      // this op always builds an open-key ADict.
      { input: z.array(z.value), output: [z.dict()] },
      // Duplicate keys are last-write-wins: a Map re-set on an existing fold-name
      // updates the value but keeps the FIRST occurrence's iteration position. ADict's
      // own constructor requires unique fold-names up front (throws otherwise), so
      // resolving duplicates down to one pair per name is this call site's job.
      //
      // A real `function(this: CallCtx, …)`, not an arrow: dispatch delivers the live
      // ctx via `this: CallCtx` (common/capability.ts's `hostImpl.apply(makeCallCtx(
      // runCtx), args)`), and an arrow-fn impl structurally cannot read `this` — every
      // `(dict …)` call would mint its ADict + every key's ASymbol run-invisible,
      // outside the run's ctx. Heap-charge the fresh ADict off `this.runCtx`: an
      // unbounded interleaved arg list is the same unmetered-spine shape
      // `scheme-zod.ts`'s container codecs close (mirrors `to_array`'s rule).
      function (this: CallCtx, ...args: unknown[]): ADict {
        const byName = new Map<string, [DictKey, SchemeValue]>();
        for (let i = 0; i + 1 < args.length; i += 2) {
          const raw = args[i];
          const key: DictKey =
            raw instanceof ASymbol || raw instanceof AString || raw instanceof ACharacter
              ? raw
              : new AString(this.runCtx, String(raw).replace(/^:/, ""));
          byName.set(foldKeyName(key), [key, args[i + 1] as SchemeValue]);
        }
        chargeHeap(this.runCtx, byName.size);
        return new ADict(this.runCtx, [...byName.values()]);
      } as unknown as (...args: SchemeValue[]) => ADict,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // LIPS DIALECT (shared — empty-list alias)
    // ═══════════════════════════════════════════════════════════════════════════
    // nil — the LIPS-dialect alias for the empty list. Same principle as the
    // sibling packs' idioms: LLMs and humans reach for whichever Lisp idiom they
    // already know. R7RS spells the empty list '() ; LIPS (and the Scheme the
    // models were trained on) also binds the symbol `nil` to it. Because polyglot
    // is a base pack assembled onto user_env, `nil` inherits everywhere (the
    // inference plane is a user_env child, so it gets it for free). '() reads to the
    // ANil singleton, so this binds exactly that. A CONSTANT define: the
    // contract is the single value schema `z.nil`, validated once at bake.
    nil: symbol.define`nil: the LIPS-dialect alias for the empty list '() (the ANil singleton)`(z.nil, `'()`),

    // ═══════════════════════════════════════════════════════════════════════════
    // COMPOSITION (shared lineage — compose/pipe are Racket/CL/Clojure-adjacent
    // alike; their dialect-specific spellings — `comp`, `~>` chains — live in the
    // sibling packs. `flow` is Ramda/F#-flavored, not any one Lisp dialect's own.)
    // ═══════════════════════════════════════════════════════════════════════════
    // compose — right-to-left: ((compose f g) x) => (f (g x)).
    // `applicable` (not bare z.lambda): keyword accessors are first-class — (compose :k f).
    // type: seed multi-arg (`apply`); rest unary. Depth 0–6; deeper is a type error (no catch-all).
    compose: symbol.define`compose: right-to-left composition — ((compose f g) x) => (f (g x)); zero fns = identity`(
      {
        input: [],
        inputRest: applicable,
        output: [z.lambda],
        type: dedent`
          {
            (): <T>(x: T) => T;
            <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
            <A extends unknown[], B, R>(f: (b: B) => R, g: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, R>(f: (c: C) => R, g: (b: B) => C, h: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, D, R>(f: (d: D) => R, g: (c: C) => D, h: (b: B) => C, i: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, D, E, R>(f: (e: E) => R, g: (d: D) => E, h: (c: C) => D, i: (b: B) => C, j: (...args: A) => B): (...args: A) => R;
            <A extends unknown[], B, C, D, E, F, R>(f: (f: F) => R, g: (e: E) => F, h: (d: D) => E, i: (c: C) => D, j: (b: B) => C, k: (...args: A) => B): (...args: A) => R;
          }
        `,
      },
      `(lambda fns
         (lambda args
           (let ((rfns (reverse fns)))
             (if (null? rfns)
                 (if (null? args) #void (car args))
                 (let loop ((fs (cdr rfns)) (acc (apply (car rfns) args)))
                   (if (null? fs) acc (loop (cdr fs) ((car fs) acc))))))))`,
    ),
    // pipe — left-to-right twin of compose. Same ladder, seed first.
    pipe: symbol.define`pipe: left-to-right composition — ((pipe f g) x) => (g (f x)); zero fns = identity`(
      {
        input: [],
        inputRest: applicable,
        output: [z.lambda],
        type: dedent`
          {
            (): <T>(x: T) => T;
            <A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R;
            <A extends unknown[], B, R>(f: (...args: A) => B, g: (b: B) => R): (...args: A) => R;
            <A extends unknown[], B, C, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => R): (...args: A) => R;
            <A extends unknown[], B, C, D, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => R): (...args: A) => R;
            <A extends unknown[], B, C, D, E, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => E, j: (e: E) => R): (...args: A) => R;
            <A extends unknown[], B, C, D, E, F, R>(f: (...args: A) => B, g: (b: B) => C, h: (c: C) => D, i: (d: D) => E, j: (e: E) => F, k: (f: F) => R): (...args: A) => R;
          }
        `,
      },
      `(lambda fns
         (lambda args
           (if (null? fns)
               (if (null? args) #void (car args))
               (let loop ((fs (cdr fns)) (acc (apply (car fns) args)))
                 (if (null? fs) acc (loop (cdr fs) ((car fs) acc)))))))`,
    ),
    // flow — CONSTANT alias of pipe (eq? identity). No Contract.type channel on constants.
    flow: symbol.define`flow: an alias of pipe (left-to-right composition) — the Ramda/F# name`(z.lambda, `pipe`),

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE HELPER — consumed cross-dialect (this pack's own `dict`, plus
    // polyglot-clojure.ts's zipmap/%dict-set and polyglot-racket.ts's
    // alist->dict), so it stays HERE rather than traveling with any one dialect.
    // ═══════════════════════════════════════════════════════════════════════════
    // %interleave — zip two equal-length lists into a flat (k v k v …) sequence,
    // the shape `dict`/`apply` expect. CONTRACT: `z.value` on both lists AND the
    // output — deliberate: the helper self-recurses through its own contract
    // boundary once per element, so a `z.list()` codec (an O(n) spine decode)
    // would turn one interleave into O(n²) decode work; `z.value`'s instanceof
    // check keeps the recursive boundary flat.
    "%interleave":
      symbol.define`%interleave: zip ks and vs into a flat (k v k v …) list — the dict/apply argument shape (private helper)`(
        { input: [z.value, z.value], output: [z.value] },
        `(lambda (ks vs)
         (if (or (null? ks) (null? vs))
             '()
             (cons (car ks) (cons (car vs) (%interleave (cdr ks) (cdr vs))))))`,
      ),
  },
});

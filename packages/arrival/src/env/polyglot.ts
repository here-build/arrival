// @here.build/arrival/polyglot — the polyglot idiom pack.
//
// One principle: LLMs and humans reach for whichever Lisp/FP idiom they already
// know, so accept the whole family rather than forcing one dialect. Today that
// family is threading & composition:
//   ->  / ~>   thread the value as the FIRST argument  (Clojure -> , Racket ~>)
//   ->> / ~>>  thread the value as the LAST argument    (Clojure ->>, Racket ~>>)
//   compose / comp   right-to-left composition  ((compose f g) x) => (f (g x))
//   pipe / flow      left-to-right composition   ((pipe f g) x)    => (g (f x))
//
// MEMBER ACCESS — the polyglot read protocol is part of this family. `@` / `@?` /
// `@keys` (the explicit read/has/keys surface) and `(:key obj)` (the keyword
// accessor, Clojure-style) are TWO SYNTAXES over ONE interop read — Graal's
// `InteropLibrary.readMember` — implemented as `readMember`/`hasMember`/`memberKeys`
// in membrane.ts. They are origin-agnostic: a dict, a membrane-exposed foreign
// value, and an array all read the same way (arrival is a polyglot runtime, not a
// host with a fenced guest). They thread with the idioms here: (->> p :versions
// last :state). The reads are NOT declarations in the define set because they are
// native member-access primitives — `@` is a base binding, a `:`-prefixed symbol is
// self-evaluating and carries its own `apply` (`ASymbol.ts`) — but both bottom out
// in the same `arrival/tagless-final/get` protocol. This pack is their conceptual
// home; the definition is lifted onto the capability via `symbol.native` — a raw
// env.set bind (NOT rosetta-wrapped), so the membrane primitive is not routed
// through the membrane it implements.
//
// MIGRATED off the text-blob `prelude` (docs/working-proposals/symbol-define-static-
// program-validation.md, wave W4/H3): every former prelude define is an individually
// declared `symbol.define` (contract-enforced from day one, §1.2 rev2 ruling), every
// former `define-macro` a `symbol.defineSyntax` with a judged `macroAttribute` — the
// threading family below is the FIRST PRODUCTION `"expression"` attribution (§3.4's
// table named it; this pack lands it). Declaration order preserves the prelude's
// textual order 1:1 (§2.3 sequential-RHS evaluation; the three eager constants —
// `nil`, `comp`, `flow` — each follow the sibling they alias).
//
// DEPS (§2.1's bake FV locality law): the old prelude referenced half the stdlib on
// two-phase-bootstrap luck (env-roots assembles NATIVE_PACKS onto global_env, then
// BASE_PACKS onto user_env — a runtime guarantee the STATIC law deliberately does not
// consult; srfi-235's header tells the full story). Every cross-capability free name
// in the define bodies is now a declared edge:
//   equality  — null? pair? string? not repr dict? procedure?
//   numeric   — + = number?
//   strings   — string-append string-length
//   vectors   — vector? vector-length vector->list list->vector
//   srfi-1    — filter reduce
//   exceptions— error
//   lists     — map apply append reverse length cons list
// `srfi-1`/`exceptions`/`lists` are BASE_PACKS members: C3 requires a dependency
// ranked BELOW its dependent in the roots array, so base-packs.ts repositions all
// three into the tail AFTER polyglot (and srfi-235's deps order flips `polyglot`
// before `lists` to agree) — see base-packs.ts's header for the full constraint
// story. polyglot is itself a deps TARGET (`scheme/srfi-235` depends on it).
//
// DIALECT SECTIONS (V, 2026-07-10): this pack is slated to DECOMPOSE into
// polyglot-clojure / polyglot-lisp / polyglot-racket in a follow-up wave. The
// entries below are grouped under per-dialect section banners so the split is a
// cut-along-the-dotted-lines move; nothing is restructured here.
//
// Wiring-only (no resources) → pause-trivial. NOTE: scoped to the self-contained
// idiom family — cut/cute (which need gensym + JS interop) ship as SRFI-26 instead.
//
// SINGLE SOURCE: `base-packs.ts` assembles this pack (via initBridge's assembleEnv),
// so this module is the sole definition site.

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import { schemeBool } from "../values/op-helpers.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { ADict, foldKeyName, type DictKey } from "../values/primitives/ADict.js";
import { ANil, nil } from "../values/primitives/ANil.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { type SchemeValue } from "../values/types.js";
import { type AValue } from "../values/primitives/AValue.js";
import equality from "./r7rs/equality.js";
import numeric from "./r7rs/numeric.js";
import strings from "./r7rs/strings.js";
import vectors from "./r7rs/vectors.js";
import exceptions from "./r7rs/exceptions.js";
import lists from "./r7rs/lists.js";
import srfi1 from "./srfi/srfi-1.js";

// The `@`/`@?`/`@keys` verbs ARE the member-access protocol's face now: key
// normalization + direct dispatch onto the receiver's own
// `arrival/tagless-final/get|has|keys` terms (ADict structurally, AJSObject/
// AJSArray through the interop read policy over their borrowed source).
// membrane.ts's readMember/hasMember/memberKeys faces are dissolved — the verbs
// were their only production consumer, so the indirection carried nothing.
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
// symbol. Keyword accessors are first-class functions here (the pack's own thesis:
// `(compose :state last :versions)` names a pipeline — module header), and a keyword
// is a real ASymbol carrying its own `apply` (keyword-tagless-apply) — NOT a member
// of the `ACallable` union `z.lambda` tests. A bare `z.lambda` on these positions
// would reject the pack's own documented idiom, so every position polyglot APPLIES
// directly is `z.lambda | z.symbol`. (Positions that PASS a matcher through to a
// term-dispatch verb — filter's RegExp arm, map's own dispatch — stay `z.value`
// instead: the target's polymorphism is the honest contract, noted per entry.)
const applicable = z.union([z.lambda, z.symbol]);

export default new EnvCapability("scheme/polyglot", {
  // See the header's DEPS block: every cross-capability free name in the define
  // bodies, forced into declared edges by the §2.1 bake FV law. ORDER MATTERS
  // beyond readability (C3 merge input): `srfi1`/`exceptions`/`lists` are
  // BASE_PACKS members and must appear here in the SAME relative order the
  // base-packs.ts tail block gives them (srfi-1, then exceptions, then lists).
  // `equality`/`numeric`/`strings`/`vectors` are NATIVE_PACKS-only (never in
  // BASE_PACKS' roots array) — but `srfi1` must still LEAD them: srfi-1 declares
  // deps of its own ([equality, numeric, binding, exceptions, lists], W4-H3), and a
  // dependent's linearization always heads with itself, so listing `equality`/
  // `numeric` before `srfi1` contradicts L(srfi1) and deadlocks the C3 merge
  // (AssembleLinearizationError, found on the merged H3 tree). The rule, same as
  // the tail block's: dependents before their dependencies WITHIN a deps array too.
  deps: [srfi1, equality, numeric, strings, vectors, exceptions, lists],
  // `:`-prefixed symbols are self-evaluating (keyword-tagless-apply.md) — `ASymbol`
  // itself carries `apply` — so this pack contributes no resolvers, only symbols.
  // A PLAIN record (the pre-migration builder form carried a dead TDZ-deferral
  // reason and made the pack statically un-enumerable — §2.2 exports would have
  // hidden `compose` from srfi-235's own FV allowlist).
  symbols: {
    // ═══════════════════════════════════════════════════════════════════════════
    // MEMBER-ACCESS PROTOCOL (shared — every dialect reads through this)
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
      (obj: unknown, key: unknown): SchemeValue | Promise<SchemeValue> => {
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
      (obj: unknown, key: unknown) => {
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
      (obj: unknown) => {
        const keys = obj != null ? (obj as Partial<AValue>)["arrival/tagless-final/keys"] : undefined;
        const names = typeof keys === "function" ? keys.call(obj) : [];
        return names.map((k) => new AString(CONSTANT_CTX, k));
      },
    ),
    // `dict` — the Scheme-side companion to the `:key` accessor and the `@` read:
    // build an open-key map from interleaved `:key value` pairs. A keyword in arg
    // position self-evaluates to itself (a real ASymbol — keyword-tagless-apply.md),
    // so its key is read the same way a bare quoted symbol's would be: stringify and
    // strip a leading `:` if present. Relocated VERBATIM from stdlib.ts global_env
    // (husk dissolution); the serializer prints it back as `(dict …)` and
    // arrival-chain-view transpiles it to a JS/Python object literal. (Plain
    // `symbol.native`: dict reads no membrane primitive, so it needs no deferral.)
    dict: symbol.native`dict: an open-key map built from interleaved :key value pairs`(
      // Input stays flat `z.value` — each interleaved position is genuinely either a
      // key (a self-evaluating keyword symbol, a bare symbol, or a string) or an
      // arbitrary stored value; there's no well-typed way to express the alternation
      // over a flat variadic without a shape that no longer matches the real call
      // form. The OUTPUT is unconditional: this impl always builds (and only ever
      // builds) an ADict.
      // v2 `dict` is a function (bare `dict()` = the open/homogeneous ADict codec) — was a bare
      // `z.instanceof(ADict)` constant in v1. This op always builds an open-key ADict, so `dict()`.
      { input: z.array(z.value), output: [z.dict()] },
      // Duplicate keys are last-write-wins: a Map re-set on an existing fold-name
      // updates the value but keeps the FIRST occurrence's iteration position —
      // the same behavior the old plain-object `obj[key] = value` loop had. ADict's
      // own constructor requires unique fold-names up front (throws otherwise), so
      // resolving duplicates down to one pair per name is this call site's job.
      ((...args: unknown[]): ADict => {
        const byName = new Map<string, [DictKey, SchemeValue]>();
        for (let i = 0; i + 1 < args.length; i += 2) {
          const raw = args[i];
          const key: DictKey =
            raw instanceof ASymbol || raw instanceof AString || raw instanceof ACharacter
              ? raw
              : new AString(CONSTANT_CTX, String(raw).replace(/^:/, ""));
          byName.set(foldKeyName(key), [key, args[i + 1] as SchemeValue]);
        }
        return new ADict(CONSTANT_CTX, [...byName.values()]);
      }) as unknown as (...args: SchemeValue[]) => ADict,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // LIPS DIALECT (shared — empty-list alias)
    // ═══════════════════════════════════════════════════════════════════════════
    // nil — the LIPS-dialect alias for the empty list. Same principle as the
    // threading idioms and :key accessors: LLMs and humans reach for whichever Lisp
    // idiom they already know. R7RS spells the empty list '() ; LIPS (and the Scheme
    // the models were trained on) also binds the symbol `nil` to it. Because polyglot
    // is a base pack assembled onto user_env, `nil` inherits everywhere (the
    // inference plane is a user_env child, so it gets it for free). '() reads to the
    // ANil singleton, so this binds exactly that. A CONSTANT define (§1.2): the
    // contract is the single value schema `z.nil`, validated once at bake.
    nil: symbol.define`nil: the LIPS-dialect alias for the empty list '() (the ANil singleton)`(z.nil, `'()`),

    // ═══════════════════════════════════════════════════════════════════════════
    // COMPOSITION (shared lineage — compose is Racket/CL/Clojure-adjacent alike;
    // comp is Clojure's name, flow is Ramda/F#-flavored; see the dialect table)
    // ═══════════════════════════════════════════════════════════════════════════
    // compose — right-to-left composition: ((compose f g) x) => (f (g x)).
    // Keyword accessors are first-class functions, so (compose :state last :versions)
    // names a pipeline — hence `applicable` (callable-or-symbol), never bare z.lambda,
    // on the variadic fns. Output is unconditional: the body always mints a lambda.
    compose: symbol.define`compose: right-to-left composition — ((compose f g) x) => (f (g x)); zero fns = identity`(
      { input: [], inputRest: applicable, output: [z.lambda] },
      `(lambda fns
         (lambda args
           (let ((rfns (reverse fns)))
             (if (null? rfns)
                 (if (null? args) #void (car args))
                 (let loop ((fs (cdr rfns)) (acc (apply (car rfns) args)))
                   (if (null? fs) acc (loop (cdr fs) ((car fs) acc))))))))`,
    ),
    // comp — Clojure's name for compose. A CONSTANT define: the RHS is the bare
    // identifier `compose` (already bound — sequential-RHS §2.3, declared just
    // above), so the contract is the single value schema z.lambda (the value IS the
    // bound compose procedure), same shape as srfi-235's `always` alias.
    comp: symbol.define`comp: Clojure's name for compose — a back-compat alias binding the same procedure`(
      z.lambda,
      `compose`,
    ),
    // pipe — left-to-right composition: ((pipe f g) x) => (g (f x)).
    pipe: symbol.define`pipe: left-to-right composition — ((pipe f g) x) => (g (f x)); zero fns = identity`(
      { input: [], inputRest: applicable, output: [z.lambda] },
      `(lambda fns
         (lambda args
           (if (null? fns)
               (if (null? args) #void (car args))
               (let loop ((fs (cdr fns)) (acc (apply (car fns) args)))
                 (if (null? fs) acc (loop (cdr fs) ((car fs) acc)))))))`,
    ),
    // flow — pipe's Ramda/F#-flavored alias. CONSTANT, same shape as comp.
    flow: symbol.define`flow: an alias of pipe (left-to-right composition) — the Ramda/F# name`(z.lambda, `pipe`),

    // ═══════════════════════════════════════════════════════════════════════════
    // THREADING MACROS (Clojure -> ->> ; Racket ~> ~>>) — the FIRST production
    // `macroAttribute: "expression"` declarations (§3.4)
    // ═══════════════════════════════════════════════════════════════════════════
    // ATTRIBUTE JUDGMENT (§3.4 case law, per-macro): every argument position of the
    // threading family is ORDINARY EXPRESSION SPACE — `x` is an evaluated seed, each
    // form is either a call form (whose elements are expressions the expansion
    // preserves verbatim, merely splicing the threaded value in) or a bare symbol
    // (a function REFERENCE the expansion applies). Nothing binds (contrast
    // `receive`/`and-let*`'s formals → "binder") and nothing is a positional token
    // consumed by the expander (contrast `cut`'s `<>` → "opaque"). So the validator
    // legitimately WALKS the arguments: `(-> x undefined-fn)` REPORTS unbound-symbol
    // at parse phase — pinned as the first production expression-attribution row in
    // this pack's migration suite (polyglot-symbol-define.test.ts) beside LAW 4's
    // synthetic ternary row. Keyword accessors in thread position (`(->> p :versions)`)
    // stay clean for free: keyword-shaped names never enter the FV walk by
    // construction (§3.5).
    "->": symbol.defineSyntax`->: thread x as the FIRST argument through each form (Clojure thread-first) — (-> x (f a) g) => (g (f x a))`(
      `(lambda (x . forms)
         (if (null? forms)
             x
             (let ((form (car forms)))
               \`(-> ,(if (pair? form)
                          (cons (car form) (cons x (cdr form)))
                          (list form x))
                    ,@(cdr forms)))))`,
      { macroAttribute: "expression" },
    ),
    "->>": symbol.defineSyntax`->>: thread x as the LAST argument through each form (Clojure thread-last) — (->> x (f a) g) => (g (f a x))`(
      `(lambda (x . forms)
         (if (null? forms)
             x
             (let ((form (car forms)))
               \`(->> ,(if (pair? form)
                           (append form (list x))
                           (list form x))
                     ,@(cdr forms)))))`,
      { macroAttribute: "expression" },
    ),
    "~>": symbol.defineSyntax`~>: Racket's thread-first — an alias expanding to (-> …)`(
      `(lambda (x . forms) \`(-> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),
    "~>>": symbol.defineSyntax`~>>: Racket's thread-last — an alias expanding to (->> …)`(
      `(lambda (x . forms) \`(->> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE HELPERS (shared plumbing — % convention; travel with whichever split
    // pack keeps their consumers, see the dialect table)
    // ═══════════════════════════════════════════════════════════════════════════
    // %interleave — zip two equal-length lists into a flat (k v k v …) sequence,
    // the shape `dict`/`apply` expect. CONTRACT: `z.value` on both lists AND the
    // output — deliberate (§1.2 carve-out): the helper self-recurses through its own
    // contract boundary once per element, so a `z.list()` codec (an O(n) spine
    // decode) would turn one interleave into O(n²) decode work; `z.value`'s
    // instanceof check keeps the recursive boundary flat.
    "%interleave": symbol.define`%interleave: zip ks and vs into a flat (k v k v …) list — the dict/apply argument shape (private helper)`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (ks vs)
         (if (or (null? ks) (null? vs))
             '()
             (cons (car ks) (cons (car vs) (%interleave (cdr ks) (cdr vs))))))`,
    ),
    // %dict-set — a dict with key k rebuilt to value v, everything else preserved
    // (dicts are immutable — see HASH_TABLE_REASON in srfi-stubs.ts). Applied to nil
    // it builds a fresh single-key dict (@keys nil = '()), which is exactly what
    // assoc-in needs to create missing intermediate maps on demand — so `d` is
    // honestly `z.value` (dict OR nil), never `z.dict()`. `@keys` returns a raw JS
    // array (not a scheme list — filter/map need the term protocol), so
    // `vector->list` (R7RS §6.8 — a raw JS array is representation-blind as a
    // vector here, per z.vector) lifts it first.
    // k v are placed LAST (not first): `dict`'s own key resolution (stringify, strip a
    // leading `:`) normalizes a keyword / symbol / string key to the
    // SAME underlying JS-object key as an already-stored string key — a plain `equal?`
    // comparison can't see that (a pluck closure is never `equal?` to a string), but
    // sequential `obj[key] = value` assignment naturally dedupes on the LAST write. So
    // no explicit exclusion is needed: k v simply overwrite whatever ks/vs already wrote.
    "%dict-set": symbol.define`%dict-set: a NEW dict with key k set to v, everything else preserved; applied to nil it mints a fresh single-key dict (private helper)`(
      // k: keyword/symbol/string (dict's own normalization is the semantics);
      // v: anything. Output IS unconditionally a dict.
      { input: [z.value, z.value, z.value], output: [z.dict()] },
      `(lambda (d k v)
         (let* ((ks (vector->list (@keys d)))
                (vs (map (lambda (key) (@ d key)) ks)))
           (apply dict (append (%interleave ks vs) (list k v)))))`,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // CLOJURE — cross-dialect stdlib completion: famous Clojure symbols that are
    // PURE functions over primitives already bound here. An LLM (or human) reaching
    // for a well-known symbol from another dialect gets a REAL binding, not a
    // teaching-stub door — when the semantics are implementable without IO/mutation/
    // macro machinery. (The genuinely-impure/macro-only cousins — println, setf,
    // defun, loop, nreverse, for/list, for/fold, gethash, getf, hash-ref — are
    // doored instead, in env/polyglot-stubs.ts.)
    //
    // NOTE: `first` (SRFI-1), `comp` (alias above), `flatten` (r7rs/lists.ts,
    // LIPS extension) and `curry` (SRFI-235-adjacent, srfi-235.ts) are ALREADY
    // bound elsewhere — deliberately not redefined here.
    // ═══════════════════════════════════════════════════════════════════════════
    // str — Clojure: concatenate the display form of every arg. Strings pass
    // through as-is; everything else prints via `repr` (the external-representation
    // protocol, r7rs/equality.ts) before concatenating with string-append.
    // Genuinely variadic-any input (§1.2 carve-out: any value has a display form);
    // the output is unconditionally a string.
    str: symbol.define`str: Clojure — concatenate the display form of every arg (strings as-is, everything else via repr)`(
      { input: [], inputRest: z.value, output: [z.string] },
      `(lambda args
         (apply string-append (map (lambda (x) (if (string? x) x (repr x))) args)))`,
    ),
    // get-in — Clojure: read a value nested ks-deep through dicts (or anything
    // `@` reads), nil if any step misses. `obj` is origin-agnostic BY DESIGN (the
    // `@` read protocol's whole point) and the result is whatever is stored — both
    // honestly `z.value`.
    "get-in": symbol.define`get-in: Clojure — read a value nested ks-deep through dicts (or anything @ reads); nil if any step misses`(
      { input: [z.value, z.list()], output: [z.value] },
      `(lambda (obj ks)
         (if (null? ks)
             obj
             (get-in (@ obj (car ks)) (cdr ks))))`,
    ),
    // assoc-in — Clojure: a NEW obj with the value at nested path ks set to v,
    // building missing intermediate dicts as needed (see %dict-set). Output is
    // `z.value`, not `z.dict()`: with an EMPTY path the result is v itself —
    // any value — by definition.
    "assoc-in": symbol.define`assoc-in: Clojure — a NEW obj with the value at nested path ks set to v, minting missing intermediate dicts on demand`(
      { input: [z.value, z.list(), z.value], output: [z.value] },
      `(lambda (obj ks v)
         (if (null? ks)
             v
             (if (null? (cdr ks))
                 (%dict-set obj (car ks) v)
                 (%dict-set obj (car ks) (assoc-in (@ obj (car ks)) (cdr ks) v)))))`,
    ),
    // update-in — Clojure: assoc-in the result of applying f to the current value.
    // `f` is applied directly by this body → `applicable` (a keyword accessor is a
    // legal updater exactly like any fn).
    "update-in": symbol.define`update-in: Clojure — assoc-in the result of applying f to the value currently at nested path ks`(
      { input: [z.value, z.list(), applicable], output: [z.value] },
      `(lambda (obj ks f)
         (assoc-in obj ks (f (get-in obj ks))))`,
    ),
    // zipmap — Clojure: a dict pairing each key with the value at the same
    // position in vs.
    zipmap: symbol.define`zipmap: Clojure — a dict pairing each key in ks with the value at the same position in vs`(
      { input: [z.list(), z.list()], output: [z.dict()] },
      `(lambda (ks vs) (apply dict (%interleave ks vs)))`,
    ),
    // frequencies — Clojure: a dict of each distinct element to its occurrence
    // count. Non-string elements key by their `repr` (dict keys are strings).
    // `coll` stays `z.value`: the body delegates to `reduce` (srfi-1's tagless
    // term dispatcher), so any reduce-capable receiver (list, vector, nil) is
    // legal — a `z.list()` contract would narrow the real surface.
    frequencies: symbol.define`frequencies: Clojure — a dict of each distinct element to its occurrence count (non-string elements key by repr)`(
      { input: [z.value], output: [z.dict()] },
      `(lambda (coll)
         (reduce
           (lambda (x acc)
             (let* ((k (if (string? x) x (repr x)))
                    (cur (@ acc k)))
               (%dict-set acc k (if (null? cur) 1 (+ cur 1)))))
           (dict)
           coll))`,
    ),
    // group-by — Clojure: a dict of (f element) to the list of elements that
    // produced it, in original order. `f` applied directly → applicable; `coll`
    // term-dispatched via reduce → z.value (same reasoning as frequencies).
    "group-by": symbol.define`group-by: Clojure — a dict of (f element) to the list of elements that produced it, in original order`(
      { input: [applicable, z.value], output: [z.dict()] },
      `(lambda (f coll)
         (reduce
           (lambda (x acc)
             (let* ((k0 (f x))
                    (k (if (string? k0) k0 (repr k0)))
                    (cur (@ acc k)))
               (%dict-set acc k (append (if (null? cur) '() cur) (list x)))))
           (dict)
           coll))`,
    ),
    // partial — Clojure: fix the leading args of f, returning a function of the
    // rest. `f` applied (later) by the minted closure → applicable; the fixed
    // args are genuinely anything.
    partial: symbol.define`partial: Clojure — fix the leading args of f, returning a function of the rest`(
      { input: [applicable], inputRest: z.value, output: [z.lambda] },
      `(lambda (f . args)
         (lambda more (apply f (append args more))))`,
    ),
    // juxt — Clojure: a function that applies every fn to the same args,
    // collecting the results into a list (in fn order).
    juxt: symbol.define`juxt: Clojure — a function applying every fn to the same args, collecting the results into a list in fn order`(
      { input: [], inputRest: applicable, output: [z.lambda] },
      `(lambda fns
         (lambda args
           (map (lambda (f) (apply f args)) fns)))`,
    ),
    // mapv / filterv — Clojure: map/filter with a vector result instead of a list.
    // `f`/`pred` PASS THROUGH to map/filter's own dispatch (which owns the
    // callable-or-matcher polymorphism — filter accepts a RegExp, per its own doc),
    // so they stay `z.value`; the trailing lists must be real list spines for the
    // list->vector lift to hold, so those are `z.list()`; the output is
    // unconditionally a vector.
    mapv: symbol.define`mapv: Clojure — map with a vector result instead of a list`(
      { input: [z.value], inputRest: z.list(), output: [z.vector()] },
      `(lambda (f . lists) (list->vector (apply map (cons f lists))))`,
    ),
    filterv: symbol.define`filterv: Clojure — filter with a vector result instead of a list`(
      { input: [z.value, z.list()], output: [z.vector()] },
      `(lambda (pred lst) (list->vector (filter pred lst)))`,
    ),
    // %conj-list — conj's list arm (private helper). `z.value` both sides —
    // self-recursive per item (the %interleave perf reasoning) and coll is the
    // accumulating polymorphic result.
    "%conj-list": symbol.define`%conj-list: conj's list arm — cons each item onto coll in order, so the LAST item passed ends up FIRST (private helper)`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (coll items)
         (if (null? items)
             coll
             (%conj-list (cons (car items) coll) (cdr items))))`,
    ),
    // conj — Clojure: add items to a collection in its natural growth position —
    // the front for a list (each successive item conj'd onto the accumulating
    // result, so the LAST item passed ends up FIRST), the end for a vector.
    // GENUINELY SHAPELESS (§1.2 carve-out): coll is list-or-vector and the result
    // is in coll's OWN representation — no single richer type is honest.
    conj: symbol.define`conj: Clojure — add items at the collection's natural growth position (front for a list, end for a vector)`(
      { input: [z.value], inputRest: z.value, output: [z.value] },
      `(lambda (coll . items)
         (if (vector? coll)
             (list->vector (append (vector->list coll) items))
             (%conj-list coll items)))`,
    ),
    // into — Clojure: pour every element of from into to via conj, in from's
    // order. SHAPELESS carve-out on both collections (conj's representation
    // polymorphism + reduce's term dispatch).
    into: symbol.define`into: Clojure — pour every element of from into to via conj, in from's order`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (to from)
         (reduce (lambda (x acc) (conj acc x)) to from))`,
    ),
    // rest — Clojure: cdr that tolerates a non-pair (nil) instead of erroring.
    // The `z.value` input IS the semantics (tolerance is the whole binding).
    rest: symbol.define`rest: Clojure — cdr that tolerates a non-pair (returns '()) instead of erroring`(
      { input: [z.value], output: [z.value] },
      `(lambda (xs) (if (pair? xs) (cdr xs) '()))`,
    ),
    // empty? — Clojure: #t iff the list / string / vector / dict has no elements.
    // (`@keys` returns a raw JS array, not a scheme list — `length` accepts it
    // directly as a ".length carrier", r7rs/lists.ts, so no array->list needed here.)
    // OUTPUT is `z.value`, not `z.boolean` (§1.2 carve-out, representation honesty):
    // the cond arms return MIXED boolean representations — `#t`/`#f` literals and
    // null?/pair?/dict? verdicts are boxed ABool, but `=`'s verdict is a raw JS
    // boolean — and `z.boolean`'s codec is `instanceof ABool` only. Both are
    // scheme-truthy/falsy alike (`if` doesn't care) — the pre-migration suite pins
    // exactly this via `(if (empty? …) …)` normalization.
    "empty?": symbol.define`empty?: Clojure — #t iff the list / string / vector / dict has no elements`(
      { input: [z.value], output: [z.value] },
      `(lambda (xs)
         (cond
           ((null? xs) #t)
           ((pair? xs) #f)
           ((string? xs) (= (string-length xs) 0))
           ((vector? xs) (= (vector-length xs) 0))
           ((dict? xs) (= (length (@keys xs)) 0))
           (else #f)))`,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // COMMON LISP — same completion principle, CL surface
    // ═══════════════════════════════════════════════════════════════════════════
    // mapcar — Common Lisp: identical argument order to R7RS map (proc, then one
    // or more lists), so it is a direct alias. `f` passes through to map's own
    // dispatch (z.value); the lists are real list spines (CL mapcar is list-only,
    // and map over lists yields a list — the honest output).
    mapcar: symbol.define`mapcar: Common Lisp — identical argument order to R7RS map (proc, then one or more lists); a direct alias`(
      { input: [z.value], inputRest: z.list(), output: [z.list()] },
      `(lambda (f . lists) (apply map (cons f lists)))`,
    ),
    // remove-if / remove-if-not — Common Lisp: filter, with the sense of the
    // predicate flipped / kept. remove-if APPLIES pred itself (the negating
    // wrapper) → applicable; remove-if-not passes pred straight through to filter
    // (whose dispatch owns the callable-or-RegExp polymorphism) → z.value. The
    // sequence stays z.value both times: filter is term-dispatched (a vector is a
    // legal receiver returning a vector), so `z.list()` in/out would narrow it.
    "remove-if": symbol.define`remove-if: Common Lisp — keep the elements NOT satisfying pred (filter with the sense flipped)`(
      { input: [applicable, z.value], output: [z.value] },
      `(lambda (pred lst) (filter (lambda (x) (not (pred x))) lst))`,
    ),
    "remove-if-not": symbol.define`remove-if-not: Common Lisp — keep the elements satisfying pred (a filter alias)`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (pred lst) (filter pred lst))`,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // RACKET — dict accessor family (Racket's dict library) — grain-completion
    // ═══════════════════════════════════════════════════════════════════════════
    // MCP-Atlas trajectory autopsy found models reaching for `dict-ref` to read a
    // field off a dict-shaped tool result and getting stranded (Unbound variable):
    // `@`/`:key` already read ANYTHING member-shaped (dict / membrane-foreign /
    // array — origin-agnostic, see the module header), but a model trained on
    // Racket's dict library reaches for its actual name. This family is that name,
    // PLUS the value `@` doesn't have: dict-ref/dict-keys/… are dict-SPECIFIC —
    // they guard the dict shape (see %dict-guard) so a wrong-shaped argument fails
    // loudly (door: fact + why + action) instead of silently reading nil through
    // `@`'s origin-agnostic fallback.
    //
    // CONTRACT JUDGMENT for the whole family: `d` is `z.value` ON PURPOSE, never
    // `z.dict()` — the %dict-guard TEACHING DOOR is the pack's own errors-as-doors
    // surface (fact + why + action, naming `@` as the origin-agnostic alternative),
    // and a `z.dict()` input contract would preempt it with a bare zod boundary
    // error, destroying the door. The guard IS the validator here; the contract
    // stays out of its way. (Pinned by the pre-migration suite's own
    // "errors with a door on a non-dict" rows, run unmodified.)
    //
    // %dict-guard — internal: the dict? guard shared by the whole family below.
    "%dict-guard": symbol.define`%dict-guard: the dict? teaching guard shared by the dict-* family — returns d when dict-shaped, else throws the fact+why+action door (private helper)`(
      { input: [z.string, z.value], output: [z.dict()] },
      `(lambda (who d)
         (if (dict? d)
             d
             (error (str who ": expected a dict (native {…} / (dict …) record), got "
                         (cond ((pair? d) "a pair/list")
                               ((vector? d) "a vector")
                               ((string? d) "a string")
                               ((number? d) "a number")
                               ((null? d) "'() (empty list)")
                               ((procedure? d) "a procedure")
                               (else "a foreign/membrane value"))
                         " — " who " guards the dict shape so a wrong-shaped argument "
                         "fails loudly instead of silently reading nil; use @ for an "
                         "origin-agnostic read across dict/array/foreign values instead"))))`,
    ),
    // dict-ref — Racket: read the value at key, with an optional failure-result
    // when key is missing. Same missing-key convention as get-in/@ (nil when no
    // default is given — NOT a second convention); key may be a keyword (:key), a
    // quoted symbol, or a string, normalized identically to @/:key. `@?` (not a
    // bare `@` nil-check) distinguishes "key truly missing" from "key present with
    // a nil/'() value" before falling back. The optional default rides inputRest
    // (0-or-1 rest arg — the scheme rest-parameter shape).
    "dict-ref": symbol.define`dict-ref: Racket — the value at key in d, or the optional default (nil when absent and no default); keys normalize like @/:key`(
      { input: [z.value, z.value], inputRest: z.value, output: [z.value] },
      `(lambda (d key . default)
         (%dict-guard "dict-ref" d)
         (if (@? d key)
             (@ d key)
             (if (null? default) nil (car default))))`,
    ),
    // dict-has-key? — Racket: #t iff key resolves in d. A dict-guarded alias of @?
    // (whose verdict is the boxed schemeBool — hence a real z.boolean output).
    "dict-has-key?": symbol.define`dict-has-key?: Racket — #t iff key resolves in d; a dict-guarded alias of @?`(
      { input: [z.value, z.value], output: [z.boolean] },
      `(lambda (d key)
         (%dict-guard "dict-has-key?" d)
         (@? d key))`,
    ),
    // dict-keys — Racket: d's own keys as a proper scheme list. `@keys` alone
    // returns a raw JS array — composes with length, but not map/filter (see
    // %dict-set's comment above) — so this lifts it via vector->list once, the same
    // move %dict-set already makes. Elements are the boxed AString keys `@keys`
    // mints → z.list(z.string).
    "dict-keys": symbol.define`dict-keys: Racket — d's own keys as a proper scheme list (the @keys array lifted via vector->list)`(
      { input: [z.value], output: [z.list(z.string)] },
      `(lambda (d)
         (%dict-guard "dict-keys" d)
         (vector->list (@keys d)))`,
    ),
    // dict-values — Racket: the value at each of d's keys, in dict-keys order.
    "dict-values": symbol.define`dict-values: Racket — the value at each of d's keys, in dict-keys order`(
      { input: [z.value], output: [z.list()] },
      `(lambda (d)
         (%dict-guard "dict-values" d)
         (map (lambda (k) (@ d k)) (dict-keys d)))`,
    ),
    // dict-count — Racket: the number of keys in d. `length` over a proper list
    // always yields an exact count (its own term boxes an AExact) → z.exact.
    "dict-count": symbol.define`dict-count: Racket — the number of keys in d`(
      { input: [z.value], output: [z.exact] },
      `(lambda (d)
         (%dict-guard "dict-count" d)
         (length (dict-keys d)))`,
    ),
    // dict->alist — d's entries as an alist of (key . value) pairs, in dict-keys
    // order. The inverse of alist->dict.
    "dict->alist": symbol.define`dict->alist: d's entries as an alist of (key . value) pairs, in dict-keys order — the inverse of alist->dict`(
      { input: [z.value], output: [z.list(z.pair)] },
      `(lambda (d)
         (%dict-guard "dict->alist" d)
         (map (lambda (k) (cons k (@ d k))) (dict-keys d)))`,
    ),
    // alist->dict — the inverse of dict->alist: build a dict from an alist of
    // (key . value) pairs. Each key may be a keyword/symbol/string — the same
    // normalization `dict` itself already applies to its own :key args. The one
    // dict-family input that IS a real typed spine: a proper list of pairs.
    "alist->dict": symbol.define`alist->dict: build a dict from an alist of (key . value) pairs — the inverse of dict->alist; keys normalize like dict's own`(
      { input: [z.list(z.pair)], output: [z.dict()] },
      `(lambda (alist)
         (apply dict (%interleave (map car alist) (map cdr alist))))`,
    ),
    // dict-set / dict-update — DOORS, not functions (V, 2026-07-04). This env is
    // immutable, and a "set"/"update" VERB reads as in-place mutation: a pure
    // implementation returning a new dict is a trap — the model believes it mutated
    // d, nothing changed, and the failure is silent (exactly the class the doors
    // program exists to delete). So the verbs exist only to teach the sanctioned
    // pure path: assoc-in/update-in + (define …). Same family as the SRFI-69
    // hash-table immutable-redirect stubs. SHAPELESS contracts (§1.2 carve-out,
    // one line each): the body unconditionally throws, so no input shape is ever
    // consumed and no output is ever produced — a fixed contract would be fiction.
    "dict-set": symbol.define`dict-set: a teaching DOOR — dicts are immutable here; build a NEW dict via assoc-in and bind it`(
      { input: [], inputRest: z.value, output: [z.value] },
      `(lambda _args
         (error (str "dict-set is not provided — dicts are immutable here, and a 'set' "
                     "verb implies in-place mutation, which never happens. Build a NEW "
                     "dict and bind it: (define d2 (assoc-in d (list :key) value)) — "
                     "the original d is unchanged.")))`,
    ),
    "dict-update": symbol.define`dict-update: a teaching DOOR — dicts are immutable here; build a NEW dict via update-in and bind it`(
      { input: [], inputRest: z.value, output: [z.value] },
      `(lambda _args
         (error (str "dict-update is not provided — dicts are immutable here, and an "
                     "'update' verb implies in-place mutation, which never happens. "
                     "Build a NEW dict and bind it: "
                     "(define d2 (update-in d (list :key) updater)) — "
                     "the original d is unchanged.")))`,
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // GUILE / EMACS LISP — accessor-name alias
    // ═══════════════════════════════════════════════════════════════════════════
    // assoc-ref — Guile/Emacs Lisp: read by key, same polyglot-idiom principle as
    // the threading family above (a model reaches for whichever accessor name it
    // already knows) — an alias of dict-ref, not a second read convention. Mirrors
    // dict-ref's contract exactly (including the z.value door-preserving d).
    "assoc-ref": symbol.define`assoc-ref: Guile/Emacs Lisp — read by key with an optional default; an alias of dict-ref, not a second read convention`(
      { input: [z.value, z.value], inputRest: z.value, output: [z.value] },
      `(lambda (d key . default)
         (apply dict-ref (cons d (cons key default))))`,
    ),
  },
});

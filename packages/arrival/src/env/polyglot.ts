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
// last :state). The reads are NOT in this prelude because they are native
// member-access primitives — `@` is a base binding, a `:`-prefixed symbol is
// self-evaluating and carries its own `apply` (`ASymbol.ts`) — but both bottom out
// in the same `arrival/tagless-final/get` protocol. This pack is their conceptual
// home; the definition is lifted onto
// the capability via `symbol.native` — a raw env.set bind (NOT rosetta-wrapped), so the
// membrane primitive is not routed through the membrane it implements.
//
// Wiring-only (no resources) → pause-trivial. NOTE: scoped to the self-contained
// idiom family — cut/cute (which need gensym + JS interop) ship as SRFI-26 instead.
//
// SINGLE SOURCE: `base-packs.ts` assembles `POLYGLOT_SCM` and
// evals it (via initBridge's assembleEnv), so this module is the sole definition site.

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import { hasMember, memberKeys, readMember } from "../membrane.js";
import { schemeBool } from "../values/op-helpers.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import { ADict, foldKeyName, type DictKey } from "../values/primitives/ADict.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { type SchemeValue } from "../values/types.js";

/** The polyglot idiom pack — the full member-access surface plus the threading family:
 *   • `@` / `@?` / `@keys` — the explicit member read/has/keys. `symbol.native` bindings
 *     (raw env.set, no codec — the typed equivalent of the old `{ value }`): they are
 *     membrane PRIMITIVES and must not be routed through the membrane they implement.
 *   • `:key` — the keyword accessor. Self-evaluating (`ASymbol` carries `apply` —
 *     keyword-tagless-apply.md), not a resolver contributed by this pack.
 *   • `-> / ->> / compose / pipe / …` — threading & composition (prelude).
 *  Module-singleton capability; `@`/`:key` bottom out in the same per-class `get`
 *  protocol (`arrival/tagless-final/get`) that `readMember` (membrane.ts) also uses. */
// IMPORT-ORDER SAFETY: `membrane.ts` is a heavy module (it pulls the evaluator) that
// can be MID-INITIALIZATION when this capability's spec object is evaluated — the
// assembly path imports it via `base-packs → polyglot → membrane → evaluator → …`, a
// cycle. Reading `readMember` at module-eval time would freeze the TDZ `undefined`
// into the spec. So defer every membrane read to APPLY time (when `initBridge`
// assembles, all modules are loaded): `symbols` uses the builder form.

export default new EnvCapability("scheme/polyglot", {
  prelude: `
    ;; -----------------------------------------------------------------------------
    ;; nil — the LIPS-dialect alias for the empty list (polyglot)
    ;; -----------------------------------------------------------------------------
    ;; Same principle as the threading idioms and :key accessors below: LLMs and
    ;; humans reach for whichever Lisp idiom they already know. R7RS spells the empty
    ;; list '() ; LIPS (and the Scheme the models were trained on) also binds the
    ;; symbol \`nil\` to it. It is one more dialect alias, so it lives in the polyglot
    ;; base rather than in a one-binding compat pack — and because polyglot is a base
    ;; pack assembled onto user_env, \`nil\` inherits everywhere (the inference plane is
    ;; a user_env child, so it gets it for free). \`'()\` reads to the ANil singleton,
    ;; so this binds exactly that.
    (define nil '())

    ;; -----------------------------------------------------------------------------
    ;; Threading & composition (polyglot)
    ;; -----------------------------------------------------------------------------
    ;; LLMs and humans reach for whichever Lisp/FP idiom they already know — the
    ;; same reason :key accessors exist. So accept the whole family rather than
    ;; force one dialect:
    ;;   ->  / ~>    thread the value as the FIRST argument  (Clojure -> , Racket ~>)
    ;;   ->> / ~>>   thread the value as the LAST argument    (Clojure ->>, Racket ~>>)
    ;;   compose / comp   right-to-left composition  ((compose f g) x) => (f (g x))
    ;;   pipe / flow      left-to-right composition   ((pipe f g) x)    => (g (f x))
    ;; Keyword accessors are first-class functions, so (->> p :versions last :state)
    ;; threads a value while (compose :state last :versions) names the pipeline.
    
    (define (compose . fns)
      (lambda args
        (let ((rfns (reverse fns)))
          (if (null? rfns)
              (if (null? args) #void (car args))
              (let loop ((fs (cdr rfns)) (acc (apply (car rfns) args)))
                (if (null? fs) acc (loop (cdr fs) ((car fs) acc))))))))
    (define comp compose)
    
    (define (pipe . fns)
      (lambda args
        (if (null? fns)
            (if (null? args) #void (car args))
            (let loop ((fs (cdr fns)) (acc (apply (car fns) args)))
              (if (null? fs) acc (loop (cdr fs) ((car fs) acc)))))))
    (define flow pipe)
    
    (define-macro (-> x . forms)
      (if (null? forms)
          x
          (let ((form (car forms)))
            \`(-> ,(if (pair? form)
                       (cons (car form) (cons x (cdr form)))
                       (list form x))
                 ,@(cdr forms)))))
    
    (define-macro (->> x . forms)
      (if (null? forms)
          x
          (let ((form (car forms)))
            \`(->> ,(if (pair? form)
                        (append form (list x))
                        (list form x))
                  ,@(cdr forms)))))
    
    (define-macro (~> x . forms) \`(-> ,x ,@forms))
    (define-macro (~>> x . forms) \`(->> ,x ,@forms))

    ;; -----------------------------------------------------------------------------
    ;; Cross-dialect stdlib completion (polyglot) — famous Clojure/CL symbols that
    ;; are PURE functions over primitives already bound here. Same principle as the
    ;; threading family above: an LLM (or human) reaching for a well-known symbol
    ;; from another dialect should get a REAL binding, not a teaching-stub door —
    ;; when the semantics are implementable without IO/mutation/macro machinery.
    ;; (The genuinely-impure/macro-only cousins — println, setf, defun, loop,
    ;; nreverse, for/list, for/fold, gethash, getf, hash-ref — are doored instead,
    ;; in env/polyglot-rich-errors/stubs.ts.) Every primitive these compose (map,
    ;; filter, reduce, append, dict, @, @keys, …) is verified bound elsewhere in
    ;; this pack or a sibling R7RS/SRFI pack.
    ;;
    ;; NOTE: \`first\` (SRFI-1), \`comp\` (alias above), \`flatten\` (r7rs/lists.ts,
    ;; LIPS extension) and \`curry\` (SRFI-235-adjacent, srfi-235.ts) are ALREADY
    ;; bound elsewhere — deliberately not redefined here.

    ;; %interleave — zip two equal-length lists into a flat (k v k v …) sequence,
    ;; the shape \`dict\`/\`apply\` expect. Private helper (% convention, see %chain-rel).
    (define (%interleave ks vs)
      (if (or (null? ks) (null? vs))
          '()
          (cons (car ks) (cons (car vs) (%interleave (cdr ks) (cdr vs))))))

    ;; %dict-set — a dict with key k rebuilt to value v, everything else preserved
    ;; (dicts are immutable — see HASH_TABLE_REASON in srfi-stubs.ts). Applied to nil
    ;; it builds a fresh single-key dict (@keys nil = '()), which is exactly what
    ;; assoc-in needs to create missing intermediate maps on demand. \`@keys\` returns
    ;; a raw JS array (not a scheme list — filter/map need the term protocol), so
    ;; \`vector->list\` (R7RS §6.8 — a raw JS array is representation-blind as a
    ;; vector here, per z.svector) lifts it first.
    ;; k v are placed LAST (not first): \`dict\`'s own key resolution (stringify, strip a
    ;; leading \`:\`) normalizes a keyword / symbol / string key to the
    ;; SAME underlying JS-object key as an already-stored string key — a plain \`equal?\`
    ;; comparison can't see that (a pluck closure is never \`equal?\` to a string), but
    ;; sequential \`obj[key] = value\` assignment naturally dedupes on the LAST write. So
    ;; no explicit exclusion is needed: k v simply overwrite whatever ks/vs already wrote.
    (define (%dict-set d k v)
      (let* ((ks (vector->list (@keys d)))
             (vs (map (lambda (key) (@ d key)) ks)))
        (apply dict (append (%interleave ks vs) (list k v)))))

    ;; str — Clojure: concatenate the display form of every arg. Strings pass
    ;; through as-is; everything else prints via \`repr\` (the external-representation
    ;; protocol, r7rs/equality.ts) before concatenating with string-append.
    (define (str . args)
      (apply string-append (map (lambda (x) (if (string? x) x (repr x))) args)))

    ;; get-in — Clojure: read a value nested ks-deep through dicts (or anything
    ;; \`@\` reads), nil if any step misses.
    (define (get-in obj ks)
      (if (null? ks)
          obj
          (get-in (@ obj (car ks)) (cdr ks))))

    ;; assoc-in — Clojure: a NEW obj with the value at nested path ks set to v,
    ;; building missing intermediate dicts as needed (see %dict-set).
    (define (assoc-in obj ks v)
      (if (null? ks)
          v
          (if (null? (cdr ks))
              (%dict-set obj (car ks) v)
              (%dict-set obj (car ks) (assoc-in (@ obj (car ks)) (cdr ks) v)))))

    ;; update-in — Clojure: assoc-in the result of applying f to the current value.
    (define (update-in obj ks f)
      (assoc-in obj ks (f (get-in obj ks))))

    ;; zipmap — Clojure: a dict pairing each key with the value at the same
    ;; position in vs.
    (define (zipmap ks vs) (apply dict (%interleave ks vs)))

    ;; frequencies — Clojure: a dict of each distinct element to its occurrence
    ;; count. Non-string elements key by their \`repr\` (dict keys are strings).
    (define (frequencies coll)
      (reduce
        (lambda (x acc)
          (let* ((k (if (string? x) x (repr x)))
                 (cur (@ acc k)))
            (%dict-set acc k (if (null? cur) 1 (+ cur 1)))))
        (dict)
        coll))

    ;; group-by — Clojure: a dict of (f element) to the list of elements that
    ;; produced it, in original order.
    (define (group-by f coll)
      (reduce
        (lambda (x acc)
          (let* ((k0 (f x))
                 (k (if (string? k0) k0 (repr k0)))
                 (cur (@ acc k)))
            (%dict-set acc k (append (if (null? cur) '() cur) (list x)))))
        (dict)
        coll))

    ;; partial — Clojure: fix the leading args of f, returning a function of the
    ;; rest.
    (define (partial f . args)
      (lambda more (apply f (append args more))))

    ;; juxt — Clojure: a function that applies every fn to the same args,
    ;; collecting the results into a list (in fn order).
    (define (juxt . fns)
      (lambda args
        (map (lambda (f) (apply f args)) fns)))

    ;; mapv / filterv — Clojure: map/filter with a vector result instead of a list.
    (define (mapv f . lists) (list->vector (apply map (cons f lists))))
    (define (filterv pred lst) (list->vector (filter pred lst)))

    ;; conj — Clojure: add items to a collection in its natural growth position —
    ;; the front for a list (each successive item conj'd onto the accumulating
    ;; result, so the LAST item passed ends up FIRST), the end for a vector.
    (define (%conj-list coll items)
      (if (null? items)
          coll
          (%conj-list (cons (car items) coll) (cdr items))))
    (define (conj coll . items)
      (if (vector? coll)
          (list->vector (append (vector->list coll) items))
          (%conj-list coll items)))

    ;; into — Clojure: pour every element of from into to via conj, in from's
    ;; order.
    (define (into to from)
      (reduce (lambda (x acc) (conj acc x)) to from))

    ;; rest — Clojure: cdr that tolerates a non-pair (nil) instead of erroring.
    (define (rest xs) (if (pair? xs) (cdr xs) '()))

    ;; empty? — Clojure: #t iff the list / string / vector / dict has no elements.
    ;; (\`@keys\` returns a raw JS array, not a scheme list — \`length\` accepts it
    ;; directly as a ".length carrier", r7rs/lists.ts, so no array->list needed here.)
    (define (empty? xs)
      (cond
        ((null? xs) #t)
        ((pair? xs) #f)
        ((string? xs) (= (string-length xs) 0))
        ((vector? xs) (= (vector-length xs) 0))
        ((dict? xs) (= (length (@keys xs)) 0))
        (else #f)))

    ;; mapcar — Common Lisp: identical argument order to R7RS map (proc, then one
    ;; or more lists), so it is a direct alias.
    (define (mapcar f . lists) (apply map (cons f lists)))

    ;; remove-if / remove-if-not — Common Lisp: filter, with the sense of the
    ;; predicate flipped / kept.
    (define (remove-if pred lst) (filter (lambda (x) (not (pred x))) lst))
    (define (remove-if-not pred lst) (filter pred lst))

    ;; -----------------------------------------------------------------------------
    ;; dict accessor family (Racket's dict library) — grain-completion
    ;; -----------------------------------------------------------------------------
    ;; MCP-Atlas trajectory autopsy found models reaching for \`dict-ref\` to read a
    ;; field off a dict-shaped tool result and getting stranded (Unbound variable):
    ;; \`@\`/\`:key\` already read ANYTHING member-shaped (dict / membrane-foreign /
    ;; array — origin-agnostic, see the module header), but a model trained on
    ;; Racket's dict library reaches for its actual name. This family is that name,
    ;; PLUS the value \`@\` doesn't have: dict-ref/dict-keys/… are dict-SPECIFIC —
    ;; they guard the dict shape (see %dict-guard) so a wrong-shaped argument fails
    ;; loudly (door: fact + why + action) instead of silently reading nil through
    ;; \`@\`'s origin-agnostic fallback.

    ;; %dict-guard — internal: the dict? guard shared by the whole family below.
    (define (%dict-guard who d)
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
                      "origin-agnostic read across dict/array/foreign values instead"))))

    ;; dict-ref — Racket: read the value at key, with an optional failure-result
    ;; when key is missing. Same missing-key convention as get-in/@ (nil when no
    ;; default is given — NOT a second convention); key may be a keyword (:key), a
    ;; quoted symbol, or a string, normalized identically to @/:key (readMember,
    ;; membrane.ts). \`@?\` (not a bare \`@\` nil-check) distinguishes "key truly
    ;; missing" from "key present with a nil/'() value" before falling back.
    (define (dict-ref d key . default)
      (%dict-guard "dict-ref" d)
      (if (@? d key)
          (@ d key)
          (if (null? default) nil (car default))))

    ;; dict-has-key? — Racket: #t iff key resolves in d. A dict-guarded alias of @?.
    (define (dict-has-key? d key)
      (%dict-guard "dict-has-key?" d)
      (@? d key))

    ;; dict-keys — Racket: d's own keys as a proper scheme list. \`@keys\` alone
    ;; returns a raw JS array — composes with length, but not map/filter (see
    ;; %dict-set's comment above) — so this lifts it via vector->list once, the same
    ;; move %dict-set already makes.
    (define (dict-keys d)
      (%dict-guard "dict-keys" d)
      (vector->list (@keys d)))

    ;; dict-values — Racket: the value at each of d's keys, in dict-keys order.
    (define (dict-values d)
      (%dict-guard "dict-values" d)
      (map (lambda (k) (@ d k)) (dict-keys d)))

    ;; dict-count — Racket: the number of keys in d.
    (define (dict-count d)
      (%dict-guard "dict-count" d)
      (length (dict-keys d)))

    ;; dict->alist — d's entries as an alist of (key . value) pairs, in dict-keys
    ;; order. The inverse of alist->dict.
    (define (dict->alist d)
      (%dict-guard "dict->alist" d)
      (map (lambda (k) (cons k (@ d k))) (dict-keys d)))

    ;; alist->dict — the inverse of dict->alist: build a dict from an alist of
    ;; (key . value) pairs. Each key may be a keyword/symbol/string — the same
    ;; normalization \`dict\` itself already applies to its own :key args.
    (define (alist->dict alist)
      (apply dict (%interleave (map car alist) (map cdr alist))))

    ;; dict-set / dict-update — DOORS, not functions (V, 2026-07-04). This env is
    ;; immutable, and a "set"/"update" VERB reads as in-place mutation: a pure
    ;; implementation returning a new dict is a trap — the model believes it mutated
    ;; d, nothing changed, and the failure is silent (exactly the class the doors
    ;; program exists to delete). So the verbs exist only to teach the sanctioned
    ;; pure path: assoc-in/update-in + (define …). Same family as the SRFI-69
    ;; hash-table immutable-redirect stubs.
    (define (dict-set . _args)
      (error (str "dict-set is not provided — dicts are immutable here, and a 'set' "
                  "verb implies in-place mutation, which never happens. Build a NEW "
                  "dict and bind it: (define d2 (assoc-in d (list :key) value)) — "
                  "the original d is unchanged.")))

    (define (dict-update . _args)
      (error (str "dict-update is not provided — dicts are immutable here, and an "
                  "'update' verb implies in-place mutation, which never happens. "
                  "Build a NEW dict and bind it: "
                  "(define d2 (update-in d (list :key) updater)) — "
                  "the original d is unchanged.")))

    ;; assoc-ref — Guile/Emacs Lisp: read by key, same polyglot-idiom principle as
    ;; the threading family above (a model reaches for whichever accessor name it
    ;; already knows) — an alias of dict-ref, not a second read convention.
    (define (assoc-ref d key . default)
      (apply dict-ref (cons d (cons key default))))
`,
  // The former `:key` keyword-accessor resolver lived here. `:`-prefixed symbols are now
  // self-evaluating (keyword-tagless-apply.md) — `ASymbol` itself carries `apply`, so this
  // pack contributes no resolvers at all anymore.
  symbols: () => ({
    // `obj`/`key` stay `z.value` on BOTH `@`/`@?`/`@keys` — genuinely host-blind inputs:
    // `readMember`/`hasMember`/`memberKeys` dispatch on `instanceof AJSObject` / `Array.isArray`
    // / plain-prototype checks, and are called directly with raw (non-scheme) JS values from
    // outside the evaluator too (see clone-identity.test.ts). The OUTPUT sides below were the
    // imprecise part — each op has a single, unconditional real return type; `z.value`
    // there was discarding it, not describing a genuinely-blind slot.
    "@": symbol.native`@: read a member — origin-agnostic (dict / membrane-foreign / array)`(
      // `readMember` always returns a real scheme value (nil / a boxed read / an AJSArray-
      // wrapped array) — never something OUTSIDE SchemeValue. `z.value` (the identity term for
      // "a polymorphic accessor's operand", scheme-zod.ts's own worked example) replaces the
      // `z.value` that was discarding this.
      { input: [z.value, z.value], output: [z.value] },
      readMember,
    ),
    "@?": symbol.native`@?: #t iff obj has the member key`(
      // The verdict is the boxed scheme face (schemeBool flyweight — Face split; the raw
      // JS boolean `hasMember` returns is a membrane-layer detail).
      { input: [z.value, z.value], output: [z.boolean] },
      (obj: unknown, key: unknown) => schemeBool(hasMember(obj, key)),
    ),
    "@keys": symbol.native`@keys: the own member keys of obj`(
      // `memberKeys` returns raw JS strings; the scheme face boxes each to AString
      // (z.array(z.string)'s scheme side — Face split).
      { input: [z.value], output: [z.array(z.string)] },
      (obj: unknown) => memberKeys(obj).map((k) => new AString(CONSTANT_CTX, k)),
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
      { input: z.array(z.value), output: [z.dict] },
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
  }),
});

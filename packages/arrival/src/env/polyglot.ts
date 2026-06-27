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
// member-access primitives — `@` is a base binding, a `:`-prefixed symbol resolves
// to a pluck closure in `Environment.get` — but both bottom out in the same
// membrane core. This pack is their conceptual home; the definition is lifted onto
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
import { hasMember, keywordAccessorResolver, memberKeys, readMember } from "../membrane.js";
import { KEYWORD_ACCESSOR_FIELD } from "../Environment.js";

/** The polyglot idiom pack — the full member-access surface plus the threading family:
 *   • `@` / `@?` / `@keys` — the explicit member read/has/keys. `symbol.native` bindings
 *     (raw env.set, no codec — the typed equivalent of the old `{ value }`): they are
 *     membrane PRIMITIVES and must not be routed through the membrane they implement.
 *   • `:key` — the keyword accessor, the `@`-alias, contributed as a catchall `resolver`.
 *   • `-> / ->> / compose / pipe / …` — threading & composition (prelude).
 *  Module-singleton capability; `@`/`:key` bottom out in one `readMember` (membrane.ts). */
// IMPORT-ORDER SAFETY: `membrane.ts` is a heavy module (it pulls the evaluator) that
// can be MID-INITIALIZATION when this capability's spec object is evaluated — the
// assembly path imports it via `base-packs → polyglot → membrane → evaluator → …`, a
// cycle. Reading `readMember` / `keywordAccessorResolver` at module-eval time would
// freeze the TDZ `undefined` into the spec; assembly would then `set("@", undefined)`
// and push an undefined resolver. So defer every membrane read to APPLY time (when
// `initBridge` assembles, all modules are loaded): `symbols` uses the builder form,
// and the resolver delegates through a stable wrapper whose `resolve` reads the live
// `keywordAccessorResolver` binding only when called.
export default new EnvCapability("scheme/polyglot", {
  prelude: `
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
`,
  resolvers: [{ id: "keyword-accessor", resolve: (name: string) => keywordAccessorResolver.resolve(name) }],
  symbols: () => ({
    "@": symbol.native`@: read a member — origin-agnostic (dict / membrane-foreign / array)`(
      { input: [z.unknown(), z.unknown()], output: [z.unknown()] },
      readMember,
    ),
    "@?": symbol.native`@?: #t iff obj has the member key`(
      { input: [z.unknown(), z.unknown()], output: [z.unknown()] },
      hasMember,
    ),
    "@keys": symbol.native`@keys: the own member keys of obj`(
      { input: [z.unknown()], output: [z.unknown()] },
      memberKeys,
    ),
    // `dict` — the Scheme-side companion to the `:key` accessor and the `@` read:
    // build an open-key map from interleaved `:key value` pairs. A keyword in arg
    // position evaluates to its pluck closure carrying the bare key on
    // KEYWORD_ACCESSOR_FIELD; dict reads that (else strips a leading `:`) to key the
    // plain object. Relocated VERBATIM from stdlib.ts global_env (husk dissolution);
    // the serializer prints it back as `(dict …)` and arrival-chain-view transpiles
    // it to a JS/Python object literal. (Plain `symbol.native`: dict reads no membrane
    // primitive, only KEYWORD_ACCESSOR_FIELD at call-time, so it needs no deferral.)
    dict: symbol.native`dict: an open-key map built from interleaved :key value pairs`(
      { input: z.array(z.unknown()), output: [z.unknown()] },
      (...args: unknown[]): unknown => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i + 1 < args.length; i += 2) {
          const k = args[i] as { [KEYWORD_ACCESSOR_FIELD]?: string } | null;
          const key =
            (k != null && (typeof k === "function" || typeof k === "object") && k[KEYWORD_ACCESSOR_FIELD]) ||
            String(args[i]).replace(/^:/, "");
          obj[key] = args[i + 1];
        }
        return obj;
      },
    ),
  }),
});

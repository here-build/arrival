// @inhuman.tools/arrival/env/polyglot-stubs — the CROSS-DIALECT teaching-stub pack,
// sibling in spirit to `env/srfi/srfi-stubs.ts` but a DIFFERENT population:
//
//   srfi/srfi-stubs.ts     — SRFI symbols the SPEC defines that arrival omits.
//   r7rs/host.ts           — the R7RS §6.13/§6.14 host-interface omission doors.
//   polyglot-stubs.ts      — symbols from OTHER dialects (Common Lisp / Racket /
//   (this file)              Clojure) with no SRFI/R7RS lineage at all, that a model
//                            trained across the whole Lisp family predictably reaches
//                            for anyway. A symbol belongs here iff no SRFI number /
//                            R7RS section covers it.
//
// Declaring a stub (rather than leaving the name silently absent) makes it
// typo-suggestible for free: typo suggestions derive from the chain's ACTUAL
// vocabulary (src/unbound-variable.ts), which includes these doors. The
// polyglot IMPLEMENTATION packs (env/polyglot.ts's shared core plus
// env/polyglot-clojure.ts / -lisp.ts / -racket.ts) hold the actual pure
// IMPLEMENTATIONS (str/mapcar/get-in/…); this pack holds the cross-dialect
// omission doors.
//
// Every symbol here is genuinely NOT a pure-function candidate — IO, in-place
// mutation, a macro too dialect-specific to generalize, or a hash-table type this
// runtime deliberately doesn't have (dicts are native and immutable instead; see
// srfi-stubs.ts family 1). The PURE, implementable cross-dialect symbols
// (mapcar, str, get-in, frequencies, conj, …) are real bindings in the
// implementation packs instead — a bare "Unbound variable" is a dead-end wall,
// but a symbol that CAN just work shouldn't get a "sorry, not here" stub either.
// This pack is only for the remainder: door the fact, the reason, and (where an
// honest one exists) the exact bound alternative.
//
// DIALECT SECTIONS (grouped internally, not a physical file split): unlike the
// implementation packs, doors carry no `deps`/FV-law weight a split would ever
// need to isolate — every `symbol.notImplemented` body unconditionally throws,
// so there is nothing here for the bake FV locality law to check, and splitting
// would only fragment the REASON constants (HASH_LIBRARY_REASON's Racket/CL
// spellings share one string; IO_REASON's Lisp/Clojure spellings share another)
// across files for zero functional gain. This pack remains ONE `EnvCapability`
// ("scheme/polyglot-stubs"), registered ONCE in base-packs.ts, matching the
// dialect table:
//   COMMON LISP  — type-of, gethash, getf, setf, defun, loop, nreverse,
//                  with-open-file, print.
//   CLOJURE      — println.
//   RACKET       — make-hash, make-hasheq, hash-ref, for/list, for/fold.
//   SHARED       — `<>` stays put: it's SRFI-26-adjacent (the cut/cute
//                  placeholder token), not any one dialect's idiom.
//
// SCOPE: registered as its own BASE_PACKS entry in base-packs.ts (NOT folded into
// allSrfi — it isn't a SRFI), so every env that inherits sandboxedEnv doors these
// symbols, same as srfi-stubs.ts.

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";

// Mirrors srfi-stubs.ts's HASH_TABLE_REASON verbatim (same design omission —
// dicts are native & immutable — reached via a different dialect's name for the
// same concept: Racket's make-hash/make-hasheq/hash-ref, CL's gethash/getf).
// Shared across the Common Lisp and Racket sections below (not duplicated —
// see the header's dialect-sectioning judgment).
const HASH_LIBRARY_REASON =
  "hash tables are not implemented — dicts are native and immutable here: build with {:key value ...} or (dict :key value ...), read with (:key d) or (@ d :key), enumerate keys with (@keys d); for iteration fold over (@keys d), and rebuild a fresh dict instead of mutating one in place";

// Shared across the Common Lisp and Clojure IO doors below (print/println).
const IO_REASON =
  "output is omitted from arrival by design — ambient IO has no construction-site to root a value's lineage at, the same reason random/date are omitted (see srfi-stubs.ts); return the value instead of printing it, it flows to the caller directly";

export default new EnvCapability("scheme/polyglot-stubs", {
  symbols: {
    // ═══════════════════════════════════════════════════════════════════════════
    // SHARED — not any one dialect's idiom
    // ═══════════════════════════════════════════════════════════════════════════
    // `<>` — SRFI-26 cut placeholder / SQL not-equal. A bare reference is a
    // genuine misuse either way — see srfi-26.ts, which recognizes `<>` only as
    // a string-matched placeholder INSIDE cut/cute's macro expansion, never as a
    // standalone bound symbol.
    "<>": symbol.notImplemented`<>: <> is not a standalone bound symbol — it has two real readings and neither is a bare value: (1) SRFI-26's cut/cute placeholder token, valid ONLY inside a (cut ...) / (cute ...) form, e.g. (cut f <>) — referenced bare it means nothing; (2) SQL's not-equal operator — if that's what you meant, use (not (equal? a b)) or (not (= a b))`,

    // ═══════════════════════════════════════════════════════════════════════════
    // COMMON LISP
    // ═══════════════════════════════════════════════════════════════════════════
    "type-of": symbol.notImplemented`type-of: type-of is not implemented — this runtime has no single reflective type-of-object function (Common Lisp CLHS); use the granular type predicates instead: pair?, string?, number?, symbol?, boolean?, vector?, dict?, procedure?, null?`,
    gethash: symbol.notImplemented`gethash: ${HASH_LIBRARY_REASON}`,
    getf: symbol.notImplemented`getf: ${HASH_LIBRARY_REASON}`,
    setf: symbol.notImplemented`setf: setf is not implemented — this is a pure sandbox with no in-place mutation of bindings or structures; rebind with (define ...) or thread a new value through instead of mutating one in place`,
    defun: symbol.notImplemented`defun: defun is not implemented — Common Lisp's function-definition form; use (define (name args ...) body ...) instead`,
    loop: symbol.notImplemented`loop: loop is not implemented — Common Lisp's iteration macro has no single compositional equivalent here; use named let, map/filter/reduce, or the SRFI-1 iteration helpers (iota, unfold, fold-right) instead`,
    nreverse: symbol.notImplemented`nreverse: nreverse is not implemented — it reverses a list destructively (in place); reverse (R7RS) is bound and returns a fresh reversed list instead`,
    // with-open-file — same design omission as r7rs/host.ts's port doors and its
    // §6.13.1 file-opener family (files arrive through TOOLS, not streams); this
    // spelling lives here because it is the CL macro, not an R7RS verb.
    "with-open-file": symbol.notImplemented`with-open-file: no file ports in this sandbox — files arrive through tools, not streams; call the filesystem tool bound in this environment (e.g. (filesystem/read_file :path "...")) and use the returned value directly`,
    print: symbol.notImplemented`print: ${IO_REASON}`,

    // ═══════════════════════════════════════════════════════════════════════════
    // CLOJURE
    // ═══════════════════════════════════════════════════════════════════════════
    println: symbol.notImplemented`println: ${IO_REASON}`,

    // ═══════════════════════════════════════════════════════════════════════════
    // RACKET
    // ═══════════════════════════════════════════════════════════════════════════
    "make-hash": symbol.notImplemented`make-hash: ${HASH_LIBRARY_REASON}`,
    "make-hasheq": symbol.notImplemented`make-hasheq: ${HASH_LIBRARY_REASON}`,
    "hash-ref": symbol.notImplemented`hash-ref: ${HASH_LIBRARY_REASON}`,
    "for/list": symbol.notImplemented`for/list: for/list is not implemented — Racket's iteration-comprehension macro (binding clauses like ([x lst]) over a body) has no direct equivalent here; use (map (lambda (x) body) lst) instead`,
    "for/fold": symbol.notImplemented`for/fold: for/fold is not implemented — Racket's accumulating-iteration macro has no direct equivalent here; use (reduce (lambda (x acc) body) initial lst) instead (see env/polyglot-clojure.ts's frequencies/group-by for worked examples)`,
  },
});

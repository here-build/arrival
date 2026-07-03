// @here.build/arrival/libraries/well-known-stubs — the CROSS-DIALECT teaching-stub
// pack, sibling in spirit to `env/srfi/srfi-stubs.ts` but a DIFFERENT population:
//
//   srfi-stubs.ts     — SRFI/R7RS symbols the SPEC defines that arrival omits.
//   well-known-stubs  — symbols from OTHER dialects (Common Lisp / Racket /
//   (this pack)         Clojure) with no SRFI/R7RS lineage at all, that a model
//                       trained across the whole Lisp family predictably reaches
//                       for anyway. Keep the two populations separate: a symbol
//                       belongs here iff no SRFI number covers it.
//
// Every symbol here is genuinely NOT a pure-function candidate — IO, in-place
// mutation, a macro too dialect-specific to generalize, or a hash-table type this
// runtime deliberately doesn't have (dicts are native and immutable instead; see
// srfi-stubs.ts family 1). The PURE, implementable cross-dialect symbols
// (mapcar, str, get-in, frequencies, conj, …) are real bindings in
// `env/polyglot.ts` instead — a bare "Unbound variable" is a dead-end wall, but a
// symbol that CAN just work shouldn't get a "sorry, not here" stub either. This
// pack is only for the remainder: door the fact, the reason, and (where an honest
// one exists) the exact bound alternative.
//
// Five families:
//   1. type-of (CL)        — no reflective type function; granular predicates instead.
//   2. <>                   — SRFI-26 cut placeholder / SQL not-equal, never a bare value.
//   3. hash-table constructors/accessors (Racket/CL spellings not already in
//      srfi-stubs.ts: make-hash, make-hasheq, hash-ref, gethash, getf) — dicts are
//      native & immutable, same redirect as srfi-stubs.ts's make-hash-table family.
//   4. IO (Clojure println/print) — ambient output has no construction-site to
//      root a value's lineage at, same tone as srfi-stubs.ts's RANDOM_REASON/
//      TIME_DATE_REASON design-omission doors.
//   5. Mutation / iteration macros too dialect-specific to generalize (CL setf,
//      defun, loop, nreverse; Racket for/list, for/fold) — each needs either
//      in-place mutation this pure sandbox forbids, or a binding-form macro
//      shaped enough around its own dialect that a compositional redirect would
//      be a bigger invention than a teaching door.
//
// SCOPE: registered as its own BASE_PACKS entry in base-packs.ts (NOT folded into
// allSrfi — it isn't a SRFI), so every env that inherits sandboxedEnv doors these
// symbols, same as srfi-stubs.ts.

import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

// ── 1. Common Lisp `type-of` ─────────────────────────────────────────────────
const TYPE_OF_REASON =
  "type-of is not implemented — this runtime has no single reflective type-of-object function (Common Lisp CLHS); use the granular type predicates instead: pair?, string?, number?, symbol?, boolean?, vector?, dict?, procedure?, null?";

// ── 2. `<>` — SRFI-26 cut placeholder / SQL not-equal ────────────────────────
// A bare reference is a genuine misuse either way — see srfi-26.ts, which
// recognizes `<>` only as a string-matched placeholder INSIDE cut/cute's macro
// expansion, never as a standalone bound symbol.
const CUT_OR_NOTEQUAL_REASON =
  "<> is not a standalone bound symbol — it has two real readings and neither is a bare value: (1) SRFI-26's cut/cute placeholder token, valid ONLY inside a (cut ...) / (cute ...) form, e.g. (cut f <>) — referenced bare it means nothing; (2) SQL's not-equal operator — if that's what you meant, use (not (equal? a b)) or (not (= a b))";

// ── 3. Hash-table spellings not already doored by srfi-stubs.ts ─────────────
// Mirrors srfi-stubs.ts's HASH_TABLE_REASON verbatim (same design omission —
// dicts are native & immutable — reached via a different dialect's name for the
// same concept: Racket's make-hash/make-hasheq/hash-ref, CL's gethash/getf).
const HASH_LIBRARY_REASON =
  "hash tables are not implemented — dicts are native and immutable here: build with {:key value ...} or (dict :key value ...), read with (:key d) or (@ d :key), enumerate keys with (@keys d); for iteration fold over (@keys d), and rebuild a fresh dict instead of mutating one in place";

// ── 4. IO (Clojure println / print) ──────────────────────────────────────────
const IO_REASON =
  "output is omitted from arrival by design — ambient IO has no construction-site to root a value's lineage at, the same reason random/date are omitted (see srfi-stubs.ts); return the value instead of printing it, it flows to the caller directly";

// ── 5. Mutation / dialect-specific iteration macros ──────────────────────────
const SETF_REASON =
  "setf is not implemented — this is a pure sandbox with no in-place mutation of bindings or structures; rebind with (define ...) or thread a new value through instead of mutating one in place";
const DEFUN_REASON = "defun is not implemented — Common Lisp's function-definition form; use (define (name args ...) body ...) instead";
const LOOP_REASON =
  "loop is not implemented — Common Lisp's iteration macro has no single compositional equivalent here; use named let, map/filter/reduce, or the SRFI-1 iteration helpers (iota, unfold, fold-right) instead";
const NREVERSE_REASON =
  "nreverse is not implemented — it reverses a list destructively (in place); reverse (R7RS) is bound and returns a fresh reversed list instead";
const FOR_LIST_REASON =
  "for/list is not implemented — Racket's iteration-comprehension macro (binding clauses like ([x lst]) over a body) has no direct equivalent here; use (map (lambda (x) body) lst) instead";
const FOR_FOLD_REASON =
  "for/fold is not implemented — Racket's accumulating-iteration macro has no direct equivalent here; use (reduce (lambda (x acc) body) initial lst) instead (see env/polyglot.ts's frequencies/group-by for worked examples)";

export default new EnvCapability("scheme/well-known-stubs", {
  symbols: {
    // 1. Common Lisp type-of
    "type-of": symbol.notImplemented`type-of: ${TYPE_OF_REASON}`,

    // 2. <> — SRFI-26 placeholder / SQL not-equal
    "<>": symbol.notImplemented`<>: ${CUT_OR_NOTEQUAL_REASON}`,

    // 3. Hash-table spellings (Racket + CL) not already in srfi-stubs.ts
    "make-hash": symbol.notImplemented`make-hash: ${HASH_LIBRARY_REASON}`,
    "make-hasheq": symbol.notImplemented`make-hasheq: ${HASH_LIBRARY_REASON}`,
    "hash-ref": symbol.notImplemented`hash-ref: ${HASH_LIBRARY_REASON}`,
    gethash: symbol.notImplemented`gethash: ${HASH_LIBRARY_REASON}`,
    getf: symbol.notImplemented`getf: ${HASH_LIBRARY_REASON}`,

    // 4. IO (Clojure)
    println: symbol.notImplemented`println: ${IO_REASON}`,
    print: symbol.notImplemented`print: ${IO_REASON}`,

    // 5. Mutation / dialect-specific iteration macros
    setf: symbol.notImplemented`setf: ${SETF_REASON}`,
    defun: symbol.notImplemented`defun: ${DEFUN_REASON}`,
    loop: symbol.notImplemented`loop: ${LOOP_REASON}`,
    nreverse: symbol.notImplemented`nreverse: ${NREVERSE_REASON}`,
    "for/list": symbol.notImplemented`for/list: ${FOR_LIST_REASON}`,
    "for/fold": symbol.notImplemented`for/fold: ${FOR_FOLD_REASON}`,
  },
});

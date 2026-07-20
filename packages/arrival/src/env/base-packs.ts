// BASE_PACKS — the scheme stdlib as a capability set, the pack-assembled base.
//
// These are the `scheme/*` capabilities. `initBridge` ASSEMBLES them onto user_env
// (assembleEnv) — this IS the scheme-stdlib load path. Each pack's prelude +
// symbols + resolvers become the LIVE source of the env's scheme surface.
//
// `scheme/core` is the precedence floor (constants, syntax-binding
// macros); everything else expands against it. The base preludes are verified
// mutually order-independent (no pack expands another's macro), so PRELUDE
// EVALUATION order is immaterial (every cross-capability reference lives inside a
// `lambda`/`define-macro` body — late-bound at CALL time, never at define time).
//
// ARRAY POSITION, however, doubles as a C3 precedence constraint the moment any
// member declares `deps` (kernel.ts's `c3Linearize` feeds this array's own order
// in as a merge input — the roots order gives the total order). C3 requires a
// dependency to be a "good head" ranked BELOW its dependent, so any pack that
// declares `deps` on names still positioned ahead of it in this array must move
// — dependents lead, dependencies trail. This is always behaviorally inert
// (every cross-capability reference is late-bound at CALL time, per the
// invariant above) but load-bearing for the C3 merge the moment a member
// declares `deps`.
//
// The tail block [racket, clojure, lisp, polyglot, srfi1, binding, exceptions,
// lists] is the current resolution of that constraint:
//   racket     — depends on clojure/polyglot/equality/numeric/vectors/lists/
//                exceptions; depended on by nothing else in this set.
//   clojure    — depended on by racket; depends on polyglot/srfi1/equality/
//                numeric/strings/vectors/lists.
//   lisp       — depends on srfi1/equality/lists; no ordering relationship of
//                its own to racket/clojure/polyglot (an independent branch —
//                its position among them is the zero-collateral choice).
//   polyglot   — depended on by srfi-235, clojure, racket; depends on equality/
//                lists (the shared core all three dialect packs sit on top of —
//                see polyglot.ts).
//   srfi1      — depended on by polyglot/clojure/lisp; depends on
//                exceptions/lists (multi-return binding surface is purity-doored;
//                span/partition use list products, no binding dep).
//   binding    — multi-return + set! doors only; no pack depends on it for FV, so it
//                keeps the tail as zero-collateral placement next to the other
//                repositioned R7RS packs.
//   exceptions — depended on by srfi-189, srfi-1, racket; leads lists (srfi-189's
//                and srfi-1's deps orders both say so).
//   lists      — depended on by srfi-235, srfi-128, srfi-189, srfi-1, polyglot,
//                clojure, lisp, racket: LAST, after every consumer.
//
// `equality`/`numeric`/`strings`/`vectors`/`chars` are NATIVE_PACKS members,
// never entries of this array, so they carry no ROOTS-order constraint and
// never need repositioning here.
//
// The polyglot family is four sibling packs sharing one dependency shape:
// `scheme/polyglot` (the shared core — `@`/`@?`/`@keys`/`dict`, `nil`,
// `compose`/`pipe`/`flow`, `%interleave`) plus three dialect packs —
// `scheme/polyglot-clojure` (`->`/`->>`/`comp` and the Clojure stdlib
// completion), `scheme/polyglot-lisp` (mapcar/remove-if/remove-if-not),
// `scheme/polyglot-racket` (`~>`/`~>>` aliasing Clojure's threading, the
// dict-library accessor family, and Guile's `assoc-ref`). `scheme/polyglot`
// (core) is itself a deps TARGET (srfi-235 depends on it for `compose`) and a
// dependent of every dialect pack (clojure/lisp/racket all declare `deps`
// reaching back to it) — hence its tail position, leading the three dialect
// packs while trailing behind them for its own dependents. Two of the three
// dialect packs also depend on each other: `scheme/polyglot-racket`'s `~>`/`~>>`
// expand to Clojure's `->`/`->>` (quasiquoted DATA, so the static FV walker
// doesn't force the edge — but the runtime expansion is a dead Unbound-variable
// trap without it, so the edge is declared anyway), and racket's
// dict-set/dict-update door messages + %dict-guard call Clojure's `str`. So
// `scheme/polyglot-racket` depends on `scheme/polyglot-clojure`, which depends
// on `scheme/polyglot` (core) + `scheme/srfi-1` + assorted R7RS natives — the
// same "dependents before dependencies WITHIN a deps array too" shape the tail
// block follows throughout; each dialect pack's own header carries the
// name-by-name census.

import type { EnvCapability } from "../common/capability.js";
import core from "./core/core.js";
import polyglotStubs from "./polyglot/polyglot-stubs.js";
import macros from "./macros/macros.js";
import polyglot from "./polyglot/polyglot.js";
import polyglotClojure from "./polyglot/polyglot-clojure.js";
import polyglotLisp from "./polyglot/polyglot-lisp.js";
import polyglotRacket from "./polyglot/polyglot-racket.js";
import { allR7rs, binding, exceptions, lists } from "./r7rs/index.js";
import { allSrfi, srfi1 } from "./srfi/index.js";

// `polyglotStubs` (env/polyglot/polyglot-stubs.ts) is its OWN entry — NOT folded into
// `allSrfi` — because it is not a SRFI: it doors cross-dialect (Common Lisp /
// Racket / Clojure) symbols with no SRFI/R7RS lineage at all. See its header.
//
// `binding`/`lists`/`exceptions` are pulled OUT of `...allR7rs`'s spread, and
// `srfi1` out of `...allSrfi`'s (filtered below), so they can be repositioned
// into the tail block — see the header comment above.
const r7rsWithoutRepositioned = allR7rs.filter((pack) => pack !== lists && pack !== exceptions && pack !== binding);
const srfiWithoutRepositioned = allSrfi.filter((pack) => pack !== srfi1);

export const BASE_PACKS: readonly EnvCapability[] = [
  core,
  macros,
  ...r7rsWithoutRepositioned,
  ...srfiWithoutRepositioned,
  polyglotStubs,
  // The C3 tail block — dependents first, dependencies after; see the header for
  // why POSITION (not just presence) is load-bearing once a member declares `deps`.
  polyglotRacket,
  polyglotClojure,
  polyglotLisp,
  polyglot,
  srfi1,
  binding,
  exceptions,
  lists,
];

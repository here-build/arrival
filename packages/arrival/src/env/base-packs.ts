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
// member declares `deps` (kernel.ts's `c3Linearize` feeds this array's own order in
// as a merge input — "the roots order gives the total order"). `scheme/srfi-235`
// (symbol-define-static-program-validation.md wave W4/H1) is the FIRST pack to
// declare real `deps` (on `polyglot` + `scheme/lists`, converting two prior
// assembly-order-luck references — `compose`, `not`/`length`/`apply`/`append` — into
// declared edges the bake FV law can check). C3 requires a dependency to be a "good
// head" ranked BELOW its dependent, which contradicts this array's PRIOR flat
// position (`polyglot`/`lists` both textually preceded `srfi-235`) — so `polyglot`
// and `lists` (r7rs/lists.ts) were placed LAST here, after every consumer.
// `scheme/srfi-189` (wave W4/H2b) adds a THIRD such target: it declares
// `deps: [equality, lists, exceptions]` (`error`, for `maybe-ref`/`either-ref`/
// `either-swap`'s failure path — see srfi-189.ts's header for why the real scheme
// `error` procedure, not a bare JS throw, is required for `with-exception-handler`
// fidelity). `equality` is a NATIVE_PACKS member (never an entry of this array, so
// no repositioning needed — same reasoning srfi-43's `deps: [equality, numeric,
// vectors]` already established). `exceptions` (r7rs/exceptions.ts) IS a
// BASE_PACKS member and, like `lists`/`polyglot` before srfi-235's fix, PRECEDED
// its new dependent (`allSrfi`, hence `srfi-189`) in this array — the identical C3
// conflict (empirically confirmed: `AssembleLinearizationError` on `initBridge()`
// before this fix), resolved the identical way. `exceptions` now joins
// `lists`/`polyglot` in the tail block — placed BEFORE them (not after) so the
// PRE-EXISTING pin "`lists` is the second-to-last member, immediately before
// `polyglot`" (r7rs/lists.ts's own migration test, ROW 7) stays true unchanged:
// `exceptions` has no ordering relationship of its own to `lists`/`polyglot` (no
// dep among the three names another), so any position in the tail block is C3-
// legal — leading it is the zero-collateral choice. Behaviorally inert (the
// "mutually order-independent" invariant above, unchanged — `guard`/`raise`/etc.
// are all `define-macro`/lambda bodies, late-bound at call time) but now also
// C3-consistent for any current or future `deps` declaration naming any of the
// three.
// `scheme/srfi-1` (wave W4/H3) adds the FOURTH target: `binding`
// (r7rs/binding.ts — `values`, which span/break/partition's bodies call). Same
// conflict (binding sat inside `...allR7rs`'s spread, BEFORE its new dependent in
// `allSrfi`), same resolution: `binding` joins the tail block. srfi-1's own
// `deps` array orders [… binding, exceptions, lists] to match this block, so the
// two C3 merge inputs (roots order, deps order) never contradict.
// `scheme/polyglot` (wave W4/H3, same wave — its own migration) became a DEPENDENT
// itself, the FIFTH restructuring: its migrated define bodies declared
// `deps: [srfi1, equality, numeric, strings, vectors, exceptions, lists]` (see
// polyglot.ts's header for the name-by-name census; `srfi1` LEADS that array
// because a dependent's linearization heads with itself — polyglot.ts's deps
// note). `equality`/`numeric`/`strings`/`vectors` are NATIVE_PACKS-only (no
// ROOTS-order constraint — srfi-43's precedent),
// but `srfi-1` (filter/reduce), `exceptions` (error) and `lists` (map/apply/…)
// ARE members, and ALL previously preceded polyglot — the identical C3 conflict.
// Resolution: `polyglot` moves UP to LEAD the tail block, `srfi1` is pulled out
// of `...allSrfi`'s spread to follow it, and `binding`/`exceptions`/`lists` trail
// in sibling-established order. Two coordinated pin/order updates landed in the
// same commit: `scheme/srfi-235`'s deps order became `[polyglot, equality,
// numeric, lists]` (its old `[…, lists, polyglot]` order was a merge input
// contradicting the new tail — and polyglot must LEAD outright, since
// L(polyglot) now heads itself before the natives it shares with srfi-235), and
// lists' migration-test ROW 7 re-pinned the tail
// (`lists` is now LAST outright; `polyglot` leads the tail rather than closing
// it). Behaviorally inert as ever (everything cross-capability is late-bound at
// CALL time) but C3-consistent for every `deps` edge declared then.
//
// `scheme/polyglot` DIALECT SPLIT (V, 2026-07-10) is the SIXTH restructuring, and
// the largest: the FIFTH restructuring's giant `deps: [srfi1, equality, numeric,
// strings, vectors, exceptions, lists]` was the whole polyglot family's combined
// reach — LIPS-dialect `nil` and the Racket/CL/Clojure idiom census — bundled into
// one pack because it hadn't yet been decomposed. It now has: `scheme/polyglot`
// (this file's `polyglot` import) SHRINKS to the shared core — `@`/`@?`/`@keys`/
// `dict`, `nil`, `compose`/`pipe`/`flow`, `%interleave` — and its own `deps`
// shrinks in step to `[equality, lists]` (polyglot.ts's header). Three new
// dialect packs pick up everything else: `scheme/polyglot-clojure`
// (polyglot-clojure.ts — `->`/`->>`/`comp`, and the Clojure stdlib completion:
// str/get-in/assoc-in/…/empty?), `scheme/polyglot-lisp` (polyglot-lisp.ts —
// mapcar/remove-if/remove-if-not), `scheme/polyglot-racket` (polyglot-racket.ts —
// `~>`/`~>>` aliasing Clojure's threading, the dict-library accessor family, and
// Guile's `assoc-ref`).
//
// Each dialect pack is, like the old monolith, BOTH a deps target (`scheme/
// polyglot` — unchanged, `compose` still lives there — remains srfi-235's dep,
// verified unaffected by this split) and a dependent (of the shared core, of
// `srfi-1`, of assorted R7RS natives). Two of the three ALSO depend on each
// other: `scheme/polyglot-racket`'s `~>`/`~>>` expand to Clojure's `->`/`->>`
// (quasiquoted DATA, so the static FV walker doesn't force the edge — but the
// runtime expansion is a dead Unbound-variable trap without it, so the edge is
// declared anyway; polyglot-racket.ts's header has the honest judgment call),
// and racket's dict-set/dict-update door messages + %dict-guard (relocated INTO
// polyglot-racket.ts, per its header's judgment — its only consumers are that
// pack's own dict-* family) call Clojure's `str`. So `scheme/polyglot-racket`
// depends on `scheme/polyglot-clojure`, which depends on `scheme/polyglot`
// (core) + `scheme/srfi-1` + assorted R7RS natives, which is exactly the same
// "dependents before dependencies WITHIN a deps array too" shape srfi-235.ts
// already established — each dialect pack's own header carries the full
// name-by-name census and ordering derivation.
//
// The resulting tail order [racket, clojure, lisp, polyglot, srfi1, binding,
// exceptions, lists]:
//   racket     — depends on clojure/polyglot/equality/numeric/vectors/lists/
//                exceptions; depended on by nothing else in this set.
//   clojure    — depended on by racket; depends on polyglot/srfi1/equality/
//                numeric/strings/vectors/lists.
//   lisp       — depends on srfi1/equality/lists; no ordering relationship of
//                its own to racket/clojure/polyglot (an independent branch —
//                its position among them is the zero-collateral choice).
//   polyglot   — depended on by srfi-235, clojure, racket; depends on equality/
//                lists (shrunk from the pre-split census — see polyglot.ts).
//   srfi1      — depended on by polyglot(pre-split)/clojure/lisp; depends on
//                binding/exceptions/lists.
//   binding    — depended on by srfi-1; no ordering relationship of its own to
//                exceptions/lists (leading them is the zero-collateral choice).
//   exceptions — depended on by srfi-189, srfi-1, racket; leads lists (srfi-189's
//                and srfi-1's deps orders both say so).
//   lists      — depended on by srfi-235, srfi-128, srfi-189, srfi-1, polyglot,
//                clojure, lisp, racket: LAST, after every consumer.

import type { EnvCapability } from "../common/capability.js";
import core from "./core/core.js";
import polyglotStubs from "./polyglot-stubs.js";
import macros from "./macros.js";
import polyglot from "./polyglot.js";
import polyglotClojure from "./polyglot-clojure.js";
import polyglotLisp from "./polyglot-lisp.js";
import polyglotRacket from "./polyglot-racket.js";
import { allR7rs, binding, exceptions, lists } from "./r7rs/index.js";
import { allSrfi, srfi1 } from "./srfi/index.js";

// `polyglotStubs` (env/polyglot-stubs.ts) is its OWN entry — NOT folded into
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

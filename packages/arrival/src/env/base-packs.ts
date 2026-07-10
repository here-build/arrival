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
// and `lists` (r7rs/lists.ts — the only two BASE_PACKS members any `deps` edge
// currently names) are placed LAST here, after every consumer. Behaviorally inert
// (the "mutually order-independent" invariant above, unchanged) but now also C3-
// consistent for any current or future `deps` declaration naming either of them.

import type { EnvCapability } from "../common/capability.js";
import core from "./core/core.js";
import polyglotStubs from "./polyglot-stubs.js";
import macros from "./macros.js";
import polyglot from "./polyglot.js";
import { allR7rs, lists } from "./r7rs/index.js";
import { allSrfi } from "./srfi/index.js";

// `polyglotStubs` (env/polyglot-stubs.ts) is its OWN entry — NOT folded into
// `allSrfi` — because it is not a SRFI: it doors cross-dialect (Common Lisp /
// Racket / Clojure) symbols with no SRFI/R7RS lineage at all. See its header.
//
// `lists` is pulled OUT of `...allR7rs`'s spread (filtered below) so it can be
// repositioned last alongside `polyglot` — see the header comment above.
const r7rsWithoutLists = allR7rs.filter((pack) => pack !== lists);

export const BASE_PACKS: readonly EnvCapability[] = [
  core,
  macros,
  ...r7rsWithoutLists,
  ...allSrfi,
  polyglotStubs,
  // Last: every `deps` edge declared anywhere in this array today (`scheme/srfi-235`)
  // names one of these two — see the header comment for why position, not just
  // presence, matters once a member declares `deps`.
  lists,
  polyglot,
];

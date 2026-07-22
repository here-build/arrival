// BASE_ROSTER — Stage C Cut 2 (docs/plans/stage-c-corpse-deletion.md, "THE LINCHPIN"): the FULL
// base capability set, self-hosting home. Exactly what `ensureBaseAssembled` (generator-exec.ts)
// lowers onto the legacy `global_env`/`user_env` realm frames for the AMBIENT path — NATIVE_PACKS
// (the JS-implemented R7RS domains) + BASE_PACKS (the `.scm` stdlib) — re-exported here as ONE
// roster so the VOCABULARY path can fold it into every run's own tuple instead of resolving
// builtins by parenting on a pre-baked realm singleton.
//
// THE CORNERSTONE (ledger): ambient and global/lexical scope are separate SPECIES. The vocabulary
// is the ambient — a frozen, pre-existing, un-forgeable map — and it must be SELF-HOSTING: a
// run's vocabulary is `buildVocabulary([...capabilities, ...BASE_ROSTER], config)`
// (generator-exec.ts's `execStateViaVocabulary`), never a child frame parented on `user_env`.
// `BASE_ROSTER` is what makes that fold possible: every base symbol (`+`, `map`, `car`, the whole
// scheme surface) becomes an ordinary member of the tuple's own C3 closure, baked by
// `env/vocabulary.ts`'s `buildVocabulary` exactly like a user capability's symbols are — not a
// parent-chain fallback.
//
// WHY THIS IS NOT `[...NATIVE_PACKS, ...BASE_PACKS]` — a genuine C3 conflict, found empirically
// (the full-suite run after the naive version): most of NATIVE_PACKS (`chars`/`strings`/
// `equality`/`numeric`/`vectors`) are ALREADY reachable — TRANSITIVELY, via `deps` — from several
// BASE_PACKS members (`scheme/polyglot-racket`: `deps: […, equality, numeric, …, vectors, …]`;
// `scheme/polyglot-clojure`: `deps: […, equality, numeric, strings, vectors, …]`; `scheme/srfi-1`,
// `srfi-43`, `srfi-128`, `srfi-235`, `scheme/polyglot` all name a compatible subset). Every one of
// those `deps` lists agrees on ONE partial order — equality before numeric before
// {strings/vectors/chars/exceptions/…} — which is exactly why BASE_PACKS' own closure already
// linearizes cleanly today (this is the SAME C3 walk `common/kernel.ts`'s `assembleEnv` already
// runs over BASE_PACKS, proven by the working bootstrap). Passing ALL of NATIVE_PACKS as
// ADDITIONAL CO-ROOTS re-asserts a SECOND, independent ordering constraint for that same
// {equality, numeric, vectors, …} set — NATIVE_PACKS's own array position (`chars, strings,
// vectors, bytevectors, equality, numeric, errorObjects` — vectors BEFORE equality BEFORE
// numeric) — which directly CONTRADICTS the deps-driven order above (equality BEFORE numeric
// BEFORE vectors). C3's synthetic root-list merge treats co-root order as a REAL constraint (not
// just an "if nothing else says otherwise" tie-break — see `common/dag-linearize.ts`'s `c3Order`:
// the root-name list is always one of the merge's own input lists), so this always throws
// `AssembleLinearizationError` ("inconsistent dependency precedence") the instant ANY
// vocabulary is built (even the bare-exec degenerate tuple — every real- and test-exec in the
// suite failed the same way).
//
// THE FIX — only add the NATIVE_PACKS members that are NOT already deps-reachable from BASE_PACKS
// (grep-verified: `bytevectors` and `errorObjects` are referenced by NOTHING else's `deps`
// anywhere in the package). Both have zero deps of their own and nothing depends on them, so
// adding them as extra roots asserts no relative order any OTHER list contests — trivially
// consistent. `chars`/`strings`/`equality`/`numeric`/`vectors` are left OUT of the explicit roots
// list entirely: they still land in the tuple's final closure and get bound into
// `Vocabulary.map` exactly like everyone else — reached transitively, the SAME way BASE_PACKS'
// own legacy assembly already reaches them, just never asserted as competing co-roots.
//
// ORDER — BASE_PACKS first, then the two standalone extras. Neither currently declares a
// `symbol.define`/`.spec.prelude` (grep-verified, Cut 2: zero `prelude:` fields and zero
// `kind: "define"`/`"define-syntax"` entries anywhere under NATIVE_PACKS/BASE_PACKS), so no
// bake-time evalScheme call anywhere in this roster depends on processing order today.
//
// CALLER-SIDE MERGE ORDER MATTERS, and is NOT this module's concern: `execStateViaVocabulary`
// builds `[...capabilities, ...BASE_ROSTER]` (user capabilities FIRST in the root list, this
// roster LAST) — see that function's own doc for why: independent roots with no `deps` edge
// between them keep root-list order as the C3 tie-break, and BASE_ROSTER must land at LOWER
// precedence (processed FIRST in the deps-first apply walk) so its bindings are already in the
// tuple's static core by the time any user capability's OWN `symbol.define` bakes — while a user
// capability keeps HIGHER precedence (self overwrites dep), matching the legacy ambient path's own
// child-wins union (`CompiledResolutionChain.ts`'s `compileResolutionChain`: a run's own
// capabilities frame was always the CLOSER layer, winning over the base).
//
// buildVocabulary/assembleRun themselves stay UNCHANGED — pure `capabilities → Vocabulary` (their
// own existing unit tests build small, isolated tuples with NO base roster mixed in). The
// self-hosting fold is `execStateViaVocabulary`'s own responsibility, not baked into either.

import type { EnvCapability } from "../common/capability.js";
import { BASE_PACKS } from "./base-packs.js";
import bytevectors from "./r7rs/bytevectors.js";
import errorObjects from "./r7rs/error-objects.js";

export const BASE_ROSTER: readonly EnvCapability[] = [...BASE_PACKS, bytevectors, errorObjects];

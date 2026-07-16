/**
 * LEGIBILITY — constitution §3.5's third-invention pass. As of E1a (engine
 * plan §2 E1a), this is PURE-REGION CSE ONLY: the other two legs — implicit
 * destruction and element-name singularization — DISSOLVED into the walker's
 * own naming pipeline (../naming/census.ts's use-shape analysis feeds
 * ../naming/allocate.ts's naming policy directly; ../walker/walk.ts commits
 * the result before `walk()` ever returns). Their knowledge is fully
 * preserved — `analyzeParam`/`cdrOffsetOf` and the `.map`-callback
 * singularize gate are ported verbatim into census.ts, now computed as a
 * READ over the tree instead of a decide-and-rewrite pass — but they are no
 * longer independently callable functions in this module.
 *
 * ── Why CSE alone still runs here, post-walk (unchanged reasoning) ─────────
 * CSE's eligibility (a REGISTRY read — `cacheClass`/`provenance`, constitution
 * §2.3) and its structural-equality grouping both need the FINISHED,
 * already-NAMED Residual tree — hoisting is a cross-occurrence dedup decision
 * the naming phase's per-site census was never structured to make (it census-
 * es binding SITES, not multi-occurrence EXPRESSION sharing). E2's plan
 * ("CSE and the peephole pair become sharing/idiom decision views… decided
 * pre-census so shared bindings get named like everything else" — engine plan
 * §2 E2) is where CSE's own knowledge pulls backward into the model; not this
 * wave.
 *
 * ── Pipeline placement: PRE-ASYNC-IFY (unchanged) ───────────────────────────
 * ASYNC-IFY's `typeOf` (async-ify.ts) treats a bare `Ref` as UNCONDITIONALLY
 * sync — "by the time a value is bound, every ordinary binding position has
 * already resolved it." Its `Const`/`ConstDecl` handling is completely
 * ordinary: `consume(init)` awaits the init iff `typeOf(init)` says promise.
 * CSE hoists two identical `(infer …)` calls to ONE `Const(__infer,
 * Call(RuntimeRef("infer"), args))` plus N `Ref(__infer)` reads — still
 * perfectly sync-shaped, per Law W. ASYNC-IFY then sees an ORDINARY Const
 * whose init is a seeded RuntimeRef call, and awaits it exactly like any
 * other seeded call; every read site is a `Ref`, which `typeOf` already
 * treats as sync. Running CSE after ASYNC-IFY would force its structural-
 * equality and eligibility checks to see THROUGH `Await` — a second,
 * Promise-aware code path Law W (rules and the walker are async-BLIND, on
 * purpose) exists to prevent.
 */
import { pureRegionCse } from "./cse.js";
import type { EmitRegistry } from "../registry/index.js";
import type { CompilationUnit } from "../residual/types.js";

export interface LegibilityOptions {
  /** The SAME registry `walk()` was given — CSE's purity gate reads
   *  `cacheClass`/`provenance` off it (constitution §2.3). */
  readonly registry: EmitRegistry;
}

/** The pass, in its (now singular) documented placement. Pure: never mutates
 *  `unit`. */
export function legibility(unit: CompilationUnit, opts: LegibilityOptions): CompilationUnit {
  return pureRegionCse(unit, opts.registry);
}

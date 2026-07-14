/**
 * LEGIBILITY — constitution §3.5's third-invention pass: implicit destruction +
 * element-name singularization + pure-region CSE, composed over the walker's
 * finished (sync-shaped) Residual tree.
 *
 * ── Pipeline placement: PRE-ASYNC-IFY (a documented deviation) ──────────────────
 *
 * The constitution's §3.1 pipeline diagram and §3.5 table both draw LEGIBILITY
 * AFTER ASYNC-IFY. This implementation places it BEFORE instead, for one
 * load-bearing reason:
 *
 * ASYNC-IFY's `typeOf` (async-ify.ts) treats a bare `Ref` as UNCONDITIONALLY
 * sync — "by the time a value is bound, every ordinary binding position has
 * already resolved it." Its `Const`/`ConstDecl` handling is completely ordinary:
 * `consume(init)` awaits the init iff `typeOf(init)` says promise. This means:
 *
 *   - CSE-before-ASYNC-IFY (chosen): two identical `(infer …)` calls dedup to
 *     ONE `Const(__infer, Call(RuntimeRef("infer"), args))` plus N `Ref(__infer)`
 *     reads — still perfectly sync-shaped, per Law W. ASYNC-IFY then sees an
 *     ORDINARY Const whose init is a seeded RuntimeRef call, and awaits it
 *     exactly like any other seeded call (`const __infer = await infer(...)`);
 *     every read site is a `Ref`, which `typeOf` already treats as sync. Zero
 *     new logic in either pass — CSE never has to know `Await` exists, and
 *     ASYNC-IFY never has to know CSE ran.
 *   - CSE-after-ASYNC-IFY (rejected): the two calls would already be wrapped
 *     (`Await(Call(...))`) by the time CSE ran, so CSE's structural-equality and
 *     eligibility checks would need to see THROUGH `Await` — a second,
 *     Promise-aware code path CSE has no other reason to carry. Worse, Law W
 *     (rules and the walker are async-BLIND, on purpose) would then have a
 *     second violator: CSE would need to reason about asyncness to do its job,
 *     re-introducing exactly the asyncness-leaking-into-a-sync-shaped-pass
 *     problem Law W exists to prevent.
 *
 * Legs 1–2 (destructure, singularize) are ORDER-NEUTRAL with respect to
 * ASYNC-IFY: ASYNC-IFY never inspects an Arrow's own parameter shapes, and a
 * `Method`'s receiver/callback identity survives its rewrites unchanged (the
 * `.map`-with-async-callback collapse wraps the WHOLE node; it does not touch
 * `recv` or the callback's param list). Since CSE's constraint is the only
 * one-directional requirement, and running all three legs at a single pipeline
 * point — rather than splitting LEGIBILITY into a pre- and a post-ASYNC-IFY half
 * — keeps the pipeline's insertion surface to one call, the WHOLE pass lands
 * pre-ASYNC-IFY. (Verified empirically too: `../__tests__/legibility.test.ts`'s
 * "infer pair deduped" golden exercises exactly this Const/await interaction
 * end to end.)
 *
 * ── Sub-pass ordering: destructure → singularize → CSE ──────────────────────────
 *
 * destructure-before-singularize: singularization only fires on an Arrow's SOLE,
 * still-`Binding`-shaped (not yet `ArrayPattern`) parameter (singularize.ts) —
 * running destructure first means a tuple param that GOT destructured is
 * naturally skipped by singularize (there is no longer a single scalar name to
 * improve; `[first, second]` already reads as intent), instead of the two legs
 * racing to rename the same slot.
 *
 * CSE-last: it works over the FINAL naming (post-destructure, post-singularize),
 * so its own `__`-prefixed temp names are minted against the most complete
 * "already taken" set — a CSE temp can never accidentally shadow a name either
 * earlier leg just introduced.
 */
import { pureRegionCse } from "./cse.js";
import { destructureParams } from "./destructure.js";
import { singularizeHofParams } from "./singularize.js";
import type { EmitRegistry } from "../registry/index.js";
import type { CompilationUnit } from "../residual/types.js";

export interface LegibilityOptions {
  /** The SAME registry `walk()` was given — CSE's purity gate reads
   *  `cacheClass`/`provenance` off it (constitution §2.3). */
  readonly registry: EmitRegistry;
}

/** The composed pass, in the documented order. Pure: never mutates `unit`. */
export function legibility(unit: CompilationUnit, opts: LegibilityOptions): CompilationUnit {
  const destructured = destructureParams(unit);
  const singularized = singularizeHofParams(destructured);
  return pureRegionCse(singularized, opts.registry);
}

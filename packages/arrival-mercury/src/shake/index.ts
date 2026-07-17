/**
 * THE SHAKE — E3's effect-preserving liveness pass (engine plan §2 E3):
 * "dead top-level defines + unreferenced requires pruned WHILE PRESERVING
 * EFFECTS — a sink or effectful top-level (provenance/cacheClass from the
 * registry says which — the §2.3 effect model) SURVIVES even if
 * unreferenced… 'Everything present is live' becomes the model's
 * post-condition invariant, and the census stops needing liveness caveats."
 *
 * SCOPE THIS WAVE (the plan's own red-first cut): DEFINES ONLY. Requires are
 * NOT pruned — "conservative: keep requires — module effects are the
 * loader's concern, prune only defines this wave, note requires" (the plan's
 * own words, verbatim). A `Require` node is therefore always an
 * unconditional root below, never a pruning candidate.
 *
 * THE ALGORITHM — a flat, name-keyed liveness fixpoint over ONE sibling
 * forms list (a program's true top level; today's actual caller,
 * `../oracle/harness.ts`'s `compileGreenfield`, hands it the oracle
 * wrapper's OWN body — the corpus program's real top-level defines live one
 * level inside `(define (__oracle-main) …)`, not in `classified.forms`
 * itself; see that module's own comment for the wrap-specific surgery):
 *
 *   1. Partition `forms` into named top-level `Define`/`DefineFn` entries and
 *      every OTHER form ("roots" — a bare expression, a `Require`, anything
 *      that executes unconditionally at this level and can therefore never
 *      be dead).
 *   2. A define is EFFECTFUL iff its own subtree calls a registry symbol
 *      whose declared `provenance` marks a real crossing (`isEffectfulSubtree`,
 *      below) — an unreferenced top-level `(infer …)` still burns budget /
 *      calls a model the moment the program runs, so deleting it changes
 *      OBSERVABLE behavior even though its VALUE is never read. This is a
 *      DIFFERENT question from CSE's dedup-safety gate (`../naming/
 *      shared-bindings.ts`), which reads the SAME two registry fields for a
 *      DIFFERENT purpose (see `NO_OWN_CROSSING`'s own doc for the worked
 *      contrast — `infer` is CSE-eligible, cacheClass "pure", yet still NOT
 *      shake-eligible).
 *   3. A define's NAME must SURVIVE iff it is free-referenced (transitively)
 *      from a root, from another surviving define's own value/body, OR it is
 *      itself EFFECTFUL (step 2) — effectfulness is seeded into the SAME
 *      liveness fixpoint as an unconditional root, not decided as an
 *      afterthought on top of it. THE LOAD-BEARING REASON: an effectful
 *      define that is ITSELF dead may still reference an otherwise-dead,
 *      otherwise-PURE sibling (`(define helper …) (define unused (helper
 *      (infer …)))` — `unused` is effectful and must survive; `helper` is
 *      referenced ONLY from `unused`'s own body, so pruning `helper` while
 *      keeping `unused` would leave `unused`'s reference to `helper`
 *      DANGLING — a real miscompile, not merely a missed optimization). One
 *      worklist fixpoint over BOTH seed classes (roots ∪ effectful defines)
 *      closes this: whatever an effectful-but-otherwise-dead define reaches
 *      is pulled along with it, transitively, exactly like root-reachability
 *      already was.
 *   4. Every surviving name is KEPT; everything else is DEAD and PRUNED (dead
 *      names are, by construction, never effectful and never referenced by
 *      anything that survives — step 3 already pulled in every name that
 *      would need them). For REPORTING, a surviving name that is NOT
 *      reachable from a true root (computed as a SEPARATE, root-only closure)
 *      lands in `keptForEffect` — whether because it is itself effectful, or
 *      because it is needed to support one that is (`helper`, above, reports
 *      here too — it survives on effect grounds just as surely as `unused`
 *      does, even though it has no crossing of its own).
 *
 * REDEFINITION (a top-level name defined more than once): declined entirely,
 * matching `../propagate/index.ts`'s `propagateTopLevelDefines` own stance
 * for the identical situation ("A name defined more than once at top level…
 * is never propagated — declines rather than guess which definition a
 * reference means"). Every same-named define is kept, unconditionally, when
 * its name is multiply-defined — this pass does not attempt to disambiguate
 * which one a reference resolves to.
 *
 * SOUNDNESS — the same "flat, unscoped, safe-direction over-approximation"
 * discipline `../peepholes/index.ts`'s shadow guard and `../propagate/
 * index.ts`'s `collectAllBoundNames` both use (their own headers explain why
 * porting the walker's real `schemeFrames` scope stack just to answer "is
 * this name free at this depth" would cost as much machinery as `walk()`
 * itself): `freeNamesIn` collects every `Ref`-mentioned name ANYWHERE in a
 * subtree, with NO scope awareness at all. A local parameter/let-binding
 * that happens to SHARE a name with a dead top-level define makes this
 * function (harmlessly) over-count that define as "referenced" — the safe
 * direction (Law F: declining an optimization is never wrong; the one wrong
 * direction — pruning something still needed — cannot happen this way).
 */
import type { ProvenanceRole } from "@inhuman.tools/arrival/symbol";

import type { CoreForm, Define, DefineFn, NodeId } from "../coreform/types.js";
import type { EmitRegistry } from "../registry/harvest.js";

/** One pruned or effect-kept entry — the reporting/testing surface. */
export interface ShakeEntry {
  readonly name: string;
  readonly id: NodeId;
}

export interface ShakeDecision {
  /** `forms` with every dead-and-pure define removed; order preserved among
   *  survivors. Identity fast path: `=== forms` (the SAME reference) when
   *  nothing was pruned — mirrors `materializeSharedBindings`/
   *  `materializeAsyncness`'s own "no groups ⇒ unit unchanged" convention. */
  readonly forms: readonly CoreForm[];
  /** Dead AND pure — removed. */
  readonly pruned: readonly ShakeEntry[];
  /** Dead but EFFECTFUL, or dead-but-redefined — kept on effect (or
   *  redefinition-safety) grounds; the reporting/testing surface for the
   *  red-first "dead effectful top-level is KEPT" case. */
  readonly keptForEffect: readonly ShakeEntry[];
}

/**
 * Provenance roles this pass treats as "no observable crossing of its own"
 * (constitution §2.3's effect model) — see the module header's step 3.
 * `undefined` = no declared role at all (the common case for a purely
 * overlay-authored rule row with no underlying arrival-core Contract, e.g.
 * this package's own `car`/`cdr` phase-1 rows — AND the safe default for any
 * symbol this pass has never heard of). `"pipe"` = the native/sequence/
 * tagless DEFAULT ("pure pass-through — propagate, never mint",
 * `_bake.ts`'s own words) — ordinary builtins (`+`, `string-append`, `car`)
 * resolve here; the `DEAD_DEFINE` fixture's `unused` (`string-append`) is
 * exactly this case. `"transparent"` = explicitly invisible to lineage by its
 * own name, included on the same textual authority even though no
 * declaration marks it yet (`_bake.ts`: "GRAPH-LAYER targets no declaration
 * marks yet").
 *
 * DELIBERATELY EXCLUDED (conservatively KEPT, never pruned, if ever dead):
 *
 *  - `"source"` — mints a fresh point; `infer`'s own resolved role
 *    (empirically confirmed: `provenance: "source"`, `cacheClass: "pure"`).
 *    THE WORKED CONTRAST this row exists to name: `infer` is CSE-ELIGIBLE
 *    (`../naming/shared-bindings.ts`'s `isEligible` reads `cacheClass ===
 *    "pure"` and gates OUT only `"sink"`/`"opaque"` — "source" passes) yet is
 *    NOT shake-eligible. CSE asks "can two occurrences share one call" (yes —
 *    cacheClass says repeated calls are value-equivalent); the shake asks
 *    "can the ONLY occurrence be deleted entirely" (no — cacheClass governs
 *    value-repeatability, never existence-of-effect; "budget burn is an
 *    explicit side-channel outside semantics", constitution §2.3). The
 *    plan's own worked example makes this the load-bearing case: "a dead
 *    EFFECTFUL top-level (an infer at top level, a write-file) is KEPT".
 *  - `"sink"` / `"opaque"` — the constitution's own "ordered, never-deduped,
 *    never-reordered class".
 *  - `"fan"` / `"loop"` — map/filter-shaped combinators (`map` resolves
 *    `provenance: "fan"` empirically). Whether the COMBINATOR itself is safe
 *    to drop when its own callback is provably pure is a real further
 *    question this wave does not attempt (it would need to reason THROUGH
 *    the callback, not just read one row) — declining is always safe, per
 *    Law F, so both stay in the "keep if dead" bucket until a future wave
 *    earns the widening.
 */
const NO_OWN_CROSSING = new Set<ProvenanceRole | undefined>([undefined, "pipe", "transparent"]);

// ── free-name collection (flat, unscoped — see the module header) ──────────

/** A missing case here silently drops that subtree's names/effects from the
 *  census — exactly the incomplete-walk hazard the sibling `propagate`
 *  module's guard exists for (its WALKER-NAMING audit finding #3): a future
 *  `CoreForm` kind fails to COMPILE at these call sites instead. */
function assertNever(f: never): never {
  throw new Error(`shake: unhandled CoreForm kind: ${JSON.stringify(f)}`);
}

function freeNamesIn(node: CoreForm, out: Set<string>): void {
  switch (node.kind) {
    case "Ref":
      out.add(node.name);
      return;
    case "Define":
      freeNamesIn(node.value, out);
      if (node.overridableType !== undefined) freeNamesIn(node.overridableType, out);
      return;
    case "DefineFn":
      for (const f of node.body) freeNamesIn(f, out);
      if (node.overridableType !== undefined) freeNamesIn(node.overridableType, out);
      return;
    case "Lambda":
      for (const f of node.body) freeNamesIn(f, out);
      return;
    case "If":
      freeNamesIn(node.cond, out);
      freeNamesIn(node.then, out);
      freeNamesIn(node.else, out);
      return;
    case "And":
    case "Or":
      for (const a of node.args) freeNamesIn(a, out);
      return;
    case "Let":
    case "NamedLet":
      for (const b of node.bindings) freeNamesIn(b.init, out);
      for (const f of node.body) freeNamesIn(f, out);
      return;
    case "Begin":
      for (const f of node.body) freeNamesIn(f, out);
      return;
    case "App":
      freeNamesIn(node.fn, out);
      for (const a of node.positionalArgs) freeNamesIn(a, out);
      for (const kw of node.kwargs) freeNamesIn(kw.value, out);
      return;
    case "Dict":
      for (const e of node.entries) freeNamesIn(e.value, out);
      return;
    case "Lit":
    case "Quote":
    case "Require":
    case "Door":
      return;
    default:
      return assertNever(node);
  }
}

// ── effect detection (registry-dependent — see the module header, step 3) ──

/** True iff `node`'s subtree contains an `App` whose free head resolves,
 *  through `registry`, to a row whose declared `provenance` is NOT in
 *  `NO_OWN_CROSSING` — i.e. a real crossing lives anywhere inside, at any
 *  depth (not just at `node`'s own top). A locally-shadowed name that
 *  happens to share text with an effectful registry symbol is (harmlessly)
 *  over-counted as effectful too — the same safe-direction over-
 *  approximation `freeNamesIn` makes, for the identical reason. */
function isEffectfulSubtree(node: CoreForm, registry: EmitRegistry): boolean {
  let found = false;
  const visit = (n: CoreForm): void => {
    if (found) return;
    if (n.kind === "App" && n.fn.kind === "Ref") {
      const row = registry.lookup(n.fn.name);
      if (row !== undefined && !NO_OWN_CROSSING.has(row.provenance)) {
        found = true;
        return;
      }
    }
    switch (n.kind) {
      case "Define":
        visit(n.value);
        if (n.overridableType !== undefined) visit(n.overridableType);
        return;
      case "DefineFn":
        for (const f of n.body) visit(f);
        if (n.overridableType !== undefined) visit(n.overridableType);
        return;
      case "Lambda":
        for (const f of n.body) visit(f);
        return;
      case "If":
        visit(n.cond);
        visit(n.then);
        visit(n.else);
        return;
      case "And":
      case "Or":
        for (const a of n.args) visit(a);
        return;
      case "Let":
      case "NamedLet":
        for (const b of n.bindings) visit(b.init);
        for (const f of n.body) visit(f);
        return;
      case "Begin":
        for (const f of n.body) visit(f);
        return;
      case "App":
        visit(n.fn);
        for (const a of n.positionalArgs) visit(a);
        for (const kw of n.kwargs) visit(kw.value);
        return;
      case "Dict":
        for (const e of n.entries) visit(e.value);
        return;
      case "Ref":
      case "Lit":
      case "Quote":
      case "Require":
      case "Door":
        return;
      default:
        return assertNever(n);
    }
  };
  visit(node);
  return found;
}

const isNamedDefine = (f: CoreForm): f is Define | DefineFn => f.kind === "Define" || f.kind === "DefineFn";

/**
 * `sm.shakeOf`'s underlying decision — see the module header. Pure; never
 * mutates `forms`.
 */
export function shakeTopLevel(forms: readonly CoreForm[], registry: EmitRegistry): ShakeDecision {
  const defines = forms.filter(isNamedDefine);
  if (defines.length === 0) return { forms, pruned: [], keptForEffect: [] };

  // Redefinition (module header): a multiply-defined name is EXCLUDED from
  // pruning consideration entirely — every define carrying it is kept,
  // unconditionally. The liveness fixpoint therefore scans EVERY definition's
  // body when such a name is reached — every one of those bodies survives in
  // the output, so a binding referenced solely from an EARLIER definition is
  // just as live as one the last definition needs (scanning only the
  // last-wins body pruned exactly that binding, leaving kept code with a
  // dangling reference — the pass's own no-dangling invariant broken).
  const defsByName = new Map<string, (Define | DefineFn)[]>();
  for (const d of defines) {
    const bucket = defsByName.get(d.name);
    if (bucket) bucket.push(d);
    else defsByName.set(d.name, [d]);
  }
  const singlyDefined = (name: string): boolean => defsByName.get(name)?.length === 1;

  // Effectfulness is a STATIC property of a define's own subtree (step 2 —
  // never depends on liveness), computed once, up front, for every
  // singly-defined name. A multiply-defined name is never a shake candidate
  // either way (module header), so it is never checked here.
  const effectfulNames = new Set<string>();
  for (const d of defines) {
    if (singlyDefined(d.name) && isEffectfulSubtree(d, registry)) effectfulNames.add(d.name);
  }

  const rootNames = new Set<string>();
  for (const f of forms) if (!isNamedDefine(f)) freeNamesIn(f, rootNames);

  /** ONE worklist fixpoint, parameterized over its seed set (step 3/4's own
   *  "two closures" design): `rootsOnly` computes root-reachability alone
   *  (the REPORTING baseline — distinguishes "genuinely demanded" from
   *  "surviving only because an effectful sibling needs it"); the real
   *  survivor set additionally seeds every effectful name as an
   *  unconditional root, so whatever an effectful-but-otherwise-dead define
   *  reaches is pulled along with it, transitively (the `helper`/`unused`
   *  soundness case — module header). */
  const closureOf = (extraSeeds: ReadonlySet<string>): Set<string> => {
    const reached = new Set<string>();
    const worklist: string[] = [];
    const markReached = (name: string): void => {
      if (defsByName.has(name) && !reached.has(name)) {
        reached.add(name);
        worklist.push(name);
      }
    };
    for (const n of rootNames) markReached(n);
    for (const n of extraSeeds) markReached(n);
    while (worklist.length > 0) {
      const name = worklist.pop()!;
      const refs = new Set<string>();
      for (const d of defsByName.get(name)!) freeNamesIn(d, refs);
      for (const n of refs) markReached(n);
    }
    return reached;
  };

  const reachableFromRoots = closureOf(new Set());
  const survivors = closureOf(effectfulNames);

  const pruned: ShakeEntry[] = [];
  const keptForEffect: ShakeEntry[] = [];
  const kept: CoreForm[] = [];
  let changed = false;
  for (const f of forms) {
    if (isNamedDefine(f) && singlyDefined(f.name) && !survivors.has(f.name)) {
      // Dead, and — by construction of `survivors` above — never itself
      // effectful and never needed by anything that survives. Safe to prune.
      pruned.push({ name: f.name, id: f.id });
      changed = true;
      continue;
    }
    if (isNamedDefine(f) && singlyDefined(f.name) && !reachableFromRoots.has(f.name)) {
      // Survives, but NOT via genuine root-reachability — the reporting
      // surface for the red-first "dead effectful top-level is KEPT" case
      // (covers both the effectful define itself and any otherwise-pure
      // sibling it transitively needs).
      keptForEffect.push({ name: f.name, id: f.id });
    }
    kept.push(f);
  }
  return { forms: changed ? kept : forms, pruned, keptForEffect };
}

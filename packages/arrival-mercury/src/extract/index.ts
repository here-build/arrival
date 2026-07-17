/**
 * extract — CoreForm → StaticProv, TOTAL (G1 scaffold, 2026-07-15).
 *
 * THE LAW (I1): total and fail-closed. Every CoreForm kind lifts to a
 * StaticProv or becomes `opaque` with a stable reason code. Mislabeling is the
 * only sin; `opaque` is always sound. The switch below is exhaustive WITHOUT a
 * default arm — tsc's return-type check is the totality proof; adding a 17th
 * CoreForm kind breaks this file at compile time, never silently at run time.
 *
 * Arm ownership (§2g arm-group cut; each arm is a separate module so the three
 * build in parallel — tsc exhaustiveness + this one dispatcher enforce I1
 * across the seam):
 *   ARM-A  atoms/bindings/structure  — Lit Ref Quote Define Let Begin Require Door
 *   ARM-B  application/control      — App DefineFn Lambda NamedLet If And Or
 *   ARM-C  containers + registry    — Dict, plus the HeadRegistry ARM-B calls
 *                                     for known primitive heads, plus string RLE
 *
 * Scope discipline is inherited from wire/derive.ts (its five hardenings are
 * the contract): binding-site scoping (a bound value carries the scope it was
 * bound IN), letKind honored (all four let kinds), beta-reduction of user
 * callees with a cycle guard (revisit ⇒ opaque "cyclic-binding"), kwargs folded
 * (never a silent forge channel), DefineFn in the top-level scope (the
 * named-helper forge died there).
 */
import type { CoreForm, NodeId } from "../coreform/types.js";
import type { HeadRegistry, StaticProv } from "../model/static-prov.js";

import { extractAtom } from "./arm-atoms.js";
import { extractControl } from "./arm-control.js";
import { extractContainer } from "./arm-containers.js";

/** A name bound in scope — either the EXPRESSION it was bound to plus the
 *  scope that expression must itself be read in (binding-site scoping,
 *  derive.ts hardening #2: without it, beta-reduction reads a callee's free
 *  names in the CALLER's scope and forges), or a SYNTHETIC attribution value
 *  directly (fan-body element/acc params — `buildFan` binds `element` to
 *  MuxProv{key:null} over the collection; there is no expr to defer to).
 *  ARM-A's Ref case returns `prov` directly when present. */
export type Bound = { readonly tag: "expr"; readonly expr: CoreForm; readonly scope: Scope } | { readonly tag: "prov"; readonly prov: StaticProv };

export interface Scope {
  readonly names: ReadonlyMap<string, Bound>;
  readonly parent: Scope | null;
}

export const EMPTY_SCOPE: Scope = { names: new Map(), parent: null };

export function lookup(scope: Scope, name: string): Bound | undefined {
  for (let s: Scope | null = scope; s; s = s.parent) {
    const hit = s.names.get(name);
    if (hit) return hit;
  }
  return undefined;
}

export interface ExtractCtx {
  readonly scope: Scope;
  readonly registry: HeadRegistry;
  /** Beta-reduction cycle guard (derive.ts hardening #1): forms currently being
   *  reduced; a revisit means recursion through bindings ⇒ the arm returns
   *  `opaque("cyclic-binding")` rather than diverging. */
  readonly reducing: ReadonlySet<CoreForm>;
  /** The shared-DAG memo (G2, 2026-07-16; upgraded to READ-SET memoization,
   *  #74, 2026-07-17): a Bound's `{tag:"expr"}` extraction, cached ON THE
   *  BOUND OBJECT — every Ref that `lookup()`s to the SAME Bound (a top-level
   *  `define`, a `let`-binding) shares the identical StaticProv object
   *  reference on every use WHOSE `reducing` set agrees with the entry's own
   *  recorded reads (`readSetMatches`, below — the soundness gate), turning
   *  the attribution TREE into the shared DAG a provenance circuit actually
   *  is (Deutch-Milo-Roy-Tannen, ICDT 2014). Beta-reduction creates FRESH
   *  Bound objects per call site (betaReduce's `paramNames.set(...,
   *  {tag:"expr", expr: allArgs[i], ...})`), so this WeakMap never conflates
   *  two different calls' argument attributions — object identity IS the
   *  sharing key, by construction. Created fresh per `extractProgram` run
   *  (never module-global — extract stays reentrant/pure across independent
   *  runs). See `extractRef` (arm-atoms.ts) for the cache's read/write
   *  discipline and `riskProbes`, below, for the read-set's own soundness
   *  argument. */
  readonly memo: WeakMap<Bound, MemoEntry>;
  /** The memo's safety mechanism (paired with `memo`, above) — a READ-SET,
   *  not a 1-bit flag. A Bound's extraction is sound to cache-and-reuse ONLY
   *  where `ctx.reducing`'s CONTENT agrees with what the ORIGINAL extraction
   *  observed — not merely "never hits a cycle," and not merely "never
   *  consulted `reducing` at all" (that first upgrade, #46, was already a
   *  refinement of a hypothetical all-or-nothing rule; this is the second:
   *  cache the CONDITION, not just its absence). A weaker rule — cache
   *  unless the result contains an `opaque("cyclic-binding")` anywhere — is
   *  UNSOUND: a Bound can extract cleanly through a non-recursive helper `h`
   *  on one path, yet the SAME Bound referenced from a DIFFERENT point
   *  already mid-reducing `h` via an unrelated call site hits
   *  `ctx.reducing.has(h)` and opaques instead — same Bound, same cached-
   *  candidate value, two genuinely different correct answers depending on
   *  the ambient `reducing` set at the reference point.
   *
   *  Concretely: `(define (idf x) x) (define shared (idf 42)) (define (f n)
   *  (if (= n 0) (idf shared) (f (- n 1))))` — resolving `shared` directly
   *  extracts cleanly (a ConstProv, zero opaques anywhere), but resolving it
   *  from inside `f`'s body — where `idf` is ALREADY mid-reduction for the
   *  OUTER `(idf shared)` call — must opaque on the INNER `(idf 42)`
   *  betaReduce (`ctx.reducing.has(idf)` now true). The direct reference's
   *  own extraction records exactly one consultation, `(idf, false)`; that
   *  is `shared`'s memo entry's read-set. The from-inside-`f` reference,
   *  before ever touching the memo, re-derives `shared`'s Bound and asks
   *  `readSetMatches`: does `ctx.reducing.has(idf)` STILL read `false` here?
   *  No — `idf` is already reducing — so the entry is (correctly) treated as
   *  inapplicable and `shared` is RE-EXTRACTED fresh at this reference
   *  point, reaching the same `ctx.reducing.has(idf)` check the direct path
   *  did, this time observing `true` and opaquing. Neither reference point
   *  ever sees the other's answer; caching the first, opaque-free result and
   *  serving it to the second site — what a 1-bit "was `reducing` ever
   *  consulted" rule is FORCED to refuse altogether, since both paths
   *  consult it — would silently swap in the wrong answer, and that is
   *  exactly the failure mode a per-binding read-set is precise enough to
   *  avoid while a boolean is not: the two paths' reads DISAGREE (`false` vs
   *  `true` on the same binding), so `readSetMatches` tells them apart
   *  instead of refusing to cache either.
   *
   *  `riskProbes` makes "which `reducing` memberships this extraction's
   *  answer depends on" a directly observable property instead of an
   *  unreliable output-shape proxy: `checkReducing` (below) is the ONE door
   *  every `ctx.reducing` consultation in this package goes through —
   *  `extractRef` here; `resolveCallee`/`betaReduce` in arm-control.ts;
   *  `buildFan` in arm-containers.ts — so a consultation and its recording
   *  can never come apart: asking "is `binding` reducing?" and recording the
   *  answer into every CURRENTLY ACTIVE probe are the same step, REGARDLESS
   *  of whether the check hits or misses — a miss recorded is a miss
   *  required at reuse time. `extractRef` pushes a fresh probe before
   *  attempting a new (uncached, or cache-inapplicable) resolution and
   *  ALWAYS writes the result to `memo` alongside whatever read-set that
   *  probe accumulated (an empty read-set — nothing anywhere in the
   *  resolution ever consulted `reducing` — trivially matches every future
   *  context, which is the #46 behavior as the read-set's own vacuous case).
   *  A served cache HIT replays its entry's own read-set into the current
   *  probes too (`replayReads`, below): the cached value's dependencies are
   *  exactly as load-bearing for an ENCLOSING attempt's own cacheability as
   *  a fresh consultation would have been — skipping that replay is what
   *  let a cache hit under-record an outer Bound's transitive dependencies
   *  (the idf/shared/f counterexample two paragraphs up is the worked
   *  failure this closes). (Nested resolutions push their OWN probe but
   *  still mark every ENCLOSING one: touching `reducing` at any depth —
   *  directly or via a replayed cache hit — is a real dependency of every
   *  in-flight ancestor attempt, not just the innermost — read-propagation,
   *  not just touch-propagation.) A probe list, not a single probe, because
   *  attempts nest (a cached-or-not Bound can defer to
   *  ANOTHER Bound partway through its own extraction). This is why the
   *  Bound's OWN registry-checked-once invariant (`registry` is one constant
   *  instance for a whole `extractProgram` run) doesn't need its own probe —
   *  only `reducing`'s content varies by call site, and it is the only one
   *  of the three ctx fields any code path ever branches on.
   *
   *  Immutability (the arrival-immutable-no-dynamics law) is what makes a
   *  MATCHED read permanent: the same binding, re-checked against the same
   *  observed membership, can never later disagree with itself mid-run —
   *  there is no `set!` to invalidate a read after the fact, so once
   *  `readSetMatches` confirms agreement the cached `result` is not a
   *  snapshot that might go stale, it simply IS the value this reference
   *  point would compute. */
  readonly riskProbes: readonly RiskProbe[];
}

/** One cached extraction outcome, paired with the READ-SET that makes it
 *  safe to reuse — see `ExtractCtx.memo`/`riskProbes`'s doc for the full
 *  soundness argument. `result` alone (the pre-#74 shape) is not enough: a
 *  Bound's extraction can be context-dependent on `reducing`'s content, so
 *  the entry must carry exactly WHICH consultations produced it, so a future
 *  reference point can check whether it would have observed the same
 *  answers. */
export interface MemoEntry {
  readonly reads: ReadonlyMap<CoreForm, boolean>;
  readonly result: StaticProv;
}

/** Does a memo entry's recorded read-set agree with the CURRENT `reducing`
 *  set at a new reference point — i.e., would every `ctx.reducing.has(
 *  binding)` consultation the original extraction performed return the SAME
 *  answer here? Iff so, the cached `result` is provably the exact value
 *  this reference point would itself compute (`ExtractCtx.riskProbes`'s doc
 *  has the full argument and the idf/shared/f worked counterexample). A
 *  binding never checked by the original extraction places no constraint at
 *  all — absence from `reads` is not a "false" reading, it is no reading,
 *  so an empty read-set (nothing ever consulted `reducing`) matches every
 *  context vacuously — the #46 all-clear case, subsumed here rather than
 *  special-cased. */
export function readSetMatches(reads: ReadonlyMap<CoreForm, boolean>, reducing: ReadonlySet<CoreForm>): boolean {
  for (const [binding, observed] of reads) {
    if (reducing.has(binding) !== observed) return false;
  }
  return true;
}

/** A mutable cell threaded through `ExtractCtx.riskProbes` — see `ExtractCtx.
 *  riskProbes`'s own doc for the full argument. Deliberately the one
 *  internally-mutable value in an otherwise immutable module: it never
 *  escapes `extract()`'s call tree and never appears in any returned
 *  StaticProv, so `extract` stays referentially transparent from every
 *  caller's perspective — this is bookkeeping for the cache's OWN soundness,
 *  not a language-level dynamics the arrival-immutable-no-dynamics law (which
 *  governs the SCHEME programs being analyzed, not this analyzer's internals)
 *  has any bearing on. */
export interface RiskProbe {
  /** Every `ctx.reducing.has(binding)` consultation observed during this
   *  attempt's own (possibly nested) recursive extraction, keyed by
   *  `binding` (last write wins — see `markRead`'s doc for why the same
   *  probe can never legitimately observe two different answers for the
   *  same binding, so overwriting is never lossy in practice). */
  readonly reads: Map<CoreForm, boolean>;
}

/** THE atomic door for every `ctx.reducing.has(binding)` consultation in this
 *  package (`extractRef` here; `resolveCallee`/`betaReduce` in
 *  arm-control.ts; `buildFan` in arm-containers.ts). Checking membership and
 *  recording the read used to be two separate statements at each call site,
 *  coordinated only by a repeated reminder comment — exactly the kind of
 *  rule a future edit can forget to honor. This door makes the pairing
 *  structural instead: there is no way to ask "is `binding` reducing?"
 *  without the answer landing in every currently-active risk probe, because
 *  asking IS recording — one function does both, in the same step. Returns
 *  the membership test's own result so a call site can branch on it
 *  directly: `if (checkReducing(ctx, binding)) return opaque(...)`. */
export function checkReducing(ctx: ExtractCtx, binding: CoreForm): boolean {
  const observed = ctx.reducing.has(binding);
  markRead(ctx, binding, observed);
  return observed;
}

/** Propagate an ALREADY-RECORDED read-set into every currently-active risk
 *  probe — call this whenever a memo hit serves a cached result in place of
 *  a fresh extraction (`extractRef`'s cache-hit branch, arm-atoms.ts),
 *  instead of re-deriving it. The bindings that produced the cached value
 *  are dependencies of THIS reference point's own answer too, exactly as if
 *  they had been consulted here directly — omitting the replay is what let
 *  a cache hit under-record an ENCLOSING attempt's own transitive
 *  dependencies (`ExtractCtx.riskProbes`'s doc has the soundness argument
 *  and the worked idf/shared/f counterexample this closes). A no-op when
 *  `reads` is empty or no probe is in flight, same as `markRead` itself. */
export function replayReads(ctx: ExtractCtx, reads: ReadonlyMap<CoreForm, boolean>): void {
  for (const [binding, observed] of reads) markRead(ctx, binding, observed);
}

/** `checkReducing`/`replayReads`'s shared primitive — record one binding's
 *  observed `reducing` membership into every currently-active probe. Not
 *  exported: every consultation of `reducing`'s content goes through
 *  `checkReducing`, and every replay of an already-recorded read-set goes
 *  through `replayReads`; nothing else has a reason to touch a probe
 *  directly.
 *
 *  Can the SAME probe ever observe two DIFFERENT answers for the SAME
 *  `binding`? No, by construction of `checkReducing`'s call sites: each
 *  returns IMMEDIATELY (opaque) when it reads `true`, so a probe's subtree
 *  never continues past a `true` reading to re-check the identical binding
 *  later; and `reducing` only ever GROWS going down through a single call
 *  chain (fresh `Set`s built by adding to a copy, never by removing), so two
 *  consultations of the same binding within one still-open probe's subtree
 *  cannot see a `true`-then-`false` transition either. `.set()`'s overwrite
 *  semantics are therefore never actually exercised on a genuine
 *  disagreement — they are here only because a `Map` is the natural
 *  accumulator, not because a conflict is expected. */
function markRead(ctx: ExtractCtx, binding: CoreForm, observed: boolean): void {
  for (const p of ctx.riskProbes) p.reads.set(binding, observed);
}

export const opaque = (site: NodeId, reason: string): StaticProv => ({ kind: "opaque", site, reason });

/** The one dispatcher. Exhaustive by tsc (no default): the totality proof. */
export function extract(form: CoreForm, ctx: ExtractCtx): StaticProv {
  switch (form.kind) {
    case "Lit":
    case "Ref":
    case "Quote":
    case "Define":
    case "Let":
    case "Begin":
    case "Require":
    case "Door":
      return extractAtom(form, ctx);
    case "App":
    case "DefineFn":
    case "Lambda":
    case "NamedLet":
    case "If":
    case "And":
    case "Or":
      return extractControl(form, ctx);
    case "Dict":
      return extractContainer(form, ctx);
  }
}

/** Which form in a defines-then-expressions body is the VALUE — the last
 *  form that is neither a `Define` nor a `DefineFn` (R7RS's internal-define
 *  idiom: defines pool at the front, in any position, and never compete to
 *  be the body's own value). All-defines body: fall back to the body's own
 *  last element (a bare top-level `Define` there attributes its value via
 *  ARM-A's own Define case). Empty body: undefined — every caller's own
 *  fail-closed opaque. Shared by `extractBody` (below — which ALSO builds
 *  the scope those defines populate) and `recognizeTailFold` (arm-control.ts,
 *  which only needs to KNOW which form is the value — a pure syntactic
 *  pre-check against the raw CoreForm, run before any scope/extraction
 *  machinery exists at all). */
export function lastValueForm(body: readonly CoreForm[]): CoreForm | undefined {
  let last: CoreForm | undefined;
  for (const f of body) {
    if (f.kind === "Define" || f.kind === "DefineFn") continue;
    last = f;
  }
  return last ?? body.at(-1);
}

/** THE ONE defines-then-expressions body walk (R7RS internal-define idiom).
 *  Every body-hosting construct shares this exact shape, so there is exactly
 *  one place that decides it: Begin/Let bodies (ARM-A), a beta-reduced
 *  callee's body (ARM-B), a fan lambda's body (ARM-C), and the program's own
 *  top-level form list (`extractProgram`, below) all walk THIS. A
 *  Define/DefineFn extends one body-local frame (visible to the rest of the
 *  body, self-referential — mutual visibility among internal helpers,
 *  letrec*-style); every other form is a candidate value, and the LAST one
 *  seen (`lastValueForm`) is the one actually extracted — earlier candidates
 *  are effect positions and are never walked (I1 needs their crossing sites
 *  to exist in the SOURCE, not in this return value). Empty body:
 *  `opaque(siteId, emptyReason)` — `emptyReason` lets each caller keep its
 *  own diagnostic ("empty-body" for an ordinary Begin/Let/callee body,
 *  "fan/empty-body" for a fan lambda, "empty-program" for a whole program
 *  with no value forms at all).
 *
 *  `define/overridable` (a `Define` with `overridableType` set) ALWAYS binds
 *  as a synthetic evidence-class InputProv, never its fallback expr, AT ANY
 *  DEPTH — not only at the program's own top level. The harness supplies
 *  overrides by NAME; nothing about that contract depends on how deeply the
 *  declaration is lexically nested, so a single uniform rule (checked here,
 *  once) is the honest policy — before this unification only
 *  `extractProgram`'s own copy of this walk ever checked `overridableType`
 *  at all, an accident of which copy happened to be written first, not a
 *  deliberate restriction (a nested `(let () (define/overridable e
 *  (s/string) "fallback") e)` used to silently attribute to "fallback"'s
 *  const — the shadowed-input forge's shape, one level removed from the
 *  case that fix already covers). `DefineFn`'s own `overridableType` (the
 *  fn-shorthand spelling, `(define/overridable (f params…) type body…)`,
 *  spec §4.8) is a SEPARATE, pre-existing gap: no copy of this walk ever
 *  checked it, at any depth, so there is no inconsistency to resolve by
 *  unifying — left exactly as-is, out of this fix's scope. */
export function extractBody(
  body: readonly CoreForm[],
  ctx: ExtractCtx,
  siteId: NodeId,
  emptyReason = "empty-body",
): StaticProv {
  const names = new Map<string, Bound>();
  const frame: Scope = { names, parent: ctx.scope };
  for (const f of body) {
    if (f.kind === "Define") {
      names.set(
        f.name,
        f.overridableType !== undefined
          ? { tag: "prov", prov: { kind: "input", site: f.id, name: f.name } }
          : { tag: "expr", expr: f.value, scope: frame },
      );
    } else if (f.kind === "DefineFn") {
      names.set(f.name, { tag: "expr", expr: f, scope: frame });
    }
  }
  const target = lastValueForm(body);
  if (target === undefined) return opaque(siteId, emptyReason);
  return extract(target, { ...ctx, scope: frame });
}

/** Program-level entry: the top level is just the outermost body (parent
 *  scope `null`) — `extractBody` (above) already IS this walk, so this is a
 *  direct call, not a copy of it. Returns the attribution of the LAST value
 *  form (the program's result, matching discovery-run's `userForms.at(-1)`
 *  convention). */
export function extractProgram(forms: readonly CoreForm[], registry: HeadRegistry): StaticProv {
  const ctx: ExtractCtx = { scope: EMPTY_SCOPE, registry, reducing: new Set(), memo: new WeakMap(), riskProbes: [] };
  return extractBody(forms, ctx, 0 as NodeId, "empty-program");
}

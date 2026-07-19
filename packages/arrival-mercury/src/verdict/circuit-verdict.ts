/**
 * T4 — the static verdict channel: the circuit's OWN reading, no probe.
 *
 * `wire/policy.ts` answers the seal's two structural questions (`dataShaped`,
 * `judgmentShaped`) by walking a `WireDescriptor`
 * (docs/foundations/arrival-scheme/provenance-by-perturbation.md §3). This
 * module answers the SAME two questions over the circuit that retires it —
 * `StaticProv` (src/model/static-prov.ts) — so the seal's static leg can
 * re-point from `wire/policy` to `extract`'s output
 * (docs/working-proposals/scheme-semantic-model-synthesis.md §2g). Mirrors
 * `wire/policy.ts`'s naming (`dataShaped`,
 * `judgmentShaped`) so that re-point is mechanical. Imports NOTHING from
 * `wire/` — the circuit stands alone on the `StaticProv` types.
 *
 * `judgmentShaped` here takes no `vocabulary` argument, unlike its
 * `wire/policy` namesake: this module answers "is the circuit SHAPED like a
 * judgment" (a finite, evidence-guarded choice among the program's own
 * constants); checking those constants against a DECLARED output schema is a
 * downstream concern (T6c's conjunction, which owns the schema) and does not
 * belong to the circuit reading.
 *
 * ── The two channels ─────────────────────────────────────────────────────────
 *
 * `channels` folds a circuit bottom-up into two TERMINAL sets, in one pass:
 *   - **content** — what can flow INTO the value (a `choice`'s ALTS; a
 *     `fan`'s body AND — the element mux — its collection; the
 *     sources/parts/runs of `fused`/`mux`/`build`/`string`). A `mint` is a
 *     TERMINAL content anchor — never its `closed`.
 *   - **selection** — what grounds WHICH value was chosen (a `choice`'s
 *     GUARDS; a `mint`'s `closed` inputs — the crossing's OWN inputs ground
 *     why it fired, never what it contains, static-prov.ts's `MintProv` doc;
 *     and, when a `fan` is `collapse:"route"`-shaped [min/max/last/filter-
 *     survivor], the collection ALSO plays a selection role — which element
 *     wins is itself a data-dependent choice, exactly like a guard).
 *
 * A channel is `{ anchors, consts, opaques }`: `anchors` are the reachable
 * `input`/`mint` terminals (kind + integrity + site, for reporting — never
 * compared on, never load-bearing by themselves); `consts`/`opaques` are bare
 * counts, because WHICH const or opaque is reachable never matters to a
 * verdict, only that one is.
 *
 * ── Why one flat union is sound: the absorptive lattice ─────────────────────
 *
 * Every composite node folds children's content into content and children's
 * selection into selection by SET UNION — `fused`/`mux`/`build`/`string` are
 * transparent; `choice` routes alts→content and guards→selection (a guard's
 * FULL contribution, content and its own nested selection both); `fan` routes
 * body+collection→content and body+collection→selection, additionally
 * promoting the collection's CONTENT into selection when `collapse:"route"`.
 *
 * A `const`, an `opaque`, or an ambient-integrity anchor is ABSORPTIVE under
 * this union (Dannert–Grädel–Naaf–Tannen, CSL 2021 — absorptive-semiring
 * fixpoint theory): introduced anywhere in a subtree, it propagates to every
 * ancestor's content channel and cannot be diluted by a clean sibling. That is
 * exactly why `dataShaped` needs no per-`choice`-alt recursion to enforce "the
 * adversary picks the branch, every world must ground" (perturbation.md §3):
 * one flat union over the WHOLE tree already computes that conjunction, at
 * every depth, because a bad leaf anywhere can only make the aggregate worse,
 * never better — union is monotone in badness. `judgmentShaped`'s per-guard
 * requirement ("at least one evidence anchor reaches EVERY guard") is the one
 * place this shortcut does NOT apply: universal-then-existential across a
 * guard LIST cannot be read off one flattened union, so it calls `channels`
 * again on each guard individually (still one O(size) pass per guard, still
 * no fuel — see below).
 *
 * ── No fuel, no fixpoint: why a plain recursive walk terminates ─────────────
 *
 * `extract`'s cycle guard (beta-reduction with a revisit-set — perturbation.md
 * §3's named-helper fix) lifts every recursive/cyclic construct to `opaque`
 * AT THE PRODUCER: a `StaticProv` this module ever receives is already a
 * finite, acyclic graph. Shared sub-objects may repeat under multiple parents
 * (the type is a "provenance CIRCUIT," Deutch-Milo-Roy-Tannen ICDT 2014 —
 * DAG-shared BY OBJECT IDENTITY since `extract`'s own memo, `ExtractCtx.memo`
 * in src/extract/index.ts, G2), but repetition under distinct parents is not
 * a cycle, and a bottom-up fold terminates on the DISTINCT-node count either
 * way (memoized here by identity, `channelsMemo` below, purely so a node with
 * high in-degree folds once instead of once per incoming edge — never a
 * fixpoint concern, see below).
 *
 * This memoization does NOT weaken `(- (:v e) (:v e))`'s own guard: those two
 * `(:v e)` reads are two SEPARATE `App` nodes over an unbound name — `e`
 * resolves through extractRef's free-name path (never a Bound, never
 * `ExtractCtx.memo`'d), so they produce two DISTINCT `MuxProv`/`InputProv`
 * OBJECTS, and `channelsMemo` folds each independently and counts `e` twice,
 * exactly as seal.ts's worked example requires — the counting the probe
 * relies on is about REPEATED EVIDENCE READS at runtime, and it survives
 * completely intact because it was never about object identity to begin
 * with. What DOES now fold once is the case that IS the same object — two
 * Refs to one `define`/`let` binding (`(define xs (:v e)) (- xs xs)`) — and
 * this is sound for every check this module performs: `dataShaped` and
 * `guardGroundsInEvidence` only ever test PRESENCE (`anchors.length > 0`,
 * `.some(...)`, `.every(...)`) or EXACT-ZERO (`consts === 0`, `opaques ===
 * 0`) — never a multiplicity threshold — and both kinds of test are
 * reachability properties, invariant under how many incoming edges a shared
 * node has. Folding `xs` once instead of twice changes `anchors.length` from
 * 2 to 1 but never changes whether zero is reachable or whether an anchor
 * exists; no verdict this module returns can depend on a count a future
 * change might introduce without re-examining this note.
 *
 * The Knaster-Tarski least-fixpoint machinery the design docs invoke
 * (scheme-semantic-model-synthesis.md §2c) governs `extract`'s OWN dialect
 * evaluation — resolving a recursive user definition or a fold's accumulator
 * into circuit-plus-aggregation form is a genuine fixpoint problem, solved
 * once, at the producer, over a lattice that DOES admit cycles internally.
 * By the time a circuit reaches this module that problem is already closed:
 * a single bottom-up pass over a finite, already-resolved tree IS its own
 * least fixpoint (no cycle left to iterate against). If a circuit ever
 * arrives here containing a real cycle, the tree claim was violated
 * upstream — STOP and report it; do not silently add a fuel counter (a
 * budget-truncated walk under-approximates the const/opaque set, which is
 * exactly the forgeable partial attribution I1 forbids).
 */
import type { NodeId } from "../coreform/types.js";
import type { ChoiceProv, Integrity, MuxProv, StaticProv } from "../model/static-prov.js";

// ── The channel shape ────────────────────────────────────────────────────────

/** One reachable `input`/`mint` terminal. `site` rides along for reporting
 *  (which crossing/parameter grounded this channel) — it is never compared on
 *  and never load-bearing for a verdict; only `integrity` and the presence of
 *  the entry are. */
export interface ChannelAnchor {
  readonly kind: "mint" | "input";
  readonly integrity: Integrity;
  readonly site: NodeId;
}

/** One channel's reachable terminals. `consts`/`opaques` are bare counts —
 *  WHICH const or opaque is reachable never matters to a verdict, only that
 *  one is (see header, "absorptive lattice"). */
export interface ChannelTerminals {
  readonly anchors: readonly ChannelAnchor[];
  readonly consts: number;
  readonly opaques: number;
}

export interface Channels {
  readonly content: ChannelTerminals;
  readonly selection: ChannelTerminals;
}

const EMPTY: ChannelTerminals = { anchors: [], consts: 0, opaques: 0 };

/** Absorptive union: badness (`consts`, `opaques`, a non-evidence anchor) can
 *  only accumulate across parts; a clean sibling never dilutes an unclean
 *  one. Reused for both channels at every composite node. */
function unionTerminals(parts: readonly ChannelTerminals[]): ChannelTerminals {
  const anchors: ChannelAnchor[] = [];
  let consts = 0;
  let opaques = 0;
  for (const part of parts) {
    anchors.push(...part.anchors);
    consts += part.consts;
    opaques += part.opaques;
  }
  return { anchors, consts, opaques };
}

// ── mux narrowing (the shared where-provenance rule) ─────────────────────────

/** The three-way partition a statically-keyed projection makes over its
 *  source. `parts` = the candidate part attributions the key selects
 *  (exactly one for a unique key; the CANDIDATE union for a duplicate-keyed
 *  container); `dead` = the 0-hit fail-closed sub-case (the key is provably
 *  absent from a literal container); `whole` = no narrowing applies (null/
 *  dynamic key, or a non-build source) and the whole source is the sound
 *  over-approximation. */
export type MuxNarrowing =
  | { readonly kind: "parts"; readonly parts: readonly StaticProv[] }
  | { readonly kind: "dead" }
  | { readonly kind: "whole" };

/**
 * Where-provenance narrowing (Buneman-Khanna-Tan, ICDT 2001 — §2d borrow
 * table): the projected value's provenance is the provenance of the PART it
 * was copied FROM, not the whole container. When the source is a
 * statically-keyed build and the projection key names specific part(s),
 * NARROW to those parts — a sibling part's const (a `(dict :v (infer …) :other
 * "FAKE")` decoy, or an alist pair's own quoted key) genuinely never flows to
 * `(:v e)` at runtime, so inheriting the whole container's channels
 * over-refuses (it is sound-but-blind: it blocks the entire field-access
 * evidence idiom).
 *
 * SOUNDNESS of narrowing (why removing siblings cannot hide a forge):
 * `(:v e)` returns ONLY the v-part; the decoy in `:other` never appears
 * in the output, so attributing the output to v alone is exactly correct.
 * Fail-closed fallbacks keep it sound where the key is not statically
 * resolvable: a null key (dynamic index), a key matching NO part
 * (out-of-range / unknown field), or MULTIPLE matching parts (a
 * duplicate-keyed alist, where runtime picks one but statically we cannot
 * say which) all fall back to the whole-source channels — the
 * conservative over-approximation, never a narrowing that could drop a
 * reachable const.
 *
 * A BuildProv's parts are the COMPLETE static part set (a literal
 * container; a dynamically-extended one extracts as mux/fused/opaque
 * over a base, not a build). So a statically-resolvable key partitions
 * three ways — see `MuxNarrowing`.
 *
 * THE ONE SHARED HELPER: this rule
 * has two callers — `channels()`'s mux arm (the verdict fold) and the compose
 * projection's `access.dead` mark (`compose-template.ts`) — and any future
 * `fieldProv` descent. One function, N callers, so the narrowing rule can
 * never drift between the verdict and a render.
 */
export function narrowMux(prov: MuxProv): MuxNarrowing {
  const src = prov.source;
  if (prov.key !== null && src.kind === "build") {
    const hits = src.parts.filter((p) => p.key === prov.key);
    // 1 part → exact where-provenance. >1 (a duplicate-keyed container,
    // runtime picks one) → the CANDIDATES: sound (the value is one of them)
    // and still excludes irrelevant siblings. Never widens to the whole
    // container.
    if (hits.length >= 1) return { kind: "parts", parts: hits.map((p) => p.prov) };
    // 0 parts → the field is PROVABLY ABSENT from this literal container;
    // the projection is nil/absent at runtime, grounded in nothing.
    return { kind: "dead" };
  }
  // Null key (dynamic index — could be ANY part) or a non-build source
  // (projection of an input/fused/mint): no narrowing applies.
  return { kind: "whole" };
}

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * Fold a circuit into its two attribution channels, bottom-up, in ONE pass —
 * MEMOIZED by `StaticProv` object identity within this one top-level call —
 * the shared-DAG follow-through: `extract`'s own memo,
 * `ExtractCtx.memo` in src/extract/index.ts, is what makes two Refs to one
 * binding share the identical object; this is what a CONSUMER of that
 * sharing does with it. Safe to call again on any sub-circuit (a guard, a
 * collection) exactly as on the whole circuit — `judgmentShaped` does this
 * per guard, each such call getting its OWN fresh memo (`channels` creates
 * one per invocation, below) — see the header for why no fuel is needed
 * either way. PURE: this is strictly a performance change over an
 * already-acyclic DAG (`extract`'s cycle guard is what guarantees that), not
 * a semantics change — unlike the extract-side memo, there is no ambient
 * context here for a cached value to accidentally depend on (`channelsFresh`
 * is a plain bottom-up fold: a node's `Channels` is a pure function of its
 * children's already-computed `Channels`, nothing else), so memoizing by
 * identity is unconditionally sound — no analog of `ExtractCtx.riskProbes`
 * is needed here. Without this, a shared node under many parents (the
 * pathological case this fix exists for) would be RE-WALKED once per
 * incoming edge — the exact "per-use re-derivation" the fused-provenance
 * thesis rules out; with it, each distinct node folds exactly once,
 * regardless of its in-degree.
 */
export function channels(prov: StaticProv): Channels {
  return channelsMemo(prov, new Map());
}

/** Memoizing dispatcher: a cache hit returns the SAME `Channels` object
 *  computed the first time this exact `prov` reference was folded within the
 *  CURRENT top-level `channels()` call; a miss computes it via
 *  `channelsFresh`, caches, and returns. */
function channelsMemo(prov: StaticProv, memo: Map<StaticProv, Channels>): Channels {
  const cached = memo.get(prov);
  if (cached !== undefined) return cached;
  const result = channelsFresh(prov, memo);
  memo.set(prov, result);
  return result;
}

/**
 * The exhaustive per-kind fold for a NOT-YET-memoized `prov`. Exhaustive over
 * `StaticProv`'s ten members WITHOUT a `default` arm: tsc's return-type check
 * is the totality proof, mirroring `extract`'s own dispatcher
 * (src/extract/index.ts). Called only from `channelsMemo`, above; every
 * recursive reference to a child goes back through `channelsMemo` (never a
 * bare recursive call to this function, and never to the public `channels`,
 * which would start a FRESH memo per child and defeat the point).
 */
function channelsFresh(prov: StaticProv, memo: Map<StaticProv, Channels>): Channels {
  switch (prov.kind) {
    case "input":
      // Evidence-class by construction (static-prov.ts's `InputProv` doc) —
      // there is no `integrity` field on `InputProv` to read because there is
      // only ever one answer.
      return {
        content: { anchors: [{ kind: "input", integrity: "evidence", site: prov.site }], consts: 0, opaques: 0 },
        selection: EMPTY,
      };

    case "mint": {
      // The mint's own identity is the CONTENT anchor. `closed` — the
      // crossing's own inputs — grounds SELECTION only, recursively (both
      // halves of each closed input's own channels: a closed input can
      // itself carry further selection structure, e.g. a nested mint).
      const closed = prov.closed.map((c) => channelsMemo(c, memo));
      return {
        content: { anchors: [{ kind: "mint", integrity: prov.integrity, site: prov.site }], consts: 0, opaques: 0 },
        selection: unionTerminals(closed.flatMap((c) => [c.content, c.selection])),
      };
    }

    case "const":
      return { content: { anchors: [], consts: 1, opaques: 0 }, selection: EMPTY };

    case "opaque":
      return { content: { anchors: [], consts: 0, opaques: 1 }, selection: EMPTY };

    case "fused": {
      const parts = prov.sources.map((c) => channelsMemo(c, memo));
      return {
        content: unionTerminals(parts.map((p) => p.content)),
        selection: unionTerminals(parts.map((p) => p.selection)),
      };
    }

    case "mux": {
      // Where-provenance narrowing — the rule itself lives in `narrowMux`
      // (above), SHARED with the compose projection's dead-mark so the two
      // can never drift; this arm only folds the partition it returns.
      const narrowed = narrowMux(prov);
      if (narrowed.kind === "parts") {
        return {
          content: unionTerminals(narrowed.parts.map((p) => channelsMemo(p, memo).content)),
          selection: unionTerminals(narrowed.parts.map((p) => channelsMemo(p, memo).selection)),
        };
      }
      if (narrowed.kind === "dead") {
        // 0 parts → provably absent. Empty content would vacuously satisfy
        // dataShaped (every-anchor-evidence over ∅ is true), so fail closed
        // EXPLICITLY with an opaque — "this projection lands on no known
        // part," a not-attestable, never a spurious attestation of an absent
        // value.
        return { content: { anchors: [], consts: 0, opaques: 1 }, selection: EMPTY };
      }
      // No narrowing applies: the whole source is the sound over-approximation.
      return channelsMemo(prov.source, memo);
    }

    case "build": {
      const parts = prov.parts.map((p) => channelsMemo(p.prov, memo));
      return {
        content: unionTerminals(parts.map((p) => p.content)),
        selection: unionTerminals(parts.map((p) => p.selection)),
      };
    }

    case "string": {
      const parts = prov.runs.map((c) => channelsMemo(c, memo));
      return {
        content: unionTerminals(parts.map((p) => p.content)),
        selection: unionTerminals(parts.map((p) => p.selection)),
      };
    }

    case "choice": {
      // The one place content and selection cross: alts feed the parent's
      // content; guards feed the parent's selection IN FULL (a guard's own
      // content AND its own nested selection both — a guard can itself
      // contain a further choice or mint). An alt's own nested selection
      // (a further choice inside it) also bubbles into the parent's
      // selection, so a tower of nested guards all ground one outer verdict.
      const alts = prov.alts.map((a) => channelsMemo(a, memo));
      const guards = prov.guards.map((g) => channelsMemo(g, memo));
      return {
        content: unionTerminals(alts.map((a) => a.content)),
        selection: unionTerminals([...alts.map((a) => a.selection), ...guards.map((g) => g.content), ...guards.map((g) => g.selection)]),
      };
    }

    case "fan": {
      // Content: the body AND the collection, unconditionally — the body's
      // per-element references reach the collection through the element mux,
      // but this module never assumes that embedding; it unions the
      // collection in explicitly regardless of how extract wires the body.
      const body = channelsMemo(prov.body, memo);
      const collection = channelsMemo(prov.collection, memo);
      const selectionParts = [body.selection, collection.selection];
      // `route` (min/max/last/filter-survivor): the fan IS a choice over the
      // collection's own elements — the collection's CONTENT grounds WHICH
      // element wins, exactly as a choice's guard grounds its own selection.
      // `combine`/`lowered` carry no such role: every element contributes
      // (combine) or the body's own internal choices already ground
      // themselves (lowered).
      if (prov.collapse === "route") selectionParts.push(collection.content);
      return {
        content: unionTerminals([body.content, collection.content]),
        selection: unionTerminals(selectionParts),
      };
    }
  }
}

// ── dataShaped ───────────────────────────────────────────────────────────────

/**
 * TRUE iff every content path from the root reaches an evidence-class anchor
 * (an `input`, or a `mint` with `integrity:"evidence"`) and no content
 * position anywhere carries a `const` or an `opaque`. An ambient-integrity
 * anchor anywhere in content is ALSO disqualifying — the ungrounded-ambient
 * reading (static-prov.ts's `Integrity` doc): `(now)`/`(uuid)` are real
 * crossings, never fabrications, but they are not EVIDENCE.
 *
 * Reads as one flat check over `channels(prov).content` — see the header's
 * "absorptive lattice" note for why this already enforces "every `choice` alt
 * must independently be data-shaped" without recursing per alt.
 */
export function dataShaped(prov: StaticProv): boolean {
  const { anchors, consts, opaques } = channels(prov).content;
  return consts === 0 && opaques === 0 && anchors.length > 0 && anchors.every((a) => a.integrity === "evidence");
}

// ── judgmentShaped ───────────────────────────────────────────────────────────

/** A leaf that is exactly `{kind:"const"}` — never a `fused`/`mux`/`string`
 *  wrapping one. Mirrors `wire/policy.ts`'s `isBareLiteral` discipline: a
 *  transformed constant (`(string-upcase "yes")`) is not "the program's own
 *  constant" in the simple sense a judgment slot licenses; `const` has no
 *  further structure to wrap in the circuit's world, so the check collapses
 *  to a bare `kind` test. */
function isBareConst(prov: StaticProv): boolean {
  return prov.kind === "const";
}

/**
 * A guard grounds selection iff (a) no `opaque` is reachable from it at all
 * — content or its own nested selection — and (b) at least one evidence-class
 * anchor is reachable, through either channel (a guard can itself contain a
 * further choice/mint, so its own selection can supply the anchor as easily
 * as its content). Unlike `dataShaped`'s content check, a guard MAY carry
 * `const`s (a comparison threshold is the author's judgment, not a
 * fabrication — the `1000` in `(< (:v e) 1000)`) and needs only ONE evidence
 * anchor, not an all-evidence aggregate: a guard is never itself presented as
 * data.
 *
 * JUDGMENT CALL (opaque-in-guard): the contract's rule for `judgmentShaped`
 * states only the evidence-existential ("at least one evidence anchor
 * reaches every guard"); the separate blanket rule for `circuitVerdict`
 * ("opaque ANYWHERE in a relevant channel → not-attestable for that role")
 * does not name guards explicitly. A guard is unambiguously part of the
 * judgment role's relevant surface, and an opaque region is exactly where an
 * adversary hides a forged selection alongside a decoy evidence read — read
 * narrowly, the evidence-existential alone would let
 * `fused[(:flag e), opaque]` ground a guard on the real anchor while the
 * opaque half does anything undetectable. Failing closed here (rejecting any
 * guard reaching an opaque, even alongside real evidence) is the conservative
 * reading and the one this module takes.
 */
function guardGroundsInEvidence(guard: StaticProv): boolean {
  const { content, selection } = channels(guard);
  if (content.opaques > 0 || selection.opaques > 0) return false;
  return content.anchors.some((a) => a.integrity === "evidence") || selection.anchors.some((a) => a.integrity === "evidence");
}

export interface ChoiceTower {
  readonly guards: readonly StaticProv[];
  readonly leafAlts: readonly StaticProv[];
}

/**
 * Flatten a chain of nested `choice`s reached through ALTS — the lowering of
 * a source `cond`/`when`/multi-arm-`if` chain, which has no N-ary CoreForm
 * node of its own (coreform/types.ts's union has no `Cond`) and so desugars
 * to nested binary `If`s — into one judgment: every guard encountered
 * anywhere in the tower, and every LEAF (non-`choice`) alt. The common shape
 * is a linear if-else-if chain (only the LAST alt continues the tower); this
 * walk also handles a branching tower (a nested `choice` in a non-last alt)
 * identically, since it checks every alt, not just the last. Finite by the
 * tree claim (header) — no separate depth budget needed.
 */
export function flattenChoiceTower(prov: ChoiceProv): ChoiceTower {
  const guards: StaticProv[] = [...prov.guards];
  const leafAlts: StaticProv[] = [];
  for (const alt of prov.alts) {
    if (alt.kind === "choice") {
      const nested = flattenChoiceTower(alt);
      guards.push(...nested.guards);
      leafAlts.push(...nested.leafAlts);
    } else {
      leafAlts.push(alt);
    }
  }
  return { guards, leafAlts };
}

/**
 * TRUE iff the root — or the root's choice TOWER (`flattenChoiceTower`) — is
 * a choice whose every leaf alt is a bare const (an enumerated vocabulary,
 * structurally: no externally DECLARED set is checked here, see header),
 * whose tower has AT LEAST ONE guard, and whose every guard, at every level
 * of the tower, grounds in evidence (`guardGroundsInEvidence`). A non-`choice`
 * root is never judgment-shaped.
 *
 * THE `guards.length > 0` CONJUNCT: without it,
 * `guards.every(guardGroundsInEvidence)` is VACUOUSLY true on an empty guard
 * list — `Array.prototype.every` returns `true` for "every element of the
 * empty set satisfies P" regardless of P, which cannot distinguish "every
 * guard grounds in evidence" from "there is no guard to check at all". A
 * guardless choice IS a reachable shape, not a hypothetical: `extractAndOr`
 * (arm-control.ts) gives `and`/`or` `guards: provs.slice(0, -1)`, which is
 * EMPTY for a single-argument call — `(and "YES")` extracts to
 * `ChoiceProv{guards:[], alts:[const]}`. Without this conjunct that shape
 * would read as `judgment-shaped`: a bare author-written literal with nothing
 * grounding WHY it was selected (there is no selection — there is only one
 * option) would pass the same check as a genuine evidence-guarded judgment.
 * This never reaches the live seal as an over-grant (`seal.ts`'s probe
 * conjunct still requires an observed `"selection"` crossing, which a
 * guardless choice never produces), but the STATIC certificate alone would be
 * wrong, which is what this module exists to get right. A judgment with
 * nothing grounding its selection is not a judgment.
 */
export function judgmentShaped(prov: StaticProv): boolean {
  if (prov.kind !== "choice") return false;
  const { guards, leafAlts } = flattenChoiceTower(prov);
  return guards.length > 0 && leafAlts.length > 0 && leafAlts.every(isBareConst) && guards.every(guardGroundsInEvidence);
}

// ── circuitVerdict ───────────────────────────────────────────────────────────

export type CircuitRole = "data" | "judgment";
export type CircuitVerdict = "data-shaped" | "judgment-shaped" | "not-attestable";

/**
 * The one export a caller needs: `dataShaped`/`judgmentShaped` restated as a
 * single reportable outcome. NEVER any positive besides the two named here —
 * `dataShaped`/`judgmentShaped` already fold every disqualifying condition
 * (a `const`, an `opaque`, an ambient anchor, in the role's relevant channel)
 * into their boolean, so a `false` surfaces here as `"not-attestable"`,
 * never a third positive and never a distinct "fabrication" reading. (Mirrors
 * `wire/policy.ts`'s `verdictFor` shape, minus the `vocabulary` parameter and
 * the `"fabrication"` variant — see the module header.)
 */
export function circuitVerdict(prov: StaticProv, role: CircuitRole): CircuitVerdict {
  if (role === "data") return dataShaped(prov) ? "data-shaped" : "not-attestable";
  return judgmentShaped(prov) ? "judgment-shaped" : "not-attestable";
}

// ── planeOf ──────────────────────────────────────────────────────────────────

/** The channel-plane of one node — see `planeOf`. */
export type Plane = "transparent" | "active" | "const";

/**
 * C1 — the one boundary every projection derives from
 * (docs/working-proposals/provenance-beautiful-child/README.md §1): all three
 * design lenses (control-plane collapse, compose formulas, field-granular
 * access) independently discovered the SAME cut in `channelsFresh`'s
 * per-kind fold, so it is exported ONCE, from this module — it IS a reading
 * of the verdict's channel algebra, and living beside `channelsFresh` is
 * what makes drift structurally impossible (a new `StaticProv` kind breaks
 * both switches at compile time, in the same file).
 *
 *  - `"transparent"` — the fold is the pointwise absorptive union; the node
 *    contributes nothing of its own (`fused`/`mux`/`build`/`string`, read
 *    off the arms above). A render INLINES these into a formula; a collapse
 *    view contracts them into a lens edge; an access path consumes them as
 *    a segment.
 *  - `"active"` — the fold crosses, cuts, promotes, or opens an axis
 *    (`input`/`mint` introduce anchors; `choice` crosses channels; `fan`
 *    opens the aggregation axis; `opaque` is the fail-closed wall). A render
 *    keeps these as holes/states/frontiers — never inlined.
 *  - `"const"` — the absorptive terminal, THE fabrication mark: no interior
 *    to inline or to hold open; it rides as a marked token.
 *
 * THE ONE EXCEPTION (lens-1 table, consolidation §1): a `fan` with
 * `collapse:"combine"` is DATA-plane — the enumerated, void-free AC
 * combinator (`+ * string-append cons`, `inferCollapse`/`buildFan`'s own
 * closed list) folds every element unconditionally, exactly like a `fused`
 * over N sources; nothing routes, nothing is selected, so a machine view
 * contracts it into the data plane. `route`/`lowered` fans stay active
 * (route IS a choice over the collection's elements — `channelsFresh`'s own
 * selection-promotion arm; lowered keeps a full dialect program open).
 * NOTE for formula consumers: the compose projection still renders EVERY fan
 * as a hole (spec §3's per-kind table — R1's hole-by-kind rule is about
 * formula interiors, where a variable-arity axis can never inline); this
 * exception is the machine/collapse view's contraction rule, exported here
 * so that view derives it from the verdict rather than re-deciding it.
 */
export function planeOf(prov: StaticProv): Plane {
  switch (prov.kind) {
    case "fused":
    case "mux":
    case "build":
    case "string":
      return "transparent";
    case "fan":
      return prov.collapse === "combine" ? "transparent" : "active";
    case "input":
    case "mint":
    case "choice":
    case "opaque":
      return "active";
    case "const":
      return "const";
  }
}

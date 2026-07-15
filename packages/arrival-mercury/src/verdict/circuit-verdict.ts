/**
 * T4 — the static verdict channel: the circuit's OWN reading, no probe.
 *
 * `wire/policy.ts` answers the seal's two structural questions (`dataShaped`,
 * `judgmentShaped`) by walking a `WireDescriptor`
 * (docs/foundations/arrival-scheme/provenance-by-perturbation.md §3). This
 * module answers the SAME two questions over the circuit that retires it —
 * `StaticProv` (src/model/static-prov.ts) — so the seal's static leg can
 * re-point from `wire/policy` to `extract`'s output
 * (docs/working-proposals/scheme-semantic-model-synthesis.md §2g, task T4;
 * the J1 re-point). Mirrors `wire/policy.ts`'s naming (`dataShaped`,
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
 * finite TREE. Shared sub-objects may repeat under multiple parents (the type
 * is a "provenance CIRCUIT," Deutch-Milo-Roy-Tannen ICDT 2014 — DAG-shared by
 * name), but repetition under distinct parents is not a cycle; a plain walk
 * revisits a shared node once per incoming edge and terminates on the edge
 * count, same as it would over a tree with no sharing at all — and revisiting
 * is the CORRECT over-approximation here, not a bug (`(- (:v e) (:v e))`
 * must count `e` twice; deduplicating shared structure is the probe's job,
 * never the static plane's, seal.ts's own worked example).
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
import type { ChoiceProv, Integrity, StaticProv } from "../model/static-prov.js";

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

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * Fold a circuit into its two attribution channels, bottom-up, in ONE pass.
 * Safe to call again on any sub-circuit (a guard, a collection) exactly as on
 * the whole circuit — `judgmentShaped` does this per guard; see the header
 * for why no fuel is needed either way. Exhaustive over `StaticProv`'s ten
 * members WITHOUT a `default` arm: tsc's return-type check is the totality
 * proof, mirroring `extract`'s own dispatcher (src/extract/index.ts).
 */
export function channels(prov: StaticProv): Channels {
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
      const closed = prov.closed.map(channels);
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
      const parts = prov.sources.map(channels);
      return {
        content: unionTerminals(parts.map((p) => p.content)),
        selection: unionTerminals(parts.map((p) => p.selection)),
      };
    }

    case "mux":
      // Where-provenance projection: transparent to both channels — the
      // value IS (part of) the source, so its content/selection ARE the
      // source's.
      return channels(prov.source);

    case "build": {
      const parts = prov.parts.map((p) => channels(p.prov));
      return {
        content: unionTerminals(parts.map((p) => p.content)),
        selection: unionTerminals(parts.map((p) => p.selection)),
      };
    }

    case "string": {
      const parts = prov.runs.map(channels);
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
      const alts = prov.alts.map(channels);
      const guards = prov.guards.map(channels);
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
      const body = channels(prov.body);
      const collection = channels(prov.collection);
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

interface ChoiceTower {
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
function flattenChoiceTower(prov: ChoiceProv): ChoiceTower {
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
 * structurally: no externally DECLARED set is checked here, see header) and
 * whose every guard, at every level of the tower, grounds in evidence
 * (`guardGroundsInEvidence`). A non-`choice` root is never judgment-shaped.
 */
export function judgmentShaped(prov: StaticProv): boolean {
  if (prov.kind !== "choice") return false;
  const { guards, leafAlts } = flattenChoiceTower(prov);
  return leafAlts.length > 0 && leafAlts.every(isBareConst) && guards.every(guardGroundsInEvidence);
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

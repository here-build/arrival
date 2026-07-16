/**
 * collapse-view — StaticProv → ControlMachine, the FIFTH pure projection
 * beside circuit-sexpr / circuit-mermaid / to-wireframe / compose-template
 * (docs/working-proposals/provenance-beautiful-child/control-plane-collapse.md
 * §3; consolidation README §2/§7 Wave 1, item 3). Same source (`StaticProv`),
 * same totality discipline, derived-never-stored, and the seal never reads
 * it (INV-4).
 *
 * ── the one-line idea ────────────────────────────────────────────────────
 *
 * `planeOf` (verdict/circuit-verdict.ts, C1) already splits every node into
 * transparent/active/const. Q1 (the plane quotient) contracts every maximal
 * transparent region into ONE lens edge; Q2 (the site quotient) merges
 * active instances that share a program point into ONE state. The result is
 * a hierarchical state machine: states are the five control kinds (input,
 * mint, decision, fan, opaque) plus a synthetic per-level egress marker;
 * lens edges are the wires between them, each carrying a `ComposeTemplate`
 * formula (lens 2's object) as its rendering.
 *
 * ── Q1 is NOT reimplemented here — it is `toComposeTemplate` ────────────
 *
 * `toComposeTemplate` (compose-template.ts) already makes every channel-
 * active node a HOLE and every channel-transparent node inline formula
 * structure (its own header: "R1... every channel-moving kind is a hole").
 * That IS Q1's contraction boundary. So a "port" here is built by calling
 * `toComposeTemplate` on the child StaticProv reachable from that port: the
 * resulting `ComposeTemplate.root` is the port's lens-edge formula, and every
 * non-`"shared"` hole in `ComposeTemplate.holes` is exactly the set of
 * upstream control states this edge `feeds` (a `"shared"` hole is lens 2's
 * own where-clause data-plane sharing — never a control state). This module
 * therefore does none of Q1's segmentation work twice; it only (a) decides
 * WHICH child StaticProv nodes are ports of WHICH active states (Q1's
 * control side — the walk §3 describes), and (b) applies Q2 on top.
 *
 * ── Q2 — the site quotient ───────────────────────────────────────────────
 *
 * Two disjoint merge rules, by design (§6.4, README C6):
 *   1. OBJECT IDENTITY (global, always sound, free): the exact same
 *      StaticProv object reached from two different ports is the exact same
 *      program value (already memo-shared by `ExtractCtx.memo`/G2) — it is
 *      ONE state no matter how many places reference it. Tracked with one
 *      `Map<StaticProv, StateId>` shared across the WHOLE `collapseView`
 *      call (not reset per level), because object identity is a fact about
 *      the VALUE, independent of which machine level's walk reaches it
 *      first.
 *   2. STRUCTURAL EQUALITY (per machine level, §6.4's fail-closed rule): two
 *      DIFFERENT objects sharing `(kind, site)` — the ordinary shape of a
 *      beta-reduced helper called from more than one place at the SAME
 *      level — merge into one state IFF a cheap topology fingerprint
 *      (`shapeFingerprint`, below) agrees. The fingerprint compares state
 *      kind, site, kind-specific shape metadata, and — recursively, per
 *      port — whether that port reaches an active node of the same shape,
 *      but DELIBERATELY treats the pure-formula LEAF CONTENT feeding a port
 *      (which literal, which specific access chain) as significant too —
 *      this is the CONSERVATIVE (fail-closed) reading: under-merging is
 *      never unsound, only less pretty, whereas the design's own words are
 *      "the strictness IS the honesty" (README C6). A divergence in whether
 *      a port even REACHES an active node at all (e.g. one call's argument
 *      is a bare const, another's is a further crossing) is exactly the
 *      shadowed-input class (§6.4) and correctly blocks the merge.
 *
 * `templates` (Q2-hoisting, §7/#47) is populated ONLY for the case that
 * actually has a `ControlMachine`-shaped thing to hoist: a `fan` state
 * merged (rule 2, not object identity) from ≥2 distinct instances at ONE
 * level shares its `interior` under `templates.get(site)` (see
 * `bumpInstances`). Non-fan kinds (mint/choice/opaque/input) have no
 * interior machine to hoist — they simply merge into one `ControlState`
 * with `instances > 1`, which is already the complete representation. Full
 * CROSS-LEVEL hoisting (the general #47 shape, where the same helper is
 * reached from genuinely different hierarchical contexts on different sides
 * of a fan boundary) is explicitly staged as Wave 3 work by the
 * consolidation doc (§7's own staging table) and is NOT attempted here;
 * this module's structural-equality Q2 dedup is scoped per machine level
 * (mirrors `to-wireframe.ts`'s own documented per-`Builder` dedup scope —
 * see that file's "SCOPE" note on `project`). A state discovered again from
 * a DIFFERENT level is never re-derived (object identity is global, rule 1
 * above) but is reported as a captured cross-boundary reference
 * (`capturePorts`, §6.2) on the compound state whose interior reached it,
 * rather than silently duplicated.
 *
 * ── opaque never absorbs (§6.1) ──────────────────────────────────────────
 *
 * `toComposeTemplate` already guarantees this: `opaque` is channel-active
 * (`planeOf`), hence ALWAYS a hole (`reason:"opaque"`), NEVER inlined into a
 * formula's expression tree. `LensEdge.absorbedOpaques` is therefore
 * unconditionally `[]` by construction of the shared helper this module
 * reuses — asserted, not computed, and cited here rather than re-derived.
 *
 * ── the lifted loop's guard (§6.5) ───────────────────────────────────────
 *
 * `FanProv` (static-prov.ts) has no field for a recursion-lifted fan's
 * base-case guard at all — `buildRecursionFan` (arm-control.ts) extracts
 * only the accumulator's update expression. There is therefore nothing for
 * this module to read a selection contribution FROM. No synthetic guard
 * channel is invented here (considered and declined): `ControlState` for a
 * `fan` carries no guard-shaped field, and that absence — not a
 * placeholder, not a zero-filled channel — IS the honest answer until
 * extract itself carries the guard's attribution (filed for consolidation,
 * §6.5/§6 point 1). A caption for the guard's TEXT (e.g. `(zero? n)`) is a
 * presentation concern for a later CoreForm-side-table lens, exactly like
 * every other state's caption — see "labels", below.
 *
 * ── labels are a seam, not built here ────────────────────────────────────
 *
 * Every `ControlState` already carries `site: NodeId` (kept from the
 * spec's own sketch). A caption ("evaluate", a loop guard's source text,
 * a `.prompt` name) is recoverable from a CoreForm side-table exactly the
 * way `compose-template.ts`'s `SourceLens` recovers operator/literal text —
 * this module does not build that resolution (no CoreForm forest is even
 * in scope here; `collapseView`'s only input is `StaticProv`, per the
 * spec's own signature). `site` IS the seam a future renderer combines with
 * a `SourceLens`-shaped lens; nothing new needs to exist on `ControlState`
 * for that to work.
 *
 * ── egress modeling ──────────────────────────────────────────────────────
 *
 * `StateKind` includes `"egress"` (spec §2.2: "states = program points of
 * the five control kinds plus egress"). An ACTIVE root needs no synthetic
 * wrapper — `ControlMachine.egress` points at its own state directly
 * (`{kind:"state", ...}`). A DATA-PLANE root (GEPA's own shape — the
 * top-level `max-by(...)` over the loop is a mux, i.e. transparent; the
 * task brief's own words: "egress = a lens edge") needs a lens edge, and
 * that edge needs a `(state, port)` home: exactly one synthetic
 * `"egress"`-kind state is minted for this case only, never for the
 * active-root case where it would be a pointless wrapper around an
 * already-well-defined terminal.
 *
 * ── `flattenChoiceTower` is IMPORTED from the verdict (never reimplemented) ──
 *
 * The spec (§3 step 4) requires reusing `verdict/circuit-verdict.ts`'s tower
 * flatten verbatim so a decision state's guards/alts can never drift from
 * what the verdict itself judges. The lane that authored this file found it
 * unexported and carried a marked byte-copy; the export landed the same
 * night and the copy was deleted — one function, two callers, zero drift.
 */
import type { NodeId } from "../coreform/types.js";
import { channels, flattenChoiceTower, planeOf } from "../verdict/circuit-verdict.js";
import type { Channels, ChoiceTower } from "../verdict/circuit-verdict.js";
import { type ComposeExpr, type ComposeTemplate, toComposeTemplate } from "./compose-template.js";
import type { ChoiceProv, CollapseKind, FanProv, MuxProv, StaticProv } from "./static-prov.js";

/** The five channel-active `StaticProv` kinds (`planeOf(p) === "active"`) —
 *  the only shapes `visitActive`/`buildState` ever receive. A `fan` is
 *  structurally part of this type even though a `collapse:"combine"` fan is
 *  NOT active (planeOf's own exception) — `isActive`, below, is the
 *  precise runtime check; this type only bounds "which KINDS," matching
 *  every other narrowing in this package (`Extract` by discriminant, never
 *  by a nested field). */
type ActiveProv = Extract<StaticProv, { kind: "input" | "mint" | "choice" | "fan" | "opaque" }>;

/** The exact, sole source of truth for "is this node a state" — literally
 *  `planeOf`, so this can never drift from the verdict's own boundary
 *  (C1). Also narrows `p`'s type to `ActiveProv` at every call site. */
function isActive(p: StaticProv): p is ActiveProv {
  return planeOf(p) === "active";
}

const isBareConst = (p: StaticProv): boolean => p.kind === "const";

// ── the public types ─────────────────────────────────────────────────────

export type StateKind = "input" | "mint" | "decision" | "fan" | "opaque" | "egress";

/** Globally unique across one `collapseView()` call (never reset per
 *  level) — see this file's header, Q2 rule 1: a state referenced from a
 *  different level than the one that owns it must resolve to the SAME id,
 *  which a per-level-reset counter could not guarantee. Mirrors `HoleId`'s
 *  own minted-identifier pattern (compose-template.ts), scaled up to span
 *  levels. */
export type StateId = number & { readonly __collapseStateId: unique symbol };
export type StateRef = StateId;

/** Per-machine-level (reset for every `ControlMachine`, top or interior) —
 *  mirrors `HoleId`'s per-template scoping exactly, since a `maskRow`/
 *  `egress` reference is only ever resolved within the SAME machine's own
 *  `lensEdges` array. */
export type LensEdgeId = number & { readonly __collapseLensEdgeId: unique symbol };

/** A port name, scoped to the state it belongs to (`LensEdge.to.port`) —
 *  e.g. `"guard0"`, `"arm1"`, `"closed0"`, `"collection"`, `"mask"`,
 *  `"out"`. Never globally unique on its own; always read together with
 *  `LensEdge.to.state`. */
export type PortId = string;

/**
 * `egress: StateRef | LensEdgeId` (spec §3) cannot be told apart at RUNTIME
 * by a bare `number` union — both ids are plain numbers once the branded
 * compile-time type erases, so a consumer holding just a number could never
 * know which table to look it up in. This is a necessary, minimal
 * elaboration of the spec's sketch: a tagged union carrying the SAME two
 * alternatives, safely discriminable. See "egress modeling" above for when
 * each arm is produced.
 */
export type EgressRef = { readonly kind: "state"; readonly ref: StateRef } | { readonly kind: "edge"; readonly ref: LensEdgeId };

export interface ControlState {
  readonly id: StateId;
  readonly kind: StateKind;
  /** Program point — the Q2 quotient key. Q2-merged states carry every
   *  instance's identity via `instances`; the `site` itself is shared. */
  readonly site: NodeId;
  /** Q2 multiplicity (1 = not shared). Object-identity sharing (Q2 rule 1)
   *  does NOT increment this — it is the same occurrence referenced twice,
   *  not two instances; only rule-2 (structurally-equal, distinct-object)
   *  merges increment it. */
  readonly instances: number;

  // ── decision (choice tower, `flattenChoiceTower` (imported from the verdict)) ──
  readonly guardPorts?: readonly PortId[];
  readonly armPorts?: readonly PortId[];
  /** Bare-const leaf alts (`isBareConst`) — a vocabulary chip, never a lens
   *  edge (INV-2: every const site is either an edge's `absorbedConsts` or
   *  a decision's `judgmentAlts`, never both). */
  readonly judgmentAlts?: readonly NodeId[];

  // ── fan ──
  readonly collapse?: CollapseKind; // route | lowered — combine never becomes a state (planeOf's own exception)
  /** Derived by structural fact, never guessed: a recursion-lifted fan's
   *  OWN element token shares `site` with the fan itself (`buildRecursionFan`
   *  mints both from `fn.id`); an ordinary map/filter/fold-desugared fan's
   *  element token carries the mapped function's OWN id, distinct from the
   *  fan's `site` (the App call's id) — see `findElementToken` below. Absent
   *  (not a guess) when the body never references its own element (legal,
   *  if unusual — nothing to check against). */
  readonly origin?: "desugar" | "recursion";
  /** The body's machine (compound state) — present iff `maskRow` is not
   *  (mutually exclusive; see `buildFanState`). */
  readonly interior?: ControlMachine;
  /** Cross-fan-boundary references (§6.2): named ports of THIS fan's
   *  `interior` whose lens edges feed a state owned by an ANCESTOR level
   *  (a genuine capture, not a fresh discovery) — see `captureBoundary`
   *  below. Absent when the interior discovers nothing pre-existing. */
  readonly capturePorts?: readonly PortId[];
  /** The route-fan synthetic survivor-mask choice (§6.6), merged as a lens
   *  edge over its OWN predicate rather than rendered as its own decision
   *  state — present only when `body.kind === "choice" && collapse ===
   *  "route"` AND that choice has exactly the one guard `buildFan`'s filter
   *  path always constructs (never guessed at any other shape — §6.6's own
   *  words). */
  readonly maskRow?: LensEdgeId;

  // ── mint ──
  readonly head?: string;
  readonly integrity?: "evidence" | "ambient";
  readonly closedPorts?: readonly PortId[];

  // ── opaque ──
  readonly reason?: string;
}

export interface LensEdge {
  readonly id: LensEdgeId;
  /** `(state, port)` determines the channel this edge feeds — the
   *  `choiceWireRole` idiom (to-wireframe.ts) generalized to every port:
   *  `guard*`/`closed*`/the fan's `mask` → selection; `arm*`/`collection`/
   *  `out` → content. */
  readonly to: { readonly state: StateRef; readonly port: PortId };
  /** Lens 2's own object — `ComposeTemplate.root`, this edge's rendering. */
  readonly formula: ComposeExpr;
  /** Upstream control states this edge's formula references (every
   *  non-`"shared"` hole of the `ComposeTemplate` this edge was built
   *  from) — a direct control→control feed is the degenerate case where
   *  `formula` is itself just `{kind:"hole", ...}` with one entry here. */
  readonly feeds: readonly StateRef[];
  /** Fold of every `lit` token's site across `formula` (root + every
   *  `"shared"` hole's own formula) — the fabrication badge. */
  readonly absorbedConsts: readonly NodeId[];
  /** Always `[]` — see this file's header, "opaque never absorbs". */
  readonly absorbedOpaques: readonly NodeId[];
  /**
   * `channels(child)`'s own fold over this port's root value, cached once
   * — BOTH halves (content and selection), not a single projected value.
   * A necessary elaboration of the spec's `ChannelTerminals` sketch: a
   * lossless reconstruction (INV-1) genuinely needs both — `channelsFresh`'s
   * own per-kind rules (circuit-verdict.ts) sometimes route a child's
   * CONTENT into the parent's selection (a `fan`'s route-collapse promotes
   * `collection.content`) while ALWAYS routing a guard/closed child's full
   * pair into selection and an alt's content-only into content but its
   * selection ALSO into the parent's selection — no single `(state, port)`
   * role is expressive enough to know in advance which half(s) a
   * reconstruction will want. Storing the pair here costs nothing new (it
   * is exactly `channels(child)`, uncombined) and lets any consumer apply
   * the same per-kind combination rule the verdict does, reading cached
   * halves instead of re-walking `child`.
   */
  readonly terminals: Channels;
}

export interface ControlMachine {
  readonly states: readonly ControlState[];
  readonly lensEdges: readonly LensEdge[];
  readonly egress: EgressRef;
  /** Q2-hoisted multi-context fan interiors (§7/#47) — see this file's
   *  header for the deliberately narrow scope (same-level, fan-only). Empty
   *  when nothing at this level qualifies (an honest, reportable outcome,
   *  not a gap to force). */
  readonly templates: ReadonlyMap<NodeId, ControlMachine>;
}

// ── the mutable build context (never escapes `collapseView`) ────────────

/** Shared across the WHOLE `collapseView` call — Q2 rule 1 (object
 *  identity) and id minting are global; everything else is per-level. */
interface GlobalCtx {
  readonly stateIdByProv: Map<StaticProv, StateId>;
  readonly ownerLevel: Map<StateId, LevelCtx>;
  nextStateId: number;
}

interface ShapeBucket {
  readonly fingerprint: string;
  readonly id: StateId;
}

/** One machine level's construction context (top-level, or one fan's
 *  interior). `binders` seeds `toComposeTemplate`'s R3 binder map for every
 *  ordinary port built at this level (the fan-element/accumulator token, so
 *  a formula never re-expands the whole collection expression — see this
 *  file's header and R3 in compose-template.ts). */
interface LevelCtx {
  readonly global: GlobalCtx;
  readonly binders: ReadonlyMap<StaticProv, string>;
  readonly stateOrder: StateId[]; // states OWNED by this level, first-discovery order
  readonly statesById: Map<StateId, ControlState>;
  readonly lensEdges: LensEdge[];
  readonly shapeBuckets: Map<string, ShapeBucket[]>; // key: `${kind}|${site}`
  readonly templates: Map<NodeId, ControlMachine>;
  nextLensEdgeId: number;
  egressRef: EgressRef | undefined;
}

function newLevel(global: GlobalCtx, binders: ReadonlyMap<StaticProv, string>): LevelCtx {
  return {
    global,
    binders,
    stateOrder: [],
    statesById: new Map(),
    lensEdges: [],
    shapeBuckets: new Map(),
    templates: new Map(),
    nextLensEdgeId: 1,
    egressRef: undefined,
  };
}

// ── Q1: a port is a `toComposeTemplate` call ─────────────────────────────

/** Collect every `lit` token's site reachable in a `ComposeTemplate` (root
 *  plus every `"shared"` hole's own formula) — the fold `absorbedConsts`
 *  needs. Mirrors `compose-template.test.ts`'s own `litSitesOf` test helper,
 *  necessarily duplicated here since that one is test-only. */
function litSitesOf(t: ComposeTemplate): readonly NodeId[] {
  const sites: NodeId[] = [];
  const walk = (e: ComposeExpr): void => {
    switch (e.kind) {
      case "lit":
        sites.push(e.site);
        return;
      case "hole":
      case "binder":
        return;
      case "access":
        walk(e.base);
        return;
      case "op":
        e.args.forEach(walk);
        return;
      case "runs":
        e.runs.forEach(walk);
        return;
      case "struct":
        e.fields.forEach((f) => walk(f.value));
        return;
    }
  };
  walk(t.root);
  for (const h of t.holes.values()) if (h.reason === "shared" && h.formula) walk(h.formula);
  return sites;
}

/**
 * `toComposeTemplate` always holes a `fan`, regardless of collapse kind —
 * its own header explains why (a variable-arity axis can never inline into
 * a fixed-arity formula, full stop) and explicitly hands the OTHER half of
 * the exception to this module: "this exception is the machine/collapse
 * view's contraction rule" (compose-template.ts's own words). `planeOf`
 * classifies a `combine`-collapse fan transparent for exactly this view, so
 * before Q1-segmenting anything, this rewrites every reachable
 * `combine`-fan into its own `body` (the enumerated, void-free AC fold's
 * `FusedProv`/`BuildProv`/`StringProv`, already referencing `collection` via
 * the ordinary `mux{key:null,...}` element token — no separate "iteration"
 * concept to preserve, since a combine fan collapses to ONE value). A pure,
 * identity-preserving rewrite: returns the SAME object reference whenever
 * nothing needed rewriting (the overwhelmingly common case), so census-based
 * where-clause sharing (R2) is undisturbed except exactly along the path to
 * a combine-fan. Stops at every ACTIVE node (never rewrites inside a
 * mint/choice/non-combine-fan's own children) — those get their own
 * separate `buildLensEdge` call when THEY become a state, so recursing
 * through them here would be redundant and would fabricate synthetic
 * active-node objects that could break Q2's object-identity dedup.
 */
function desugarCombine(p: StaticProv): StaticProv {
  if (p.kind === "fan" && p.collapse === "combine") return desugarCombine(p.body);
  if (planeOf(p) !== "transparent") return p; // active or const — a leaf for this rewrite
  switch (p.kind) {
    case "fused": {
      const sources = p.sources.map(desugarCombine);
      return sources.every((s, i) => s === p.sources[i]) ? p : { ...p, sources };
    }
    case "string": {
      const runs = p.runs.map(desugarCombine);
      return runs.every((r, i) => r === p.runs[i]) ? p : { ...p, runs };
    }
    case "build": {
      const parts = p.parts.map((pt) => ({ key: pt.key, prov: desugarCombine(pt.prov) }));
      return parts.every((pt, i) => pt.prov === p.parts[i]!.prov) ? p : { ...p, parts };
    }
    case "mux": {
      const source = desugarCombine(p.source);
      return source === p.source ? p : { ...p, source };
    }
    default:
      // Only reachable for a NON-combine `fan` (planeOf would have already
      // returned it above as "not transparent"); kept for tsc's exhaustive-
      // switch discipline, never actually hit.
      return p;
  }
}

/** Build one port's lens edge: Q1-segment `child` via `toComposeTemplate`
 *  (the shared helper — see this file's header), recursively `visitActive`
 *  every active hole it discovers (the edge's `feeds`), and record the
 *  edge under `level.lensEdges`. `binders` defaults to the level's own
 *  (every ordinary port); the fan mask-row port passes the FAN's OWN
 *  element binder explicitly even though the mask stays at the fan's
 *  OUTER level (§6.6 — no new level opens for a mask row, but its formula
 *  can still reference the element, so it needs the same R3 binder an
 *  interior would have gotten). Returns the new edge's id. */
function buildLensEdge(
  level: LevelCtx,
  state: StateId,
  port: PortId,
  child: StaticProv,
  binders: ReadonlyMap<StaticProv, string> = level.binders,
): LensEdgeId {
  const t = toComposeTemplate(desugarCombine(child), binders.size > 0 ? { binders } : undefined);
  const feeds: StateId[] = [];
  for (const h of t.holes.values()) {
    if (h.reason === "shared") continue;
    // Invariant, not a guess: every non-"shared" ComposeHole's `prov` is
    // channel-active by compose-template's OWN construction (a hole is
    // minted exactly at a channel-active node — its own header, "R1").
    // Checked, not assumed, since that invariant lives in a sibling module.
    if (!isActive(h.prov)) {
      throw new Error(`collapseView: hole reason "${h.reason}" but prov.kind is "${h.prov.kind}" — compose-template invariant violated`);
    }
    feeds.push(visitActive(level, h.prov));
  }
  const id = level.nextLensEdgeId++ as LensEdgeId;
  level.lensEdges.push({
    id,
    to: { state, port },
    formula: t.root,
    feeds,
    absorbedConsts: litSitesOf(t),
    absorbedOpaques: [], // opaque is always channel-active ⇒ always a hole, never inlined (header)
    terminals: channels(child),
  });
  return id;
}

// ── the fan element/accumulator binder + origin heuristic ───────────────

/** Find the fan's OWN distinguished element token — `mux{key:null,
 *  source: fan.collection}` — by IDENTITY of `source` (R3's rule,
 *  generalized: `inferCollapse`, circuit-verdict.ts, and compose-template's
 *  own binder-caller never have `collection` in scope to compare against;
 *  `collapseView` does, since both live on the same `FanProv`). Bounded,
 *  memoized DFS — `StaticProv` is acyclic (extract's own I1 cycle guard),
 *  so termination needs no fuel. Never descends into a NESTED fan's own
 *  body (that is a different binder's territory, resolved when THAT fan's
 *  own interior is built) — matches Q1's own segment-stops-at-active-nodes
 *  discipline. Returns `undefined` when the body never references its own
 *  element (legal, if unusual — e.g. a fold whose update expression ignores
 *  the running accumulator entirely). */
function findElementToken(body: StaticProv, collection: StaticProv, seen: Set<StaticProv>): MuxProv | undefined {
  if (seen.has(body)) return undefined;
  seen.add(body);
  if (body.kind === "mux" && body.key === null && body.source === collection) return body;
  // A combine-collapse fan is data-plane (planeOf's own exception — see
  // `desugarCombine`'s doc) — it never opens a new level, so the element
  // token it references is THIS level's own; descend into it exactly like
  // any other transparent container. Only a NON-combine fan is a different
  // level's territory.
  if (body.kind === "fan" && body.collapse === "combine") {
    return findElementToken(body.collection, collection, seen) ?? findElementToken(body.body, collection, seen);
  }
  switch (body.kind) {
    case "input":
    case "const":
    case "opaque":
      return undefined;
    case "fan":
      // A NESTED non-combine fan's own `body` is genuinely a different
      // level's per-element territory (parameterized by ITS OWN element,
      // never this search's target) — do not cross into it. Its
      // `collection`, though, is an ordinary reference chain this fan
      // merely passes through (the exact shape `iterate`'s recursion-lift
      // produces: `iterate.body` beta-reduces through `generation` straight
      // into `frontier`'s own FanProv, whose `collection` field is where
      // `iterate`'s element actually surfaces, fused alongside the
      // recursive map) — searching it is not crossing a level boundary,
      // it is the SAME kind of pass-through a `mux`'s `.source` already is.
      return findElementToken(body.collection, collection, seen);
    case "mint":
      for (const c of body.closed) {
        const hit = findElementToken(c, collection, seen);
        if (hit) return hit;
      }
      return undefined;
    case "fused":
      for (const c of body.sources) {
        const hit = findElementToken(c, collection, seen);
        if (hit) return hit;
      }
      return undefined;
    case "mux":
      return findElementToken(body.source, collection, seen);
    case "build":
      for (const p of body.parts) {
        const hit = findElementToken(p.prov, collection, seen);
        if (hit) return hit;
      }
      return undefined;
    case "string":
      for (const c of body.runs) {
        const hit = findElementToken(c, collection, seen);
        if (hit) return hit;
      }
      return undefined;
    case "choice":
      for (const g of body.guards) {
        const hit = findElementToken(g, collection, seen);
        if (hit) return hit;
      }
      for (const a of body.alts) {
        const hit = findElementToken(a, collection, seen);
        if (hit) return hit;
      }
      return undefined;
  }
}

// ── Q2's per-level structural-equality fingerprint ───────────────────────

/** A Q1 "does this port reach an active node, and if so what shape" probe,
 *  computed directly over raw `StaticProv` — deliberately NOT the real
 *  `toComposeTemplate` walk (that mints holes/edges; this only needs to
 *  know the shape before committing to build anything). Descends through
 *  transparent kinds only, stopping at the first active node — and, unlike
 *  a verdict fold, keeps every literal's SITE (never just "a const exists")
 *  so two ports differing only in WHICH constant they carry are correctly
 *  read as different shapes (the conservative, fail-closed reading — see
 *  this file's header, Q2 rule 2). */
function portFingerprint(p: StaticProv): string {
  // Checked FIRST, unconditionally: a `fan` is active unless its collapse is
  // specifically "combine" (planeOf's own exception) — a route/lowered fan
  // reached directly as a port's child must fingerprint as the active state
  // it will become, never fall into the transparent switch below (which
  // would otherwise misread it as a combine descent). Deliberately
  // `planeOf(p) === "active"`, NOT `isActive(p)`: the latter's type
  // predicate narrows `p` to EXCLUDE the whole `"fan"` kind in the false
  // branch (its `ActiveProv` type cannot express "fan, except combine"),
  // which would make the switch below's `"fan"` case unreachable by tsc's
  // own analysis even though a combine-fan genuinely reaches it.
  if (planeOf(p) === "active") return shapeFingerprint(p);
  switch (p.kind) {
    case "const":
      return `lit@${p.site}`;
    case "fused":
      return `⊗(${p.sources.map(portFingerprint).join(",")})`;
    case "string":
      return `str(${p.runs.map(portFingerprint).join(",")})`;
    case "build":
      return `build(${p.parts.map((pt) => `${pt.key}:${portFingerprint(pt.prov)}`).join(",")})`;
    case "mux":
      return `mux(${p.key === null ? "?" : p.key})(${portFingerprint(p.source)})`;
    case "fan": // only reachable here when collapse:"combine" (isActive already excluded it above)
      return `combine(${portFingerprint(p.collection)},${portFingerprint(p.body)})`;
    case "input":
    case "opaque":
    case "mint":
    case "choice":
      // Unreachable (isActive already returned for these above); kept for
      // tsc's exhaustive-switch discipline.
      return shapeFingerprint(p);
  }
}

/** The shape fingerprint for an ACTIVE node's OWN immediate structure —
 *  kind, site, kind-specific shape metadata, and each port's
 *  `portFingerprint` recursively (see that function's own doc for why leaf
 *  content is kept, not canonicalized away). */
function shapeFingerprint(p: StaticProv): string {
  switch (p.kind) {
    case "input":
      return `input(${p.name})@${p.site}`;
    case "opaque":
      return `opaque(${p.reason})@${p.site}`;
    case "mint":
      return `mint(${p.head},${p.integrity})@${p.site}[${p.closed.map(portFingerprint).join(";")}]`;
    case "choice": {
      const { guards, leafAlts } = flattenChoiceTower(p);
      const g = guards.map(portFingerprint).join(";");
      const a = leafAlts.map((alt) => (isBareConst(alt) ? `K@${alt.site}` : portFingerprint(alt))).join(";");
      return `choice@${p.site}[${g}|${a}]`;
    }
    case "fan": {
      const collectionShape = portFingerprint(p.collection);
      if (p.collapse === "route" && p.body.kind === "choice" && p.body.guards.length === 1) {
        return `fan(route)@${p.site}[${collectionShape}]mask(${portFingerprint(p.body.guards[0]!)})`;
      }
      return `fan(${p.collapse})@${p.site}[${collectionShape}]body(${portFingerprint(p.body)})`;
    }
    case "const":
    case "fused":
    case "mux":
    case "build":
    case "string":
      // Never the top-level subject of a Q2 comparison itself (these kinds
      // are never active — planeOf); reached only via portFingerprint's
      // own recursion, which already handles them directly.
      return portFingerprint(p);
  }
}

// ── Q2 dedup + state construction ────────────────────────────────────────

/** Increment the `instances` badge on an already-built state (rule-2 merge
 *  — see this file's header). For a `fan` whose `interior` is defined, this
 *  is also the ONE place `templates` (§7/#47) gets populated: the second
 *  (and every later) merged instance promotes the shared interior into the
 *  OWNING level's `templates` map, keyed by site. `global` is threaded in
 *  explicitly (never ambient/module-level state — this whole package's own
 *  purity discipline) since the owning level of a Q2-matched id is not
 *  necessarily the CURRENT level calling in. */
function bumpInstances(global: GlobalCtx, id: StateId): void {
  const owner = global.ownerLevel.get(id);
  if (!owner) return;
  const existing = owner.statesById.get(id);
  if (!existing) return;
  owner.statesById.set(id, { ...existing, instances: existing.instances + 1 });
  if (existing.kind === "fan" && existing.interior) owner.templates.set(existing.site, existing.interior);
}

/** Q2 + state construction for one active `StaticProv` node. Returns the
 *  (possibly pre-existing) `StateId`. See this file's header for the two
 *  merge rules. */
function visitActive(level: LevelCtx, node: ActiveProv): StateId {
  const known = level.global.stateIdByProv.get(node);
  if (known !== undefined) return known;

  const key = `${node.kind}|${node.site}`;
  const fp = shapeFingerprint(node);
  const bucket = level.shapeBuckets.get(key);
  const match = bucket?.find((b) => b.fingerprint === fp);
  if (match) {
    level.global.stateIdByProv.set(node, match.id);
    bumpInstances(level.global, match.id);
    return match.id;
  }

  const id = level.global.nextStateId++ as StateId;
  level.global.stateIdByProv.set(node, id);
  level.global.ownerLevel.set(id, level);
  if (!level.shapeBuckets.has(key)) level.shapeBuckets.set(key, []);
  level.shapeBuckets.get(key)!.push({ fingerprint: fp, id });
  level.stateOrder.push(id);

  const state = buildState(level, id, node);
  level.statesById.set(id, state);
  return id;
}

function buildState(level: LevelCtx, id: StateId, node: ActiveProv): ControlState {
  switch (node.kind) {
    case "input":
      return { id, kind: "input", site: node.site, instances: 1 };

    case "opaque":
      return { id, kind: "opaque", site: node.site, instances: 1, reason: node.reason };

    case "mint": {
      const closedPorts = node.closed.map((_, i) => `closed${i}`);
      node.closed.forEach((c, i) => buildLensEdge(level, id, closedPorts[i]!, c));
      return { id, kind: "mint", site: node.site, instances: 1, head: node.head, integrity: node.integrity, closedPorts };
    }

    case "choice": {
      const { guards, leafAlts } = flattenChoiceTower(node);
      const guardPorts = guards.map((_, i) => `guard${i}`);
      guards.forEach((g, i) => buildLensEdge(level, id, guardPorts[i]!, g));
      const armPorts: PortId[] = [];
      const judgmentAlts: NodeId[] = [];
      let armIdx = 0;
      for (const alt of leafAlts) {
        if (isBareConst(alt)) {
          judgmentAlts.push(alt.site);
          continue;
        }
        const port = `arm${armIdx++}`;
        armPorts.push(port);
        buildLensEdge(level, id, port, alt);
      }
      return { id, kind: "decision", site: node.site, instances: 1, guardPorts, armPorts, judgmentAlts };
    }

    case "fan":
      return buildFanState(level, id, node);
  }
}

/** Fan state construction — combine never reaches here (it is data-plane
 *  per `planeOf`'s own exception, so `visitActive` is never called on
 *  one); the throw below is an internal-invariant guard, not a reachable
 *  user-facing error. */
function buildFanState(level: LevelCtx, id: StateId, node: FanProv): ControlState {
  if (node.collapse === "combine") {
    throw new Error("collapseView: a combine-collapse fan must never reach buildFanState — planeOf classifies it transparent");
  }

  buildLensEdge(level, id, "collection", node.collection);

  const element = findElementToken(node.body, node.collection, new Set());
  const origin: "desugar" | "recursion" | undefined = element === undefined ? undefined : element.site === node.site ? "recursion" : "desugar";
  const nextBinders: ReadonlyMap<StaticProv, string> = element === undefined ? level.binders : new Map([...level.binders, [element, "ex"]]);

  // §6.6 — the route-fan synthetic survivor mask merges as a lens edge over
  // its own predicate; any other shape (including "route" bodies that are
  // NOT this exact synthetic choice) recurses as an ordinary interior.
  // "Never guess a mask" — the ONLY recognized shape is EXACTLY the one
  // `buildFan`'s filter path constructs (guards.length === 1).
  if (node.collapse === "route" && node.body.kind === "choice" && node.body.guards.length === 1) {
    const maskRow = buildLensEdge(level, id, "mask", node.body.guards[0]!, nextBinders);
    return { id, kind: "fan", site: node.site, instances: 1, collapse: node.collapse, origin, maskRow };
  }

  const interior = buildLevelInterior(level.global, node.body, nextBinders);
  const capturePorts = captureBoundary(interior);

  return {
    id,
    kind: "fan",
    site: node.site,
    instances: 1,
    collapse: node.collapse,
    origin,
    interior,
    ...(capturePorts.length > 0 ? { capturePorts } : {}),
  };
}

/** §6.2 — after building a fan's interior, find every state IT references
 *  that is NOT one of its own (i.e. owned by an ancestor level). Since a
 *  fan's interior is the only way to descend a level, and ownership is
 *  assigned once at first discovery and never reassigned, any fed state
 *  the interior does not itself own must have been discovered by an outer
 *  level before this interior existed — a genuine cross-boundary capture. */
function captureBoundary(interior: ControlMachine): readonly PortId[] {
  const ownStateIds = new Set(interior.states.map((s) => s.id));
  const ports = new Set<PortId>();
  for (const edge of interior.lensEdges) {
    for (const fed of edge.feeds) {
      if (!ownStateIds.has(fed)) ports.add(edge.to.port);
    }
  }
  return [...ports];
}

// ── one machine level ─────────────────────────────────────────────────────

function finishLevel(level: LevelCtx): ControlMachine {
  return {
    states: level.stateOrder.map((id) => level.statesById.get(id)!),
    lensEdges: level.lensEdges,
    egress: level.egressRef!,
    templates: level.templates,
  };
}

/** Build one full machine level rooted at `root`, given the binder map this
 *  level's formulas should resolve (empty at the top; the fan element/
 *  accumulator token for an interior — see `buildFanState`). */
function buildLevelInterior(global: GlobalCtx, root: StaticProv, binders: ReadonlyMap<StaticProv, string>): ControlMachine {
  const level = newLevel(global, binders);
  populateEgress(level, root);
  return finishLevel(level);
}

/** Wire `root` into this level's egress — see this file's header, "egress
 *  modeling", for the two shapes. */
function populateEgress(level: LevelCtx, root: StaticProv): void {
  if (isActive(root)) {
    const rootId = visitActive(level, root);
    level.egressRef = { kind: "state", ref: rootId };
    return;
  }
  const egressId = level.global.nextStateId++ as StateId;
  level.global.ownerLevel.set(egressId, level);
  level.stateOrder.push(egressId);
  level.statesById.set(egressId, { id: egressId, kind: "egress", site: root.site, instances: 1 });
  const edgeId = buildLensEdge(level, egressId, "out", root);
  level.egressRef = { kind: "edge", ref: edgeId };
}

// ── the public entry point ───────────────────────────────────────────────

/**
 * `StaticProv` → `ControlMachine`. Pure, total, deterministic (every
 * traversal order below is a fixed function of the DAG's own structure —
 * the same "first-occurrence, deterministic DFS" discipline `census.ts`/
 * `compose-template.ts` already hold). Not memoized across calls (each
 * call gets its own fresh `GlobalCtx`/id space) — a caller wanting to
 * memoize by `StaticProv` identity across renders may wrap this exactly
 * like `channels()`'s own callers do.
 */
export function collapseView(prov: StaticProv): ControlMachine {
  const global: GlobalCtx = { stateIdByProv: new Map(), ownerLevel: new Map(), nextStateId: 1 };
  return buildLevelInterior(global, prov, new Map());
}

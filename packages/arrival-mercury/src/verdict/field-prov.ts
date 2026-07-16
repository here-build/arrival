/**
 * `fieldProv` — field-granular provenance access, Wave 1 (U1 of BC-2's slice
 * of the "beautiful child" triad). The subcircuit-valued refinement of the
 * verdict's own narrowing: `channels()`'s mux arm folds a projection down to
 * a TERMINAL-set answer (content/selection channels); this module answers
 * the SAME where-provenance question but returns the SUBCIRCUIT itself — a
 * `StaticProv` any later consumer (a per-field seal, a render highlight, the
 * MCP `:at` verb — all LATER lanes, not built here) can fold however it
 * needs. Lives beside `channels`/`narrowMux` (circuit-verdict.ts) because it
 * IS a reading of the same algebra, never a second one — see
 * docs/working-proposals/provenance-beautiful-child/field-granular-access.md
 * §2/§3 for the full design; this header only restates the load-bearing
 * decisions the code below depends on.
 *
 * ── The path ─────────────────────────────────────────────────────────────
 *
 * `FieldPath` lives in VALUE space, not circuit space (§2.1): a string
 * segment addresses a dict/object key, a number segment an array/positional
 * index — the SAME alphabet `probe/verdict.ts`'s `LeafPath` and mcp-worker's
 * `attest-provider.ts`'s `LeafPath` already use (a deliberate fourth
 * non-declaration of the same grammar). `BuildProv.parts[i].key` is minted
 * (arm-control.ts's "build" case, arm-containers.ts's `extractContainer`) to
 * be EXACTLY this runtime egress address — attest-provider.ts's
 * `staticLeavesOf` "WHY THIS IS SOUND, NOT INVENTED" block is the citation;
 * §7's path-univalence law (this package's own
 * `__tests__/verdict/path-univalence.test.ts`) is what promotes that
 * citation to a tested invariant instead of a comment.
 *
 * ── `descend`'s one governing rule ──────────────────────────────────────
 *
 * The empty-path check runs FIRST, unconditionally, for every node kind —
 * INCLUDING `mux`. This is not an approximation: §2.3's per-kind table is
 * headed "behavior on step `s` (the HEAD of the remaining path)" — every row
 * in it presupposes a step exists. When the path is already exhausted there
 * is no step to discuss, so the only rule left is §2.4's "empty path → cone
 * = the node itself," applied BEFORE any mux normalization. Consequence:
 * `fieldProv(root, [])` on a mux returns the mux node verbatim, never a
 * narrowed part, even when narrowing would succeed — there is nothing left
 * to route with. This stays SOUND, never merely different: any later
 * verdict computed over the cone re-applies `narrowMux` itself (via
 * `channels()`'s own mux arm), so a cone that is "the whole mux" and a cone
 * that is "the mux's narrowed part" always fold to IDENTICAL channels — the
 * object `fieldProv` hands back is a render/identity choice, never a
 * soundness fork (INV-5 pins exactly this).
 *
 * Once a step DOES exist, mux "consumes nothing" (§2.3): it normalizes via
 * the SHARED `narrowMux` helper (circuit-verdict.ts — the R3
 * one-function-two-callers rule that keeps this module and the verdict from
 * ever drifting on where-provenance) and, on a single-part narrow,
 * re-descends into that part carrying the ENTIRE remaining path (the step
 * included) — the mux itself never eats a segment; only `build`/`fan` do.
 *
 * ── Refusal vs. conservatism (§2.5) ─────────────────────────────────────
 *
 * A REFUSAL (`{kind:"refused"}`) means the QUERY is wrong: an absent key,
 * stepping into a definite scalar (`string`/`fused`), a string step into a
 * fan body, or any step into a combine-fan's already-folded output. A
 * CONSERVATISM stays a `{kind:"cone"}` — the query was fine, the CIRCUIT is
 * merely coarse or opaque there: a dead (0-hit) mux (the car-over-cons
 * alphabet mismatch — the cone IS the mux, and ITS verdict, computed later
 * via `channels`/`circuitVerdict`, is the fail-closed opaque, never a
 * path-level error), a `whole` mux (null key or non-build source), a bare
 * terminal (`input`/`mint`/`const`/`opaque`), or a `choice` — all four get a
 * FRONTIER (remainder recorded, §2.4) because the static plane simply
 * cannot see further, not because the path was malformed. Confusing the two
 * would either over-refuse a sound over-approximation or under-refuse a
 * genuinely nonsensical query — §2.5's table is the single source of truth
 * for which is which; `descend` implements it row for row.
 *
 * ── Fans: per-template, never per-element (§2.3, §3.3) ──────────────────
 *
 * A `lowered`/`route` fan consumes a NUMERIC step into its `body` (the
 * per-template answer for every element — the same distinguished
 * `mux{key:null}` element `buildFan` already threads through the body) and
 * records the fan's own `site` in `crossedFans`; a STRING step there is a
 * `path/index-expected` refusal (wrong alphabet, not a coarse answer). A
 * `combine` fan refuses ANY step (`path/into-aggregate`) — its output is one
 * folded scalar; there is no element to land on regardless of step shape.
 * `crossedFans` is navigation-grade metadata ONLY: forbidding a per-field
 * SEAL through a nonempty `crossedFans` list is a later lane's job (§4.1);
 * this module just reports the crossing honestly and moves on.
 *
 * ── Duplicate keys — candidates, never widened (§2.3, §2.5) ─────────────
 *
 * A `build` step (or a normalized `mux`) matching ≥2 parts descends the REST
 * of the path into every hit independently and returns their fully
 * flattened cones as `candidates` (§3.1: "cone = candidates[0] by
 * convention; verdicts fold ALL" — the conjunction itself is a later lane's
 * job, not this module's — it only pins the shape). If any candidate's own
 * descent refuses, the whole candidate set refuses: a coherent
 * multi-candidate cone cannot be built out of one candidate that plainly
 * doesn't have the addressed shape (the same "a bad reading poisons the
 * aggregate" stance `channels`' absorptive union already takes, one level
 * up).
 */
import type { NodeId } from "../coreform/types.js";
import type { BuildProv, FusedProv, StaticProv, StringProv } from "../model/static-prov.js";
import { narrowMux } from "./circuit-verdict.js";

/** A field's address inside a (possibly nested) VALUE: an object key or an
 *  array index, root-to-field. `[]` addresses the root value itself. Lives
 *  in VALUE space, not circuit space (§2.1) — the SAME alphabet
 *  `probe/verdict.ts`'s `LeafPath` and mcp-worker's `attest-provider.ts`'s
 *  `LeafPath` already use; this is deliberately not a fourth declaration of
 *  a new grammar. */
export type FieldPath = readonly (string | number)[];

/**
 * PURE. A lens over `StaticProv` — no probe, no run, no render dependency
 * (field-granular-access.md §3.1). See this module's header for `descend`'s
 * governing rule and the refusal/conservatism split.
 */
export type FieldProvResult =
  | {
      readonly kind: "cone";
      /** Object-identity into the root circuit — never a synthesized node
       *  (§3.2's identity contract: a shared node reached two ways is the
       *  SAME object, for free, because this module never copies). */
      readonly cone: StaticProv;
      /** Duplicate-key multiplicity (§2.3/§2.5): present iff a `build` step
       *  or a normalized `mux` matched ≥2 parts. `cone` is `candidates[0]`
       *  by convention; a verdict must fold ALL of them (a later lane's
       *  job — this module only pins the shape). */
      readonly candidates?: readonly StaticProv[];
      /** Present iff the path was NOT fully consumed — coarseness, not an
       *  error (§2.4): the dynamic leg still uses the FULL original path
       *  against the runtime value; only the STATIC answer stops here. */
      readonly frontier?: { readonly remainder: FieldPath };
      /** Every `fan` site the descent passed a numeric step through, root
       *  to leaf, in crossing order. Navigation-grade only (§3.3, §4.1's
       *  later lane) — never verdict-bearing by itself. */
      readonly crossedFans: readonly NodeId[];
    }
  | {
      readonly kind: "refused";
      /** Stable namespaced code — §2.5's refusal rows (errors-as-doors: the
       *  code is the identity). */
      readonly code: string;
      /** House-door teaching text: names the actual keys/shape, offers the
       *  working alternative. */
      readonly teach: string;
    };

type ConeResult = Extract<FieldProvResult, { readonly kind: "cone" }>;
type RefusedResult = Extract<FieldProvResult, { readonly kind: "refused" }>;

function refuse(code: string, teach: string): FieldProvResult {
  return { kind: "refused", code, teach };
}

/** Prepend one fan `site` to a cone result's `crossedFans` (the caller is
 *  always the OUTER fan relative to whatever the recursive inner descent
 *  already accumulated, so prepending keeps the array root-to-leaf). A
 *  refusal passes through unchanged — the type has no `crossedFans` slot to
 *  add to, by design: a refused query never reports a partial navigation
 *  trail. */
function withCrossedFan(result: FieldProvResult, site: NodeId): FieldProvResult {
  if (result.kind === "refused") return result;
  return { ...result, crossedFans: [site, ...result.crossedFans] };
}

/**
 * Merge N independent descents of the SAME remaining path into the
 * duplicate-key candidate shape (§2.3's "≥2 hits" build row and its mux
 * mirror). Fails closed on ANY candidate's own refusal — see this module's
 * header for why.
 */
function descendCandidates(hits: readonly StaticProv[], rest: FieldPath): FieldProvResult {
  const results = hits.map((h) => descend(h, rest));
  const refusal = results.find((r): r is RefusedResult => r.kind === "refused");
  if (refusal) return refusal;
  const cones = results as readonly ConeResult[];
  const candidates = cones.flatMap((c) => c.candidates ?? [c.cone]);
  const crossedFans = [...new Set(cones.flatMap((c) => c.crossedFans))];
  const frontier = cones.find((c) => c.frontier !== undefined)?.frontier;
  return {
    kind: "cone",
    cone: candidates[0]!,
    candidates,
    crossedFans,
    ...(frontier !== undefined ? { frontier } : {}),
  };
}

function teachAbsentKey(node: BuildProv, step: string | number): string {
  const keys = node.parts.map((p) => JSON.stringify(p.key)).join(", ") || "(none — this container is empty)";
  const alphabet =
    node.ctor === "dict" ? "string keys address dict parts, numbers address positions" : "numeric positions address this container's parts";
  return (
    `path/absent-key — no part keyed ${JSON.stringify(step)} in this ${node.ctor} container ` +
    `(its keys: ${keys}; ${alphabet}). A provably-absent projection grounds in nothing, so ` +
    `refusing is the fail-closed reading, never an attestation of nil.`
  );
}

function teachIntoScalar(node: StringProv | FusedProv, step: string | number): string {
  const shape = node.kind === "string" ? "a string/format-run result" : "a fused (arithmetic, comparison, or cast) result";
  return (
    `path/into-scalar — this node is ${shape}, a definite scalar with no interior to address; ` +
    `step ${JSON.stringify(step)} has nothing to land on. Ask for this node's own cone (an empty ` +
    `remaining path) instead of stepping further into it.`
  );
}

function teachIntoAggregate(step: string | number): string {
  return (
    `path/into-aggregate — this fan folds every element into one combined value ` +
    `(collapse:"combine"); there is no element ${JSON.stringify(step)} left to address once ` +
    `combined. Ask for the fan's own cone (drop the remaining path) instead.`
  );
}

function teachIndexExpected(step: string | number): string {
  return (
    `path/index-expected — this is a per-element fan body; addressing it needs a numeric element ` +
    `index, not a key named ${JSON.stringify(step)}. Use a number (e.g. 0) to reach one element's ` +
    `per-template attribution.`
  );
}

/**
 * The one recursive walk (§2.3). `path.length === 0` is checked FIRST,
 * unconditionally, for every node kind — see this module's header for why
 * that includes `mux` (the per-kind table below only governs what happens
 * once a step genuinely exists).
 */
function descend(node: StaticProv, path: FieldPath): FieldProvResult {
  if (path.length === 0) {
    return { kind: "cone", cone: node, crossedFans: [] };
  }
  const step = path[0]!;
  const rest = path.slice(1);

  switch (node.kind) {
    case "build": {
      const hits = node.parts.filter((p) => p.key === step);
      if (hits.length === 0) return refuse("path/absent-key", teachAbsentKey(node, step));
      if (hits.length === 1) return descend(hits[0]!.prov, rest);
      return descendCandidates(
        hits.map((h) => h.prov),
        rest,
      );
    }

    case "fan": {
      if (node.collapse === "combine") return refuse("path/into-aggregate", teachIntoAggregate(step));
      if (typeof step !== "number") return refuse("path/index-expected", teachIndexExpected(step));
      return withCrossedFan(descend(node.body, rest), node.site);
    }

    case "mux": {
      const narrowed = narrowMux(node);
      if (narrowed.kind === "whole") {
        return { kind: "cone", cone: node, frontier: { remainder: path }, crossedFans: [] };
      }
      if (narrowed.kind === "dead") {
        // 0 hits — the car-over-cons alphabet mismatch (§2.5). The cone IS
        // this mux; ITS verdict (computed later via channels/circuitVerdict,
        // which independently re-runs narrowMux) is the fail-closed opaque.
        // A CONSERVATISM, not a refusal — the query was fine, the circuit is
        // what's blind here — so the remaining path is simply discarded,
        // never surfaced as an error or a frontier.
        return { kind: "cone", cone: node, crossedFans: [] };
      }
      // "parts" — mux consumes NOTHING, so the entire remaining path (the
      // current step included) carries through to the resolved part(s).
      if (narrowed.parts.length === 1) return descend(narrowed.parts[0]!, path);
      return descendCandidates(narrowed.parts, path);
    }

    case "choice":
      // Verdict-bearing algebra frontiers here (§2.3/C4): every world folds
      // absorptively at the choice node already; there is no per-world
      // structure this static, pure lens may distribute into (navigation
      // MAY, a later render concern — §6 — never this query).
      return { kind: "cone", cone: node, frontier: { remainder: path }, crossedFans: [] };

    case "string":
    case "fused":
      return refuse("path/into-scalar", teachIntoScalar(node, step));

    case "input":
    case "mint":
    case "const":
    case "opaque":
      // The static plane cannot decompose a crossing's output, a caller's
      // evidence, or program text (I1) — pretending otherwise would be
      // invented structure. Coarseness, not an error (§2.4): the dynamic leg
      // still reads the FULL original path against the runtime value.
      return { kind: "cone", cone: node, frontier: { remainder: path }, crossedFans: [] };
  }
}

/**
 * The query (§3.1). See this module's header for the full account; in one
 * line: descend `root` by `path`, sharing `narrowMux` with `channels()` so
 * the two can never drift (R3 — one function, two callers).
 */
export function fieldProv(root: StaticProv, path: FieldPath): FieldProvResult {
  return descend(root, path);
}

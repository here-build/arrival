/**
 * The carrier's STATIC reproduction of the dag `:fields` point-edge map — L2 consumer #1
 * (the `:fields` half of `traceToStatechart`'s `resolvePoint`). It reads the auto-bound
 * lineage carrier instead of walking the live `fieldPointMeta` mint:
 *
 *   for each consumer source-point, classify its ARGUMENT sub-expressions (`classify` stops
 *   at the source head — `lineage.ts:396` — so the whole call would be inert; the keyword
 *   plucks live in the args), collect the `field` nodes, and resolve each auto-bound to
 *   `{ base: producer-ids, key }`. Fold to the same `Map<"producer>consumer", Set<field>>`
 *   the live statechart builds inline (`fieldsByPointEdge`, `statechart.ts:166-181`).
 *
 * Proven BYTE-IDENTICAL to the live edge `:fields` over the corpus (gepa / multi-field /
 * positional-only) by `lineage-field-shadow-corpus.test.ts` — fed the REAL consumer AST off
 * the trace, no curated pluck list, so the no-spurious-pin / no-missing-pin claim is real.
 *
 * ADDITIVE + flag-gated: returns an EMPTY map when no `AutoBindings` sidecar is attached
 * (`trace.withAutoBindings()` is the flag), so wiring this reader in keeps the live path
 * byte-identical while off. The swap into `traceToStatechart` behind `--ir-lineage`, and the
 * mint's retirement, are later L2 steps; this rides ALONGSIDE the mint until every consumer
 * migrates.
 *
 * SLOT SCOPING: each field node's slots resolve ONLY against auto-bindings recorded within the
 * CONSUMER point's invocation subtree (`subtreeIds`), NOT the global first-match — so two
 * consumers reading the same slot name bind to their OWN producer, and a looped consumer's
 * iterations each bind their own (unioned per cell by the statechart's fan-collapse).
 * GENESIS: `collectFieldNodes` mirrors the live `fieldPoint` absorption — a keyword plucked off a
 * fresh constructor (`(:a (list (:b x)))`) does NOT pin the upstream producer (only the inner `:b`
 * that reaches it does), guarded by `hasKeywordField`.
 * KNOWN GAPS (corpus-gated `it.todo`, fast-follow): (1) an INLINE-SOURCE pluck `(:k (car (infer …)))`
 * loses its pin — the operator slot `infer` carries no provenance so it never auto-binds (the
 * symbol-bound `(:k (car x))` form works). (2) an `(@ x :k)` membrane read pins where the
 * keyword-only live `accessorField` (trace.ts:65) mints nothing — the carrier is the faithful side.
 */
import { classify, fieldResolve, slotsOf } from "@here.build/arrival";
import type { Classifier, LineageNode } from "@here.build/arrival";

import type { EvalTrace, Invocation } from "./trace.js";

/** Structural pair test — local, so the reader needs no `is_pair` import (mirrors statechart.ts). */
const isPair = (v: unknown): v is { readonly car: unknown; readonly cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

/** The operand expressions of a call AST `(head a b c)` → `[a, b, c]`. */
function operandsOf(node: unknown): unknown[] {
  const out: unknown[] = [];
  let n: unknown = isPair(node) ? node.cdr : null;
  while (isPair(n)) {
    out.push(n.car);
    n = n.cdr;
  }
  return out;
}

/** Does `n`'s subtree contain a KEYWORD field node? (A positional `car`/`index` step does not
 *  count — it never pins.) Used to mirror the live `fieldPoint` absorption: a keyword plucked
 *  off a value that ALREADY had a keyword plucked from it absorbs into the inner one. */
function hasKeywordField(n: LineageNode): boolean {
  switch (n.kind) {
    case "field":
      return "field" in n.step || hasKeywordField(n.child);
    case "pipe":
      return hasKeywordField(n.child);
    case "fan":
      return hasKeywordField(n.source) || (n.template ? hasKeywordField(n.template) : false);
    case "mux":
      return hasKeywordField(n.selector) || n.arms.some(hasKeywordField);
    case "merge":
    case "opaque":
      return n.children.some(hasKeywordField);
    default:
      return false; // leaf / source / literal
  }
}

/** The KEYWORD `field` nodes in a classified skeleton that actually PIN — i.e. whose base
 *  reaches a producer with NO intervening keyword field. A keyword plucked off an already-plucked
 *  value ABSORBS into the inner one (the live `fieldPoint` collapses `fieldPoint(fieldPoint(P,b),a)`
 *  → {P, b}, trace.ts:390) — so the outer key pins nothing new on the producer. This guards the
 *  GENESIS over-pin `(:a (list (:b x)))`: `:a` is plucked off a fresh constructor, not the producer
 *  `:b` reaches, so only `:b` pins. A positional `car`/`index` field (key=null) never pins; we
 *  don't collect it, but we still descend its child for deeper keyword plucks. */
function collectFieldNodes(n: LineageNode, out: LineageNode[] = []): LineageNode[] {
  switch (n.kind) {
    case "field":
      if ("field" in n.step && !hasKeywordField(n.child)) out.push(n);
      collectFieldNodes(n.child, out);
      break;
    case "pipe":
      collectFieldNodes(n.child, out);
      break;
    case "fan":
      collectFieldNodes(n.source, out);
      if (n.template) collectFieldNodes(n.template, out);
      break;
    case "mux":
      collectFieldNodes(n.selector, out);
      n.arms.forEach((a) => collectFieldNodes(a, out));
      break;
    case "merge":
    case "opaque":
      n.children.forEach((ch) => collectFieldNodes(ch, out));
      break;
    // leaf / source / literal carry no pluck.
  }
  return out;
}

/** Every invocation id in a consumer point's SUBTREE (itself + transitive children). A field
 *  pluck's symbol resolution is recorded under the child invocation that read it (e.g. the `car`
 *  invocation), which is a descendant of the consumer point — so this is the scope to resolve the
 *  pluck's slots against, isolating each consumer from another that reads the same slot name. */
function subtreeIds(root: Invocation): Set<number> {
  const ids = new Set<number>();
  const stack: Invocation[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    ids.add(n.id);
    for (const c of n.children) stack.push(c);
  }
  return ids;
}

/** Leading op-symbol of a call AST `(head . args)` → its `__name__`, else null. */
function headSymbol(node: unknown): string | null {
  if (!isPair(node)) return null;
  const head = node.car;
  if (head !== null && typeof head === "object" && "__name__" in head) {
    const n = (head as { __name__: unknown }).__name__;
    if (typeof n === "string") return n;
  }
  return null;
}

/** Collection ops `classify` models as a per-element fan template (mirrors the arrival
 *  classifier's FAN_OPS — fan-ness is not structural, so it's a tiny enumerated set). */
const FAN_OPS: ReadonlySet<string> = new Set(["map", "filter", "vector-map"]);

/**
 * A `Classifier` derived from the TRACE — no env, no hardcoded source list. The source ops
 * (`isRosettaIn`) are exactly the head-symbols of the run's provenance-point invocations: post
 * the points-by-default flip a rosetta mints iff it is a point, so the trace's points ARE the
 * sources that actually fired (http/sql/db included; new sources automatic). `classify` never
 * consults `isPure`, and `isOpaque` does not change which `field` nodes `collectFieldNodes` finds
 * (a member-read is recognized before the opaque cut, and opaque + pure both descend children) —
 * so both are trivial. This is what lets the dag self-serve the carrier — the only `:fields` source
 * now that the mint is retired — with nothing wired in (the env source-registry seam never closed).
 */
export function classifierFromTrace(trace: EvalTrace): Classifier {
  const sources = new Set<string>();
  for (const inv of trace.invocationLog) {
    if (!inv.isProvenancePoint) continue;
    const head = headSymbol(inv.node);
    if (head !== null) sources.add(head);
  }
  return {
    isPure: () => false, // classify() does not consult isPure — pure ops fall through to combine
    isRosettaIn: (op) => sources.has(op),
    isFan: (op) => FAN_OPS.has(op),
    isOpaque: () => false, // irrelevant to which field nodes collectFieldNodes collects
  };
}

/**
 * The statechart's `:fields` source: `Map<"producer>consumer", Set<field>>`. Empty when no
 * `AutoBindings` sidecar is attached (so a trace built without it carries no `:fields`). The
 * classifier defaults to `classifierFromTrace` — the trace self-describes its sources, so the dag
 * needs no env or source list.
 */
export function carrierFieldEdges(trace: EvalTrace, classifier: Classifier = classifierFromTrace(trace)): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const auto = trace.autoBindings;
  if (!auto) return out; // flag OFF — the carrier contributes nothing

  for (const inv of trace.invocationLog) {
    if (!inv.isProvenancePoint) continue; // consumers are the source-points (infer/effect calls)
    const consumer = inv.id;
    const scope = subtreeIds(inv); // resolve this consumer's slots only against ITS subtree's bindings
    // Resolve a field node's slots against bindings recorded WITHIN this consumer's subtree — not
    // the global first-match — so two consumers reading the same slot name bind to their own
    // producer, and a looped consumer's iterations each bind their own (unioned per cell downstream).
    const scopedBindings = (slots: Iterable<string>): Record<string, readonly number[]> => {
      const b: Record<string, readonly number[]> = {};
      for (const slot of slots) {
        const ids = auto.producersFor(slot, (cands) => {
          const u = new Set<number>();
          for (const c of cands) if (scope.has(c.invocationId)) for (const x of c.ids) u.add(x);
          return [...u];
        });
        if (ids.length > 0) b[slot] = ids;
      }
      return b;
    };
    for (const argExpr of operandsOf(inv.node)) {
      for (const fieldNode of collectFieldNodes(classify(argExpr, classifier))) {
        const { base, key } = fieldResolve(fieldNode, scopedBindings(slotsOf(fieldNode)));
        if (key === null) continue; // positional-forward (car / index) — no pin (D-v02-4)
        for (const producer of base) {
          if (producer === consumer) continue; // self-edge — a mid-flight artifact (matches statechart.ts:176)
          const edge = `${producer}>${consumer}`;
          (out.get(edge) ?? out.set(edge, new Set<string>()).get(edge)!).add(key);
        }
      }
    }
  }
  return out;
}

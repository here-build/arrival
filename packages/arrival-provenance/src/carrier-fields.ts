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
 * SCOPE (matches the G0/E2 spikes): single-binding (non-loop) field edges. `bindingsFor`
 * resolves a slot to its first-recorded producer set globally (`AutoBindings.producersFor`) —
 * exact when a slot is bound once (the corpus), the deferred fan×lens z-axis otherwise.
 * GENESIS caveat: a `:foo` plucked off a fresh constructor (`(:foo (list …))`) has no live
 * field-point (the list is not a producer point), but its carrier `base` can still reach an
 * upstream producer through the constructor — a potential over-pin. None occur in the corpus;
 * the dual-run flags it the moment a genesis program enters the corpus (the deferred v02-G6
 * genesis-labeling closes it).
 */
import { classify, fieldResolve, slotsOf } from "@here.build/arrival";
import type { Classifier, LineageNode } from "@here.build/arrival";

import type { EvalTrace } from "./trace.js";

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

/** Every `field` node reachable in a classified skeleton (the plucks). A field node's own
 *  child IS descended: a positional child carries `key=null` (skipped downstream) and nested
 *  keyword plucks already absorbed to this innermost field at classify time, so descending
 *  neither double-counts a real pin nor misses a pluck nested in the base expression. */
function collectFieldNodes(n: LineageNode, out: LineageNode[] = []): LineageNode[] {
  switch (n.kind) {
    case "field":
      out.push(n);
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
 * so both are trivial. This is what lets the dag self-serve the carrier under `forwardFields` with
 * nothing wired in (the production routing the env source-registry seam never closed).
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
 * The carrier analogue of the live `fieldsByPointEdge`: `Map<"producer>consumer", Set<field>>`.
 * Empty when the `AutoBindings` flag is off (the live path is then byte-identical). The classifier
 * defaults to `classifierFromTrace` — the trace self-describes its sources, so the production caller
 * (and the dag under `forwardFields`) needs no env or source list.
 */
export function carrierFieldEdges(trace: EvalTrace, classifier: Classifier = classifierFromTrace(trace)): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const auto = trace.autoBindings;
  if (!auto) return out; // flag OFF — the carrier contributes nothing

  for (const inv of trace.invocationLog) {
    if (!inv.isProvenancePoint) continue; // consumers are the source-points (infer/effect calls)
    const consumer = inv.id;
    for (const argExpr of operandsOf(inv.node)) {
      for (const fieldNode of collectFieldNodes(classify(argExpr, classifier))) {
        const { base, key } = fieldResolve(fieldNode, auto.bindingsFor(slotsOf(fieldNode)));
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

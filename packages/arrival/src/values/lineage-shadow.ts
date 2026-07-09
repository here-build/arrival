/**
 * Slices 2–3 of wiring the static lineage classifier (W3 — SHADOW MODE; design
 * docs/package-specific/arrival-provenance/provenance-static-lineage-finalization-v0.1-2026-06-19.md
 * §8). Builds a per-form skeleton at load and, behind the `irLineage` flag, ASSERTS
 * that the static `fullCone` reproduces the UNTAPPED eager `result.provenance`.
 *
 * TWO PROVENANCE MECHANISMS — do not conflate: (1) the per-op EAGER STAMP
 * (`unionProvenance`/`withInputProvenance`) runs UNTAPPED during normal eval and
 * stamps `result.provenance` — what `exec(src,{env})` returns. (2) trace-tap
 * `computeProvenance` is tapped-only and adds authoritative-forwarding + field-
 * points. `fullCone` (./lineage.ts) is the static analogue of (1) — shadow compares
 * `fullCone(skeleton, bindings)` against the UNTAPPED `provOf(result)`, NEVER
 * `computeProvenance`, with NO tap installed (generalizes `lineage-checkpoint.test.ts:60-69`).
 *
 * KEYING: the correlation key is the program's OUTPUT VALUE — classify the
 * top-level form, compare its `fullCone` to `provOf(result)`. Pair-identity-free
 * (dissolves the macro-expand-fresh-Pairs hazard); no per-node runtime stamping
 * needed since the eager stamp already lives on the result.
 *
 * BINDINGS: a static `leaf{slot}` / `source{op}` resolves at runtime to the
 * provenance its binding carries — `provOf(env.get(slot))`. Walk the skeleton
 * for its referenced slots and read each from the run env.
 *
 * THE PROVABLE SHADOW CLASS (empirical — see "BOUNDARIES" below): SOURCE-FREE
 * programs over input-leaf bindings, restricted to VALUE-position shapes where
 * the static cone coincides with the eager stamp — literals, pure pipe/merge
 * arithmetic, the string-collapse path, `cons` union, and `if`/`let`/`cond` whose
 * conservative selector∪arms superset happens to equal the taken-arm eager cone.
 * Outside that class `fullCone` legitimately DIVERGES from the eager stamp BY
 * DESIGN (element-projection, cardinality-drop, spine-rebuild, control-flow
 * superset, fan-cardinality over-attribution). Shadow asserts strictly: a
 * divergence outside the two skip categories is a THROW, never a silent pass.
 */
import { is_pair, is_macro_value } from "./value-guards.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { AValue } from "./primitives/AValue.js";
import { assertNever, CLASSIFIED_SPECIAL_FORMS, fullCone, type Bindings, type LineageNode } from "./lineage.js";
import type { Environment } from "../Environment.js";
import { APair } from "./primitives/APair.js";
import type { AListAlike, SchemeValue } from "./types.js";
import { ProvenanceShadowDivergence } from "../errors.js";

/** Provenance ids on a value, sorted — `[]` for a non-AValue. Mirrors the
 *  golden-prov / checkpoint `provOf`; this is the UNTAPPED eager stamp (mechanism 1). */
export function provOf(v: unknown): number[] {
  return v instanceof AValue ? [...v.provenance].sort((a, b) => a - b) : [];
}

/** Why a top-level form is OUTSIDE shadow's provable set (recorded, not asserted).
 *  `null` ⇒ the form is in-scope and the cone must match. */
export type ShadowSkip =
  | { readonly kind: "macro-head"; readonly op: string } // head resolves to is_macro — no static node (macros aren't classified)
  | { readonly kind: "keyword-projection"; readonly op: string }; // (:field …) where-provenance — no static node (v0.2/B2)

/** Detect the two skip categories the design names: a macro head (the classifier
 *  models applications/special-forms, not macro expansions) and a `(:field …)`
 *  keyword projection (where-provenance has no static node — out of scope). Both
 *  are recognised from the SURFACE head, before any expansion. */
export function shadowSkipReason(form: SchemeValue, env: Environment): ShadowSkip | null {
  if (!(form instanceof APair)) return null; // atoms (a literal / a bare symbol) are trivially classifiable
  const head = form.car;
  if (!(head instanceof ASymbol)) return null; // computed operator — fall through (classify stringifies it)
  const op = String(head.valueOf());

  // `(:field x)` — a keyword projection (where-provenance). No static lineage node.
  if (op.startsWith(":")) return { kind: "keyword-projection", op };

  // The special forms classify() models BY SHAPE resolve to `Macro` instances in the
  // env (the evaluator dispatches them from SPECIAL_FORMS, not by expansion), yet
  // they ARE in scope — `if`/`let`/`cond`/… are the whole point of W1. Recognise
  // them FIRST so the macro skip below does not over-skip them.
  if (CLASSIFIED_SPECIAL_FORMS.has(op)) return null;

  // A genuine macro head (a user/library macro that expands to something classify
  // cannot see statically): out of scope. The static classifier never expands.
  // `is_macro_value` reads the macro classes' `[CLASS]` brand off `constructor`
  // (value-guards.ts) — a downward, eval-import-free test, so no value→eval edge.
  const bound = env.get(op, { throwError: false });
  if (is_macro_value(bound)) return { kind: "macro-head", op };

  return null;
}

/** Collect the input-leaf slots (`leaf.slot` + `source.op`) the skeleton references,
 *  so bindings can be read from the run env for exactly those. */
function collectSlots(n: LineageNode, out: Set<string>): void {
  switch (n.kind) {
    case "literal":
      return;
    case "leaf":
      out.add(n.slot);
      return;
    case "source":
      out.add(n.op);
      return;
    case "pipe":
    case "transparent": // cone-identical to pipe (§2: neither mints nor stamps) — UNREACHABLE today
      collectSlots(n.child, out);
      return;
    case "field":
      collectSlots(n.child, out); // the focused child only — siblings were never built
      return;
    case "fan":
      collectSlots(n.source, out);
      return;
    case "mux":
      collectSlots(n.selector, out);
      n.arms.forEach((a) => collectSlots(a, out));
      return;
    case "merge":
    case "opaque":
    case "sink": // children-array shape, same barrier treatment — UNREACHABLE today
    case "binder": // children-array shape, same barrier treatment — UNREACHABLE today
      n.children.forEach((ch) => collectSlots(ch, out));
      return;
    default:
      // Same exhaustiveness contract as walk(): a new LineageNode kind without a
      // collect arm fails to compile here rather than silently under-collecting slots.
      assertNever(n);
  }
}

/** Assemble runtime bindings for a skeleton: each referenced slot ← the provenance
 *  its env binding carries (`provOf(env.get(slot))`). The proven checkpoint pattern
 *  (lineage-checkpoint.test.ts:66), driven by the slots the skeleton actually uses. */
export function bindingsForSkeleton(skeleton: LineageNode, env: Environment): Bindings {
  const slots = new Set<string>();
  collectSlots(skeleton, slots);
  const b: Record<string, readonly number[]> = {};
  for (const slot of slots) b[slot] = provOf(env.get(slot, { throwError: false }));
  return b;
}

/**
 * The shadow assert (slice 3). For an IN-SCOPE form, throw on `fullCone != provOf`.
 * For a skip-category form, return its reason (the caller records it as uncovered).
 * Asserts `fullCone` ONLY — `countCone` diverges from the eager stamp BY DESIGN
 * (the v0.2 minimal cone), so it is never asserted here.
 *
 * `formText` is the rendered source of the form (for the divergence message).
 */
export function assertShadowCone(
  skeleton: LineageNode,
  form: SchemeValue,
  result: SchemeValue,
  env: Environment,
  formText: string,
): ShadowSkip | null {
  const skip = shadowSkipReason(form, env);
  if (skip) return skip;

  const staticCone = fullCone(skeleton, bindingsForSkeleton(skeleton, env));
  const eagerCone = provOf(result);
  if (JSON.stringify(staticCone) !== JSON.stringify(eagerCone)) {
    throw new ProvenanceShadowDivergence(formText, staticCone, eagerCone);
  }
  return null;
}

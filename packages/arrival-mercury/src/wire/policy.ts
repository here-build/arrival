/**
 * The seal's policy (docs/foundations/arrival-scheme/provenance-by-perturbation.md
 * §3's table, P7: "the seal's policy is part of the specification"). Two
 * structural checks, read directly off a `WireDescriptor` — NO measures, no
 * thresholds, nothing an engineer could pick differently in private:
 *
 *   dataShaped      — the content path terminates in a PVertice, never a Literal.
 *   judgmentShaped   — may terminate in a Case whose alternatives are Literals,
 *                      PROVIDED those literals are the declared vocabulary.
 *
 * An undeclared constant in a judgment slot is a fabrication. A leaf that is
 * neither shape is not attestable — the seal has nothing to say about it.
 */
import type { Lit } from "../coreform/types.js";

import type { Literal, WireDescriptor } from "./types.js";

/** A descriptor that is JUST a program constant — no crossing anywhere in it. The
 *  narrowing target for both checks below: `alts`/other-argument positions must be
 *  exactly this shape to count as "the program's own constants," not merely
 *  "currently resolves to a Literal at the top" (a `Literal` with steps on top of
 *  it would mean further operations ran on a constant, which is still a constant,
 *  but is never produced by this walk — `deriveScalar` never appends a step onto a
 *  bare literal source. Checking `steps.length === 0` here is therefore a genuine
 *  invariant check, not decoration). */
function isBareLiteral(desc: WireDescriptor): desc is WireDescriptor & { readonly source: Literal } {
  return desc.source.kind === "Literal" && desc.steps.length === 0;
}

/**
 * True iff EVERY reachable sub-descriptor in `desc`'s construction is rooted in a
 * `PVertice` — never a bare `Literal` (a fabrication residue) and never a `Hole`
 * (unproven; the positive claim `dataShaped` makes must be a PROOF, per the design
 * doc's soundness asymmetry §0 — an unresolved position can never be silently
 * counted as clean, only as "not proven clean"). A `Case` anywhere in the chain is
 * SELECTION by construction (types.ts), so it never counts as clean even nested
 * inside another step's `otherArgs` — a selection glued into a content slot is
 * exactly as fabricated as a bare literal there.
 */
function isCleanContent(desc: WireDescriptor): boolean {
  // A `Case` is clean content iff EVERY alternative is — the leaf is a real
  // value in every branch it could take, so there is no run where it is a
  // literal. The condition is selection (why), not content (where), and does
  // not bear on cleanness. This is a PROOF (dataShaped is a positive claim):
  // `(and (:a e) (:b e))` is content either way; `(if c "A" "B")` is NOT
  // (literal alts ⇒ not clean ⇒ fabrication-in-the-middle stays rejected).
  if (desc.source.kind === "Case") {
    return desc.source.alts.every((alt) => isCleanContent(alt)) && desc.steps.every((s) => s.otherArgs.every((a) => isCleanContent(a.descriptor)));
  }
  if (desc.source.kind !== "PVertice") return false;
  return desc.steps.every((step) => step.otherArgs.every((arg) => isCleanContent(arg.descriptor)));
}

/** **data-shaped** — identifiers, paths, quoted spans, timestamps: anything
 *  presented as OBSERVED. The content path must terminate in a `PVertice`, never in
 *  a `Literal`, and must carry no literal residue at any construction step
 *  (`(string-append (:id e) "-FAKE")`'s otherArg) — a program constant in a content
 *  position IS the fabrication, whether it is the whole leaf or glued onto real
 *  content. */
export function dataShaped(desc: WireDescriptor): boolean {
  return isCleanContent(desc);
}

/** **judgment-shaped** — verdicts, classes, buckets: a leaf allowed to be a
 *  SELECTION among the program's own constants, but only the DECLARED vocabulary
 *  (the attested output schema's admissible constant set). A `Case` whose
 *  alternatives are anything other than bare literals is not attestable this way
 *  at all (an alternative built from further steps, or itself a nested `Case`, is
 *  not "the program's own constant" in the simple sense this check licenses); a
 *  `Case` of bare literals outside `vocabulary` is an undeclared constant in a
 *  judgment slot — a fabrication wearing a judgment's shape. */
export function judgmentShaped(desc: WireDescriptor, vocabulary: ReadonlySet<string>): boolean {
  if (desc.source.kind !== "Case") return false;
  const { alts } = desc.source;
  if (alts.length === 0 || !alts.every(isBareLiteral)) return false;
  return alts.every((alt) => vocabulary.has(literalKey(alt.source.lit)));
}

/** A comparable key for a literal's scalar value — string/boolean stringify to
 *  their own text; a number compares on its RAW source text (coreform's own
 *  convention — parsing a number to a value is emit's job, never classification's
 *  or this module's); `keyword`/`undefined` are not verdict-shaped values in
 *  practice but are given a stable key anyway so the vocabulary comparison never
 *  throws on an unusual literal. */
function literalKey(lit: Lit): string {
  switch (lit.value.kind) {
    case "string":
      return lit.value.value;
    case "number":
      return lit.value.text;
    case "boolean":
      return String(lit.value.value);
    case "keyword":
      return lit.value.name;
    case "undefined":
      return "";
  }
}

/** Every bare-literal AST node reachable in `desc`'s construction — the residue
 *  itself, AS NODES (design doc §3's correction: "the residue is a NODE, not a
 *  number"). Walks the same shape `isCleanContent`/`judgmentShaped` inspect: a
 *  `Case`'s `cond` and `alts`, and every step's `otherArgs`. */
function literalResidueOf(desc: WireDescriptor): readonly Lit[] {
  const out: Lit[] = [];
  const walk = (d: WireDescriptor): void => {
    if (d.source.kind === "Literal") out.push(d.source.lit);
    if (d.source.kind === "Case") {
      walk(d.source.cond);
      for (const alt of d.source.alts) walk(alt);
    }
    for (const step of d.steps) for (const arg of step.otherArgs) walk(arg.descriptor);
  };
  walk(desc);
  return out;
}

/** What a leaf was expected to be, ahead of checking it — the seal's own
 *  declaration, never inferred from the descriptor (P7: the policy is
 *  specification, not a guess the checker makes from shape alone). */
export type LeafRole = { readonly role: "data" } | { readonly role: "judgment"; readonly vocabulary: ReadonlySet<string> };

/** The seal's verdict for one leaf against its declared role — `dataShaped`/
 *  `judgmentShaped` restated as a single reportable outcome, WITH the residue nodes
 *  attached when the verdict is `"fabrication"`. This is the "verdict type" the
 *  design doc's §3 asks the policy to export; `dataShaped`/`judgmentShaped` remain
 *  the primitive, directly-named checks this composes. */
export type WireVerdict =
  | { readonly kind: "data-shaped" }
  | { readonly kind: "judgment-shaped" }
  | { readonly kind: "fabrication"; readonly residue: readonly Lit[] }
  | { readonly kind: "not-attestable" };

export function verdictFor(desc: WireDescriptor, expectation: LeafRole): WireVerdict {
  if (expectation.role === "data") {
    return dataShaped(desc) ? { kind: "data-shaped" } : { kind: "fabrication", residue: literalResidueOf(desc) };
  }
  if (desc.source.kind !== "Case") return { kind: "not-attestable" };
  const { alts } = desc.source;
  if (alts.length === 0 || !alts.every(isBareLiteral)) return { kind: "not-attestable" };
  if (judgmentShaped(desc, expectation.vocabulary)) return { kind: "judgment-shaped" };
  return { kind: "fabrication", residue: alts.filter(isBareLiteral).map((alt) => alt.source.lit) };
}

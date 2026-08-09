/**
 * The static wire descriptor — a leaf's provenance over the EXISTING CoreForm
 * vocabulary, per docs/foundations/arrival-scheme/provenance-by-perturbation.md §3
 * ("the residue is a NODE, not a number"). No second IR: the only new node is
 * `PVertice` (a declared crossing, or the program's own input boundary — an
 * unresolved reference is a boundary-in anchor per the semantic model's ontology);
 * everything else is a `case`/step composition over CoreForm's own `Lit` nodes and
 * procedure names.
 *
 * A leaf's descriptor answers, structurally and without measuring anything: does
 * this position's value CONTAIN what crossed the membrane (content), was it CHOSEN
 * from the program's own constants (selection), or does it never move (a literal —
 * a fabrication if presented as data)? §3's two policy checks (policy.ts) read this
 * shape directly; no probe is needed for the fabrication-in-the-middle shape — the
 * tree already says it. The probe (a different module, not this one) only resolves
 * the HOLE cases below, where the static shape is genuinely opaque.
 */
import type { Lit } from "../coreform/types.js";

/** A declared membrane crossing — OR (per the semantic model's boundary anchors,
 *  scheme-semantic-model.md §1) the program's own input: an identifier this
 *  descriptor's walk could not resolve to any local binding. `anchorName` is the
 *  crossing's static name: a registered capability's symbol for an effect call, or
 *  the free variable's own name for a boundary-in input. Both are "a crossing" in
 *  the sense that matters here — this walk cannot see PAST them; a probe can inject
 *  a marked witness at exactly this name to test what depends on it. */
export interface PVertice {
  readonly kind: "PVertice";
  readonly anchorName: string;
}

/** A program constant sitting in this position — the structural opposite of a
 *  crossing. Carries the actual CoreForm `Lit` node (not just its value) so a
 *  consumer can point back at the source span that produced it — this IS the
 *  fabrication residue when it occupies a content slot (policy.ts's `dataShaped`). */
export interface Literal {
  readonly kind: "Literal";
  readonly lit: Lit;
}

/** A value-dependent branch: this leaf's identity is CHOSEN by a guard, never made
 *  of its material. `cond` is the guard expression's own (recursively derived)
 *  descriptor — a guard that never reaches a `PVertice` cannot choose anything real,
 *  so a `Case` whose `cond` bottoms out at a `Literal` is itself dead code, not a
 *  provenance question. `alts` are every branch's descriptor, in source order
 *  (`if`: `[then, else]`). A `Case` is SELECTION at the point it appears — even
 *  nested inside another step's `otherArgs` — never content (policy.ts). */
export interface Case {
  readonly kind: "Case";
  readonly cond: WireDescriptor;
  readonly alts: readonly WireDescriptor[];
}

/** The path is opaque to STATIC analysis: a computed key, a filter survivor, a
 *  computed callee — anything where the CoreForm shape alone cannot say where the
 *  value came from. Honest admission of a blind spot, never silently defaulted to
 *  `Literal` (which would read as "no dependency," the opposite of the truth) or to
 *  `PVertice` (which would read as a false proof). The design doc's probe (a
 *  dynamic, separate mechanism) is what resolves a `Hole` — this module only names
 *  it. `reason` is a short, stable slug (`"computed-callee"`, `"filter-survivor"`,
 *  `"nullary-call"`, `"unsupported-form:<kind>"`) — diagnostic text, not parsed. */
export interface Hole {
  readonly kind: "Hole";
  readonly reason: string;
}

export type WireSource = PVertice | Literal | Case | Hole;

/** One sibling argument at a construction step, alongside the traced position.
 *  Carries its OWN fully recursive descriptor — not a bare "is it a literal" flag —
 *  because the same distinction generalizes past the binary case: an other-argument
 *  can itself be independently vertex-derived (legitimate additional content, e.g.
 *  `(string-append (:id e) (:name e))`), and telling that apart from a bare program
 *  constant needs the whole shape, not one bit. The residue policy.ts reads IS this
 *  node — never a count of how much moved. */
export interface WireArg {
  readonly argIndex: number;
  readonly descriptor: WireDescriptor;
}

/** One constructive operation applied on top of the traced value on its way to the
 *  leaf. `op` is the applied procedure's (or field accessor's) plain name — colon
 *  already stripped for a `:field` accessor, matching CoreForm's own convention
 *  (`keywordName`), so `op` is uniformly "the thing that got called," never a
 *  surface-syntax artifact. `argIndex` names which positional argument of that one
 *  call carries the TRACED value forward; `otherArgs` are that same call's sibling
 *  arguments (every position except `argIndex`), each tagged with its own
 *  descriptor. */
export interface WireStep {
  readonly op: string;
  readonly argIndex: number;
  readonly otherArgs: readonly WireArg[];
}

/** A leaf's full derivation: where it bottoms out (`source`), and every operation
 *  applied on top, SOURCE-TO-LEAF order — `steps[0]` runs right after `source`,
 *  `steps.at(-1)` is the last operation that produced the leaf's actual value.
 *  Matches the design doc's read-down-the-arrows rendering:
 *
 *      PVertice(anchorName)
 *        > steps[0]
 *        > steps[1]
 *        ...
 *        > result
 */
export interface WireDescriptor {
  readonly source: WireSource;
  readonly steps: readonly WireStep[];
}

/** A leaf's address inside a (possibly compound) output value: `"car"`/`"cdr"` for
 *  a pair, a 0-based index for a `list`, a string key for a `dict` entry. Composable
 *  — nested compounds append further segments (`["car", "cdr"]` for the cdr of the
 *  car of a nested pair). The root value itself (no splitting applicable) is the
 *  empty path. */
export type LeafPathSegment = "car" | "cdr" | number | string;
export type LeafPath = readonly LeafPathSegment[];

/** One leaf of the output value, addressed by its path, with its full descriptor.
 *  `derive()` (derive.ts) returns these — one per leaf when no `leafPath` narrows
 *  the request, or the single matching entry (possibly none) when it does. */
export interface LeafDescriptor {
  readonly path: LeafPath;
  readonly descriptor: WireDescriptor;
}

/**
 * CoreForm IR — the classified, id-carrying view over the desugared parse forest.
 *
 * Shapes per docs/working-proposals/arrival-mercury/coreform-ir.md §2, reconciled
 * against the constitution (docs/working-proposals/arrival-ts-transpiler-design.md
 * §3.2, which wins on conflict):
 *   - the union is the constitution's 16 members — no `SetBang` node ((set! …)
 *     classifies straight to Door("prohibited-dynamics/set!"), §2.2) and no `Do`
 *     node (the spec's §4.14 proposal; the constitution's §3.2 listing omits it,
 *     so `do` doors as `unsupported-form/do` in v1 — spec §9 item 8's fallback).
 *   - the IR is immutable; every analysis result lives in side tables keyed by
 *     NodeId (the Roslyn rule, spec §4.2). Nothing here is ever mutated.
 */
import type { Atom } from "../front/nodes.js";

/** Minted once per classify() call, dense, 0-indexed, in pre-order source order.
 *  NOT stable across compiles, NOT a content hash, NOT tied to span (spans can
 *  collide — a synthetic node inherits its parent's — ids never do). Side tables
 *  are free to implement as `Map<NodeId,T>` or a dense array indexed by NodeId;
 *  both are valid given the allocation discipline. */
export type NodeId = number & { readonly __coreFormId: unique symbol };

/** Byte-offset half-open range into the ORIGINAL .scm text — identical shape to
 *  the parser's `Node.span`, copied forward verbatim so no consumer needs a
 *  conversion step. */
export type Span = readonly [start: number, end: number];

export interface Base {
  readonly id: NodeId;
  /** ALWAYS present — the node's own source span, or (for a classification-
   *  synthesized filler node) the nearest enclosing real node's span. */
  readonly span: Span;
  /** `;;` comment lines immediately preceding this form in the source (parser-
   *  captured verbatim). Present only where the source actually had one; no
   *  inheritance. */
  readonly lead?: readonly string[];
  /** A `;;` comment trailing on the same source line. */
  readonly trail?: readonly string[];
}

// ── structural leaves (not union members — nested records with their own id) ──

export interface Param extends Base {
  readonly recordKind: "param";
  readonly name: string; // raw scheme text, pre-namer (e.g. "xs", "rest")
  readonly rest: boolean; // true for the tail of a dotted list `(a . rest)`
}

export interface Binding extends Base {
  // a let/let*/letrec/named-let variable
  readonly recordKind: "binding";
  readonly name: string;
  readonly init: CoreForm; // always present — an elided `(let ((x)) …)` init normalizes to Lit(undefined)
}

export interface KwEntry extends Base {
  // one `:key value` pair — shared by App.kwargs and Dict.entries
  readonly recordKind: "kwentry";
  /** Final string key (colon stripped, otherwise raw — key-name cleaning is a
   *  naming-layer decision downstream, never classification's). App requires a
   *  `:`-marked source key, Dict accepts either (spec §4.7). */
  readonly key: string;
  readonly value: CoreForm;
}

// ── the union ──────────────────────────────────────────────────────────────────

export type CoreForm =
  | Define
  | DefineFn
  | Lambda
  | If
  | And
  | Or
  | Let
  | NamedLet
  | Begin
  | Quote
  | App
  | Ref
  | Lit
  | Dict
  | Require
  | Door;

export interface Define extends Base {
  readonly kind: "Define";
  readonly name: string;
  readonly value: CoreForm;
  /** `define/overridable`'s extra type-tag slot (`(define/overridable name type default)`);
   *  undefined for plain `define` (spec §4.8). */
  readonly overridableType?: CoreForm;
}

export interface DefineFn extends Base {
  // `(define (f params…) body…)` — no synthetic Lambda (spec §4.9)
  readonly kind: "DefineFn";
  readonly name: string;
  readonly params: readonly Param[];
  readonly body: readonly CoreForm[]; // non-empty; internal defines are ordinary elements
  readonly overridableType?: CoreForm; // `(define/overridable (f params…) type body…)` — spec §4.8
}

export interface Lambda extends Base {
  readonly kind: "Lambda";
  readonly params: readonly Param[];
  readonly body: readonly CoreForm[];
}

export interface If extends Base {
  readonly kind: "If";
  readonly cond: CoreForm;
  readonly then: CoreForm;
  readonly else: CoreForm; // always present; a source-elided else normalizes to Lit(undefined)
}

export interface And extends Base {
  readonly kind: "And";
  readonly args: readonly CoreForm[];
}
export interface Or extends Base {
  readonly kind: "Or";
  readonly args: readonly CoreForm[];
}

export type LetKind = "let" | "let*" | "letrec" | "letrec*";
export interface Let extends Base {
  readonly kind: "Let";
  readonly letKind: LetKind; // one node shape, semantics-tag only (spec §4.10)
  readonly bindings: readonly Binding[];
  readonly body: readonly CoreForm[];
}

export interface NamedLet extends Base {
  // ONLY a bare `let` head (spec §4.11)
  readonly kind: "NamedLet";
  readonly loopName: string;
  readonly bindings: readonly Binding[];
  readonly body: readonly CoreForm[];
}

export interface Begin extends Base {
  readonly kind: "Begin";
  readonly body: readonly CoreForm[];
}

// No SetBang node. `set!` is prohibited at the language level (constitution §2.2 — mutation is
// incompatible with non-exponential provenance): every occurrence classifies straight to
// Door("prohibited-dynamics/set!"), never to a lowerable `{name, value}` shape.
// Deleted, not ported — constitution §2.2's "compiler consequences — deletions" list.

/** Quoted data is inert — NEVER re-classified as CoreForm (spec §4.6). A mirror datatype,
 *  not the CoreForm union, so a quoted `(if a b c)` can never be misread as an If node. */
export type ScalarLit =
  | { readonly kind: "number"; readonly text: string } // raw text — parsing to a value is emit's job
  | { readonly kind: "string"; readonly value: string } // DECODED (escapes resolved at classification time, spec §4.13)
  | { readonly kind: "boolean"; readonly value: boolean };
/** Dotted pairs FOLD AT CLASSIFY TIME (⚖️ ruled, constitution §2.1 + engine-walker.md's
 *  cross-check): a QuoteDatum list never contains a bare-dot item — `'(1 . 2)` classifies
 *  identical to `'(1 2)`. */
export type QuoteDatum =
  | ScalarLit
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "list"; readonly items: readonly QuoteDatum[] };
export interface Quote extends Base {
  readonly kind: "Quote";
  readonly datum: QuoteDatum;
}

export interface App extends Base {
  readonly kind: "App";
  readonly fn: CoreForm; // fully general — a Ref, a Lambda (IIFE), another App, a keyword Lit, …
  readonly positionalArgs: readonly CoreForm[];
  readonly kwargs: readonly KwEntry[]; // raw split preserved — the trailing-object collapse is the engine walker's job (spec §4.7)
}

export interface Ref extends Base {
  readonly kind: "Ref";
  readonly name: string;
} // unresolved — resolution is a side table (spec §4.2)

export type LitValue =
  | ScalarLit
  | { readonly kind: "keyword"; readonly name: string } // a `:field` atom used as an accessor/callable head (spec §4.6)
  | { readonly kind: "undefined" }; // classification-synthesized filler ONLY, never real source
export interface Lit extends Base {
  readonly kind: "Lit";
  readonly value: LitValue;
}

export interface Dict extends Base {
  readonly kind: "Dict";
  readonly entries: readonly KwEntry[];
}
export interface Require extends Base {
  readonly kind: "Require";
  readonly path: string;
}

// "prohibited-dynamics" is a third, distinct category (constitution §2.2): not "we don't support
// this" (unsupported-form) or "the shape is broken" (malformed-source), but "this is banned at
// the language level, permanently, by design" — mutation and re-entrant control are incompatible
// with non-exponential provenance. Keeping it a separate category is what lets the door MESSAGE
// teach the provenance rationale instead of reading as a backlog gap.
export type DoorCategory = "unsupported-form" | "malformed-source" | "prohibited-dynamics";
export interface Door extends Base {
  readonly kind: "Door";
  readonly category: DoorCategory;
  readonly code: string; // stable, namespaced "<category>/<slug>" — e.g. "unsupported-form/quasiquote", "prohibited-dynamics/set!"
  readonly message: string; // human-readable; free to reword — code is the stable identity (errors-as-doors Rule 3)
}

// ── the classification result ──────────────────────────────────────────────────

export interface ClassifyResult {
  readonly forms: readonly CoreForm[]; // 1:1 with the input forest's top-level forms
  /** NodeId → the parse-tree Atom it was minted from — populated for every identifier
   *  binding/reference site (Ref, Param.name, Binding.name, Define/DefineFn.name,
   *  NamedLet.loopName). The ONLY seam to name/scope resolution: a caller composes
   *  `nameOf.get(originAtom.get(id))` itself — classify() does not depend on naming. */
  readonly originAtom: ReadonlyMap<NodeId, Atom>;
  /** Convenience table (near-free to build during the same walk): child id → parent id.
   *  Not needed by classify()'s own logic (span inheritance is computed inline via a
   *  threaded "current enclosing span") — provided for a future Law-C peephole pass
   *  that wants bottom-up parent-shape queries without re-walking top-down. */
  readonly parentOf: ReadonlyMap<NodeId, NodeId>;
  /** Every Door node's id, pre-collected — so a CI door-scan doesn't have to re-walk
   *  the tree to count/report. */
  readonly doors: readonly NodeId[];
}

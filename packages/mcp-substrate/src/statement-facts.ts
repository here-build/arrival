// statement-facts — ONE real parse per top-level scheme statement, replacing three
// independent bespoke regex/text scans that each re-derive a fact from the SAME statement
// source: manifold-tool.ts's `topLevelDefineName` (a `^(define ...` regex), scope-scan.ts's
// `scanLocalBindings` (a hand-rolled tokenizer walk), and competence.ts's `scanSuccess` (two
// boundary-anchored regexes). See docs/working-proposals/arrival-manifold-decomposition-
// 2026-07-05.md §5.1 (finding #2) for the audit this extraction answers.
//
// NOT WIRED. This file adds `analyzeStatement` as a standalone, independently-testable unit
// with zero merge surface — a new file cannot conflict with in-flight edits. Rewiring the
// three call sites above to read `StatementFacts` instead of re-scanning is a LATER task: at
// the time this was authored, manifold-tool.ts/bind.ts/doors.ts/catalog.ts/server.ts (and
// their tests) were all mid-edit by other agents.
//
// PARSER CHOICE: `@here.build/arrival-sweet`'s `parseSexprs` — the same real parser the
// type-layer's `lower.ts` already uses to lower a scheme program to TypeScript. A small,
// dependency-free (only `tiny-invariant`) plain s-expr reader that stamps every node with
// lead/trail comments (trivia, never walked as code) and a source `span`, and never folds a
// string literal's contents or a comment's text into a SYMBOL atom. That is the actual fix
// for the audit's #2 finding: `map` inside a `"map"` string literal or a `;; map` comment can
// never false-positive `usesCollectionOps`, because the parser has already thrown that text
// away (or, for a comment, filed it as inert trivia) before this module ever walks a `Node`.
// This is a deliberate, NEW dependency for arrival-manifold (previously only `arrival` +
// `arrival-serializer`) — see package.json.
//
// A CAVEAT worth naming: `parseSexprs` treats `[...]` as a plain list, IDENTICAL to `(...)` —
// it does not mint arrival's own `AVector`/`evalElements` distinction the real EVALUATOR uses
// for the bracket-bindings feature (docs/reference/bracket-bindings.md, foundations/arrival/
// arrival). That turns out not to matter for `localBindings`: distinguishing a flat WHOLE-LIST
// binding vector (Clojure surface, `[a 1 b 2]`) from a list of per-element pairs (Racket
// surface, `([a 1] [b 2])`, or classic `((a 1) (b 2))`) only needs the SHAPE of the bindings-
// slot's FIRST element — a bare atom (a name) means whole-list, a nested list (a pair) means
// per-element — never the literal bracket character, and (crucially) never the shape of any
// VALUE. A binding NAME is by grammar always a bare symbol (R2a: a symbol at every even/name
// position), so it alone discriminates the surface; a compound value (`[a 1 b (+ 1 2)]`, the
// mainstream Clojure "compute one binding from a prior" idiom) is thus harmless. See
// `collectLetBindingNames` below, and the bracket-binding tests in this module's test file for
// both surfaces exercised directly.
//
// DELIBERATE SEMANTIC IMPROVEMENT (named per the task that authored this file): the OLD
// `competence.ts scanSuccess` explicitly does NOT exclude a trigger word appearing inside a
// `;;` comment ("a deliberate non-goal... over-flagging is the safe direction" — see
// competence.ts's file header). A real parse excludes it for free (comments are trivia, never
// walked as a `Node`) — `usesCollectionOps`/`usesStringOps` are therefore STRICTER than the
// old regex for exactly the two named false-positive classes (a trigger word inside a STRING
// LITERAL, or inside a COMMENT). Every OTHER textual-match behavior is preserved verbatim,
// including matching a trigger symbol used purely as DATA inside a `quote`d form (the old
// regex has no notion of quoting either, and the task's brief is a like-for-like extraction,
// not a redesign of what counts as "uses collection ops" beyond those two named fixes).
//
// SCOPE NOTE: `localBindings` covers exactly scope-scan.ts's current `LET_FORMS` set
// (let/let*/letrec/letrec*) plus lambda parameters and a nested `(define ...)` — NOT `do`
// (scope-scan.ts's `scanLocalBindings` does not scan `do`'s bindings today either; this is a
// like-for-like extraction, not an expansion of coverage). It also does not fold in the
// `TOOL_SYMBOL` duplication between session-history.ts/context-ring.ts (NEW-3 in the
// decomposition doc) — that is a separate finding, not one of the three functions this file
// was asked to replace.

import { parseSexprs, type Node } from "@here.build/arrival-sweet";

export interface StatementFacts {
  /** True iff this statement's own top-level form is `(define ...)` — a bare SHAPE check.
   *  Unlike {@link definedName}, this is true even for a malformed `(define)` with no
   *  extractable name — the two fields are deliberately independent (mirrors manifold-tool.ts's
   *  `topLevelDefineName`, which could only ever express the combined "name, or nothing"). */
  readonly isDefine: boolean;
  /** The bound NAME for `(define x …)` / `(define (f a b) …)` — never the `(f a b)` head.
   *  `undefined` for a non-define statement, or a define malformed enough to carry no name
   *  (e.g. `(define)`, `(define () body)`). */
  readonly definedName: string | undefined;
  /** True iff a `map`/`filter`/`reduce`/`fold`/`fold-left`/`fold-right`/`filterv`/`mapv`
   *  SYMBOL (never a string literal, never inside a comment) appears anywhere in this
   *  statement — the map/filter/reduce family named in competence.ts, ported verbatim. */
  readonly usesCollectionOps: boolean;
  /** True iff a `string-*` or `substring` SYMBOL (same string/comment exclusions) appears
   *  anywhere in this statement. */
  readonly usesStringOps: boolean;
  /** Every name bound in a NON-top-level lexical scope inside this statement: a `let`,
   *  `let*`, `letrec`, or `letrec*` binding (incl. a named-let's own loop name, and BOTH the
   *  whole-list/Clojure and per-element/Racket bracket-binding surfaces — see the module
   *  header), a lambda parameter (incl. the single-symbol variadic form), or a nested
   *  `(define X ...)`. De-duplicated; order unspecified (matches scope-scan.ts's
   *  `scanLocalBindings` contract exactly — existing callers already sort before comparing). */
  readonly localBindings: readonly string[];
}

const EMPTY_FACTS: StatementFacts = {
  isDefine: false,
  definedName: undefined,
  usesCollectionOps: false,
  usesStringOps: false,
  localBindings: [],
};

// ── local, structural Node guards ────────────────────────────────────────────────────────────
// arrival-sweet keeps its own `isAtom`/`isKeyword` etc. private — same idiom as the type-layer's
// lower.ts: re-declare the few guards needed here, anchored on Node's structural shape, never a
// cast (a future field rename then breaks HERE, loudly, instead of silently reading undefined).
type AtomNode = { atom: string; str?: boolean };
type ListNode = { list: Node[] };
const isAtom = (n: Node | undefined): n is AtomNode => n != null && "atom" in n;
const isList = (n: Node | undefined): n is ListNode => n != null && "list" in n;
/** A WORD atom — a symbol/operator/number lexeme, never a `"string literal"` (`str: true`). */
const isWord = (n: Node | undefined): n is AtomNode => isAtom(n) && n.str !== true;

// ── trigger-family word lists — VERBATIM from competence.ts (ported, not redesigned; see
// competence.ts for the "why these families" rationale, incl. why `fold`/`fold-left` are kept
// despite not currently being bound builtins) ────────────────────────────────────────────────
const COLLECTION_SYMBOLS = new Set(["map", "filter", "reduce", "fold", "fold-left", "fold-right", "filterv", "mapv"]);
/** competence.ts's `string-[\w?!*<>=]+|substring`, applied to a WHOLE word-atom's text. No
 *  boundary lookaround is needed here (unlike competence.ts's regex, which scans raw source
 *  text) — the real reader has already delimited the token, so the atom's own text IS exactly
 *  what would sit between a `BEFORE`/`AFTER` boundary pair in the old regex. */
const STRING_TRIGGER = /^(?:string-[\w?!*<>=]+|substring)$/;

/** scope-scan.ts's current `LET_FORMS` — deliberately NOT including `do` (see module header). */
const LET_FORMS = new Set(["let", "let*", "letrec", "letrec*"]);

interface WalkAccumulator {
  usesCollectionOps: boolean;
  usesStringOps: boolean;
  localBindings: Set<string>;
}

/** Collect a lambda's parameter list into `acc.localBindings`: a flat list of symbols, or the
 *  single-symbol variadic form (`(lambda args ...)`) — this dialect never destructures a
 *  parameter, so one shallow pass is exact (mirrors scope-scan.ts's `collectParamList`; a
 *  malformed/nested param shape this dialect doesn't support is silently invisible here too,
 *  matching the old behavior). */
function collectParamNames(paramsNode: Node | undefined, acc: WalkAccumulator): void {
  if (!paramsNode) return;
  if (isWord(paramsNode)) {
    acc.localBindings.add(paramsNode.atom); // variadic: the single bound name
    return;
  }
  if (!isList(paramsNode)) return;
  for (const p of paramsNode.list) {
    // Skip the dotted-tail marker itself (`(a . b)`'s literal `.`) — it is punctuation, never a
    // bound name; `b` (the rest-arg, the NEXT word in the list) is the real binding. Matches the
    // type-layer's own `lambdaParams` convention (arrival's lowering skips this exact marker for
    // this exact reason) — `parseSexprs` (a simpler reader than arrival's own) reads `.` as an
    // ordinary word atom with no special-casing, so this module must exclude it explicitly.
    if (isWord(p) && p.atom !== ".") acc.localBindings.add(p.atom);
  }
}

/** Collect a let-family form's BINDINGS-SLOT names — both bracket-binding surfaces
 *  (docs/reference/bracket-bindings.md) fall out of ONE shape test on the slot's FIRST element,
 *  with no need to distinguish `[` from `(` (parseSexprs doesn't preserve that distinction, and
 *  this heuristic never needed it):
 *    - the FIRST element is a bare atom (`[a 1 b 2]`, or the historical curiosity of a malformed
 *      `(a 1 b 2)`) → the R2a Clojure WHOLE-LIST surface: flat alternating name/value, names at
 *      the even indices.
 *    - the FIRST element is itself a list (classic pairs `((a 1) (b 2))`, R2b Racket per-element
 *      `([a 1] [b 2])`, or R2c mixed `([a 1] (b 2))`) → per-element: each LIST element's own
 *      first child is a name; a bare atom sibling in this shape (only reachable via a
 *      malformed/ambiguous input, e.g. `do`'s excluded whole-list attempt) is skipped, matching
 *      scope-scan.ts's current under-collection for that unreachable-in-practice edge.
 *
 *  WHY THE FIRST ELEMENT ALONE, not `every(isAtom)`: a binding NAME is by grammar ALWAYS a bare
 *  symbol (R2a mandates a symbol at every even/name position) — it can never legitimately be a
 *  compound expression. The two surfaces differ ONLY in whether that name sits bare at the top of
 *  the slot (whole-list) or wrapped in its own pair-sublist (per-element), so the first element's
 *  shape — atom vs. list — is a total discriminator. The old `items.every(isAtom)` test was
 *  UNSOUND precisely because it also inspected VALUE positions: one compound value
 *  (`[a 1 b (+ 1 2)]` — a call, a `(lambda …)`, a nested `(let …)`; the everyday Clojure idiom of
 *  computing a binding from a prior one) failed `.every` for the WHOLE slot, mis-routed it to the
 *  per-element branch, silently dropped every real bare-atom name, and instead pulled the
 *  compound value's own HEAD (`+`/`lambda`/`let`) as a phantom name. Testing the name-position
 *  shape alone makes every value shape irrelevant, which is exactly correct. */
function collectLetBindingNames(bindingsNode: Node | undefined, acc: WalkAccumulator): void {
  if (!isList(bindingsNode)) return;
  const items = bindingsNode.list;
  const wholeList = isAtom(items[0]); // first element bare atom (a name) → whole-list; list (a pair) or empty → per-element
  if (wholeList) {
    for (let i = 0; i < items.length; i += 2) {
      const nameNode = items[i];
      if (isWord(nameNode)) acc.localBindings.add(nameNode.atom);
    }
    return;
  }
  for (const el of items) {
    if (!isList(el)) continue;
    const nameNode = el.list[0];
    if (isWord(nameNode)) acc.localBindings.add(nameNode.atom);
  }
}

/** Recurse into a let-family form's BINDINGS-SLOT VALUE expressions ONLY — never the raw
 *  `(name value)` pair treated as a freestanding form. Mirrors `collectLetBindingNames`'s OWN
 *  first-element shape test (whole-list vs. per-element) IN LOCKSTEP, so the two functions always
 *  agree on which elements are "names" versus "values" for the same input — a divergence here
 *  would be strictly worse than the original bug (the two would disagree about the very split
 *  they exist to compute).
 *
 *  THE BUG THIS FIXES: before this function existed, `walk`'s generic blanket recursion
 *  (`for (const child of items) walk(child, depth+1, acc)`) walked the bindings-list container
 *  as an ordinary child too — meaning it re-walked each raw `(name value)` pair as if it were a
 *  freestanding form. When a binding's NAME happened to equal a scope keyword
 *  (`let`/`let*`/`letrec`/`letrec*`/`lambda`/`define`), that pair was mis-dispatched as a form OF
 *  that kind: `(let ((let foo)) let)` re-walked the pair `(let foo)` as a nested `let`, reading
 *  `foo` as a phantom named-let LOOP NAME; `(let ((lambda (p q))) x)` re-walked `(lambda (p q))`
 *  as a real lambda, capturing `p`/`q` as two phantom parameter bindings. Neither `p`, `q`, nor
 *  the loop-name `foo` are actual local bindings — they are the VALUE of an ordinarily-named
 *  binding that only collided with a keyword by spelling.
 *
 *  The fix: `walk`'s LET_FORMS branch now recurses into binding VALUES (this function) and BODY
 *  forms explicitly, instead of falling through to the generic blanket recursion over the whole
 *  form's `items` (which included the bindings-list container itself). Values still need
 *  walking — a lambda genuinely nested inside a binding's value, or a trigger word used there,
 *  must still be found — just not by re-interpreting the NAME slot as a dispatchable head. */
function walkLetBindingValues(bindingsNode: Node | undefined, depth: number, acc: WalkAccumulator): void {
  if (!isList(bindingsNode)) return;
  const items = bindingsNode.list;
  const wholeList = isAtom(items[0]); // IDENTICAL discriminator to collectLetBindingNames — keep in lockstep
  if (wholeList) {
    // Whole-list (Clojure) surface: values sit at the ODD indices (names at the even ones,
    // matching `collectLetBindingNames`'s own indexing exactly).
    for (let i = 1; i < items.length; i += 2) walk(items[i]!, depth + 1, acc);
    return;
  }
  for (const el of items) {
    if (!isList(el)) continue;
    // Per-element (Racket/classic) pair: everything AFTER the first child (the name) is value —
    // almost always exactly one value expression, but walking every remaining child is exact
    // even for a malformed multi-value pair.
    for (let i = 1; i < el.list.length; i++) walk(el.list[i]!, depth + 1, acc);
  }
}

/** One recursive pass over a statement's parsed form: every atom is checked against both
 *  trigger families (never a string atom — the #2 false-positive fix), and every list is
 *  checked for a binding-introducing shape (lambda / let-family / a NESTED define) before
 *  recursing into ALL of its children regardless — the blanket recursion is what reaches a
 *  lambda nested inside a binding's own VALUE (e.g. `(letrec ((f (lambda (n) n))) (f))`'s `n`),
 *  and is also what reproduces the old regex's over-inclusive match on a trigger word used
 *  purely as quoted DATA (never specifically excluded, matching "like-for-like").
 *
 *  `depth` starts at 1 for the statement's own root form — matching scope-scan.ts's token-walk
 *  convention exactly (its own `depth` variable is already 1 by the time it inspects the
 *  top-level form's own head), so a NESTED `(define ...)` first becomes eligible at `depth > 1`;
 *  the statement's OWN top-level define (depth 1) is deliberately excluded here — that's
 *  {@link defineShapeOf}'s job, a separate mechanism (matching `topLevelDefineName`'s current,
 *  separate treatment from `scanLocalBindings`). A function-form nested define's OWN parameter
 *  list (e.g. `(define (g x) ...)` nested inside a let body) is NOT walked as params here either
 *  — only its name is captured — reproducing scope-scan.ts's existing behavior exactly (only an
 *  explicit `lambda` gets parameter extraction; a nested function-define does not). */
function walk(node: Node, depth: number, acc: WalkAccumulator): void {
  if (isAtom(node)) {
    if (node.str !== true) {
      if (COLLECTION_SYMBOLS.has(node.atom)) acc.usesCollectionOps = true;
      if (STRING_TRIGGER.test(node.atom)) acc.usesStringOps = true;
    }
    return;
  }
  const items = node.list;
  const head = items[0];
  const headName = isWord(head) ? head.atom : undefined;

  if (headName === "lambda") {
    collectParamNames(items[1], acc);
  } else if (headName !== undefined && LET_FORMS.has(headName)) {
    let idx = 1;
    const maybeLoopName = items[idx];
    if (isWord(maybeLoopName)) {
      acc.localBindings.add(maybeLoopName.atom); // named let — the loop name is itself local
      idx++;
    }
    const bindingsNode = items[idx];
    collectLetBindingNames(bindingsNode, acc);
    // Recurse into binding VALUES and the body explicitly — NEVER the generic blanket recursion
    // (no-secrets/no-secrets false-flags the backticked-name possessive on the next line as
    // high-entropy; it's a function-name reference, not a secret):
    // eslint-disable-next-line no-secrets/no-secrets
    // below, which would re-walk the raw bindings-list container (see `walkLetBindingValues`'s
    // doc for the exact bug this avoids: a binding named `let`/`lambda`/etc. getting its own
    // value misread as a fresh form of that kind).
    walkLetBindingValues(bindingsNode, depth, acc);
    for (let i = idx + 1; i < items.length; i++) walk(items[i]!, depth + 1, acc); // the body
    return;
  } else if (headName === "define" && depth > 1) {
    const nameNode = items[1];
    if (isWord(nameNode)) {
      acc.localBindings.add(nameNode.atom);
    } else if (isList(nameNode)) {
      const fnHead = nameNode.list[0];
      if (isWord(fnHead)) acc.localBindings.add(fnHead.atom);
    }
  }

  for (const child of items) walk(child, depth + 1, acc);
}

/** The top-level form's `(define ...)` shape. Mirrors manifold-tool.ts's `topLevelDefineName`
 *  regex exactly: the variable form's name, or the function form's `f` from `(f a b)` — never
 *  the parameter list. Unlike the regex (a single "name, or undefined" return), this separates
 *  "is this shaped like a define at all" from "did a name come out of it" — see
 *  {@link StatementFacts.isDefine}. */
function defineShapeOf(root: Node): { isDefine: boolean; definedName: string | undefined } {
  if (!isList(root)) return { isDefine: false, definedName: undefined };
  const head = root.list[0];
  if (!isWord(head) || head.atom !== "define") return { isDefine: false, definedName: undefined };
  const second = root.list[1];
  if (isWord(second)) return { isDefine: true, definedName: second.atom };
  if (isList(second)) {
    const fnHead = second.list[0];
    if (isWord(fnHead)) return { isDefine: true, definedName: fnHead.atom };
  }
  return { isDefine: true, definedName: undefined }; // e.g. `(define)`, `(define () body)`
}

/**
 * ONE real parse of a single top-level scheme statement's source, deriving every fact
 * `topLevelDefineName` (manifold-tool.ts), `scanLocalBindings` (scope-scan.ts), and
 * `competence.scanSuccess` (competence.ts) currently re-derive with three independent
 * regex/tokenizer scans. `source` is expected to be exactly ONE top-level form's text (the
 * shape `splitTopLevel` already slices statements into, trailing comment included when
 * present) — a comment-only or empty `source` (never produced by `splitTopLevel` today, but
 * handled here defensively) returns all-false/empty/undefined facts rather than throwing. A
 * genuinely malformed statement (unbalanced parens) propagates `parseSexprs`'s throw — by the
 * time this would run in the eventual wiring, the whole call's syntax gate (`parse(expr)`) has
 * already guaranteed every sliced statement is well-formed, so this precondition always holds
 * there; it is a real precondition for a direct caller too, not swallowed here.
 */
export function analyzeStatement(source: string): StatementFacts {
  const forms = parseSexprs(source);
  const root = forms[0];
  if (!root) return EMPTY_FACTS;

  const acc: WalkAccumulator = { usesCollectionOps: false, usesStringOps: false, localBindings: new Set() };
  for (const form of forms) walk(form, 1, acc);

  const { isDefine, definedName } = defineShapeOf(root);
  return {
    isDefine,
    definedName,
    usesCollectionOps: acc.usesCollectionOps,
    usesStringOps: acc.usesStringOps,
    localBindings: [...acc.localBindings],
  };
}

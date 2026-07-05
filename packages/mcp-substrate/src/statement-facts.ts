// statement-facts — ONE real parse per top-level scheme statement, replacing three
// independent bespoke regex/text scans that each re-derive a fact from the SAME statement
// source: manifold-tool.ts's `topLevelDefineName` (a `^(define ...` regex), scope-scan.ts's
// `scanLocalBindings` (a hand-rolled tokenizer walk), and competence.ts's `scanSuccess` (two
// boundary-anchored regexes). See docs/working-proposals/arrival-manifold-decomposition-
// 2026-07-05.md §5.1 (finding #2) for the audit this extraction answers.
//
// PARSER CHOICE, REWORKED (2026-07-06): this module used to call a sibling package's sweet-
// expression s-expr reader — a self-described "EXPERIMENT (spike)" parser built for that
// package's own rendering needs (comment-preserving plain trees), reused opportunistically here.
// Its own file header listed "no vectors / #\char" as a known v0 limitation, and a live
// MCP-Atlas benchmark run
// crashed on ordinary R7RS code (`(char=? #\" (car chars))`) because of exactly that gap — see
// docs/working-proposals/arrival-manifold-decomposition-2026-07-05.md and the commit history
// around 2026-07-06 for the incident. `analyzeStatement` now takes an ALREADY-PARSED
// `SchemeValue` — the exact form arrival's real `Lexer`/`Parser`/`parse()` produced (the same
// parser that actually executes model code), never a second, less-faithful grammar. There is no
// parsing left in this module at all: `runner.ts`'s syntax-gate `parse(expr)` call is the ONE
// real parse, and its results are both executed AND analyzed here.
//
// NO RunContext: this module only READS fields off an already-minted `SchemeValue` (`.car`/
// `.cdr`/`.__vector__`/`.__name__`/`.dictForms`) — it never constructs an `AValue`, interns a
// symbol, or calls a heap-charging (allocation-metering) method. It is provably side-effect-free
// against the real execution's own per-run context (which `exec` mints separately).
//
// THE REAL AVector/APair DISTINCTION: unlike the old spike parser (which flattened `[...]` to an
// ordinary list, identical to `(...)`), the real reader mints a genuine `AVector` for a `[...]`
// literal, with its own `evalElements`/bracket-binding semantics (docs/reference/bracket-
// bindings.md). `localBindings` still only needs the SHAPE of the bindings-slot's FIRST
// element — atomish (a symbol/string/number/etc.) means whole-list (Clojure `[a 1 b 2]`),
// structural (a nested pair/vector) means per-element (Racket `([a 1] [b 2])`, or classic
// `((a 1) (b 2))`) — never the literal bracket character, and never the shape of any VALUE. A
// binding NAME is by grammar always a bare symbol (R2a: a symbol at every even/name position),
// so it alone discriminates the surface; a compound value (`[a 1 b (+ 1 2)]`) is harmless. See
// `collectLetBindingNames` below, and the bracket-binding tests in this module's test file for
// both surfaces exercised directly.
//
// A GENUINE, INTENTIONAL BEHAVIOR IMPROVEMENT over the old spike-parser behavior (named here,
// not silently introduced): a bracket-headed form like `[let ((a 1)) a]` is now correctly
// recognized as an `AVector` (DATA), never dispatched as a `let` special form — the old spike
// parser flattened `[...]` → list and would have mis-read this as a real `let`. No existing test
// exercised the old (wrong) behavior; this is a pure correctness gain from using the real reader.
//
// DELIBERATE SEMANTIC IMPROVEMENT (ported verbatim from the prior version of this module): the
// OLD `competence.ts scanSuccess` explicitly does NOT exclude a trigger word appearing inside a
// `;;` comment ("a deliberate non-goal... over-flagging is the safe direction" — see
// competence.ts's file header). A real parse excludes it for free (comments are trivia, never
// materialized as a `SchemeValue` at all) — `usesCollectionOps`/`usesStringOps` are therefore
// STRICTER than the old regex for exactly the two named false-positive classes (a trigger word
// inside a STRING LITERAL, or inside a COMMENT). Every OTHER textual-match behavior is preserved
// verbatim, including matching a trigger symbol used purely as DATA inside a `quote`d form (the
// old regex has no notion of quoting either).
//
// SCOPE NOTE: `localBindings` covers exactly scope-scan.ts's current `LET_FORMS` set
// (let/let*/letrec/letrec*) plus lambda parameters and a nested `(define ...)` — NOT `do`
// (scope-scan.ts's `scanLocalBindings` does not scan `do`'s bindings today either; this is a
// like-for-like extraction, not an expansion of coverage). It also does not fold in the
// `TOOL_SYMBOL` duplication between session-history.ts/context-ring.ts (NEW-3 in the
// decomposition doc) — that is a separate finding, not one of the three functions this file
// was asked to replace.
//
// CYCLE SAFETY (a risk this migration introduces that the old spike parser never had): the real
// reader can produce genuinely CIRCULAR structure via R7RS datum labels (`#n=`/`#n#` —
// arrival's `Parser.ts`). `walk`'s own recursive descent guards against this with a `Set<object>`
// shared across one `analyzeStatement` call: a structural node already visited by `walk` itself
// is never re-descended into. This is scoped to `walk`'s OWN recursion only (never shared with
// `spineItems`' local per-call guard below) — see that function's doc for why conflating the two
// would break ordinary, non-circular processing.

// `AJSObject` (the `{...}` dict-literal wrapper) is exported from arrival's barrel under the
// alias `AObject` (`export { AJSObject as AObject } from "./values/primitives/AJSObject.js"` —
// the same dual-name convention as `ACharacter`/`AChar`). Re-aliased back to `AJSObject` locally
// for readability — it is the identical class either way, so every `instanceof` check below is
// unaffected.
import { AObject as AJSObject, ANil, APair, ASymbol, AVector, type SchemeValue } from "@here.build/arrival";

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
   *  header), a lambda parameter (incl. the single-symbol variadic form and a dotted rest-arg),
   *  or a nested `(define X ...)`. De-duplicated; order unspecified (matches scope-scan.ts's
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

// ── real-AST structural guards ───────────────────────────────────────────────────────────────
// A "structural" node is one `walk` recurses INTO (a real cons cell, a vector, a dict-literal
// object, or the empty list); everything else — a symbol, a string, a number, a char, a
// boolean, a procedure — is a LEAF. `()` is `ANil`, the real nil singleton, NOT the old plain-
// tree's `{list: []}` — it is structural (nothing to walk, but not an "atom" for the bracket-
// binding shape discriminator below either).
type Structural = APair | AVector | AJSObject | ANil;
const isStructural = (n: SchemeValue | undefined): n is Structural =>
  n instanceof APair || n instanceof AVector || n instanceof AJSObject || n instanceof ANil;

/** A symbol's name, or `undefined` for anything else (including a gensym, whose `__name__` is
 *  an ES6 `symbol`, not a string — this dialect's reader never produces one, but a defensive
 *  guard here costs nothing and keeps the return type honest). Never `AString` — the string-vs-
 *  symbol distinction is load-bearing (see module header): a `"map"` string literal must never
 *  be mistaken for the `map` symbol, and this guard is the one place that distinction is made. */
function symbolName(n: SchemeValue | undefined): string | undefined {
  return n instanceof ASymbol && typeof n.__name__ === "string" ? n.__name__ : undefined;
}

/** Walk a cons SPINE (`node`, `node.cdr`, `node.cdr.cdr`, …) collecting each `car`, stopping at
 *  the first non-pair `cdr` (the proper-list terminator `ANil`, or — for an IMPROPER list like a
 *  dotted `(a . b)` lambda param list — the dotted TAIL value itself, returned separately so a
 *  caller can decide whether it's a bindable name). Real cons cells are always freshly minted
 *  per read (no incidental sharing) UNLESS a datum label (`#n=`/`#n#`) explicitly shares/cycles
 *  one, so this needs its OWN, call-LOCAL cycle guard (never shared with `walk`'s cross-call
 *  memo — see module header) purely to stop an outright circular SPINE (e.g. a `#0=(a . #0#)`
 *  fed in as a params/bindings list) from looping forever while still being read fresh every time
 *  a distinct caller (`collectLetBindingNames`, then `walkLetBindingValues`) inspects the SAME
 *  bindings-slot node — sharing one guard across those two calls would make the second call see
 *  every node as "already visited" and silently return nothing. */
function spineItems(node: SchemeValue | undefined): { items: SchemeValue[]; tail: SchemeValue | undefined } {
  const items: SchemeValue[] = [];
  const localSeen = new Set<object>();
  let cur: SchemeValue | undefined = node;
  while (cur instanceof APair) {
    if (localSeen.has(cur)) return { items, tail: undefined };
    localSeen.add(cur);
    items.push(cur.car as SchemeValue);
    cur = cur.cdr as SchemeValue | undefined;
  }
  const tail = cur === undefined || cur instanceof ANil ? undefined : cur;
  return { items, tail };
}

/** Normalizes a let-family BINDINGS-SLOT (or one of its per-element pairs) to its flat element
 *  sequence, whichever real shape it arrived in: an `AVector` (`[...]` bracket literal) reads its
 *  `__vector__` payload directly; a real cons spine (`(...)` paren list, or `ANil` for an empty
 *  slot) walks via {@link spineItems}; anything else (malformed input) is `[]`. */
function bindingElements(node: SchemeValue | undefined): SchemeValue[] {
  if (node instanceof AVector) return node.__vector__;
  if (node instanceof APair || node instanceof ANil) return spineItems(node).items;
  return [];
}

// ── trigger-family word lists — VERBATIM from competence.ts (ported, not redesigned; see
// competence.ts for the "why these families" rationale, incl. why `fold`/`fold-left` are kept
// despite not currently being bound builtins) ────────────────────────────────────────────────
const COLLECTION_SYMBOLS = new Set(["map", "filter", "reduce", "fold", "fold-left", "fold-right", "filterv", "mapv"]);
/** competence.ts's `string-[\w?!*<>=]+|substring`, applied to a whole SYMBOL's name. No boundary
 *  lookaround is needed here (unlike competence.ts's regex, which scans raw source text) — the
 *  real reader has already delimited the token, so the symbol's own name IS exactly what would
 *  sit between a `BEFORE`/`AFTER` boundary pair in the old regex. */
const STRING_TRIGGER = /^(?:string-[\w?!*<>=]+|substring)$/;

/** scope-scan.ts's current `LET_FORMS` — deliberately NOT including `do` (see module header). */
const LET_FORMS = new Set(["let", "let*", "letrec", "letrec*"]);

interface WalkAccumulator {
  usesCollectionOps: boolean;
  usesStringOps: boolean;
  localBindings: Set<string>;
}

/** Collect a lambda's parameter list into `acc.localBindings`: a flat list of symbols, the
 *  single-symbol variadic form (`(lambda args ...)`), or a dotted rest-arg (`(lambda (a . b)
 *  ...)`, `(lambda (a b . rest) ...)`) — this dialect never destructures a parameter, so one
 *  shallow spine-walk is exact (mirrors scope-scan.ts's `collectParamList`). Unlike the old
 *  spike-parser version, there is no literal `.` marker to skip: the real reader parses a
 *  dotted param list directly to an IMPROPER cons spine (`(a . b)` = `APair(a, ASymbol(b))`, no
 *  intervening "." atom at all), so {@link spineItems}'s own dotted-tail return already IS the
 *  rest-arg name — collected the same way a whole-list name would be, from ANY position, not
 *  just the lambda-params special case the old code hard-coded. */
function collectParamNames(paramsNode: SchemeValue | undefined, acc: WalkAccumulator): void {
  if (paramsNode === undefined) return;
  const variadicName = symbolName(paramsNode); // `(lambda args ...)` — the single bound name
  if (variadicName !== undefined) {
    acc.localBindings.add(variadicName);
    return;
  }
  if (!(paramsNode instanceof APair) && !(paramsNode instanceof ANil)) return; // malformed: invisible, matches old behavior
  const { items, tail } = spineItems(paramsNode);
  for (const p of items) {
    const name = symbolName(p);
    if (name !== undefined) acc.localBindings.add(name);
  }
  const tailName = symbolName(tail); // the dotted rest-arg, if any
  if (tailName !== undefined) acc.localBindings.add(tailName);
}

/** Collect a let-family form's BINDINGS-SLOT names — both bracket-binding surfaces
 *  (docs/reference/bracket-bindings.md) fall out of ONE shape test on the slot's FIRST element,
 *  with no need to distinguish `[` from `(` (both real surfaces flow through
 *  {@link bindingElements} uniformly):
 *    - the FIRST element is ATOMISH (not structural — a bare symbol `[a 1 b 2]`, or the
 *      historical curiosity of a malformed `(a 1 b 2)`) → the R2a Clojure WHOLE-LIST surface:
 *      flat alternating name/value, names at the even indices.
 *    - the FIRST element is STRUCTURAL (a nested pair `((a 1) (b 2))`/`([a 1] (b 2))`, or a
 *      nested vector `([a 1] [b 2])`) → per-element: each element's own first child (again via
 *      {@link bindingElements}) is a name; a bare-atom sibling in this shape (only reachable via
 *      malformed/ambiguous input) is skipped, matching scope-scan.ts's current under-collection
 *      for that unreachable-in-practice edge.
 *
 *  WHY THE FIRST ELEMENT ALONE, not "every element atomic": a binding NAME is by grammar ALWAYS
 *  a bare symbol (R2a mandates a symbol at every even/name position) — it can never legitimately
 *  be a compound expression. The two surfaces differ ONLY in whether that name sits bare at the
 *  top of the slot (whole-list) or wrapped in its own pair-sublist (per-element), so the first
 *  element's shape — atomish vs. structural — is a total discriminator. Testing every element
 *  (names AND values) was the old spike-parser-era bug this module inherited and fixed: a single
 *  compound VALUE (`[a 1 b (+ 1 2)]` — a call, a `(lambda …)`, a nested `(let …)`; the everyday
 *  Clojure idiom of computing a binding from a prior one) must never mis-route the whole slot to
 *  the per-element branch and silently drop every real bare-atom name. */
function collectLetBindingNames(bindingsNode: SchemeValue | undefined, acc: WalkAccumulator): void {
  const items = bindingElements(bindingsNode);
  if (items.length === 0) return;
  const wholeList = !isStructural(items[0]); // atomish first element (a name) → whole-list; structural → per-element
  if (wholeList) {
    for (let i = 0; i < items.length; i += 2) {
      const name = symbolName(items[i]);
      if (name !== undefined) acc.localBindings.add(name);
    }
    return;
  }
  for (const el of items) {
    const subItems = bindingElements(el);
    const name = symbolName(subItems[0]);
    if (name !== undefined) acc.localBindings.add(name);
  }
}

/** Recurse into a let-family form's BINDINGS-SLOT VALUE expressions ONLY — never the raw
 *  `(name value)` pair treated as a freestanding form. Mirrors `collectLetBindingNames`'s OWN
 *  first-element shape test (whole-list vs. per-element) IN LOCKSTEP, so the two functions always
 *  agree on which elements are "names" versus "values" for the same input — a divergence here
 *  would be strictly worse than the original bug (the two would disagree about the very split
 *  they exist to compute).
 *
 *  THE BUG THIS FIXES (ported from the prior version of this module): a blanket recursion over
 *  every child of a let-family form — including the bindings-list container itself, and with it
 *  each raw `(name value)` pair — would re-dispatch a pair whose NAME happens to equal a scope
 *  keyword (`let`/`let*`/`letrec`/`letrec*`/`lambda`/`define`) as if it were a fresh form of that
 *  kind, misreading the VALUE as phantom parameters/loop-names/bindings. `walk`'s LET_FORMS
 *  branch instead recurses into binding VALUES (this function) and BODY forms explicitly,
 *  never falling through to a blanket recursion over the raw bindings-list container. Values
 *  still need walking — a lambda genuinely nested inside a binding's value, or a trigger word
 *  used there, must still be found — just not by re-interpreting the NAME slot as a dispatchable
 *  head. */
function walkLetBindingValues(
  bindingsNode: SchemeValue | undefined,
  depth: number,
  acc: WalkAccumulator,
  seen: Set<object>,
): void {
  const items = bindingElements(bindingsNode);
  if (items.length === 0) return;
  const wholeList = !isStructural(items[0]); // IDENTICAL discriminator to collectLetBindingNames — keep in lockstep
  if (wholeList) {
    // Whole-list (Clojure) surface: values sit at the ODD indices (names at the even ones,
    // matching `collectLetBindingNames`'s own indexing exactly).
    for (let i = 1; i < items.length; i += 2) walk(items[i], depth + 1, acc, seen);
    return;
  }
  for (const el of items) {
    const subItems = bindingElements(el);
    // Per-element (Racket/classic) pair: everything AFTER the first child (the name) is value —
    // almost always exactly one value expression, but walking every remaining child is exact
    // even for a malformed multi-value pair.
    for (let i = 1; i < subItems.length; i++) walk(subItems[i], depth + 1, acc, seen);
  }
}

/** One recursive pass over a statement's parsed form. A symbol is checked against both trigger
 *  families (never a string, never a comment — comments never materialize as a `SchemeValue` at
 *  all, which is the #2 false-positive fix); a structural node is checked for a binding-
 *  introducing shape (lambda / let-family / a NESTED define) before recursing into ALL of its
 *  children regardless — the blanket recursion is what reaches a lambda nested inside a
 *  binding's own VALUE (e.g. `(letrec ((f (lambda (n) n))) (f))`'s `n`), and is also what
 *  reproduces the old regex's over-inclusive match on a trigger word used purely as quoted DATA
 *  (never specifically excluded, matching "like-for-like").
 *
 *  `seen` is `walk`'s OWN cross-call cycle guard (module header): a structural node is marked the
 *  first time `walk` itself descends into it, and a re-encountered node (only possible via a
 *  genuinely circular/shared datum-label structure — real, non-shared parses never repeat a node
 *  identity) short-circuits rather than re-descending. This is safe even for a legitimately
 *  SHARED (non-cyclic) node: since it's the literal same object, walking it twice would collect
 *  the identical set of facts both times, so skipping the repeat loses nothing observable while
 *  guaranteeing termination on an actual cycle.
 *
 *  `depth` starts at 1 for the statement's own root form — matching scope-scan.ts's token-walk
 *  convention exactly, so a NESTED `(define ...)` first becomes eligible at `depth > 1`; the
 *  statement's OWN top-level define (depth 1) is deliberately excluded here — that's
 *  {@link defineShapeOf}'s job, a separate mechanism (matching `topLevelDefineName`'s current,
 *  separate treatment from `scanLocalBindings`). A function-form nested define's OWN parameter
 *  list (e.g. `(define (g x) ...)` nested inside a let body) is NOT walked as params here either
 *  — only its name is captured — reproducing scope-scan.ts's existing behavior exactly (only an
 *  explicit `lambda` gets parameter extraction; a nested function-define does not). */
function walk(node: SchemeValue | undefined, depth: number, acc: WalkAccumulator, seen: Set<object>): void {
  if (node === undefined) return;

  const name = symbolName(node);
  if (name !== undefined) {
    if (COLLECTION_SYMBOLS.has(name)) acc.usesCollectionOps = true;
    if (STRING_TRIGGER.test(name)) acc.usesStringOps = true;
    return;
  }

  if (!isStructural(node)) return; // AString/ACharacter/numbers/booleans/procedures/… — inert leaves
  if (seen.has(node)) return; // cycle/shared-node guard — see doc above
  seen.add(node);

  if (node instanceof AVector) {
    for (const el of node.__vector__) walk(el, depth + 1, acc, seen);
    return;
  }
  if (node instanceof AJSObject) {
    for (const el of node.dictForms ?? []) walk(el, depth + 1, acc, seen);
    return;
  }
  if (node instanceof ANil) return; // the empty list — nothing to walk

  // node instanceof APair from here.
  const head = node.car as SchemeValue | undefined;
  const headName = symbolName(head);
  const { items: rest } = spineItems(node.cdr as SchemeValue | undefined);

  if (headName === "lambda") {
    collectParamNames(rest[0], acc);
  } else if (headName !== undefined && LET_FORMS.has(headName)) {
    let idx = 0;
    const maybeLoopName = symbolName(rest[0]);
    if (maybeLoopName !== undefined) {
      acc.localBindings.add(maybeLoopName); // named let — the loop name is itself local
      idx = 1;
    }
    const bindingsNode = rest[idx];
    collectLetBindingNames(bindingsNode, acc);
    // Recurse into binding VALUES and the body explicitly — NEVER a generic blanket recursion
    // over the raw bindings-list container (no-secrets/no-secrets false-flags the backticked
    // function-name possessive on the next line as high-entropy; it's a function-name reference,
    // not a secret):
    // eslint-disable-next-line no-secrets/no-secrets
    // see `walkLetBindingValues`'s doc for the exact bug this avoids: a binding named
    // `let`/`lambda`/etc. getting its own value misread as a fresh form of that kind).
    walkLetBindingValues(bindingsNode, depth, acc, seen);
    for (let i = idx + 1; i < rest.length; i++) walk(rest[i], depth + 1, acc, seen); // the body
    return;
  } else if (headName === "define" && depth > 1) {
    const nameNode = rest[0];
    const asName = symbolName(nameNode);
    if (asName !== undefined) {
      acc.localBindings.add(asName);
    } else if (nameNode instanceof APair) {
      const fnHead = symbolName(nameNode.car as SchemeValue | undefined);
      if (fnHead !== undefined) acc.localBindings.add(fnHead);
    }
  }

  walk(head, depth + 1, acc, seen);
  for (const child of rest) walk(child, depth + 1, acc, seen);
}

/** The top-level form's `(define ...)` shape. Mirrors manifold-tool.ts's `topLevelDefineName`
 *  regex exactly: the variable form's name, or the function form's `f` from `(f a b)` — never
 *  the parameter list. Unlike the regex (a single "name, or undefined" return), this separates
 *  "is this shaped like a define at all" from "did a name come out of it" — see
 *  {@link StatementFacts.isDefine}. */
function defineShapeOf(root: SchemeValue): { isDefine: boolean; definedName: string | undefined } {
  if (!(root instanceof APair)) return { isDefine: false, definedName: undefined };
  const headName = symbolName(root.car as SchemeValue | undefined);
  if (headName !== "define") return { isDefine: false, definedName: undefined };
  const { items: rest } = spineItems(root.cdr as SchemeValue | undefined);
  const second = rest[0];
  const asName = symbolName(second);
  if (asName !== undefined) return { isDefine: true, definedName: asName };
  if (second instanceof APair) {
    const fnHead = symbolName(second.car as SchemeValue | undefined);
    if (fnHead !== undefined) return { isDefine: true, definedName: fnHead };
  }
  return { isDefine: true, definedName: undefined }; // e.g. `(define)`, `(define () body)`
}

/**
 * ONE real parse's worth of facts for a single top-level scheme statement, deriving every fact
 * `topLevelDefineName` (manifold-tool.ts), `scanLocalBindings` (scope-scan.ts), and
 * `competence.scanSuccess` (competence.ts) currently re-derive with three independent
 * regex/tokenizer scans. `form` is the ALREADY-PARSED top-level form — the exact `SchemeValue`
 * arrival's real reader produced for one statement (never source text; this module does no
 * parsing of its own — see module header). `undefined` (an empty/comment-only source, which
 * `parse()` yields zero forms for) returns {@link EMPTY_FACTS} rather than throwing.
 *
 * Takes exactly ONE form — there is no array/multi-form overload. Every real caller (the syntax-
 * gated statement loop in runner.ts) always has exactly one form per statement to analyze;
 * keeping a multi-form-fold path alive would be dead code kept alive purely to dodge migrating
 * old tests, which is itself exactly the kind of shortcut this module's rework exists to remove.
 */
export function analyzeStatement(form: SchemeValue | undefined): StatementFacts {
  if (form === undefined) return EMPTY_FACTS;

  const acc: WalkAccumulator = { usesCollectionOps: false, usesStringOps: false, localBindings: new Set() };
  const seen = new Set<object>();
  walk(form, 1, acc, seen);

  const { isDefine, definedName } = defineShapeOf(form);
  return {
    isDefine,
    definedName,
    usesCollectionOps: acc.usesCollectionOps,
    usesStringOps: acc.usesStringOps,
    localBindings: [...acc.localBindings],
  };
}

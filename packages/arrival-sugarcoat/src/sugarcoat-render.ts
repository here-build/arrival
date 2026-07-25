/**
 * Classic Scheme → sugarcoat-expression RENDERER.
 *
 * The choice-laden half of the classic↔sugarcoat bifunctor: sugarcoat→classic is a
 * deterministic reader (sugarcoat-read.ts), but classic→sugarcoat is a *choice* of
 * layout. This renderer is heuristic (width-budget + a fixed "pull first arg if it
 * fits" head-line rule), not MDL-optimal — soundness comes from the round-trip law
 * (read ∘ render preserves the AST, enforced by the corpus tests in arrival-chain),
 * not from layout optimality.
 *
 * Layers rendered:
 *   • curly-infix     (- n 1)            → {n - 1}        ; arithmetic/comparison only
 *   • neoteric        (f x y)            → f(x y)         ; optional (reads odd for data/pairs)
 *   • indentation     big forms          → head on a line, children indented
 *   • at-expressions  (str "a " x)       → @{a @x}        ; prose/template heads
 *   • comments        ;; a line-comment on its OWN line(s) before a datum is that
 *                     datum's `lead`; one on the SAME line just after is its `trail`.
 *                     Both are captured by the parser and re-emitted — comments are
 *                     trivia to the reader, so carrying them stays round-trip-safe.
 *
 * KNOWN LIMITATIONS:
 *   • head-line rule is fixed, not optimized (an MDL layout-cost pass would replace it).
 *   • dangling comments before a `)` (own line, no datum after) are dropped, and
 *     comments on inline-rendered operands aren't shown (only at formatSugarcoat seams).
 *   • no $ / \\ group markers, no vector (#(…)) rendering.
 */

import invariant from "tiny-invariant";

export type Node =
  | { atom: string; str?: boolean; lead?: string[]; trail?: string[]; span?: readonly [start: number, end: number] }
  | { list: Node[]; lead?: string[]; trail?: string[]; span?: readonly [start: number, end: number] };

// null-safe: items[0] of an empty list `()` is undefined; isAtom(undefined) must
// be false, not throw ('in' on undefined). Empty lists come from `'()` folds.
const isAtom = (n: Node | undefined): n is { atom: string; str?: boolean } => n != null && "atom" in n;

// Post-guard arm accessors. A head/child whose arm was already proven by a
// boolean predicate (isInfix, isQuoteForm, isLetElidable, isKeyword, …) that TS
// can't carry through — re-assert via the isAtom guard so the read stays anchored
// to Node's shape. A future field rename then breaks HERE, loudly, where a
// `(x as { atom }).atom` cast would silently read undefined. The invariant never
// fires (every caller is already inside the matching guard).
const atomText = (nd: Node): string => {
  invariant(isAtom(nd), "expected an atom node");
  return nd.atom;
};
const childList = (nd: Node): Node[] => {
  invariant(!isAtom(nd), "expected a list node");
  return nd.list;
};

// ── parser: source text → plain tree, capturing comments ──────────────────────
//
// A `;`-line-comment on its OWN line(s) before a datum becomes that datum's
// `lead`; one on the SAME line just after a datum is its `trail`. (A dangling
// comment before a `)` with no following datum is dropped.) Comments are trivia
// to the sugarcoat READER, and `nodeEq` ignores lead/trail, so carrying them in the
// render keeps `sugarcoatToScheme` form-matching — hence the round-trip — intact.
export function parseSexprs(src: string): Node[] {
  let i = 0;
  const n = src.length;
  const isDelim = (c: string | undefined) =>
    c === undefined || /\s/.test(c) || c === "(" || c === ")" || c === "[" || c === "]" || c === '"' || c === ";";

  let pendingLead: string[] = [];
  let lastNode: Node | null = null;
  let sawNewlineSinceNode = false;

  const skipWs = () => {
    while (i < n) {
      const c = src[i];
      if (c === "\n") {
        sawNewlineSinceNode = true;
        i++;
        continue;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === ";") {
        const start = i;
        while (i < n && src[i] !== "\n") i++;
        const text = src.slice(start, i).replace(/\s+$/, "");
        // same line as the just-read datum → its trailing comment; else leading.
        if (!sawNewlineSinceNode && lastNode) (lastNode.trail ??= []).push(text);
        else pendingLead.push(text);
        continue;
      }
      break;
    }
  };

  const readString = (): Node => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        out += src[i] + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return { atom: out, str: true };
      }
      out += c;
      i++;
    }
    invariant(false, "unterminated string");
  };

  const readDatum = (): Node => {
    skipWs();
    const lead = pendingLead;
    pendingLead = [];
    const start = i; // datum's first char (after lead-comment/whitespace skip)
    const c = src[i];
    invariant(c !== undefined, "unexpected EOF");
    let node: Node;
    if (c === "#" && src[i + 1] === "\\") {
      // `#\<char>` character literal (R7RS 7.1.1): self-delimiting — a single
      // non-alphabetic payload (`#\"`, `#\\`, `#\(`, `#\;`, `#\ `, ...) always
      // consumes EXACTLY one more character regardless of what follows; an
      // alphabetic payload can extend into a named literal (`#\space`,
      // `#\newline`, `#\x41`, ...), so consume the whole run. Without this,
      // the payload char falls through to the generic atom scan below, which
      // stops at `"`/`(`/`)`/`[`/`]`/`;` — e.g. `#\"` reads as the 2-char atom
      // `#\` and then hands the bare `"` to `readString`, which then swallows
      // everything up to the NEXT quote in the source (or to EOF, throwing
      // "unterminated string") instead of the one intended character literal.
      const charStart = i;
      i += 2;
      if (i < n && /[a-z]/i.test(src[i])) {
        while (i < n && /[a-z0-9]/i.test(src[i])) i++;
      } else if (i < n) {
        i++;
      }
      node = { atom: src.slice(charStart, i) };
      if (lead.length > 0) node.lead = lead;
      node.span = [start, i];
      lastNode = node;
      sawNewlineSinceNode = false;
      return node;
    }
    switch (c) {
      case "(":
      case "[": {
        node = readList(c === "(" ? ")" : "]");
        break;
      }
      case ")":
      case "]": {
        invariant(false, () => `unexpected ${c} at ${i}`);
        break;
      }
      case '"': {
        node = readString();
        break;
      }
      case "'": {
        i++;
        node = { list: [{ atom: "quote" }, readDatum()] };
        break;
      }
      case "`": {
        i++;
        node = { list: [{ atom: "quasiquote" }, readDatum()] };
        break;
      }
      case ",": {
        i++;
        if (src[i] === "@") {
          i++;
          node = { list: [{ atom: "unquote-splicing" }, readDatum()] };
        } else node = { list: [{ atom: "unquote" }, readDatum()] };

        break;
      }
      default: {
        const start = i;
        while (i < n && !isDelim(src[i])) i++;
        node = { atom: src.slice(start, i) };
      }
    }
    if (lead.length > 0) node.lead = lead;
    // Source span [start, end) in `src` — inert metadata (like lead/trail, ignored
    // by nodeEq), consumed by the editor's parameter-hint placement.
    node.span = [start, i];
    lastNode = node;
    sawNewlineSinceNode = false;
    return node;
  };

  function readList(close: ")" | "]"): Node {
    i++; // open
    const items: Node[] = [];
    for (;;) {
      skipWs();
      const c = src[i];
      invariant(c !== undefined, "unbalanced list");
      if (c === ")" || c === "]") {
        i++;
        break;
      }
      items.push(readDatum());
    }
    return { list: items };
  }

  const forms: Node[] = [];
  for (;;) {
    skipWs();
    if (i >= n) break;
    forms.push(readDatum());
  }
  return forms;
}

// ── renderer ──────────────────────────────────────────────────────────────────
export interface SugarcoatOpts {
  width: number;
  neoteric: boolean;
  curly: boolean;
  /** Heads whose args are key→value pairs: `dict` + every name bound to a
   *  `(require "….prompt")` callable. Under these, a `:keyword value` run is
   *  rendered as a pair line. Homoiconic: the pair is a tree node in the VIEW
   *  that collapses back to the flat `… k v …` canonical on read. */
  kwargHeads: Set<string>;
  /** Glyph vocabulary. `"ascii"` (default) — `&&`/`||`/`==`/`=>`, keyboard-typeable.
   *  `"math"` — the Agda-style Unicode skin: `∧`/`∨`/`≡`/`≈`/`≃`/`≤`/`≥`, lambda arrow
   *  `↦`, cond/case receiver `⇀`. Still a bidirectional lens (the reader accepts BOTH
   *  vocabularies), just prettier and harder to type — for render eloquence. */
  skin: "ascii" | "math";
  /** Render the empty-list literal `'()` as the word `nil`. SOUND — the reader folds
   *  `nil` back to `(quote ())`, so it round-trips. schemeToSugarcoat turns this ON
   *  only when the program doesn't shadow `nil` with a non-empty binding (a `(define
   *  nil '())` is fine). Off for bare-node callers so a stray render stays literal. */
  nilGlyph: boolean;
  /** Modernize string assembly for the sugarcoat surface: render `string-append` as
   *  headless `@{…}` (≡ `@str{…}` on read) and DROP redundant string coercions
   *  (`(number->string x)` → `x`, same for `symbol->string` / `->string`). `str` already
   *  coerces non-strings via `repr`, so those wrappers are pure plumbing. ONE-WAY: the
   *  result reads back as `str`, not `string-append` — save rewrites storage. Default
   *  ON (the sugarcoat projection); pass `false` to keep a strict string-append lens. */
  strTolerant: boolean;
}
export const DEFAULT_OPTS: SugarcoatOpts = {
  width: 120,
  neoteric: false,
  curly: true,
  kwargHeads: new Set(["dict"]),
  skin: "ascii",
  nilGlyph: false,
  strTolerant: true,
};

/** A `(string-append …)` tolerates a wider line than the general budget before it
 *  breaks. Breaking text assembly staircases the fragments down the page and reads
 *  worse than one long line, so we keep it inline up to this many chars. */
const STRING_APPEND_WIDTH = 160;

const QUOTE_PREFIX: Record<string, string> = {
  quote: "'",
  quasiquote: "`",
  unquote: ",",
  "unquote-splicing": ",@",
};
// Symbols that READ as infix get curly-sugar — not every binary head.
const INFIX = new Set([
  "+",
  "-",
  "*",
  "/",
  "<",
  ">",
  "<=",
  ">=",
  "modulo",
  "quotient",
  "remainder",
  "=",
  "equal?",
  "eq?",
  "eqv?", // equality
  "and",
  "or", // logical
]);
// Canonical op → display glyph. STORED op unchanged; the view swaps in the familiar
// symbol. The map is INJECTIVE for a faithful round-trip: only `equal?`→`==` (the
// structural-equality common case), `and`/`or`→`&&`/`||`. `=` (numeric), `eq?`,
// `eqv?` render AS THEMSELVES — they're different ops, and collapsing them to `==`
// would make view+save rewrite `(= n 0)` → `(equal? n 0)`. `{n = 0}` reads fine as a
// comparison; the assignment association is weak inside a visibly-expression curly.
const INFIX_GLYPH: Record<string, string> = {
  "equal?": "==",
  and: "&&",
  or: "||",
};
// The math skin (Agda-style). `∧`/`∨` also retire the `||` overload with symbol-bar
// `|…|` syntax. `≡` structural-equal, wavy `≈`/`≃` for the identity pair (eq?/eqv?),
// `≤`/`≥`. Numeric `=`, `<`, `>`, arithmetic stay themselves. Reader accepts both skins.
const MATH_GLYPH: Record<string, string> = {
  "equal?": "≡",
  and: "∧",
  or: "∨",
  "eq?": "≈",
  "eqv?": "≃",
  "<=": "≤",
  ">=": "≥",
  // heads that become infix ONLY in the math skin (see MATH_INFIX): `(cons a b)` →
  // `{a ∷ b}`, `(member x xs)` → `{x ∈ xs}`, `(compose f g)` → `{f ∘ g}`.
  cons: "∷",
  member: "∈",
  compose: "∘",
};
// Heads promoted to infix under the math skin only (ASCII keeps them prefix: `(cons a
// b)`). member returns the tail/#f, not a bool — `∈` reads it as membership intent.
const MATH_INFIX = new Set(["cons", "member", "compose"]);
const glyphOf = (op: string, o: SugarcoatOpts): string =>
  (o.skin === "math" ? MATH_GLYPH[op] : undefined) ?? INFIX_GLYPH[op] ?? op;
// Skin-dependent arrows: the lambda body arrow (`↦` maps-to) and the cond/case
// receiver (`⇀` partial function). ASCII keeps `=>` and the pierced `=?>`.
const lamArrow = (o: SugarcoatOpts): string => (o.skin === "math" ? "↦" : "=>");
const condArrow = (o: SugarcoatOpts): string => (o.skin === "math" ? "⇀" : "=?>");

// Family B — the negated-comparison collapse (math skin, bidirectional): `(not (= a
// b))` → `{a ≠ b}`; the reader pattern-matches `≠` back to `(not (= …))`. Same for the
// structural (`equal?`→`≢`) and identity (`eq?`→`≉`, `eqv?`→`≄`) heads. Only the binary
// comparison heads collapse — `(not (foo …))` on a general predicate stays `(not …)`.
// Precedence is the comparison tier (3), matching the un-negated form.
const NEG_GLYPH: Record<string, string> = { "=": "≠", "equal?": "≢", "eq?": "≉", "eqv?": "≄" };
function negComparison(items: Node[], o: SugarcoatOpts): { glyph: string; operands: Node[] } | null {
  if (o.skin !== "math" || items.length !== 2 || !isAtom(items[0]) || items[0].str || items[0].atom !== "not")
    return null;
  const inner = items[1];
  if (isAtom(inner) || inner.list.length < 3 || !isAtom(inner.list[0]) || inner.list[0].str) return null;
  const glyph = NEG_GLYPH[inner.list[0].atom];
  return glyph ? { glyph, operands: inner.list.slice(1) } : null;
}
const negContent = (neg: { glyph: string; operands: Node[] }, o: SugarcoatOpts): string =>
  neg.operands.map((x) => infixOperand(x, 3, o)).join(` ${neg.glyph} `);

// Precedence ladder (higher binds tighter), keyed on the CANONICAL op. This is a
// deliberate departure from SRFI-105 (which is precedence-free): it lets a child
// that binds tighter than its parent drop its braces, so compound expressions read
// like C/JS — {v == "click" || v == "keep-reading"} instead of {{…} || {…}}.
//   `||` ⟨ `&&` ⟨ comparison ⟨ additive ⟨ multiplicative
const INFIX_PREC: Record<string, number> = {
  or: 1,
  and: 2,
  "=": 3,
  "equal?": 3,
  "eq?": 3,
  "eqv?": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  modulo: 5,
  quotient: 5,
  remainder: 5,
  // math-skin infix (see MATH_INFIX): cons/member at the comparison tier (looser than
  // arithmetic, so `{x + 1 ∷ xs}` = `(cons (+ x 1) xs)`); compose binds tight like `.`.
  cons: 3,
  member: 3,
  compose: 5,
};
const precOf = (op: string): number => INFIX_PREC[op] ?? 3;

/** Render the INSIDE of an infix node (no outer braces): `a glyph b glyph …`,
 *  recursing through operands at this op's precedence. */
function infixContent(items: Node[], o: SugarcoatOpts): string {
  const op = atomText(items[0]);
  const myPrec = precOf(op);
  return items
    .slice(1)
    .map((x) => infixOperand(x, myPrec, o))
    .join(` ${glyphOf(op, o)} `);
}

/** Render an operand inside an infix at `parentPrec`. An infix operand keeps its
 *  braces only when it binds the same or looser than the parent (so grouping is
 *  preserved, incl. non-associative `-`/`/`); a tighter operand drops them and
 *  shares the zone. Non-infix operands render normally. */
function infixOperand(nd: Node, parentPrec: number, o: SugarcoatOpts): string {
  const neg = !isAtom(nd) ? negComparison(nd.list, o) : null;
  if (neg) return 3 <= parentPrec ? `{${negContent(neg, o)}}` : negContent(neg, o);
  if (!isAtom(nd) && nd.list.length >= 3 && isInfix(nd.list, o)) {
    const opPrec = precOf(atomText(nd.list[0]));
    const content = infixContent(nd.list, o);
    return opPrec <= parentPrec ? `{${content}}` : content;
  }
  return inlineSugarcoat(nd, o);
}

/** `(lambda (params…) single-body)` — rendered as an arrow `{(params) => body}`.
 *  Curly-wrapped so it's self-delimiting (drops in anywhere) AND shares the infix
 *  zone (the body composes: `{(x) => x * 2}`). Only single-body, list-param
 *  lambdas; multi-body or rest-param lambdas stay classic `lambda` form. */
const isArrowLambda = (items: Node[]): boolean =>
  items.length === 3 && isAtom(items[0]) && !items[0].str && items[0].atom === "lambda" && !isAtom(items[1]);

/** Render an arrow body. `=>` is the loosest operator (precedence 0), so the body
 *  shares the arrow's `{}` — any infix body (prec ≥ 1) drops its braces. */
function inlineArrowBody(nd: Node, o: SugarcoatOpts): string {
  return infixOperand(nd, 0, o);
}

const isQuoteForm = (items: Node[]): boolean =>
  items.length === 2 && isAtom(items[0]) && !items[0].str && QUOTE_PREFIX[items[0].atom] !== undefined;

/** `(quote ())` — the empty-list literal `'()`. Rendered as `nil` under `nilGlyph`;
 *  the reader folds `nil` back, so it round-trips. Quasiquote/unquote don't count —
 *  only a plain `quote` of the empty list is the list-end bottom. */
const isEmptyQuote = (items: Node[]): boolean =>
  items.length === 2 &&
  isAtom(items[0]) &&
  !items[0].str &&
  items[0].atom === "quote" &&
  !isAtom(items[1]) &&
  items[1].list.length === 0;

const hasDot = (items: Node[]): boolean => items.some((it) => isAtom(it) && !it.str && it.atom === ".");

const isInfix = (items: Node[], o: SugarcoatOpts): boolean =>
  o.curly &&
  items.length >= 3 &&
  !hasDot(items) &&
  isAtom(items[0]) &&
  !items[0].str &&
  (INFIX.has(items[0].atom) || (o.skin === "math" && MATH_INFIX.has(items[0].atom)));

const isKeyword = (nd: Node): boolean => isAtom(nd) && !nd.str && nd.atom.startsWith(":") && nd.atom.length > 1;

// ── at-expressions render (inverse of sugarcoat-read's @-reader) ─────────────────────
// `(str …)`→`@{…}`; under default `strTolerant`, `(string-append …)` also →`@{…}` with
// known scalar→string coercions stripped (`number->string`/`symbol->string`/`->string`).
// Strict mode (`strTolerant: false`) keeps `(string-append …)`→`@string-append{…}`.
// dedent never appears in canonical scheme (the reader dissolved it); multi-line
// `(str …)` renders as `@dedent{…}`. `@str{…}` is a read-side alias of headless `@{…}`.
const AT_TEXT_HEADS = new Set(["str", "string-append"]);
// a bare `@id` interpolation must FULLY match the reader's restricted class (no `.`).
const INTERP_ID = /^[A-Za-z0-9!$%&*/:<=>?^_~+-]+$/;
const unescapeScheme = (s: string): string =>
  s.replace(/\\(["\\ntr])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
const isStrNode = (n: Node): n is { atom: string; str: true } => isAtom(n) && !!(n as { str?: boolean }).str;

// String coercions that `str` (the tolerant concatenator) makes redundant — stripped
// under `strTolerant` (default). Only scalar→string coercions: `(list->string x)` is
// NOT here — str would repr the list, not join its chars, so dropping it would change
// meaning.
const COERCE_STRIP = new Set(["number->string", "symbol->string", "->string"]);
const stripCoercion = (nd: Node): Node =>
  !isAtom(nd) &&
  nd.list.length === 2 &&
  isAtom(nd.list[0]) &&
  !nd.list[0].str &&
  COERCE_STRIP.has(nd.list[0].atom)
    ? nd.list[1]
    : nd;

/**
 * Pure accessor/subscript chain on a bare-name base — the at-body spelling
 * `@persona[:id]` / `@xs[0][1:]` (no graft parens). null when the form needs a
 * `@(…)` graft (method dots, compound base, non-subscript steps).
 *
 * Graft parens are wrong for postfix sugar: `@(persona[:id])` re-reads as a
 * ONE-element list around the accessor (`((:id persona))`), so bare is the only
 * sound surface for these chains.
 */
function bareInterpAccessor(nd: Node, o: SugarcoatOpts): string | null {
  const { base, steps, emit } = peelChain(nd, o);
  if (!emit || steps.length === 0) return null;
  if (!steps.every((s) => "sub" in s)) return null;
  if (!isAtom(base) || base.str || !INTERP_ID.test(base.atom)) return null;
  return `@${base.atom}${steps.map((s) => ("sub" in s ? s.sub : "")).join("")}`;
}

/** Emit one interpolation part. A simple symbol → `@id`, guarded to `@|id|` when the
 *  NEXT literal starts with an interp-class char (else the reader reads them glued).
 *  Pure accessor chains → bare `@recv[:k]` / `@xs[0]` (the sugarcoat surface). Any
 *  other compound → `@(…)` graft of its CLASSIC-prefix form. Classic (not sugar) is
 *  load-bearing for grafts: the `@(datum)` reader peels the outer parens as the
 *  graft envelope, so a method-chain (`x.f`, no parens) or a re-parenthesized sugar
 *  form (`(persona[:id])` → double-wrap) wouldn't round-trip — but `(f x)` classic
 *  reads back verbatim. A non-INTERP_ID atom has no spelling → null (caller bails
 *  to classic). */
function interpPiece(p: Node, next: Node | undefined, o: SugarcoatOpts): string | null {
  if (isAtom(p)) {
    if (p.str || !INTERP_ID.test(p.atom)) return null;
    const glue = next != null && isStrNode(next) && INTERP_ID.test(unescapeScheme(next.atom)[0] ?? "");
    return glue ? `@|${p.atom}|` : `@${p.atom}`;
  }
  const bare = bareInterpAccessor(p, o);
  if (bare != null) return bare;
  // inlineScheme of a list is already parenthesized (`(f x)`), which IS the `@(datum)`
  // graft body — so `@` + it, not `@(` + it + `)` (that would double-wrap to `@((f x))`).
  return `@${inlineScheme(p)}`;
}

/** Render `(str …)`/`(string-append …)` as a SINGLE-LINE at-expression, or null when
 *  not safely round-trippable (caller falls back to classic). Soundness gates: no
 *  adjacent string literals (the reader coalesces), no `@`/brace/newline in literal
 *  text (no in-body escape for those; newline ⇒ the deferred multi-line path), and
 *  at least one prose literal (preference — don't at-exp `(str x y)`). */
function renderAtExpr(items: Node[], o: SugarcoatOpts): string | null {
  if (!o.curly || !isAtom(items[0]) || items[0].str || !AT_TEXT_HEADS.has(items[0].atom)) return null;
  // strTolerant: `string-append` is the tolerant `str`; render headless and drop the
  // redundant coercion wrappers (one-way normalization — see COERCE_STRIP / SugarcoatOpts).
  const head = o.strTolerant && items[0].atom === "string-append" ? "str" : items[0].atom;
  const parts = (o.strTolerant ? items.slice(1).map(stripCoercion) : items.slice(1));
  if (parts.length === 0) return null;
  let prevWasStr = false;
  let sawLiteral = false; // ≥1 string literal — else it's `(str x y)`, not worth an at-exp
  let sawProse = false; // a space/quote-bearing literal — genuine prose
  let sawInterp = false; // ≥1 hole — a template worth surfacing even without spaces
  let body = "";
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (isStrNode(p)) {
      if (prevWasStr) return null; // adjacent literals coalesce on read → not representable
      prevWasStr = true;
      const raw = unescapeScheme(p.atom);
      if (/[\n\r@{}]/.test(raw)) return null; // newline ⇒ multi-line path; @/brace ⇒ no text-mode escape
      if (raw.length > 0) sawLiteral = true;
      if (/[ "]/.test(raw)) sawProse = true; // space or quote ⇒ genuine prose
      body += raw;
    } else {
      prevWasStr = false;
      const piece = interpPiece(p, parts[k + 1], o);
      if (piece == null) return null;
      sawInterp = true;
      body += piece;
    }
  }
  // Worth an at-exp iff there's real text AND it's more than a bare word — either prose
  // or a hole. `(str "hello")` (lone wordless literal) and `(str x y)` (no literal) stay classic.
  if (!sawLiteral || (!sawProse && !sawInterp)) return null;
  return head === "str" ? `@{${body}}` : `@${head}{${body}}`;
}

/** Multi-line render for a `(str …)` whose prose carries a newline: `@dedent{…}` with
 *  cosmetic indent the reader strips back (round-trips) when the value has no intrinsic
 *  common indent, else `@{…}` verbatim. Only `str` (string-append multi-line stays
 *  classic — one escaped line reads cleaner than a flush-left block). Returns null when
 *  not a newline-bearing representable str (single-line/classic handled elsewhere). */
function renderAtDedentBlock(nd: Node, col: number, o: SugarcoatOpts): string | null {
  if (!o.curly || isAtom(nd)) return null;
  const items = nd.list;
  const h0 = isAtom(items[0]) && !items[0].str ? items[0].atom : null;
  // `str` always; `string-append` too under strTolerant (it normalizes to str) — both
  // emit a `@{…}`/`@dedent{…}` (str head), with coercion wrappers stripped when tolerant.
  if (h0 !== "str" && !(o.strTolerant && h0 === "string-append")) return null;
  const parts = o.strTolerant ? items.slice(1).map(stripCoercion) : items.slice(1);
  if (parts.length === 0) return null;
  let prevWasStr = false;
  let hasNewline = false;
  const pieces: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (isStrNode(p)) {
      if (prevWasStr) return null;
      prevWasStr = true;
      const raw = unescapeScheme(p.atom);
      if (/[@{}]/.test(raw)) return null;
      if (raw.includes("\n")) hasNewline = true;
      pieces.push(raw);
    } else {
      prevWasStr = false;
      const piece = interpPiece(p, parts[k + 1], o);
      if (piece == null) return null;
      pieces.push(piece);
    }
  }
  if (!hasNewline) return null; // single-line → renderAtExpr / classic
  const lines = pieces.join("").split("\n");
  let vmin = Infinity; // value's intrinsic common indent (non-first, non-blank lines)
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].trim() === "") continue;
    vmin = Math.min(vmin, /^[ \t]*/.exec(lines[k])![0].length);
  }
  if (vmin === Infinity) return null; // all continuation lines blank → let classic handle
  if (vmin > 0) return `@{${lines.join("\n")}}`; // intrinsic indent → verbatim, no dedent
  const pad = " ".repeat(col + 2); // dedent strips exactly this back on read (fixed point)
  const body = lines.map((ln, k) => (k === 0 || ln.trim() === "" ? ln : pad + ln)).join("\n");
  return `@dedent{${body}}`;
}

// ── pair-accessor lens: the whole c[ad]+r family as a list-indexing surface ───
//
// A pair path `c[ad]+r` is a chain of just two ops applied inner→outer (read the
// letters right-to-left): a PULL k = take element k (letters `dᵏa`), a DROP k =
// drop the first k (letters `dᵏ`). Maximal `d…d a` runs fuse into one pull; an
// innermost trailing `d…d` is a drop. The SAME chain has three faces — sugarcoat
// subscripts (`[k]`/`[k:]`), JS (`[k]`/`.slice(k)`), and the word itself — so this
// one primitive is what the renderer prints, the reader fuses back (inverse), and
// the chain-view compiler lowers. Total over the family (caar, cadadr… all swept
// in, not just the linear car/cdr/cadr/caddr). The sugar lives in punctuation
// space (`[]`), so it can NEVER collide with a user identifier — the same
// faithfulness property that lets `equal?`→`==`.

export type PairStep = { pull: number } | { drop: number };

/** Decompose a `c[ad]+r` accessor word into its PULL/DROP chain in OPERAND order
 *  (step 0 applies to the operand first). null if `head` is not an accessor. */
export function decodeAccessor(head: string): PairStep[] | null {
  const m = /^c([ad]+)r$/.exec(head);
  if (!m) return null;
  const letters = m[1];
  const steps: PairStep[] = [];
  let d = 0;
  for (let i = letters.length - 1; i >= 0; i--) {
    if (letters[i] === "d")
      d++; // skip another element
    else (steps.push({ pull: d }), (d = 0)); // an `a` closes the pull it caps
  }
  if (d > 0) steps.push({ drop: d }); // innermost bare cdr-run (no `a` after)
  return steps;
}

/** Inverse of decodeAccessor: a PULL/DROP chain → the `c[ad]+r` word. Operand-order
 *  steps map to letters outer→inner, so written letters are the reverse: pull k →
 *  `a dᵏ`, drop k → `dᵏ`. Any chain yields a valid word (so the reader can fuse a
 *  slice-then-pull like `xs[1:][0]` to `cadr` → which re-renders as `xs[1]`). */
export function encodeAccessor(steps: PairStep[]): string {
  const letters = steps
    .slice()
    .reverse()
    .map((s) => ("pull" in s ? "a" + "d".repeat(s.pull) : "d".repeat(s.drop)))
    .join("");
  return `c${letters}r`;
}

/** Cost of a step in accessor-word letters: pull k = `dᵏa` (k+1), drop k = `dᵏ`. */
export const accessorStepLetters = (s: PairStep): number => ("pull" in s ? s.pull + 1 : s.drop);

/** A pair accessor → its subscript-chain sugar: `(caadr x)`→`x[1][0]`, `(cdar x)`
 *  →`x[0][1:]`. null if not an accessor. Unconditional — render decomposes any word
 *  it is given; only the reader (sugarcoat-read) caps fusion depth for portable output. */
function accessorSubscript(head: string): string | null {
  const steps = decodeAccessor(head);
  if (!steps) return null;
  return steps.map((s) => ("pull" in s ? `[${s.pull}]` : `[${s.drop}:]`)).join("");
}

/** A literal `(require "….prompt")` — the inline-require call style used in the
 *  examples (vs. the bound-name style `(define react (require …))` in fixtures).
 *  Both are kwarg-takers; only `.prompt` (not `.hbs`, which takes positionals). */
const isRequirePrompt = (nd: Node): boolean =>
  !isAtom(nd) &&
  nd.list.length === 2 &&
  isAtom(nd.list[0]) &&
  nd.list[0].atom === "require" &&
  isAtom(nd.list[1]) &&
  !!nd.list[1].str &&
  nd.list[1].atom.endsWith(".prompt");

const isKwargHead = (items: Node[], o: SugarcoatOpts): boolean =>
  items.length > 0 &&
  ((isAtom(items[0]) && !items[0].str && o.kwargHeads.has(items[0].atom)) || isRequirePrompt(items[0]));

/** A head is a kwarg-taker if it's `dict` or a name bound to a `.prompt` require. */
export function collectKwargHeads(forms: Node[]): Set<string> {
  const heads = new Set<string>(["dict"]);
  for (const f of forms) {
    if (isAtom(f) || f.list.length < 3) continue;
    const [h, name, val] = f.list;
    if (
      isAtom(h) &&
      h.atom === "define" &&
      isAtom(name) &&
      !isAtom(val) &&
      val.list.length === 2 &&
      isAtom(val.list[0]) &&
      val.list[0].atom === "require" &&
      isAtom(val.list[1]) &&
      val.list[1].str &&
      val.list[1].atom.endsWith(".prompt")
    )
      heads.add(name.atom);
  }
  return heads;
}

// ── method-dot chains (§2 Method, §4.3 receiver-last fold, §5 render gate) ──────
//
// The postfix dot is the visible pipe: `(g (f x))` ↔ `x.f.g`, `(map Λ xs)` ↔
// `xs.map{…}`. Render PEELS a datum into `base + [step…]` by unwinding nested
// single-receiver calls (the receiver always in the LAST arg slot), then emits the
// chain iff there are ≥2 steps OR the single step is an accessor / key / braced
// method. A lone bare unary (`(not p)`) stays prefix — exactly the §5 gate.

// ident-start glyphs (R7RS initial set, minus digits) — mirror of sugarcoat-read's;
// a `.` is a method-split only before one of these, so escSym escapes exactly the
// dots rewrite_L would otherwise split. (Producer side of the same rule.)
const RENDER_IDENT_START = /[A-Za-z!$%&*/:<=>?^_~]/;

/** Re-escape any `.` in a symbol that `rewrite_L` would treat as a method split, so
 *  it reads back as a LITERAL dot in the symbol. No-op for the corpus (0 code dots);
 *  applied only to sugarcoat bare-atom / method-op emission, never to classic output. */
function escSym(s: string): string {
  let out = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    const next = s[k + 1];
    if (
      c === "." &&
      k > 0 &&
      s[k - 1] !== "." &&
      next !== "." &&
      next !== undefined &&
      RENDER_IDENT_START.test(next) &&
      !/[0-9]/.test(next)
    )
      out += "\\.";
    else out += c;
  }
  return out;
}

// Heads that are NOT peelable receivers: special forms (the §5 carve-out) plus the
// infix ops (rendered curly when arity ≥3, never a postfix method) and the access
// heads `@`/`:k` (peeled by their own step branches, not as plain methods).
const NEVER_METHOD = new Set<string>([
  "quote",
  "quasiquote",
  "unquote",
  "unquote-splicing",
  "lambda",
  "named-lambda",
  "define",
  "define-values",
  "define-syntax",
  "define-record-type",
  "if",
  "cond",
  "case",
  "when",
  "unless",
  "and",
  "or",
  "begin",
  "do",
  "set!",
  // `not` never becomes a method-dot step: `(not (dict? x))` must stay `(not x.dict?)`, not
  // chain to `x.dict?.not` (a trailing `.not` reads backwards). The sugarcoat negation MACRO
  // — `(not (= a b))` → `{a ≠ b}` — is a separate `negComparison` check that runs before the
  // chain, so it's untouched by this exclusion.
  "not",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "let-values",
  "let*-values",
  "let-syntax",
  "letrec-syntax",
  "else",
  "=>",
  "delay",
  "delay-force",
  "parameterize",
  "guard",
  "syntax-rules",
  "@",
  "+",
  "-",
  "*",
  "/",
  "<",
  ">",
  "<=",
  ">=",
  "=",
  "equal?",
  "eq?",
  "eqv?",
  "modulo",
  "quotient",
  "remainder",
]);

/** Element-wise HOFs whose LAST argument is the collection — so `(map f xs)` flips to
 *  `xs.map(f)` (named f) / `xs.map{…}` (lambda f). A general `(op a b)` does NOT flip (the
 *  receiver is ambiguous); only these known heads earn the un-gated collection-last flip. */
const ELEMENT_HOFS = new Set<string>([
  "map",
  "filter",
  "for-each",
  "find",
  "find-tail",
  "remove",
  "partition",
  "count",
  "filter-map",
  "append-map",
  "take-while",
  "drop-while",
  "any",
  "every",
  "list-index",
]);

/** A head usable as a bare/braced postfix method op: a plain symbol that is neither
 *  a special form, an infix op, an access head, nor a pair-accessor word. */
const isPlainMethodOp = (nd: Node): nd is { atom: string; str?: boolean } =>
  isAtom(nd) && !nd.str && !NEVER_METHOD.has(nd.atom) && !nd.atom.startsWith(":") && decodeAccessor(nd.atom) === null;

// A lone bare unary `(f x)` surfaces as `x.f` only when the head reads well postfix:
// a predicate (`list?`→`x.list?`), a conversion (`number->string`→`x.number->string`),
// or a curated well-known op. A generic verb (`display`, `foo`) or `not` stays prefix —
// `p.not` reads worse than `(not p)`. The reader folds ANY `x.f` back, so this gate is
// pure render taste, not a round-trip constraint (§5, narrowed from "never emit").
const UNARY_METHOD_ALLOW = new Set(["length", "reverse", "abs", "string-length", "string-upcase", "string-downcase"]);
const shouldFlipUnary = (op: string): boolean =>
  op.endsWith("?") || op.includes("->") || UNARY_METHOD_ALLOW.has(op);

/** Relational / equality predicates — suffix `=?` `<?` `>?` `<=?` `>=?` (`char=?`,
 *  `string<?`, `boolean=?`, a bare `=?`). A SYMMETRIC or ordering check, not a subject-test:
 *  flipping `(char=? #\2 x)` to `#\2.char=?(x)` mis-reads an equality guard as a method on
 *  its left operand. These stay prefix even though they end in `?`. (The word forms
 *  `equal?`/`eq?`/`eqv?` are out separately via NEVER_METHOD.) */
const isRelationalPredicate = (op: string): boolean => /[<>=]=?\?$/.test(op);

/** Render a `(lambda (p…) body)` as a trailing-lambda block (§3.3). Emits the
 *  IMPLICIT `{ B }` only for the single param `it` AND a non-arrow body — otherwise
 *  the bare body would re-read as the lambda itself (dropping the `it` wrapper), so
 *  fall back to the explicit `{(p…) => B}`. ≥2 params always name (the pronoun
 *  breaks on ≥2 antecedents). */
function renderTrailingLambda(lam: Node, o: SugarcoatOpts): string {
  const params = childList(lam)[1];
  const names = childList(params).map((p) => atomText(p));
  const body = childList(lam)[2];
  const bodyTxt = inlineArrowBody(body, o);
  const implicit = names.length === 1 && names[0] === "it" && !(!isAtom(body) && isArrowLambda(body.list));
  return implicit ? `{ ${bodyTxt} }` : `{(${names.join(" ")}) ${lamArrow(o)} ${bodyTxt}}`;
}

/** One postfix step on the render side: a subscript/key run (`[…]`), or a method
 *  (`.op` bare, `.op(args)` predicate call, or `.op{B}` braced — its lambda carried). */
type RStep = { sub: string } | { op: string; lam?: Node; args?: Node[] };

/** Peel ONE outermost step off `nd`, returning the receiver + the step — or null if
 *  `nd` isn't a single-receiver postfix application. Mirrors §4.3's constructors. */
function asStep(nd: Node, o: SugarcoatOpts): { recv: Node; step: RStep } | null {
  if (isAtom(nd)) return null;
  const items = nd.list;
  // accessor `(c[ad]+r recv)` → subscript run; static key `(:k recv)` → `[:k]`.
  if (items.length === 2 && isAtom(items[0]) && !items[0].str) {
    const sub = accessorSubscript(items[0].atom);
    if (sub) return { recv: items[1], step: { sub } };
    if (isKeyword(items[0])) return { recv: items[1], step: { sub: `[${items[0].atom}]` } };
  }
  // dynamic key `(@ recv key)` → `[key]`.
  if (items.length === 3 && isAtom(items[0]) && !items[0].str && items[0].atom === "@")
    return { recv: items[1], step: { sub: `[${inlineSugarcoat(items[2], o)}]` } };
  // braced method `(op LAMBDA recv)` — exactly two args, lambda first (§5 gate).
  if (items.length === 3 && isPlainMethodOp(items[0]) && !isAtom(items[1]) && isArrowLambda(items[1].list))
    return { recv: items[2], step: { op: items[0].atom, lam: items[1] } };
  // element-wise HOF with a NAMED (non-lambda) function: `(map run-one-test tests)` →
  // `tests.map(run-one-test)`. The collection is reliably LAST for these known HOFs, so the
  // flip is safe WITHOUT the `?` gate a general `(op a b)` would need (there the receiver is
  // ambiguous). The lambda case is the braced rule above; here the mapper is a symbol / a
  // value-producing compound — but NOT an accessor/keyword (`(map car xs)` stays prefix: an
  // accessor passed as a value has its own `[0]` sugar and isn't a named function).
  if (
    items.length === 3 &&
    isPlainMethodOp(items[0]) &&
    ELEMENT_HOFS.has(items[0].atom) &&
    (isAtom(items[1]) ? isPlainMethodOp(items[1]) : true)
  )
    return { recv: items[2], step: { op: items[0].atom, args: [items[1]] } };
  // bare method `(op recv)`.
  if (items.length === 2 && isPlainMethodOp(items[0])) return { recv: items[1], step: { op: items[0].atom } };
  // predicate with args `(pred? arg… recv)` → `recv.pred?(arg…)` — receiver LAST. GATED to
  // SUBJECT-TEST `?`-heads: `seat.valid-seat?(game)` reads well, but two families must NOT
  // flip — (a) receiver-FIRST builtins (`vector-ref v i`, `list-ref lst i`), which aren't
  // predicates, so the `?` gate excludes them; (b) RELATIONAL predicates (`char=?`,
  // `string<?`, `<=?`), a symmetric/ordering check where `#\2.char=?(x)` mis-reads equality
  // as a method — excluded by isRelationalPredicate. (`equal?`/`eq?`/`eqv?` are already out
  // via NEVER_METHOD.) Reader folds `.op(args)` back receiver-last, so the round-trip holds.
  if (
    items.length >= 3 &&
    isPlainMethodOp(items[0]) &&
    items[0].atom.endsWith("?") &&
    !isRelationalPredicate(items[0].atom)
  )
    return { recv: items[items.length - 1], step: { op: items[0].atom, args: items.slice(1, -1) } };
  return null;
}

/** Peel `nd` fully into `base + [step…]` (base-first order) and decide whether to
 *  surface it as a postfix chain (§5): ≥2 steps, or a single accessor/key/braced
 *  step. A lone bare unary method canonicalizes to prefix (emit=false). */
/** A raw scalar literal — number, boolean, or char. Never a method-dot RECEIVER: `7.valid?`,
 *  `#t.foo`, `#\a.bar` read as nonsense (a literal has no methods). Strings are NOT scalars
 *  here (`nd.str` is a separate literal kind, and `"s".upcase` reads fine). */
const isLiteralScalar = (nd: Node): boolean => {
  if (!isAtom(nd) || nd.str) return false;
  const a = nd.atom;
  return (
    a === "#t" ||
    a === "#f" ||
    a === "#true" ||
    a === "#false" ||
    a.startsWith("#\\") ||
    /^[+-]?(\d|\.\d|#[xbodei])/i.test(a)
  );
};

function peelChain(nd: Node, o: SugarcoatOpts): { base: Node; steps: RStep[]; emit: boolean } {
  const steps: RStep[] = [];
  let cur = nd;
  // STOP the peel when the next receiver would be a raw scalar literal: `7.valid?`, `#t.foo`,
  // `6.iota` read as nonsense (a literal has no methods). Stopping (rather than gating the
  // whole chain) keeps the compound as the base — `(iota 6).map{…}`, not a flattened prefix.
  for (let s = asStep(cur, o); s && !isLiteralScalar(s.recv); s = asStep(cur, o)) {
    steps.unshift(s.step); // discovered outermost-first → unshift gives base-first
    cur = s.recv;
  }
  const lone = steps.length === 1 ? steps[0] : null;
  const emit =
    steps.length >= 2 ||
    (lone != null &&
      ("sub" in lone ||
        lone.lam != null ||
        ("op" in lone && (shouldFlipUnary(lone.op) || (lone.args?.length ?? 0) > 0))));
  return { base: cur, steps, emit };
}

/** Render one step's surface text: `[…]` subscript, `.op`, or `.op{ B }`. The
 *  lambda-brace binds TIGHT to the op (no space) — isomorphic to a tight arg-group
 *  `fold(knil)`. This is load-bearing for round-trip: a loose `{…}` is a sibling
 *  curly operand, so only a tight brace reads back as THIS step's trailing lambda
 *  (else `recv.op {sibling}` would swallow the sibling — see sugarcoat-read's brace gate). */
function stepText(s: RStep, o: SugarcoatOpts): string {
  if ("sub" in s) return s.sub;
  const args = s.args && s.args.length > 0 ? `(${s.args.map((a) => inlineSugarcoat(a, o)).join(" ")})` : "";
  const lam = s.lam ? renderTrailingLambda(s.lam, o) : "";
  return `.${escSym(s.op)}${args}${lam}`;
}

/** One-line rendering, no width check. */
export function inlineSugarcoat(nd: Node, o: SugarcoatOpts): string {
  // A bare `=>` symbol is always a RECEIVER arrow (cond/case's `(datum => proc)`, the
  // partial function) — never a value or the lambda arrow (that's emitted as a literal
  // by the arrow-lambda branch, never routed through here). Render it `=?>` so the case
  // form matches cond; the reader folds `=?>` back to the `=>` symbol.
  if (isAtom(nd)) return nd.str ? `"${nd.atom}"` : nd.atom === "=>" ? condArrow(o) : escSym(nd.atom);
  const items = nd.list;
  if (items.length === 0) return "()";
  if (o.nilGlyph && isEmptyQuote(items)) return "nil";
  if (isQuoteForm(items)) return QUOTE_PREFIX[atomText(items[0])] + inlineSugarcoat(items[1], o);
  const at = renderAtExpr(items, o);
  if (at != null) return at;
  const neg = negComparison(items, o); // (not (= a b)) → {a ≠ b} (math skin)
  if (neg) return `{${negContent(neg, o)}}`;
  if (isInfix(items, o)) {
    return `{${infixContent(items, o)}}`;
  }
  if (isArrowLambda(items)) {
    return `{${inlineSugarcoat(items[1], o)} ${lamArrow(o)} ${inlineArrowBody(items[2], o)}}`;
  }
  // postfix chain (§4.3 + §5 gate): accessor/key subscripts (`(car X)`→`X[0]`,
  // `(:k X)`→`X[:k]`, `(@ X k)`→`X[k]`) and method dots (`(map Λ xs)`→`xs.map{…}`,
  // `(g (f x))`→`x.f.g`), unified — emit iff ≥2 steps or a single accessor/key/
  // braced step. A lone bare unary (`(not p)`) canonicalizes to prefix (falls
  // through). A bare `car`/`:k` passed as a VALUE (`(map car xs)`) has no receiver
  // step and never enters a chain.
  const chain = peelChain(nd, o);
  if (chain.emit) return inlineSugarcoat(chain.base, o) + chain.steps.map((s) => stepText(s, o)).join("");
  if (o.neoteric && !hasDot(items) && isAtom(items[0]) && !items[0].str && QUOTE_PREFIX[items[0].atom] === undefined) {
    return `${items[0].atom}(${items
      .slice(1)
      .map((it) => inlineSugarcoat(it, o))
      .join(" ")})`;
  }
  return `(${items.map((it) => inlineSugarcoat(it, o)).join(" ")})`;
}

/** A flat list = every element is an atom, e.g. a function signature `(f x y)`. */
const isFlatList = (nd: Node): boolean => !isAtom(nd) && nd.list.length > 0 && nd.list.every(isAtom);

/** Definition heads whose FLAT-LIST second element is a function SIGNATURE (a binding
 *  target), not an application to be method-dotted. */
const DEFINE_HEADS = new Set(["define", "define/overridable"]);

/** A function `define` — `(define (name args…) body…)` (or `define/overridable`) with a
 *  FLAT-LIST signature. These always render broken (`define (sig)` ⏎ body), never inline as
 *  `(define (f x) body)`, so every function definition is shaped identically regardless of
 *  width (the inline/broken mix reads as an imbalance). */
const isFnDefine = (nd: Node): boolean =>
  !isAtom(nd) &&
  nd.list.length >= 2 &&
  isAtom(nd.list[0]) &&
  !nd.list[0].str &&
  DEFINE_HEADS.has(nd.list[0].atom) &&
  isFlatList(nd.list[1]);

/** `(cond …)` — always rendered vertical: `cond` ⏎ each clause as `test` ⏎
 *  consequence (never inline, never starting from `(`). Reconstructed by plain
 *  I-expressions: a `test` line + consequence child reads back as (test cons). */
const isCondForm = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length > 0 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === "cond";

/** `(if test then [else])` — broken by default: the condition pulls onto the `if` line, each
 *  arm on its own indented line, so a fork carrying real structure is legible at a glance.
 *  The exception is a TRIVIAL if (isTrivialIf) — a low-density fork reads better on one line. */
const isIfForm = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length >= 3 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === "if";

/** A trivial `if` — condition and both arms are atoms or FLAT (all-atom) lists, e.g.
 *  `(if (< d 0) -1 1)`. A structural (Halstead-ish) density signal: no arm carries nested
 *  compound structure, so the fork is low-density and reads cleanest on ONE line
 *  (`if {d < 0} -1 1`) rather than force-verticalized. The moment an arm nests a real
 *  sub-computation, the always-break returns (the fork-legibility argument holds again). */
const isTrivialIf = (nd: Node): boolean =>
  !isAtom(nd) && isIfForm(nd) && nd.list.slice(1).every((a) => isAtom(a) || isFlatList(a));

/** `(begin s…)` — ALWAYS broken, `begin` alone on its line, every step below it. Unlike
 *  the generic break it does NOT pull the first step up: a sequence reads as a column of
 *  steps, and a lone leading step on the head line breaks that shape. */
const isBeginForm = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length >= 2 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === "begin";

/** `(string-append …)` — see STRING_APPEND_WIDTH. Granted the wider inline budget. */
const isStringAppend = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length > 0 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === "string-append";

const LET_FAMILY = new Set(["let", "let*", "letrec", "letrec*"]);
/** Any `let`-family form. A `let` binds a named intermediate — pure cognitive density, not
 *  line length — so it ALWAYS breaks (like `if`/`cond`/`begin`), never renders inline, even
 *  when it would fit. Elidable ones take the nicer `name` ⏎ `value` render (isLetElidable);
 *  the rest fall to the generic break (`let (bindings)` ⏎ body). */
const isLetForm = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length >= 2 && isAtom(nd.list[0]) && !nd.list[0].str && LET_FAMILY.has(nd.list[0].atom);
const isBindingShaped = (nd: Node): boolean => !isAtom(nd) && nd.list.length === 2 && isAtom(nd.list[0]);
/** A `let`/`let*`/`letrec`/`letrec*` whose bindings can be ELIDED in the view (each binding
 *  shown as `name` ⏎ `value`, dropping the `(( ))`). Safe when every binding is `(sym val)`
 *  AND the reader can recover where the bindings end. The reader's `regroupLetFamily` reserves
 *  the LAST child as body (its `i < length-1` guard), so:
 *    • a SINGLE body expr is always recoverable — even a binding-shaped one like
 *      `(ok (cond …))` — because it's the last child and never swallowed into the bindings;
 *    • with ≥2 body exprs, a binding-shaped FIRST body expr WOULD be swallowed, so that case
 *      stays non-elided (the `(( ))` group is kept, still faithful).
 *  Named `let` excluded (items[1] is a symbol, not a bindings list). */
const isLetElidable = (nd: Node): boolean => {
  if (isAtom(nd) || nd.list.length < 2) return false;
  const h = nd.list[0];
  if (!isAtom(h) || h.str || !LET_FAMILY.has(h.atom)) return false;
  // Named let `(let loop bindings body)`: the loop symbol is child 1; bindings/body shift +1.
  const named = isAtom(nd.list[1]) && nd.list.length > 2;
  const binds = named ? nd.list[2] : nd.list[1];
  if (binds === undefined || isAtom(binds) || binds.list.length === 0 || !binds.list.every(isBindingShaped)) return false;
  const body = nd.list.slice(named ? 3 : 2);
  return body.length === 1 || (body.length > 1 && !isBindingShaped(body[0]));
};

/** Break a too-long curly-infix `{a op b op …}` operator-led: first operand after
 *  `{`, each subsequent on its own line prefixed with the operator. Recurses, so a
 *  nested long curly (e.g. `{{a - b} < c}`) breaks at every level that overflows. */
function formatInfix(items: Node[], col: number, o: SugarcoatOpts): string {
  const op = atomText(items[0]);
  const operands = items.slice(1);
  let out = `{${formatSugarcoat(operands[0], col + 1, o)}`;
  const contCol = col + 2;
  for (let k = 1; k < operands.length; k++) {
    const g = glyphOf(op, o);
    out += `\n${" ".repeat(contCol)}${g} ${formatSugarcoat(operands[k], contCol + g.length + 1, o)}`;
  }
  return `${out}}`;
}

/** Emit a node's captured comments around its rendered `body`: each `lead` line
 *  before it (at column `col`), the same-line `trail` after. Applied at every
 *  formatSugarcoat seam, so top-level forms and broken-list children show comments. */
function withComments(nd: Node, body: string, col: number): string {
  const pad = " ".repeat(col);
  let out = body;
  if (nd.lead?.length) out = `${nd.lead.join(`\n${pad}`)}\n${pad}${out}`;
  if (nd.trail?.length) out = `${out}  ${nd.trail.join(" ")}`;
  return out;
}

/** Render a node starting at column `col`; breaks to indented sugarcoat form when it
 *  exceeds the width budget. First line is unindented (caller positions it). The
 *  exported entry wraps the core renderer to re-emit the node's lead/trail comments
 *  (recursive calls hit this wrapper too, so nested comments render). */
export function formatSugarcoat(nd: Node, col: number, o: SugarcoatOpts): string {
  return withComments(nd, formatSugarcoatCore(nd, col, o), col);
}
function formatSugarcoatCore(nd: Node, col: number, o: SugarcoatOpts): string {
  const atBlock = renderAtDedentBlock(nd, col, o);
  if (atBlock != null) return atBlock; // multi-line @dedent{…}/@{…} for newline-bearing str
  // A single-line at-expression stays inline even past the width budget: the generic
  // list-break can't split it (a broken `@{…}` would re-render as the classic
  // string-append staircase, which reads worse), so honour the at-string as one line.
  const atInline = !isAtom(nd) ? renderAtExpr(nd.list, o) : null;
  if (atInline != null) return atInline;
  const flat = inlineSugarcoat(nd, o);
  // Function defines, cond, and elidable let-family always break (uniform shape,
  // even if they'd fit); everything else stays inline when it fits. string-append
  // gets a wider budget — text assembly reads worse broken than as one long line.
  const budget = isStringAppend(nd) ? Math.max(o.width, STRING_APPEND_WIDTH) : o.width;
  if (
    col + flat.length <= budget &&
    !isFnDefine(nd) &&
    !isCondForm(nd) &&
    !isLetForm(nd) &&
    (!isIfForm(nd) || isTrivialIf(nd)) &&
    !isBeginForm(nd)
  )
    return flat;
  if (isAtom(nd)) return flat;
  const items = nd.list;
  if (items.length === 0) return "()";
  // A 1-element list `(X)` can't break via indentation — a lone indented child
  // reads back as X, not (X) — so keep it inline even past the width budget
  // (e.g. a single long `let` binding `((cls (map …)))`). Round-trip > width here.
  if (items.length === 1) return flat;

  // Function define — `head (name args…)` ⏎ body. The SIGNATURE is a BINDING target, not a
  // call: render it as a literal paren group, NEVER method-dotted. `define (hand-value? x)`,
  // not `define x.hand-value?` (which reads as assigning to a method). The body renders
  // normally — its own predicate calls DO flip (`x.dict?`). Reader folds the classic
  // `head (sig)` ⏎ body straight back to the definition.
  if (isFnDefine(nd)) {
    const pad2 = " ".repeat(col + 2);
    const sig = `(${childList(items[1]).map((a) => atomText(a)).join(" ")})`;
    const out = [`${atomText(items[0])} ${sig}`];
    for (const bodyExpr of items.slice(2)) out.push(pad2 + formatSugarcoat(bodyExpr, col + 2, o));
    return out.join("\n");
  }

  // let-family with elidable bindings: `let*` ⏎ each binding `name` ⏎ `value` ⏎ body.
  // The `(( ))` is dropped in the view; the reader re-groups leading binding-shaped
  // children. (Unsafe lets never reach here — isLetElidable already excluded them.)
  if (isLetElidable(nd)) {
    const pad2 = " ".repeat(col + 2);
    const pad4 = " ".repeat(col + 4);
    // Named let `(let loop bindings body)` — the loop symbol rides the head line (`let loop`),
    // bindings/body shift by one. The reader's regroupLetFamily skips the loop symbol to match.
    const named = isAtom(items[1]) && items.length > 2;
    const bindsNode = named ? items[2] : items[1];
    const out = [named ? `${atomText(items[0])} ${atomText(items[1])}` : atomText(items[0])];
    // isLetElidable guarantees the bindings arm is a non-empty list of binding-shaped
    // `(name value)` 2-lists (its `binds.list.every(isBindingShaped)` gate), so childList
    // re-asserts that proven arm.
    for (const b of childList(bindsNode)) {
      const bind = childList(b);
      out.push(pad2 + formatSugarcoat(bind[0], col + 2, o)); // binding name
      out.push(pad4 + formatSugarcoat(bind[1], col + 4, o)); // binding value
    }
    for (const bodyExpr of items.slice(named ? 3 : 2)) out.push(pad2 + formatSugarcoat(bodyExpr, col + 2, o));
    return out.join("\n");
  }

  // Non-elidable / named let (elidable ones took the branch above): keep the bindings as a
  // literal `(( ))` group — each binding `(name <value>)` with the NAME literal (a binding
  // target, never method-dotted, same rule as a define signature) and the value sugared. The
  // generic break would method-dot the binding pair `(y (g x))` into `x.g.y`, mis-reading a
  // binding as a call.
  if (isLetForm(nd)) {
    const pad2 = " ".repeat(col + 2);
    const named = isAtom(items[1]);
    const bindsNode = named ? items[2] : items[1];
    const head = `${atomText(items[0])}${named ? ` ${atomText(items[1])}` : ""}`;
    const out: string[] = [];
    if (isAtom(bindsNode)) {
      out.push(`${head} ${inlineSugarcoat(bindsNode, o)}`);
    } else {
      const binds = childList(bindsNode).map((b) => {
        const bl = childList(b);
        return bl.length >= 2 ? `(${atomText(bl[0])} ${inlineSugarcoat(bl[1], o)})` : inlineSugarcoat(b, o);
      });
      if (binds.length <= 1) {
        // single (or empty) binding stays compact on the head line.
        out.push(`${head} (${binds.join(" ")})`);
      } else {
        // ≥2 bindings: `head` alone, then each binding as `(name` ⏎ `value)` — NAME and VALUE
        // on separate lines. A let* is sequential; every binding is a step the reader tracks,
        // and setting the value apart from the name reads clearest. Aligned inside the `(( ))`
        // group, which stays explicit (round-trip: the reader reads the multi-line paren group
        // as one bindings datum, then the body).
        const valuePad = " ".repeat(col + 6);
        const bindsList = childList(bindsNode);
        out.push(head);
        bindsList.forEach((b, i) => {
          const bl = childList(b);
          const last = i === bindsList.length - 1;
          if (bl.length >= 2) {
            out.push(`${pad2}${i === 0 ? "((" : " ("}${atomText(bl[0])}`);
            out.push(`${valuePad}${inlineSugarcoat(bl[1], o)})${last ? ")" : ""}`);
          } else {
            // degenerate binding (not `(name value)`) — keep it on one line, faithfully.
            out.push(`${pad2}${i === 0 ? "(" : " "}${inlineSugarcoat(b, o)}${last ? ")" : ""}`);
          }
        });
      }
    }
    for (const bodyExpr of items.slice(named ? 3 : 2)) out.push(pad2 + formatSugarcoat(bodyExpr, col + 2, o));
    return out.join("\n");
  }

  // cond: `cond` ⏎ each clause as `test` ⏎ consequence(s). A 1-element clause
  // `(test)` stays a paren group (can't break losslessly). Reconstructed by plain
  // I-expressions (a `test` line + consequence child → (test cons)).
  if (isCondForm(nd)) {
    const pad2 = " ".repeat(col + 2);
    const pad4 = " ".repeat(col + 4);
    const out = ["cond"];
    for (const clause of items.slice(1)) {
      if (isAtom(clause) || clause.list.length < 2) {
        out.push(pad2 + inlineSugarcoat(clause, o));
        continue;
      }
      // `(test => recv)` cond-arrow clause: the R7RS receiver form — a PARTIAL
      // function (`test`'s value, when truthy, is sent to `recv`; #f falls through).
      // Rendered `=?>` (the ASCII partial-function arrow `⇀`, the `?` piercing the
      // shaft) to disambiguate it from the lambda arrow `=>` and the kwarg pair glyph —
      // three jobs, one token, now two. The reader folds `=?>`/`⇀`/`⇸` back to the `=>`
      // symbol. Inline `test =?> recv` (reads back as the 3-elem clause) when it fits;
      // else `test =?>` trailing the test line with recv indented below.
      if (clause.list.length === 3 && isAtom(clause.list[1]) && !clause.list[1].str && clause.list[1].atom === "=>") {
        const testFlat = inlineSugarcoat(clause.list[0], o);
        const recvFlat = inlineSugarcoat(clause.list[2], o);
        if (col + 2 + testFlat.length + condArrow(o).length + 2 + recvFlat.length <= o.width) {
          out.push(`${pad2}${testFlat} ${condArrow(o)} ${recvFlat}`);
        } else {
          out.push(`${pad2}${testFlat} ${condArrow(o)}`);
          out.push(pad4 + formatSugarcoat(clause.list[2], col + 4, o));
        }
        continue;
      }
      out.push(pad2 + formatSugarcoat(clause.list[0], col + 2, o)); // test (curly if infix)
      for (const cons of clause.list.slice(1)) out.push(pad4 + formatSugarcoat(cons, col + 4, o));
    }
    return out.join("\n");
  }

  if (isQuoteForm(items)) {
    const pre = QUOTE_PREFIX[atomText(items[0])];
    return pre + formatSugarcoat(items[1], col + pre.length, o);
  }
  if (isInfix(items, o)) return formatInfix(items, col, o); // operator-led break when over width

  // long method chain (§3.4): base on the head line, one `.op` per indented line —
  // where the pipe reads best. Only ALL-method chains break this way: a `[…]`
  // subscript step can't lead a line (its first token is `[`, not `.`, so the reader
  // wouldn't fold it back as a step). Require the base to render on one line, so its
  // own indentation can't collide with the step lines; otherwise fall through to the
  // generic prefix break (still faithful, just not dotted).
  {
    const chain = peelChain(nd, o);
    const baseFlat = inlineSugarcoat(chain.base, o);
    if (
      chain.emit &&
      chain.steps.length >= 2 &&
      chain.steps.every((s) => "op" in s) &&
      col + baseFlat.length <= o.width
    ) {
      const pad = " ".repeat(col + 2);
      return [baseFlat, ...chain.steps.map((s) => pad + stepText(s, o))].join("\n");
    }
  }

  // kwarg-head break: render `:key value` runs as `:key => value` pair lines.
  // The pair is a synthetic (=> k v) view-node; it stays atomic (never split
  // mid-pair — the failure the flat indenter had). Leading positionals (e.g. a
  // .prompt cache-key) render before the first keyword, untouched.
  if (isKwargHead(items, o)) {
    let line = inlineSugarcoat(items[0], o);
    let i = 1;
    if (i < items.length && !isKeyword(items[i])) {
      const a1 = inlineSugarcoat(items[i], o);
      if (col + line.length + 1 + a1.length <= o.width) {
        line += ` ${a1}`;
        i++;
      }
    }
    const pad = " ".repeat(col + 2);
    const out = [line];
    while (i < items.length) {
      if (isKeyword(items[i]) && i + 1 < items.length) {
        // A pair line is the trailing-colon form `key: value` — the leading `:key`
        // flips to a trailing `key:` (JSON/YAML). This is the ONLY pair glyph: `=>`
        // was retired so the arrow means only the lambda (`{… => …}`) and, pierced,
        // the cond receiver (`=?>`). The broken `:key value` form is unsound anyway
        // (a `:key value` child line reads as the accessor call `(:key value)`).
        const raw = atomText(items[i]);
        const keyPart = `${raw.slice(1)}:`;
        const vFlat = inlineSugarcoat(items[i + 1], o);
        if (col + 2 + keyPart.length + 1 + vFlat.length <= o.width) {
          // fits: `key: value` on one line.
          out.push(`${pad + keyPart} ${vFlat}`);
        } else {
          // value must break: HANG it on the next line at a fixed +2 step rather
          // than aligning under the value's start column — aligning makes deep
          // nesting staircase rightward (key-length compounds per level). The
          // hang keeps indentation linear in depth, YAML-style (`key:` ⏎ block).
          out.push(pad + keyPart);
          out.push(" ".repeat(col + 4) + formatSugarcoat(items[i + 1], col + 4, o));
        }
        i += 2;
      } else {
        out.push(pad + formatSugarcoat(items[i], col + 2, o));
        i++;
      }
    }
    return out.join("\n");
  }

  // sugarcoat break: head on its own line (+ first arg if it still fits), rest indented.
  // If the head is itself a long compound (e.g. a `let` binding `(v (triage …))`),
  // BREAK it rather than inlining — inlining a compound head is what produced
  // 190-char lines for binding lists. A short/atom head keeps the first-arg pull.
  const headFlat = inlineSugarcoat(items[0], o);
  const headFits = col + headFlat.length <= o.width;
  let line = headFits ? headFlat : formatSugarcoat(items[0], col, o);
  let idx = 1;
  // Pull the first arg onto the head line ONLY if ≥1 element still remains as a
  // child (`items.length > 2`). A broken list is recovered by the reader as
  // "head line + indented children" — if pulling left ZERO children, the line
  // would read back as a flat token sequence, silently dropping the list's parens
  // (`((c …) (b …))` → `(c …) (b …)`). Keeping a child preserves the list.
  // `begin` never pulls its first step up — a sequence reads as a clean column of steps.
  if (headFits && items.length > 2 && !isBeginForm(nd)) {
    const a1 = inlineSugarcoat(items[1], o);
    if (col + headFlat.length + 1 + a1.length <= o.width) {
      line += ` ${a1}`;
      idx = 2;
    }
  }
  const pad = " ".repeat(col + 2);
  const out = [line];
  for (; idx < items.length; idx++) out.push(pad + formatSugarcoat(items[idx], col + 2, o));
  return out.join("\n");
}

// ── the pairing bijection (the bifunctor's core, as homoiconic tree-rewrites) ──
//
// inflate: flat canonical → view tree, grouping each `:key value` run under a
//   kwarg-head into a `(=> key value)` pair node (the internal tag is `=>`, at
//   index 0 — never confusable with a cond clause's `=>` at index 1; the DISPLAY
//   is always the trailing-colon `key: value`, no glyph choice).
// flatten: view tree → flat canonical, splicing every pair node back to `key value`.
// Law: flatten(inflate(t)) ≡ t. Storage stays flat (lowest entropy); the paired
// form exists only in the view. Odd-arity/non-keyword simply doesn't pair (and is
// already dict's own runtime error), so the transform is total AND lossless.
const PAIR_TAG = "=>";
const isPairNode = (nd: Node): boolean =>
  !isAtom(nd) && nd.list.length === 3 && isAtom(nd.list[0]) && !nd.list[0].str && nd.list[0].atom === PAIR_TAG;

export function inflateKwargs(nd: Node, heads: Set<string>): Node {
  if (isAtom(nd)) return nd;
  const items = nd.list.map((c) => inflateKwargs(c, heads));
  if (!isKwargHead(items, { ...DEFAULT_OPTS, kwargHeads: heads })) return { list: items };
  const out: Node[] = [items[0]];
  let i = 1;
  while (i < items.length) {
    if (isKeyword(items[i]) && i + 1 < items.length) {
      out.push({ list: [{ atom: PAIR_TAG }, items[i], items[i + 1]] });
      i += 2;
    } else {
      out.push(items[i]);
      i++;
    }
  }
  return { list: out };
}

export function flattenKwargs(nd: Node): Node {
  if (isAtom(nd)) return nd;
  const out: Node[] = [];
  for (const c of nd.list) {
    if (isPairNode(c)) out.push(flattenKwargs(childList(c)[1]), flattenKwargs(childList(c)[2]));
    else out.push(flattenKwargs(c));
  }
  return { list: out };
}

/** Structural equality on parsed trees (atom text + string-ness; list shape). */
export function nodeEq(a: Node, b: Node): boolean {
  if (isAtom(a) && isAtom(b)) return a.atom === b.atom && !!a.str === !!b.str;
  if (!isAtom(a) && !isAtom(b)) return a.list.length === b.list.length && a.list.every((x, i) => nodeEq(x, b.list[i]));
  return false;
}

/** Single-line classic serialization of a Node — the trivial inverse of
 *  parseSexprs at the atom level. String atoms wrap RAW (`"${atom}"`), exactly
 *  as inlineSugarcoat does and as parseSexprs decodes them, so the AST round-trips. */
export function inlineScheme(nd: Node): string {
  if (isAtom(nd)) return nd.str ? `"${nd.atom}"` : nd.atom;
  return `(${nd.list.map(inlineScheme).join(" ")})`;
}

/** Pretty classic (prefix-only) serialization of a Node: inline when it fits the
 *  width, else break — the head (and, when the head is a bare symbol and the pair
 *  still fits, the first operand) stay on the open-paren line; the rest indent at
 *  col+2. Pure s-expressions, NO sugarcoat transforms — this is the canonical-classic
 *  writer the sugarcoat save-back emits for a CHANGED form. It only adds whitespace
 *  over inlineScheme, so parseSexprs(printScheme(f)) ≡ f. */
export function printScheme(nd: Node, col = 0, width = DEFAULT_OPTS.width): string {
  const flat = inlineScheme(nd);
  if (isAtom(nd) || col + flat.length <= width) return flat;
  const items = nd.list;
  if (items.length <= 1) return flat; // () / (X): nothing to gain by breaking
  // Keep the head on the open line; pull the first operand up too when the head
  // is a bare symbol and the pair still fits — so `(define (f x)` / `(if test`
  // read naturally instead of head-alone.
  const pair = `${inlineScheme(items[0])} ${inlineScheme(items[1])}`;
  const pull = isAtom(items[0]) && items.length > 2 && col + 1 + pair.length <= width;
  const lead = pull ? pair : inlineScheme(items[0]);
  const pad = " ".repeat(col + 2);
  const rest = items.slice(pull ? 2 : 1).map((it) => pad + printScheme(it, col + 2, width));
  return `(${lead}\n${rest.join("\n")})`;
}

// Does a param list / rest-symbol bind the name `nil`? `(f a nil c)` or a rest `nil`.
const paramsIncludeNil = (nd: Node): boolean =>
  (isAtom(nd) && !nd.str && nd.atom === "nil") ||
  (!isAtom(nd) && nd.list.some((p) => isAtom(p) && !p.str && p.atom === "nil"));

/** Whether `'()`→`nil` is safe for this program: true unless `nil` is BOUND to a
 *  non-empty value somewhere — a `(define nil X)` with X≠'(), or `nil` sitting in a
 *  lambda / define / let / do binding position (the fold-accumulator idiom `(fold f
 *  nil xs)`). An explicit `(define nil '())` agrees with the glyph and keeps it on.
 *  Quoted `'nil` (data, never a binding) doesn't disqualify — the reader protects it. */
export function collectNilAllowed(forms: Node[]): boolean {
  const bindsNilToNonEmpty = (nd: Node): boolean => {
    if (isAtom(nd)) return false;
    const items = nd.list;
    if (items.length === 0) return false;
    const h = isAtom(items[0]) && !items[0].str ? items[0].atom : null;
    if (h === "define" && items.length >= 2) {
      const name = items[1];
      if (isAtom(name) && !name.str && name.atom === "nil") {
        const val = items[2]; // (define nil X): only '() agrees with the glyph
        if (!(val != null && !isAtom(val) && isEmptyQuote(val.list))) return true;
      }
      if (!isAtom(name) && paramsIncludeNil(name)) return true; // (define (f … nil …) …)
    }
    if ((h === "lambda" || h === "named-lambda") && paramsIncludeNil(items[h === "lambda" ? 1 : 2] ?? { list: [] }))
      return true;
    if ((h === "let" || h === "let*" || h === "letrec" || h === "letrec*" || h === "do") && items.length >= 2) {
      const binds = isAtom(items[1]) ? items[2] : items[1]; // named-let: bindings shift right one
      if (isAtom(items[1]) && !items[1].str && items[1].atom === "nil") return true; // named `nil`
      if (binds != null && !isAtom(binds))
        for (const b of binds.list)
          if (!isAtom(b) && b.list.length >= 1 && isAtom(b.list[0]) && !b.list[0].str && b.list[0].atom === "nil")
            return true;
    }
    return items.some(bindsNilToNonEmpty);
  };
  return !forms.some(bindsNilToNonEmpty);
}

/** Render a whole source file's top-level forms as sugarcoat, blank-line separated. */
export function schemeToSugarcoat(src: string, opts: Partial<SugarcoatOpts> = {}): string {
  const forms = parseSexprs(src);
  const o = {
    ...DEFAULT_OPTS,
    kwargHeads: collectKwargHeads(forms),
    nilGlyph: collectNilAllowed(forms),
    ...opts,
  };
  return forms.map((f) => formatSugarcoat(f, 0, o)).join("\n\n");
}

// lower — the scheme → TypeScript LOWERING for the type-layer.
//
// "Scheme is a TS subset except lists and pairs." This walks the s-expr forest
// (`parseSexprs` from @here.build/arrival-sweet) and emits a TS *string* that the
// lens compiles against the harvested prelude (carriers.ts + a `declare const` per
// tool). The emitted TS NEVER RUNS — it exists only so the type-checker can narrow a
// lowered call against its tool signature (the Σ∩T narrow). So fidelity is about
// TYPES, not runtime: string-escape exactness, numeric precision, etc. are immaterial
// as long as the emitted form carries the right type.
//
// The cut between "plain TS" and "carrier vocabulary":
//   • application `(head a b)`     → `head(a, b)` (scheme arg order; head is a global /
//                                    declared const) — or `_.op$escaped(a, b)` for a
//                                    non-identifier head (`+`, `string-append`, …), which
//                                    lives in the prelude's `_` namespace under its escaped,
//                                    dotted name (name-escape.ts — so `typeof _.op` is legal).
//   • lists/pairs (the ONLY non-TS-subset values) → the carrier globals
//                                    `list`/`cons`/`car`/`cdr` (functional, never `.car`).
//   • vector `#(…)`                → a native TS array `[…]`.
//   • dict / keyword-access        → object literal / index read.
//   • lambda                       → an arrow.
//   • scalars                      → their plain-TS image (string/number/boolean).
//
// SPAN-MAP (per-top-level-statement): alongside the joined `ts`, `lower` returns one
// `{ tsRange, schemeSpan }` per top-level statement — the TS byte-range each statement
// occupies in the joined output, and the scheme byte-range it came from (`forms[i].span`,
// stamped unconditionally by parseSexprs). Per-STATEMENT granularity only: the sole
// consumer (diagnose.ts) maps a diagnostic's TS offset back to the errored statement's
// scheme span (statement-coincidence); nothing reads sub-expression offsets. `{ ts }` is
// preserved verbatim — every current caller destructures `.ts` only.

import { parseSexprs, type Node } from "@here.build/arrival-sweet";

import { escapeName, isTsIdentifier } from "./name-escape.js";

/** A dict / object-property key prints bare when identifier-safe, else quoted. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A plain decimal/integer numeric literal (also covers a leading sign + exponent). */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A rational literal `p/q` — lowered to a division so its TS type is `number`. */
const RATIONAL = /^([+-]?\d+)\/(\d+)$/;

// arrival-sweet's `Node` is `{ atom; str? } | { list }` (+ inert lead/trail/span). The
// package keeps `isAtom`/`isKeyword` private, so we re-declare the few guards we need —
// anchored on the same structural shape, never a cast.
type AtomNode = { atom: string; str?: boolean };
type ListNode = { list: Node[] };

const isAtom = (n: Node | undefined): n is AtomNode => n != null && "atom" in n;
const isList = (n: Node | undefined): n is ListNode => n != null && "list" in n;
/** A word atom (not a string literal) — the symbol/operator/number lexeme position. */
const isWord = (n: Node | undefined): n is AtomNode => isAtom(n) && n.str !== true;
/** The bare `#` lexeme — the parser splits `#(…)` into `#` + the following list. */
const isVectorMark = (n: Node | undefined): boolean => isWord(n) && n.atom === "#";
/** A `:keyword` atom (dict key / field-access head); `:` alone is not a keyword. */
const isKeyword = (n: Node | undefined): n is AtomNode =>
  isWord(n) && n.atom.startsWith(":") && n.atom.length > 1;
const keywordName = (n: AtomNode): string => n.atom.slice(1);

/** An object-property / dict key prints bare when identifier-safe, else quoted. */
const propKey = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

/** One top-level statement's coordinate map: the TS byte-range it occupies in the joined
 *  `ts` output, and the scheme byte-range it lowered from. */
export interface LoweredStatement {
  readonly tsRange: readonly [start: number, end: number];
  readonly schemeSpan: readonly [start: number, end: number];
}

/** The separator `lower` joins top-level statements with — a byte-length constant the
 *  span-map's cumulative TS offset accounts for. */
const STATEMENT_SEP = ";\n";

/**
 * Lower a scheme program to a TypeScript type-inference string. Multiple top-level
 * forms become statements separated by `;\n`. `statements` is the per-statement span-map
 * (additive; `{ ts }` is unchanged).
 */
export function lower(scheme: string): { ts: string; statements: readonly LoweredStatement[] } {
  const forms = parseSexprs(scheme);
  const fragments = emitTopLevel(forms);
  const statements: LoweredStatement[] = [];
  let offset = 0;
  for (const fragment of fragments) {
    const start = offset;
    const end = start + fragment.ts.length;
    statements.push({ tsRange: [start, end], schemeSpan: fragment.schemeSpan });
    offset = end + STATEMENT_SEP.length; // the join inserts the separator after every fragment but the last
  }
  return { ts: fragments.map((f) => f.ts).join(STATEMENT_SEP), statements };
}

/** Lower the top-level forms into per-statement `{ ts, schemeSpan }`, fusing a `#` +
 *  following-list back into one vector statement (as `emitSeq` does). Each statement's
 *  scheme span covers from the first fused node's start to the last's end. */
function emitTopLevel(nodes: Node[]): { ts: string; schemeSpan: readonly [number, number] }[] {
  const out: { ts: string; schemeSpan: readonly [number, number] }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const next = nodes[i + 1];
    if (isVectorMark(node) && isList(next)) {
      out.push({ ts: emitVector(next), schemeSpan: [nodeStart(node), nodeEnd(next)] });
      i++; // consume the fused list node
      continue;
    }
    out.push({ ts: emitNode(node), schemeSpan: [nodeStart(node), nodeEnd(node)] });
  }
  return out;
}

/** A node's source start: its own `.span`, or (for a rare span-less synthesized node) the
 *  first spanned descendant's start. Top-level forms are always spanned by parseSexprs; the
 *  descent keeps the map total without a cast. */
function nodeStart(node: Node): number {
  if (node.span !== undefined) return node.span[0];
  if ("list" in node) {
    for (const child of node.list) {
      const s = nodeStart(child);
      if (s >= 0) return s;
    }
  }
  return 0;
}

/** A node's source end (mirror of `nodeStart`, scanning children last-first). */
function nodeEnd(node: Node): number {
  if (node.span !== undefined) return node.span[1];
  if ("list" in node) {
    for (let i = node.list.length - 1; i >= 0; i--) {
      const e = nodeEnd(node.list[i]!);
      if (e >= 0) return e;
    }
  }
  return 0;
}

/**
 * Lower a sibling sequence (a program's top forms, a call's args, a vector's / quoted
 * list's elements), fusing the parser's `#` + following-list back into one vector.
 */
function emitSeq(nodes: Node[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const next = nodes[i + 1];
    if (isVectorMark(nodes[i]) && isList(next)) {
      out.push(emitVector(next));
      i++; // consume the fused list node
      continue;
    }
    out.push(emitNode(nodes[i]));
  }
  return out;
}

function emitVector(node: ListNode): string {
  return `[${emitSeq(node.list).join(", ")}]`;
}

/** Emit a CALL's args, scheme order preserved. A `:keyword value` run FLIPS into a real object
 *  literal `{ key: value, … }` (the kwargs shape — `:name "Ada"` → `{ name: "Ada" }`), so the
 *  type-checker narrows each value as a plain object property and a kwargs tool's object input
 *  matches with no inverse decode. Leading non-keyword args stay positional (a mixed call
 *  `(f x :a 1)` → `f(x, { a: 1 })`); a bare keyword lowers to `{ key: undefined }`, which the
 *  property type rejects unless it admits undefined. `#(…)` values fuse to a vector as in emitSeq. */
function emitCallArgs(items: Node[]): string {
  const positional: string[] = [];
  const props: string[] = [];
  let kwargs = false;
  for (let i = 0; i < items.length; i++) {
    const node = items[i];
    if (isKeyword(node)) {
      kwargs = true;
      const key = propKey(keywordName(node)); // `:name` → the object key `name` (quoted if non-ident)
      if (items[i + 1] === undefined) {
        props.push(`${key}: undefined`); // a bare keyword (mid-edit) → undefined; the property type bites
        continue;
      }
      const value = emitValueAt(items, i + 1);
      props.push(`${key}: ${value.ts}`);
      i += value.consumed; // consume the value node(s) (the keyword itself is consumed by the loop)
      continue;
    }
    const value = emitValueAt(items, i);
    positional.push(value.ts);
    i += value.consumed - 1;
  }
  const parts = [...positional];
  if (kwargs) parts.push(props.length === 0 ? "{}" : `{ ${props.join(", ")} }`);
  return parts.join(", ");
}

/** One value node at `items[i]`, fusing a `#(…)` vector (which the parser splits into `#` + list). */
function emitValueAt(items: Node[], i: number): { ts: string; consumed: number } {
  const item = items[i];
  const next = items[i + 1];
  if (isVectorMark(item) && isList(next)) return { ts: emitVector(next), consumed: 2 };
  return { ts: emitNode(item), consumed: 1 };
}

function emitNode(node: Node): string {
  return isAtom(node) ? emitAtom(node) : emitList(node);
}

function emitAtom(node: AtomNode): string {
  if (node.str === true) return JSON.stringify(node.atom); // string literal → TS string
  const t = node.atom;
  if (t === "#t" || t === "#true") return "true";
  if (t === "#f" || t === "#false") return "false";
  if (NUMBER.test(t)) return t;
  const rat = RATIONAL.exec(t);
  if (rat !== null) return `${rat[1]} / ${rat[2]}`; // rational → number-typed division
  if (isTsIdentifier(t)) return t; // value-position symbol → the declared const / carrier global
  return `_.${escapeName(t)}`; // operator/symbol value → prelude `_` namespace member (escaped, dotted)
}

function emitList(node: ListNode): string {
  const items = node.list;
  if (items.length === 0) return "list()"; // bare () as a value = the empty list
  const head = items[0];

  // (:key obj) → obj["key"]  — keyword in head position is a field read.
  if (isKeyword(head)) {
    const obj = items[1] === undefined ? "undefined" : emitNode(items[1]);
    return `${obj}[${JSON.stringify(keywordName(head))}]`;
  }

  // Special forms, dispatched on a word head.
  if (isWord(head)) {
    switch (head.atom) {
      case "quote":
        return emitQuote(items[1]);
      case "lambda":
        return emitLambda(items);
      case "dict":
        return emitDict(items);
      case "quasiquote":
        return emitQuasiquote(items[1]);
      case "unquote":
      case "unquote-splicing":
        // A stray unquote/unquote-splicing OUTSIDE a quasiquote (malformed, but kept
        // inert): degrade to the live inner expression, same as before.
        return items[1] === undefined ? "undefined" : emitNode(items[1]);
    }
  }

  // Application — scheme arg order preserved; `:keyword value` args group into kwargs pairs.
  const args = emitCallArgs(items.slice(1));
  if (isWord(head)) {
    return isTsIdentifier(head.atom) ? `${head.atom}(${args})` : `_.${escapeName(head.atom)}(${args})`;
  }
  // Computed head (a nested application / lambda): `(expr a b)` → `expr(a, b)`.
  return `${emitNode(head)}(${args})`;
}

/** `(quote X)` from `'X`. A quoted atom → its value image (symbol → identifier — benign
 *  2304 noise, unchanged this round; number/string → itself). A quoted LIST recurses as
 *  QUOTED DATA (never as an application) — `'(("a" 1))` → `list(list("a", 1))`, never the
 *  false-positive `list("a"(1))` that treating the nested list as a call would produce (a
 *  string-literal head would get CALLED). A dotted datum `'(a . b)` → `cons(a, b)`, folding
 *  right through any preceding proper elements: `'(a b . c)` → `cons(a, cons(b, c))`. */
function emitQuote(datum: Node | undefined): string {
  return datum === undefined ? "list()" : emitQuotedDatum(datum);
}

/** One datum in QUOTED context: a nested list recurses (never applies), an atom keeps its
 *  plain value image (symbol → identifier, unchanged this round). */
function emitQuotedDatum(datum: Node): string {
  return isList(datum) ? emitQuoteLikeList(datum.list, emitQuotedDatum) : emitNode(datum);
}

/** `(quasiquote X)` from `` `X ``. Degrades to QUOTED DATA exactly like `emitQuote` — a
 *  nested list recurses, a dotted tail folds to `cons` — EXCEPT an `(unquote e)` /
 *  `(unquote-splicing e)` node found ANYWHERE inside emits the LIVE expression `emitNode(e)`,
 *  not further-quoted data. No interpolation/splicing semantics are modeled (advisory
 *  typing only, per the type-layer's inference-only contract) — the unquoted piece's
 *  inferred type is what narrows; splicing behaves identically to plain unquote here. */
function emitQuasiquote(datum: Node | undefined): string {
  return datum === undefined ? "list()" : emitQuasiDatum(datum);
}

function emitQuasiDatum(datum: Node): string {
  if (!isList(datum)) return emitNode(datum);
  const head = datum.list[0];
  if (isWord(head) && (head.atom === "unquote" || head.atom === "unquote-splicing")) {
    const inner = datum.list[1];
    return inner === undefined ? "undefined" : emitNode(inner);
  }
  return emitQuoteLikeList(datum.list, emitQuasiDatum);
}

/** Shared list-body emitter for QUOTE and QUASIQUOTE: fuses `#` + list into a vector (as
 *  `emitSeq`), detects a dotted tail via the bare `.` WORD marker (never a string atom —
 *  R7RS improper-list tail) and folds it into nested `cons(...)`, and recurses every other
 *  element through `emitElem` (quote vs. quasiquote differ only in that recursive step —
 *  quasiquote's `emitElem` additionally un-quotes an `(unquote …)`/`(unquote-splicing …)`
 *  node it encounters). */
function emitQuoteLikeList(items: Node[], emitElem: (n: Node) => string): string {
  const parts: string[] = [];
  let dotSeen = false;
  for (let i = 0; i < items.length; i++) {
    const node = items[i]!;
    if (isWord(node) && node.atom === "." && !dotSeen) {
      dotSeen = true; // the dot itself emits nothing; the following element is the tail
      continue;
    }
    const next = items[i + 1];
    if (isVectorMark(node) && isList(next)) {
      parts.push(emitVector(next)); // vector elements stay plain values (unchanged behavior)
      i++;
      continue;
    }
    parts.push(emitElem(node));
  }
  if (!dotSeen) return `list(${parts.join(", ")})`;
  let acc = parts[parts.length - 1]!; // the tail
  for (let i = parts.length - 2; i >= 0; i--) acc = `cons(${parts[i]}, ${acc})`;
  return acc;
}

/** `(lambda (x y) body…)` → `((x, y) => body)`. A multi-form body folds to a comma
 *  sequence (its TS type is the last form's); a symbol formals position is rest-args. */
function emitLambda(items: Node[]): string {
  const params = lambdaParams(items[1]);
  const body = items.slice(2);
  const bodyTs =
    body.length === 0 ? "undefined" : body.length === 1 ? emitNode(body[0]) : `(${emitSeq(body).join(", ")})`;
  return `((${params}) => ${bodyTs})`;
}

function lambdaParams(formals: Node | undefined): string {
  if (formals === undefined) return "";
  if (isWord(formals)) return `...${formals.atom}`; // (lambda rest body…) variadic
  if (!isList(formals)) return "";
  const names: string[] = [];
  for (const p of formals.list) {
    if (isWord(p) && p.atom !== ".") names.push(p.atom); // skip the dotted-tail marker
  }
  return names.join(", ");
}

/** `(dict :name "a" :age 30)` → `{ name: "a", age: 30 }`. Keys are keyword names. */
function emitDict(items: Node[]): string {
  const pairs: string[] = [];
  for (let i = 1; i < items.length; i += 2) {
    const keyNode = items[i];
    const key = isKeyword(keyNode) ? keywordName(keyNode) : isAtom(keyNode) ? keyNode.atom : "";
    const value = items[i + 1] === undefined ? "undefined" : emitNode(items[i + 1]);
    pairs.push(`${propKey(key)}: ${value}`);
  }
  return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
}

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
// Mappings + a span-map are a LATER phase; this returns the TS string only.

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

/**
 * Lower a scheme program to a TypeScript type-inference string. Multiple top-level
 * forms become statements separated by `;\n`.
 */
export function lower(scheme: string): { ts: string } {
  const forms = parseSexprs(scheme);
  return { ts: emitSeq(forms).join(";\n") };
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
      case "unquote":
      case "unquote-splicing":
        // TODO: quasiquotation is not lowered yet — degrade to the inner datum so a
        // type stays inferable rather than emitting broken syntax.
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

/** `(quote X)` from `'X`. A quoted list → `list(…)` of its lowered elements; a quoted
 *  atom → its value image (symbol → identifier, number/string → itself), matching the
 *  rule that `'(a b c)` ≡ `(list a b c)`. */
function emitQuote(datum: Node | undefined): string {
  if (datum === undefined) return "list()";
  if (isList(datum)) return `list(${emitSeq(datum.list).join(", ")})`;
  return emitNode(datum);
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

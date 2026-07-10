// dict-grammar.ts — the READER grammar of the `{…}` dict literal: key-admissibility
// predicates + the node minting. Reader-layer by nature (Parser validates with these and
// mints here; the infix ban door and the evaluator's quasiquote re-instantiation are the
// other mouths). The NODE ITSELF — its type, its detection, its dual data/code nature —
// is ADict's own algebra: see `ADict.isDictLiteral` / `DictLiteralNode`
// (values/primitives/ADict.ts), where the `literalForms` field lives. The datum face of
// `{…}` is an ADict — the same in-class pattern AVector uses for `[…]`; AJSObject plays
// no part in the dict-literal syntax.
//
// The dual nature (why the node is an ADict and not a distinct AST kind):
//   - CODE position: the evaluator lowers the node ONCE (cached) to the equivalent
//     `(dict …)` application — `{:k v}` ≡ `(dict :k v)` BY CONSTRUCTION, so evaluation,
//     membrane marshaling, heap charging and provenance all ride the normal apply path.
//   - `quote` context: evalQuote returns the node itself — a first-class READABLE dict
//     whose values are the raw forms (`(@ '{:a (f x)} :a)` reads back the form). A
//     distinct syntax-node kind would break exactly this: quote must yield a value.
//   - `quasiquote` context: processQuasiquote walks the forms element-wise (unquote
//     fires at level 1) and re-mints via `makeDictLiteralNode`.
//
// Keys are read-time-static (`:keyword` / `"string"`, both folding to the same string
// key) or unquote forms (quasiquote-substituted keys, validated post-substitution).
import { ADict, type DictKey, type DictLiteralNode } from "../values/primitives/ADict.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AString } from "../values/primitives/AString.js";
import { APair } from "../values/primitives/APair.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import type { SchemeValue } from "../values/types.js";

/** The STATIC string key of a key-position datum, or null if it isn't one.
 *  `:keyword` symbols fold to their bare name (the same `:`-strip `dict` performs);
 *  strings fold to their value. Everything else — including the legitimate
 *  unquote-form keys — has no static key. */
export function staticDictKey(datum: SchemeValue): string | null {
  if (datum instanceof ASymbol) {
    const name = typeof datum.__name__ === "string" ? datum.__name__ : String(datum.valueOf());
    return name.length > 1 && name.startsWith(":") ? name.slice(1) : null;
  }
  if (datum instanceof AString) {
    return datum.toString();
  }
  return null;
}

/** The SUFFIX-KEYWORD FLIP: at KEY position inside a
 *  `{}` literal, a symbol token with a SINGLE trailing colon is an explicit key
 *  declaration — `{flight_number: "X"}` ≡ `{:flight_number "X"}` (the trailing colon is
 *  the commitment marker, symmetric to the `:x` prefix). Returns the flipped key name,
 *  or null when the datum is not a suffix-key shape (bare symbols stay E-DICT-BAD-KEY —
 *  they could be intended as references; `a::`/`:a`/`:` are not suffix keys). Dict-
 *  literal KEY-position rule only — outside `{}` `foo:` remains a plain symbol. */
export function suffixKeyName(datum: SchemeValue): string | null {
  if (!(datum instanceof ASymbol)) return null;
  const name = typeof datum.__name__ === "string" ? datum.__name__ : String(datum.valueOf());
  if (name.length < 2 || name.startsWith(":") || !name.endsWith(":") || name.endsWith("::")) return null;
  return name.slice(0, -1);
}

/** True iff the datum is an `(unquote …)` form — the one non-static key shape the
 *  literal admits (a quasiquote-substituted key, validated post-substitution). */
export function isUnquoteForm(datum: SchemeValue): boolean {
  if (!(datum instanceof APair)) return false;
  const head = datum.car;
  if (!(head instanceof ASymbol)) return false;
  const name = typeof head.__name__ === "string" ? head.__name__ : String(head.valueOf());
  return name === "unquote";
}

/**
 * Mint the dict-literal node from an already-VALIDATED flat form sequence (the reader
 * owns validation — arity, key admissibility, static-duplicate — because the errors
 * need ParseError + source location). The ADict face maps each STATIC key — kept as
 * the real key DATUM object (`:a`'s ASymbol, `"a"`'s AString — real provenance, not a
 * folded string), a strictly better key face than a null-proto record — to its raw
 * VALUE form (unevaluated); unquote-form keys have no static entry — they exist only
 * in `literalForms` until quasiquote substitutes them. `pairs`' fold-names are unique
 * by construction here: the Parser's `make_dict_literal` already threw
 * E-DICT-DUP-KEY on any static-key collision before this ever runs, so ADict's own
 * constructor invariant (no duplicate fold-name) is trivially satisfied.
 */
export function makeDictLiteralNode(forms: readonly SchemeValue[]): DictLiteralNode {
  const pairs: Array<readonly [DictKey, SchemeValue]> = [];
  for (let i = 0; i + 1 < forms.length; i += 2) {
    const keyDatum = forms[i];
    if ((keyDatum instanceof ASymbol || keyDatum instanceof AString) && staticDictKey(keyDatum) !== null) {
      pairs.push([keyDatum, forms[i + 1]]);
    }
  }
  const node = new ADict(CONSTANT_CTX, pairs) as DictLiteralNode;
  node.literalForms = forms;
  return node;
}

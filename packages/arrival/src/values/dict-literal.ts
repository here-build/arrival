// dict-literal.ts — the `{…}` reader dict-literal NODE, shared between the reader (which
// mints and validates it) and the evaluator (which lowers it in code position and
// instantiates it under quasiquote).
//
// The node is a plain AJSObject carrying an extra `dictForms` payload (the flat
// `key value` element sequence as read, values UNEVALUATED) — no new SchemeValue union
// member. That dual nature implements the "evaluator-evaluated literal datum" semantics:
//
//   - CODE position: the evaluator lowers the node to the equivalent `(dict …)`
//     application (evaluator.ts), so `{:k v}` ≡ `(dict :k v)` BY CONSTRUCTION —
//     elements evaluate (Clojure semantics, not R7RS constant semantics).
//   - `quote` context: `evalQuote` returns the node itself — data. Its AJSObject face
//     presents the STATIC entries (`(@ '{:a (f x)} :a)` reads back the raw form),
//     which is the Clojure `'{:a (f x)}` shape.
//   - `quasiquote` context: processQuasiquote processes the forms element-wise
//     (unquote fires at level 1) and folds to a plain data dict.
//
// Keys are read-time-static (`:keyword` / `"string"`, both folding to the same string
// key) or unquote forms (quasiquote-substituted keys, validated post-substitution).
// See docs/working-proposals/arrival-curly-vector-literals.md.
import { AJSObject } from "./primitives/AJSObject.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { AString } from "./primitives/AString.js";
import { APair } from "./primitives/APair.js";
import { CONSTANT_CTX } from "./primitives/RunContext.js";
import type { SchemeValue } from "./types.js";

/** The reader-minted dict-literal node: an AJSObject whose `dictForms` is present. */
export type DictLiteralNode = AJSObject & { dictForms: readonly SchemeValue[] };

export function isDictLiteralNode(v: unknown): v is DictLiteralNode {
  return v instanceof AJSObject && v.dictForms !== undefined;
}

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

/** The SUFFIX-KEYWORD FLIP (spec: "The suffix-keyword flip"): at KEY position inside a
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
 * need ParseError + source location). The AJSObject face maps each STATIC key to its
 * raw value form (null-prototype source, so a `:__proto__` key is a plain data entry,
 * never prototype surgery); unquote-form keys have no static entry — they exist only
 * in `dictForms` until quasiquote substitutes them.
 */
export function makeDictLiteralNode(forms: readonly SchemeValue[]): DictLiteralNode {
  const source: Record<string, SchemeValue> = Object.create(null);
  for (let i = 0; i + 1 < forms.length; i += 2) {
    const key = staticDictKey(forms[i]);
    if (key !== null) source[key] = forms[i + 1];
  }
  const node = new AJSObject(CONSTANT_CTX, source) as DictLiteralNode;
  node.dictForms = forms;
  return node;
}

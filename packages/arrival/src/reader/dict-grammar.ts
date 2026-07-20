// dict-grammar.ts — the READER grammar of the `{…}` dict literal: key-admissibility
// predicates + the node minting. Reader-layer by nature (Parser validates with these and
// mints here; the infix ban door and the evaluator's quasiquote re-instantiation are the
// other mouths). The NODE ITSELF — its type, its detection, its dual data/code nature —
// is ADict's own algebra: see `ADict.isDictLiteral` / `DictLiteralNode`
// (values/primitives/ADict.ts), where the `literalForms` field lives.
//
// The dict literal's dual data/code nature (why the node is an ADict, not a distinct AST
// kind — its CODE / `quote` / `quasiquote` faces), the read-time-static-or-unquote key
// shapes, and the AVector-parallel datum face (AJSObject plays no part) are the model of
// `docs/GRAMMAR.md §LITERALS`.
import { ADict, type DictKey, type DictLiteralNode } from "../values/primitives/ADict.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AString } from "../values/primitives/AString.js";
import { APair } from "../values/primitives/APair.js";
import { CONSTANT_CTX, type RunContext } from "../run/RunContext.js";
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
 *
 * `ctx` discriminates the two mouths: the READER passes a parse ctx (the `{`'s
 * SourceLocation — ADict has no location slot, so this is the literal's only source
 * identity); the evaluator's quasiquote re-instantiation defaults to CONSTANT_CTX
 * (deferred: threading its live `ctx.runCtx` — until then the default leaves that path's
 * source identity unset, exactly as when unthreaded).
 */
export function makeDictLiteralNode(forms: readonly SchemeValue[], ctx: RunContext = CONSTANT_CTX): DictLiteralNode {
  const pairs: Array<readonly [DictKey, SchemeValue]> = [];
  for (let i = 0; i + 1 < forms.length; i += 2) {
    const keyDatum = forms[i];
    if ((keyDatum instanceof ASymbol || keyDatum instanceof AString) && staticDictKey(keyDatum) !== null) {
      pairs.push([keyDatum, forms[i + 1]]);
    }
  }
  const node = new ADict(ctx, pairs) as DictLiteralNode;
  node.literalForms = forms;
  return node;
}

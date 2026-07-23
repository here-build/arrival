// scope-scan — find non-top-level lexical bindings (let, lambda params, nested define).
//
// Used by session history to feed the scope-confusion door.
//
// Implemented as a tokenizer walk (same conventions as the REPL splitter) rather than a
// full reader. Over-collection is safe: a spurious "local" flag only affects teaching
// opportunities, never correctness.

import { tokenize } from "@inhuman.tools/arrival/lsp-internals";

interface Tok {
  token: string;
  offset: number;
}

// Same opener/closer/skip rules as the REPL statement splitter. Kept private to avoid
// cross-module coupling; these are stable lexer facts.
const isOpenTok = (tok: string): boolean =>
  tok === "(" || tok === "[" || tok === "{" || (tok.startsWith("#") && !tok.startsWith("#\\") && tok.endsWith("("));
const CLOSE = new Set([")", "]", "}"]);
const isSkip = (tok: string): boolean =>
  /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");

const LET_FORMS = new Set(["let", "let*", "letrec", "letrec*"]);

/** From index `at` (expected to be either the opening paren of a lambda's parameter list, or a
 *  bare symbol for a variadic `(lambda args body...)`), collect every top-level symbol of that
 *  list into `names` — this dialect's lambda params are a flat list, never destructured, so one
 *  pass suffices. */
function collectParamList(tokens: readonly Tok[], at: number, names: Set<string>): void {
  const opener = tokens[at];
  if (!opener) return;
  if (!isOpenTok(opener.token)) {
    names.add(opener.token); // variadic: the single bound name
    return;
  }
  let depth = 1;
  for (let i = at + 1; i < tokens.length && depth > 0; i++) {
    const t = tokens[i]!.token;
    if (isOpenTok(t)) depth++;
    else if (CLOSE.has(t)) depth--;
    else if (depth === 1) names.add(t);
  }
}

/** From index `at` (expected to be the opening paren of a let-family's WHOLE bindings list),
 *  collect the first symbol of each `(name val...)` pair into `names`. */
function collectBindingPairs(tokens: readonly Tok[], at: number, names: Set<string>): void {
  const opener = tokens[at];
  if (!opener || !isOpenTok(opener.token)) return;
  let i = at + 1;
  let depth = 1;
  while (i < tokens.length && depth > 0) {
    const t = tokens[i]!.token;
    if (CLOSE.has(t)) {
      depth--;
      i++;
      continue;
    }
    if (isOpenTok(t)) {
      const nameTok = tokens[i + 1];
      if (nameTok && !isOpenTok(nameTok.token) && !CLOSE.has(nameTok.token)) names.add(nameTok.token);
      let pairDepth = 1;
      i++;
      while (i < tokens.length && pairDepth > 0) {
        const pt = tokens[i]!.token;
        if (isOpenTok(pt)) pairDepth++;
        else if (CLOSE.has(pt)) pairDepth--;
        i++;
      }
      continue;
    }
    i++;
  }
}

/** Scan for identifiers bound in non-top-level scopes.
 *
 *  Returns de-duplicated names (order unspecified). The caller only needs membership. */
export function scanLocalBindings(source: string): string[] {
  const tokens = (tokenize(source, true) as Tok[]).filter((t) => !isSkip(t.token));
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!.token;
    if (isOpenTok(tok)) {
      depth++;
      const head = tokens[i + 1]?.token;
      if (head === "lambda") {
        collectParamList(tokens, i + 2, names);
      } else if (head !== undefined && LET_FORMS.has(head)) {
        let j = i + 2;
        // Named let: `(let loop ((x 5)) ...)` — `loop` is itself a local (recursive) binding.
        const maybeName = tokens[j];
        if (maybeName && !isOpenTok(maybeName.token)) {
          names.add(maybeName.token);
          j++;
        }
        collectBindingPairs(tokens, j, names);
      } else if (head === "define" && depth > 1) {
        const nameTok = tokens[i + 2];
        if (nameTok) {
          if (isOpenTok(nameTok.token)) {
            const fnName = tokens[i + 3];
            if (fnName) names.add(fnName.token);
          } else {
            names.add(nameTok.token);
          }
        }
      }
    } else if (CLOSE.has(tok)) {
      depth = Math.max(0, depth - 1);
    }
  }
  return [...names];
}

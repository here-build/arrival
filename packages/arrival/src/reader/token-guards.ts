// Reader-layer token classification. These predicates answer "what kind of token
// is this string?" against the reader-macro registry (./specials.ts) and the
// numeric/character regexes (./lexical-grammar.ts). They are read concerns —
// the Lexer/Parser/Formatter consult them at read time, before the evaluator ever
// sees a form — so they live in the reader, not in eval/guards.ts (which carries
// the evaluator's AmbientRuntime/Macro world).
import { directives } from "./lexical-grammar.js";
import * as specials from "./specials.js";

export function is_special(token: unknown): boolean {
  return typeof token === "string" && specials.has(token);
}

export function is_vector_literal(token: unknown): token is "#(" {
  return token === "#(";
}

export function is_bytevector_literal(token: unknown): token is "#u8(" {
  return token === "#u8(";
}

export function is_directive(token: unknown): boolean {
  return typeof token === "string" && directives.includes(token);
}

// Reader-layer token classification. These predicates answer "what kind of token
// is this string?" against the reader-macro registry (./specials.ts) and the
// numeric/character regexes (./primitives.ts). They are read concerns —
// the Lexer/Parser/Formatter consult them at read time, before the evaluator ever
// sees a form — so they live in the reader, not in eval/guards.ts (which carries
// the evaluator's AmbientRuntime/Macro world). Moved out of eval/guards.ts.
import { directives } from "./primitives.js";
import * as specials from "./specials.js";

// A registered reader-macro prefix (`'`, `` ` ``, `,`, `,@`, `#(`, `#u8(`).
export function is_special(token: unknown): boolean {
  return typeof token === "string" && specials.names().includes(token);
}

export function is_vector_literal(token: unknown): token is "#(" {
  return token === "#(";
}

export function is_bytevector_literal(token: unknown): token is "#u8(" {
  return token === "#u8(";
}

// A built-in reader-macro prefix (vs a user-registered extension — of which there
// are none; see Parser._read_object).
export function is_builtin(token: unknown): boolean {
  return typeof token === "string" && specials.__builtins__.includes(token);
}

// A reader macro whose expansion wraps a single datum (`'x` → `(quote x)`).
export function is_literal(special: unknown): boolean {
  return typeof special === "string" && specials.type(special) === specials.LITERAL;
}

// A reader macro of SYMBOL type (read-time symbol expansion).
export function is_symbol_extension(special: unknown): boolean {
  return typeof special === "string" && specials.type(special) === specials.SYMBOL;
}

// A reader directive token (`#!fold-case` / `#!no-fold-case`).
export function is_directive(token: unknown): boolean {
  return typeof token === "string" && directives.includes(token);
}

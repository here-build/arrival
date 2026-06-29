// Reader-layer token classification. These predicates answer "what kind of token
// is this string?" against the reader-macro registry (./specials.ts) and the
// numeric/character regexes (../values/primitives.ts). They are read concerns —
// the Lexer/Parser/Formatter consult them at read time, before the evaluator ever
// sees a form — so they live in the reader, not in eval/guards.ts (which carries
// the evaluator's Environment/Macro world). Moved out of eval/guards.ts.
import {
  char_re,
  complex_re,
  directives,
  float_re,
  int_re,
  rational_re,
} from "../values/primitives.js";
import * as specials from "./specials.js";

// A token that is neither a bracket nor a registered reader-macro prefix — i.e. it
// can stand on its own as an atom. Internal helper for `is_symbol_string`.
function is_atom_string(str: string): boolean {
  return !(["(", ")", "[", "]"].includes(str) || specials.names().includes(str));
}

// A token that reads as a plain symbol: an atom that is not a quoted string, a
// number (int/float/complex/rational), a character literal, or one of the bare
// boolean/nil literals.
export function is_symbol_string(str: unknown): str is string {
  if (typeof str !== "string") return false;
  return (
    is_atom_string(str) &&
    !(
      /^"[\s\S]*"$/.test(str) ||
      str.match(int_re) ||
      float_re.test(str) ||
      str.match(complex_re) ||
      str.match(rational_re) ||
      char_re.test(str) ||
      ["#t", "#f", "nil"].includes(str)
    )
  );
}

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

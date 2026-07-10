/**
 * Reader-macro registry: maps a source prefix (`'`, `` ` ``, `,`, `,@`, `#(`, …) to the
 * SchemeSymbol it expands to and an expansion `type`. The lexer consults this table to
 * recognize special syntax at read time, before the evaluator ever sees a form. The
 * table is FIXED — no runtime add/remove reader-macro verb exists.
 */
import { ASymbol } from "../values/primitives/ASymbol.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

/** Prefix expands to a single quoted/wrapped datum (`'x` → `(quote x)`). */
export const LITERAL = Symbol.for("literal");
export const SYMBOL = Symbol.for("symbol");
export function names() {
  return Object.keys(__list__);
}
export function type(name) {
  try {
    return get(name).type;
  } catch {
    // Unknown prefix — not a registered reader macro.
    return null;
  }
}
export function get(name) {
  return __list__[name];
}

const defined_specials = [
  ["'", new ASymbol(CONSTANT_CTX, "quote"), LITERAL],
  ["`", new ASymbol(CONSTANT_CTX, "quasiquote"), LITERAL],
  [",@", new ASymbol(CONSTANT_CTX, "unquote-splicing"), LITERAL],
  [",", new ASymbol(CONSTANT_CTX, "unquote"), LITERAL],
  ["#(", new ASymbol(CONSTANT_CTX, "vector"), LITERAL],
  ["#u8(", new ASymbol(CONSTANT_CTX, "bytevector"), LITERAL],
];

export const __builtins__ = Object.freeze(defined_specials.map((arr) => arr[0]));

// Pure, frozen data literal: maps each [seq, symbol, type] to a { seq, symbol, type }
// entry, built at module-eval (no mutation, no side-effect) before any reader runs.
// `names()` / `get()` / `type()` read it unchanged.
const __list__ = Object.freeze(
  Object.fromEntries(defined_specials.map(([seq, symbol, type]) => [seq, { seq, symbol, type }])),
);

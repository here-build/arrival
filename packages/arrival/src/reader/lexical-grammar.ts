/**
 * Lexical grammar tables the reader matches raw token strings against: the number grammar
 * (integer / rational / complex regexes across radixes, with `#e`/`#i`/`#x`/`#o`/`#b`/`#d`
 * mnemonics), the character-literal grammar, and the fixed constant / directive / hash-literal
 * token lists the Lexer folds into its rule assembly (see `Lexer.rules`). Pure regex + data —
 * no reader state, no side effects.
 */
import { characters } from "../values/primitives/ACharacter.js";
import { theVoid } from "../values/primitives/AVoid.js";
import { nil } from "../values/primitives/ANil.js";

export const pre_num_parse_re = /((?:#[xodbie]){0,2})(.*)/i; // deferred: float complex forms not split here
// functions generate regexes to match number rational, integer, complex, complex+rational
function num_mnemicic_re(mnemonic) {
  return mnemonic ? `(?:#${mnemonic}(?:#[ie])?|#[ie]#${mnemonic})` : "(?:#[ie])?";
}

export function gen_rational_re(mnemonic, range) {
  return `${num_mnemicic_re(mnemonic)}[+-]?${range}+/${range}+`;
}

export function gen_complex_re(mnemonic, range) {
  // [+-]i have (?=..) so it don't match +i from +inf.0
  return `${num_mnemicic_re(mnemonic)}(?:[+-]?(?:${range}+/${range}+|nan.0|inf.0|${range}+))?(?:[+-]i|[+-]?(?:${range}+/${range}+|${range}+|nan.0|inf.0)i)(?=[()[\\]\\s]|$)`;
}

export function gen_integer_re(mnemonic, range) {
  return `${num_mnemicic_re(mnemonic)}[+-]?${range}+`;
}

// deferred: rational/float pair forms ([+-]1/2|float)([+-]1/2|float)
const float_stre = String.raw`(?:[-+]?(?:[0-9]+(?:[eE][-+]?[0-9]+)|(?:\.[0-9]+|[0-9]+\.[0-9]+)(?:[eE][-+]?[0-9]+)?)|[0-9]+\.)`;
export const complex_float_stre = `(?:#[ie])?(?:[+-]?(?:[0-9][0-9_]*/[0-9][0-9_]*|nan.0|inf.0|${float_stre}|[+-]?[0-9]+))?(?:${float_stre}|[+-](?:[0-9]+/[0-9]+|[0-9]+|nan.0|inf.0)?)i`;
export const float_re = new RegExp(`^(#[ie])?${float_stre}$`, "i");
export const glob = Symbol.for("*");
// -------------------------------------------------------------------------
const character_symbols = Object.keys(characters).join("|");
const char_sre_re = `#\\\\(?:x[0-9a-f]+|${character_symbols}|[\\s\\S])`;
export const char_re = new RegExp(`^${char_sre_re}$`, "i"); // regexes with full range but without mnemonics for string->number
// Complex with (int) (float) (rational)
function make_num_stre(fn) {
  const ranges = [
    ["o", "[0-7]"],
    ["x", "[0-9a-fA-F]"],
    ["b", "[01]"],
    ["d", "[0-9]"],
    ["", "[0-9]"],
  ];
  // float exception that don't accept mnemonics
  let result = ranges.map(([m, range]) => fn(m, range)).join("|");
  if (fn === gen_complex_re) {
    result = `${complex_float_stre}|${result}`;
  }
  return result;
}

function make_type_re(fn) {
  return new RegExp(`^(?:${make_num_stre(fn)})$`, "i");
}

export const complex_re = make_type_re(gen_complex_re);
export const rational_re = make_type_re(gen_rational_re);
export const int_re = make_type_re(gen_integer_re);
export const int_bare_re = new RegExp(`^(?:${gen_integer_re("", "[0-9a-f]")})$`, "i");
export const rational_bare_re = new RegExp(`^(?:${gen_rational_re("", "[0-9a-f]")})$`, "i");
export const complex_bare_re = new RegExp(`^(?:${gen_complex_re("", "[0-9a-f]")})$`, "i");
// those constants need to be add as rules to the Lexer to work with vector literals
export const parsable_contants = {
  // `#null` → nil (the empty list — JS null's Rosetta translation; no separate JS-null
  // value leaks into the language). `#void` → the void singleton (the unspecified value).
  // Both are loose-mode tolerances: strict mode (the R7RS portability control) rejects them
  // as non-portable, since stock Scheme has no readable void/null literal.
  "#null": nil,
  "#void": theVoid,
};
export const directives = ["#!fold-case", "#!no-fold-case"];
export const hash_literals = ["#t", "#f"];

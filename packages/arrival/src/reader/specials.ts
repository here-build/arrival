/**
 * Reader-macro registry: maps a source prefix (`'`, `` ` ``, `,`, `,@`, `#(`, …) to the
 * SchemeSymbol it expands to. The lexer consults this table to recognize special syntax at
 * read time, before the evaluator ever sees a form. The table is FIXED — no runtime
 * add/remove reader-macro verb exists — and every entry wraps ONE following datum
 * (`'x` → `(quote x)`).
 */
import { ASymbol } from "../values/primitives/ASymbol.js";

interface Special {
  readonly seq: string;
  readonly symbol: ASymbol;
}

const defined_specials: ReadonlyArray<readonly [string, ASymbol]> = [
  ["'", new ASymbol("quote")],
  ["`", new ASymbol("quasiquote")],
  [",@", new ASymbol("unquote-splicing")],
  [",", new ASymbol("unquote")],
  ["#(", new ASymbol("vector")],
  ["#u8(", new ASymbol("bytevector")],
  // Serializer extras: `#attachment "att-N (mime, size)"` is one datum so it can sit in a
  // `{…}` value slot. Bounded (not a user reader-macro) — same quote-family wrap.
  ["#attachment", new ASymbol("attachment")],
];

// Frozen at module-eval — no runtime mutation; `names()`/`get()` only read it.
const __list__: ReadonlyMap<string, Special> = new Map(defined_specials.map(([seq, symbol]) => [seq, { seq, symbol }]));
const __names__: readonly string[] = Object.freeze([...__list__.keys()]);

export function names(): readonly string[] {
  return __names__;
}
export function has(name: string): boolean {
  return __list__.has(name);
}
export function get(name: string): Special {
  const special = __list__.get(name);
  if (special === undefined) throw new Error(`specials.get: ${name} is not a reader special`);
  return special;
}

// The tokenizer: Lexer-driven string → meta-token lifting (comments arrive as tokens; the
// Parser, not this module, skips them). Depends only on Lexer + eof + AString — cycle-neutral
// (Lexer imports neither this module nor the eval layer). `tokenize` is the one public entry.
import { Lexer } from "./Lexer.js";
import { eof } from "../values/primitives/EOF.js";
import { AString } from "../values/primitives/AString.js";
import invariant from "tiny-invariant";

// The lexer's per-token metadata record — the SHAPE the lexer's meta mode yields, not a
// Scheme value. (`Lexer.peek(true)` returns these; a token is reader-internal, never an
// AValue.) This is the canonical home for the type; Parser imports it from here.
export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

// `Lexer.peek` has no boolean overload, so `peek(true)`'s inferred return is the broad
// `EOF | TokenMeta | string | null` union even though meta mode always yields a TokenMeta.
// Narrow back to the real shape through a guard rather than a blind cast.
function isTokenMeta(value: unknown): value is TokenMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TokenMeta).token === "string" &&
    typeof (value as TokenMeta).col === "number"
  );
}

function tokens(str: string | AString): TokenMeta[] {
  if (str instanceof AString) {
    str = str.valueOf();
  }
  const lexer = new Lexer(str, { whitespace: true });
  const result: TokenMeta[] = [];
  while (true) {
    const token = lexer.peek(true);
    if (token === eof) {
      break;
    }
    invariant(isTokenMeta(token), "tokenize: lexer meta mode yielded a non-TokenMeta token");
    result.push(token);
    lexer.skip();
  }
  return result;
}

/** Lex `str` into the lexer's per-token meta records. The `meta` flag is the legacy
 *  `tokenize(source, true)` call shape (arrival-cli, lsp-internals) — meta mode is the only mode. */
export function tokenize(str: string | AString, _meta: true = true): TokenMeta[] {
  return tokens(str);
}

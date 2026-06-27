// The tokenizer: Lexer-driven string -> token lifting + datum-comment (#;) stripping.
// Lifted out of stdlib.ts (the LIPS monolith) into a reader leaf. It depends only on the
// Lexer + eof + AString, so it sits cycle-neutral below the monolith (Lexer does not import
// stdlib). `tokenize` is the one public entry; `tokens`/`strip_s_comments` are its private
// helpers. stdlib imports `tokenize` back for its single native-lambda literal; the reader's
// own consumers (reader/Formatter, utils/balanced) import it from here directly.
import { Lexer } from "./Lexer.js";
import { eof } from "../values/primitives/EOF.js";
import { AString } from "../values/primitives/AString.js";
import type { SchemeValue } from "../values/types.js";

// ----------------------------------------------------------------------
function tokens(str: SchemeValue): SchemeValue[] {
  if (str instanceof AString) {
    str = str.valueOf();
  }
  const lexer = new Lexer(str, { whitespace: true });
  const result: SchemeValue[] = [];
  while (true) {
    const token = lexer.peek(true);
    if (token === eof) {
      break;
    }
    result.push(token);
    lexer.skip();
  }
  return result;
}

// ----------------------------------------------------------------------
export function tokenize(str: string | AString, meta = false) {
  if (str instanceof AString) {
    str = str.toString();
  }
  if (meta) {
    return tokens(str);
  } else {
    const result = tokens(str)
      .map(function (token) {
        // we don't want literal space character to be trimmed
        if (token.token === String.raw`#\ ` || token.token == "#\\\n") {
          return token.token;
        }
        return token.token.trim();
      })
      .filter(function (token) {
        return token && !token.startsWith(";") && !/^#\|[\s\S]*\|#$/.test(token);
      });
    return strip_s_comments(result);
  }
}

// ----------------------------------------------------------------------
function strip_s_comments(tokens: string[]): string[] {
  let s_count = 0;
  let s_start: number | null = null;
  const remove_list: [number, number][] = [];
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token === "#;") {
      if (["(", "["].includes(tokens[i + 1])) {
        s_count = 1;
        s_start = i;
      } else {
        remove_list.push([i, i + 2]);
      }
      i += 1;
      continue;
    }
    if (s_start !== null) {
      if ([")", "]"].includes(token)) {
        s_count--;
      } else if (["(", "["].includes(token)) {
        s_count++;
      }
      if (s_count === 0) {
        remove_list.push([s_start, i + 1]);
        s_start = null;
      }
    }
  }
  tokens = [...tokens];
  remove_list.reverse();
  for (const [begin, end] of remove_list) {
    tokens.splice(begin, end - begin);
  }
  return tokens;
}

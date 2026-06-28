// Reader entry - collects the Parser's datum stream. Lifted out of stdlib.ts (the LIPS
// monolith we are dissolving) so the reader is a self-contained leaf: exec imports it
// STATICALLY instead of dynamically importing the whole monolith under the vestigial lips
// handle. That dynamic import existed only to dodge an exec<->reader cycle, and that cycle
// existed only because the reader could EVALUATE code at parse time (LIPS user reader-macros)
// - dead code, now removed. With the reader env-free and evaluator-free, parsing no longer
// touches the monolith at all.
import { Parser } from "./Parser.js";
import { eof } from "../values/primitives/EOF.js";
import type { SchemeValue } from "../values/types.js";

// `_parse` is the async datum generator; `parse` collects it into an array. stdlib's
// bootstrap still consumes the generator form for one native-lambda literal.
export async function* _parse(arg: SchemeValue, source?: string, strict = false) {
  let parser;
  if (arg instanceof Parser) {
    parser = arg;
  } else {
    parser = new Parser({ source, strict });
    parser.parse(arg);
  }
  let prev;
  while (true) {
    const expr = await parser.read_object();
    if (!parser.balanced()) {
      parser.ballancing_error(expr, prev);
    }
    if (expr === eof) {
      break;
    }
    prev = expr;
    yield expr;
  }
}

// unwrap the async datum generator into Promise<Array>
export const parse = async (arg: SchemeValue, source?: string, strict = false): Promise<SchemeValue[]> => {
  const result: SchemeValue[] = [];
  for await (const item of _parse(arg, source, strict)) {
    result.push(item);
  }
  return result;
};

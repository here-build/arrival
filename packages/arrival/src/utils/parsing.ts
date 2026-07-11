// Pure token→value parsers for the Scheme numeric tower (exact/inexact, rational, complex, radix
// prefixes), string literals, characters, and symbols. No I/O, no lexer state — given a token string,
// returns the boxed value. Numeric-grammar helpers originate from the LIPS reader.
import invariant from "tiny-invariant";
import { CONSTANT_CTX, type RunContext } from "../values/primitives/RunContext.js";
import { is_int } from "../eval/guards.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { complexDoor } from "../values/numbers.js";
import {
  char_re,
  complex_re,
  float_re,
  int_re,
  parsable_contants,
  pre_num_parse_re,
  rational_re,
} from "../values/primitives.js";
import { ACharacter } from "../values/primitives/ACharacter.js";
import type { SchemeValue } from "../values/types.js";

// Radix-aware bigint parser — the only consumer is the exact/rational/float parsers below.
function parseBigInt(str: string, radix: number = 10): bigint {
  str = str.trim();
  const negative = str.startsWith("-");
  if (negative || str.startsWith("+")) {
    str = str.slice(1);
  }
  let result = 0n;
  const base = BigInt(radix);
  for (const char of str.toLowerCase()) {
    const digit = Number.parseInt(char, radix);
    invariant(!Number.isNaN(digit), `Invalid digit '${char}' for radix ${radix}`);
    result = result * base + BigInt(digit);
  }
  return negative ? -result : result;
}

// ref: https://github.com/bestiejs/punycode.js/blob/master/punycode.js
function ucs2decode(string: string): number[] {
  const output: number[] = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xd8_00 && value <= 0xdb_ff && counter < length) {
      // High surrogate — decode the pair with the next code unit.
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xfc_00) === 0xdc_00) {
        // Low surrogate: combine into one astral codepoint.
        output.push(((value & 0x3_ff) << 10) + (extra & 0x3_ff) + 0x1_00_00);
      } else {
        // Unmatched high surrogate — keep it standalone; back up so the next unit is re-read.
        output.push(value);
        counter--;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

function num_pre_parse(arg: string): {
  radix?: number;
  inexact?: boolean;
  exact?: boolean;
  number?: string;
} {
  const parts = arg.match(pre_num_parse_re);
  const options: {
    radix?: number;
    inexact?: boolean;
    exact?: boolean;
    number?: string;
  } = {};
  if (parts![1]) {
    const type = parts![1].replaceAll("#", "").toLowerCase().split("");
    if (type.includes("x")) {
      options.radix = 16;
    } else if (type.includes("o")) {
      options.radix = 8;
    } else if (type.includes("b")) {
      options.radix = 2;
    } else if (type.includes("d")) {
      options.radix = 10;
    }
    if (type.includes("i")) {
      options.inexact = true;
    }
    if (type.includes("e")) {
      options.exact = true;
    }
  }
  options.number = parts![2];
  return options;
}

// The exported numeric parsers are DUAL-USE (the reader's leaf path AND the live
// `string->number` in env/r7rs/strings.ts) — hence the optional trailing `ctx`: the
// reader passes its parse ctx (source identity for the literal), the runtime caller's
// omission keeps today's CONSTANT_CTX behavior until its own ctx-threading wave lands.
export function parse_rational(arg: string, radix = 10, ctx: RunContext = CONSTANT_CTX): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const parts = parse.number!.split("/");
  const r = parse.radix || radix;
  const num = parseBigInt(parts[0], r);
  const denom = parseBigInt(parts[1], r);
  if (parse.inexact) {
    return new AInexact(ctx, Number(num) / Number(denom));
  }
  return new AExact(ctx, num, denom);
}

export function parse_integer(arg: string, radix = 10, ctx: RunContext = CONSTANT_CTX): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const r = parse.radix || radix;
  if (parse.inexact) {
    return new AInexact(ctx, Number.parseInt(parse.number!, r));
  }
  return new AExact(ctx, parseBigInt(parse.number!, r));
}

function parse_character(arg: string, ctx: RunContext): ACharacter {
  let m = arg.match(/#\\x([0-9a-f]+)$/i);
  let char: string | undefined;
  if (m) {
    const ord = Number.parseInt(m[1], 16);
    char = String.fromCodePoint(ord);
  } else {
    m = arg.match(/#\\([\s\S]+)$/);
    if (m) {
      char = m[1];
    }
  }
  invariant(char !== undefined, `Parse: invalid character in ${arg}`);
  return new ACharacter(ctx, char);
}

function parse_big_int(str: string): {
  exponent: number | undefined;
  mantisa: bigint | undefined;
} {
  const num_match = str.match(/^(([-+]?\d*)(?:\.(\d+))?)e([-+]?\d+)/i);
  let exponent: number | undefined;
  let mantisa: bigint | undefined;
  if (num_match) {
    exponent = Number.parseInt(num_match[4], 10);
    const digits = num_match[1].replace(/[-+]?(\d*)\..+$/, "$1").length;
    const decimal_points = num_match[3]?.length;
    if (digits < Math.abs(exponent)) {
      mantisa = parseBigInt(num_match[1].replace(/\./, ""), 10);
      if (decimal_points) {
        exponent -= decimal_points;
      }
    }
  }
  return { exponent, mantisa };
}

function string_to_float(str: string): number {
  return Number.parseFloat(str);
}

export function parse_float(arg: string, ctx: RunContext = CONSTANT_CTX): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const value = string_to_float(parse.number!);
  const simple_number = (parse.number!.match(/\.0$/) || !/\./.test(parse.number!)) && !/e/i.test(parse.number!);
  if (!parse.inexact) {
    if (parse.exact && simple_number) {
      return new AExact(ctx, BigInt(Math.round(value)));
    }
    // positive big num that eval to int e.g.: 1.2e+20
    if (is_int(value) && Number.isSafeInteger(value) && /e\+?\d/i.test(parse.number!)) {
      return new AExact(ctx, BigInt(Math.round(value)));
    }
    // Calculate big int and big fraction by hand — doesn't fit in a JS float.
    const { mantisa, exponent } = parse_big_int(parse.number!);
    if (mantisa !== undefined && exponent !== undefined) {
      const expAbs = Math.abs(exponent);
      const factorBigInt = 10n ** BigInt(expAbs);
      if (parse.exact && exponent < 0) {
        return new AExact(ctx, mantisa, factorBigInt);
      } else if (exponent > 0 && (parse.exact || !/\./.test(parse.number!))) {
        return new AExact(ctx, mantisa * factorBigInt);
      }
    }
  }
  // Inexact float, but exact was requested — approximate as a rational via its decimal string.
  if (parse.exact) {
    const floatVal = value;
    if (Number.isInteger(floatVal)) {
      return new AExact(ctx, BigInt(Math.round(floatVal)));
    }
    const str = floatVal.toString();
    const decimalIndex = str.indexOf(".");
    if (decimalIndex !== -1) {
      const decimals = str.length - decimalIndex - 1;
      const denom = 10n ** BigInt(decimals);
      const num = BigInt(str.replace(".", "").replace("-", ""));
      const sign = floatVal < 0 ? -1n : 1n;
      return new AExact(ctx, sign * num, denom);
    }
    return new AExact(ctx, BigInt(Math.round(floatVal)));
  }
  return new AInexact(ctx, value);
}

export function parse_complex(_arg: string, _radix = 10): AExact | AInexact {
  // Complex literals are DOORED — arrival is reals-only (R7RS § 6.2.3 permits
  // omitting complex). The reader recognized the complex shape upstream (complex_re);
  // here we reject it with the teaching message instead of building a complex value.
  // Even a zero-imaginary literal (3+0i) is complex-tower notation we don't support —
  // write the real (3). `string->number` catches this and returns #f per R7RS
  // "not a number"; a literal in source surfaces the door.
  return complexDoor();
}

function parse_string(string: string, ctx: RunContext): AString {
  // handle non JSON escapes and skip unicode escape \u (even partial)
  string = string
    .replaceAll(/\\x([0-9a-f]+);/gi, function (_, hex) {
      // Emit the real codepoint as JSON \uXXXX escape(s). For astral codepoints
      // (> U+FFFF) String.fromCodePoint yields a UTF-16 surrogate pair, which we
      // re-emit as two \uXXXX units so JSON.parse reconstructs the true char.
      const codepoint = Number.parseInt(hex, 16);
      const utf16 = String.fromCodePoint(codepoint);
      let out = "";
      for (let i = 0; i < utf16.length; i++) {
        out += String.raw`\u` + utf16.charCodeAt(i).toString(16).padStart(4, "0");
      }
      return out;
    })
    .replaceAll("\n", String.raw`\n`); // in LIPS strings can be multiline
  const m = string.match(/(\\*)(\\x[0-9A-F])/i);
  if (m && m[1].length % 2 === 0) {
    throw new Error(`Invalid string literal, unclosed: ${m[2]}`);
  }
  try {
    const str = new AString(ctx, JSON.parse(string));
    str.freeze();
    return str;
  } catch (error) {
    invariant(
      false,
      `Invalid string literal: ${(error as Error).message.replace(/in JSON /, "").replace(/.*Error: /, "")}`,
    );
  }
}

// R7RS §7.1.1 escape grammar for `|...|` bar-quoted symbols: the five mnemonic escapes,
// a literal bar/backslash, an inline hex escape (`\x<hex>;`, any Unicode scalar — astral
// codepoints round-trip through `String.fromCodePoint`), and the line-continuation escape
// (`\`, intraline whitespace, a line ending, intraline whitespace — folds to nothing).
// Shared with nothing else: `parse_string` decodes JSON-shaped escapes via `JSON.parse`
// (a different delimiter, no `\a`/`\|`), so bar-symbols get their own small decoder rather
// than a forced, awkward reuse.
const BAR_SYMBOL_MNEMONICS: Record<string, string> = {
  a: "",
  b: "\b",
  t: "\t",
  n: "\n",
  r: "\r",
};

const BAR_SYMBOL_ESCAPE_RE = /\\(?:x([0-9a-fA-F]+);|([|\\abtnr])|[ \t]*\r?\n[ \t]*)/g;

// Decodes the content between one `|...|` pair's bars. Escapes are only meaningful inside
// the bars — the plain-text runs a token may adjoin (see `splitBarSegments`) are copied verbatim.
function decodeBarSymbolEscapes(content: string): string {
  // A backslash that doesn't open one of the four recognized escape forms is invalid R7RS
  // syntax — reject it rather than silently passing the stray backslash through.
  const stray = content.match(/\\(?!x[0-9a-fA-F]+;|[|\\abtnr]|[ \t]*\r?\n)/);
  invariant(
    stray === null,
    () =>
      `Parse: invalid escape '\\${content.slice((stray!.index ?? 0) + 1, (stray!.index ?? 0) + 9)}' in |...| symbol literal`,
  );
  return content.replaceAll(BAR_SYMBOL_ESCAPE_RE, (_match, hex?: string, mnemonic?: string) => {
    if (hex !== undefined) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (mnemonic !== undefined) {
      return mnemonic === "|" || mnemonic === "\\" ? mnemonic : BAR_SYMBOL_MNEMONICS[mnemonic];
    }
    // line continuation: intraline whitespace* line-ending intraline whitespace* → nothing
    return "";
  });
}

// Splits a reader token on UNESCAPED `|` boundaries into alternating plain/quoted runs.
// `|foo bar|` is a single quoted run; `abc|d e|fgh` (plain text directly adjoining a bar
// run with no separating whitespace — an existing reader tolerance, see the Lexer's
// `b_symbol_ex` state) is plain+quoted+plain. Inside a quoted run, `\` always escapes
// exactly the following character, so an escaped `\|` can never be mistaken for the close.
function splitBarSegments(token: string): { text: string; quoted: boolean }[] {
  const segments: { text: string; quoted: boolean }[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < token.length; ++i) {
    const char = token[i];
    if (quoted && char === "\\") {
      buf += char + (token[i + 1] ?? "");
      ++i;
      continue;
    }
    if (char === "|") {
      segments.push({ text: buf, quoted });
      buf = "";
      quoted = !quoted;
      continue;
    }
    buf += char;
  }
  invariant(!quoted, `Parse: unterminated |...| symbol literal in ${token}`);
  segments.push({ text: buf, quoted: false });
  return segments;
}

function parse_symbol(arg: string, ctx: RunContext): ASymbol {
  if (!arg.includes("|")) {
    return new ASymbol(ctx, arg);
  }
  const name = splitBarSegments(arg)
    .map((segment) => (segment.quoted ? decodeBarSymbolEscapes(segment.text) : segment.text))
    .join("");
  return new ASymbol(ctx, name);
}

// ── Self-evaluating literal constants ──
// Hoisted to module scope so every `+inf.0` / `-inf.0` / `+nan.0` in source shares ONE instance.
// These MUST stay boxed SchemeInexact, not raw JS numbers: a bare primitive leaks an un-AValue past
// the parser and breaks every downstream consumer that assumes numerics are SchemeExact/SchemeInexact
// (`is_inexact`, the numeric operator wrapping in env/r7rs/numeric.ts, the L2+ provenance algebra).
const nan = new AInexact(CONSTANT_CTX, Number.NaN);
const posInf = new AInexact(CONSTANT_CTX, Number.POSITIVE_INFINITY);
const negInf = new AInexact(CONSTANT_CTX, Number.NEGATIVE_INFINITY);

const constants: Record<string, SchemeValue> = {
  "#t": schemeTrue,
  "#f": schemeFalse,
  "#true": schemeTrue,
  "#false": schemeFalse,
  "+inf.0": posInf,
  "-inf.0": negInf,
  "+nan.0": nan,
  "-nan.0": nan,
  ...parsable_contants,
};

// ── Token → value dispatch ──
// Constants first, then string, then the `#`-prefixed family (char), then the numeric tower;
// anything that falls through is a symbol. Order matters — the cheap `Object.hasOwn` and prefix tests
// gate the expensive numeric regexes.
export function parse_argument(arg: string, strict = false, ctx: RunContext = CONSTANT_CTX): SchemeValue {
  // Strict (the R7RS portability control) rejects the loose-mode `#void`/`#null`
  // reader literals — a program that writes them is not portable to a stock Scheme.
  // The VALUES (void/nil) still exist; only the non-standard readable LITERAL is gated.
  if (strict && (arg === "#void" || arg === "#null")) {
    throw new Error(`reader: \`${arg}' is not portable R7RS — strict mode rejects this loose-mode literal`);
  }
  // Constants stay SHARED singletons (#t/#f/±inf/nan) — deliberately outside the parse-ctx
  // family: per-occurrence identity would break the shared-by-reference-forever design.
  if (Object.hasOwn(constants, arg)) {
    return constants[arg];
  }
  if (/^"[\s\S]*"$/.test(arg)) {
    return parse_string(arg, ctx);
  } else if (arg[0] === "#") {
    if (char_re.test(arg)) {
      return parse_character(arg, ctx);
    }
    // characters with more than one codepoint
    const m = arg.match(/#\\(.+)/);
    if (m && ucs2decode(m[1]).length === 1) {
      return parse_character(arg, ctx);
    }
  }
  if (/[0-9a-f]|[+-]i/i.test(arg)) {
    if (arg.match(int_re)) {
      return parse_integer(arg, 10, ctx);
    } else if (float_re.test(arg)) {
      return parse_float(arg, ctx);
    } else if (arg.match(rational_re)) {
      return parse_rational(arg, 10, ctx);
    } else if (arg.match(complex_re)) {
      return parse_complex(arg);
    }
  }
  invariant(!/^#[iexobd]/.test(arg), `Invalid numeric constant: ${arg}`);
  // SYMBOLS deliberately stay OFF the parse-ctx channel (CONSTANT_CTX, byte-identical
  // interning): ASymbol's flyweight table is keyed BY ctx, so a per-occurrence parse ctx
  // would mint per-occurrence instances — and raw reference identity on interned symbols
  // is load-bearing: memq/assq compare with `===` (env/r7rs/lists.ts), and the specials
  // quote-family table shares instances with parsed source through the CONSTANT_CTX
  // table. Per-occurrence symbol spans are blocked on those `===` sites delegating to
  // `eq()` (structural-equal.ts, the codebase's own name-comparing eq?) — a later wave.
  return parse_symbol(arg, CONSTANT_CTX);
}

// Pure token→value parsers for the Scheme numeric tower (exact/inexact, rational, complex, radix
// prefixes), string literals, characters, and symbols. No I/O, no lexer state — given a token string,
// returns the boxed value. Numeric-grammar helpers originate from the LIPS reader.
import invariant from "tiny-invariant";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { is_int } from "../eval/guards.js";
import { schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact, AInexact, complexDoor } from "../values/numbers.js";
import {
  char_re,
  complex_re,
  float_re,
  int_re,
  parsable_contants,
  pre_num_parse_re,
  rational_re,
  re_re,
} from "../values/primitives.js";
import { ACharacter } from "../values/primitives/ACharacter.js";

// Radix-aware bigint parser. Moved here from the deleted reader/serialize.ts (this is its only
// consumer — the exact/rational/float parsers below). The rest of serialize.ts was a deserializer
// for a compact JSON form nothing ever produced (no serializer existed), so it was dissolved.
export function parseBigInt(str: string, radix: number = 10): bigint {
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

// -------------------------------------------------------------------------
// :: ref: https://github.com/bestiejs/punycode.js/blob/master/punycode.js
// -------------------------------------------------------------------------
export function ucs2decode(string: string): number[] {
  const output: number[] = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xd8_00 && value <= 0xdb_ff && counter < length) {
      // It's a high surrogate, and there is a next character.
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xfc_00) === 0xdc_00) {
        // Low surrogate.
        output.push(((value & 0x3_ff) << 10) + (extra & 0x3_ff) + 0x1_00_00);
      } else {
        // It's an unmatched surrogate; only append this code unit, in case the
        // next code unit is the high surrogate of a surrogate pair.
        output.push(value);
        counter--;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

// -------------------------------------------------------------------------
export function num_pre_parse(arg: string): {
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

// ----------------------------------------------------------------------
export function parse_rational(arg: string, radix = 10): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const parts = parse.number!.split("/");
  const r = parse.radix || radix;
  const num = parseBigInt(parts[0], r);
  const denom = parseBigInt(parts[1], r);
  if (parse.inexact) {
    return new AInexact(CONSTANT_CTX, Number(num) / Number(denom));
  }
  return new AExact(CONSTANT_CTX, num, denom);
}

// ----------------------------------------------------------------------
export function parse_integer(arg: string, radix = 10): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const r = parse.radix || radix;
  if (parse.inexact) {
    return new AInexact(CONSTANT_CTX, Number.parseInt(parse.number!, r));
  }
  return new AExact(CONSTANT_CTX, parseBigInt(parse.number!, r));
}

// ----------------------------------------------------------------------
export function parse_character(arg: string): ACharacter {
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
  return new ACharacter(CONSTANT_CTX, char);
}

// ----------------------------------------------------------------------
export function parse_big_int(str: string): {
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

// ----------------------------------------------------------------------
export function string_to_float(str: string): number {
  return Number.parseFloat(str);
}

// ----------------------------------------------------------------------
export function parse_float(arg: string): AExact | AInexact {
  const parse = num_pre_parse(arg);
  const value = string_to_float(parse.number!);
  const simple_number = (parse.number!.match(/\.0$/) || !/\./.test(parse.number!)) && !/e/i.test(parse.number!);
  if (!parse.inexact) {
    if (parse.exact && simple_number) {
      return new AExact(CONSTANT_CTX, BigInt(Math.round(value)));
    }
    // positive big num that eval to int e.g.: 1.2e+20
    if (is_int(value) && Number.isSafeInteger(value) && /e\+?\d/i.test(parse.number!)) {
      return new AExact(CONSTANT_CTX, BigInt(Math.round(value)));
    }
    // calculate big int and big fraction by hand - it don't fit into JS float
    const { mantisa, exponent } = parse_big_int(parse.number!);
    if (mantisa !== undefined && exponent !== undefined) {
      const expAbs = Math.abs(exponent);
      const factorBigInt = 10n ** BigInt(expAbs);
      if (parse.exact && exponent < 0) {
        return new AExact(CONSTANT_CTX, mantisa, factorBigInt);
      } else if (exponent > 0 && (parse.exact || !/\./.test(parse.number!))) {
        return new AExact(CONSTANT_CTX, mantisa * factorBigInt);
      }
    }
  }
  // For inexact floats, check if exact was requested
  if (parse.exact) {
    // Convert float to rational approximation
    // Use a simple continued fraction approach for reasonable precision
    const floatVal = value;
    if (Number.isInteger(floatVal)) {
      return new AExact(CONSTANT_CTX, BigInt(Math.round(floatVal)));
    }
    // Convert decimal to fraction
    const str = floatVal.toString();
    const decimalIndex = str.indexOf(".");
    if (decimalIndex !== -1) {
      const decimals = str.length - decimalIndex - 1;
      const denom = 10n ** BigInt(decimals);
      const num = BigInt(str.replace(".", "").replace("-", ""));
      const sign = floatVal < 0 ? -1n : 1n;
      return new AExact(CONSTANT_CTX, sign * num, denom);
    }
    return new AExact(CONSTANT_CTX, BigInt(Math.round(floatVal)));
  }
  return new AInexact(CONSTANT_CTX, value);
}

// ----------------------------------------------------------------------
export function parse_complex(_arg: string, _radix = 10): AExact | AInexact {
  // Complex literals are DOORED — arrival is reals-only (R7RS § 6.2.3 permits
  // omitting complex). The reader recognized the complex shape upstream (complex_re);
  // here we reject it with the teaching message instead of building a complex value.
  // Even a zero-imaginary literal (3+0i) is complex-tower notation we don't support —
  // write the real (3). `string->number` catches this and returns #f per R7RS
  // "not a number"; a literal in source surfaces the door.
  return complexDoor();
}

// ----------------------------------------------------------------------
export function parse_string(string: string): AString {
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
    const str = new AString(CONSTANT_CTX, JSON.parse(string));
    str.freeze();
    return str;
  } catch (error) {
    invariant(
      false,
      `Invalid string literal: ${(error as Error).message.replace(/in JSON /, "").replace(/.*Error: /, "")}`,
    );
  }
}

// ----------------------------------------------------------------------
export const parse_symbol = (arg: string): ASymbol =>
  new ASymbol(CONSTANT_CTX,
    /(?:^|.)\|/.test(arg)
      ? arg
          .split("|")
          .filter(Boolean)
          .reduce((acc, str) => {
            let result = "";
            if (/^\\+$/.test(str)) {
              if (str.length > 1) {
                const count = Math.floor(str.length / 2);
                result = "\\".repeat(count);
              }
              if (str.length % 2 !== 0) {
                result += "|";
              }
            } else {
              result = str;
            }
            return acc + result;
          })
          .replaceAll(/\\(x[^;]+);/g, (_, chr) => String.fromCharCode(Number.parseInt(`0${chr}`, 16)))
          .replaceAll(
            /\\([trn])/g,
            (_, chr) =>
              (
                ({
                  t: "\t",
                  r: "\r",
                  n: "\n",
                }) as Record<string, string>
              )[chr],
          )
      : arg,
  );

// ── Self-evaluating literal constants ──
// Hoisted to module scope so every `+inf.0` / `-inf.0` / `+nan.0` in source shares ONE instance.
// These MUST stay boxed SchemeInexact, not raw JS numbers: a bare primitive leaks an un-AValue past
// the parser and breaks every downstream consumer that assumes numerics are SchemeExact/SchemeInexact
// (`is_inexact`, the bridge's wrapOperator, the L2+ provenance algebra).
const nan = new AInexact(CONSTANT_CTX, Number.NaN);
const posInf = new AInexact(CONSTANT_CTX, Number.POSITIVE_INFINITY);
const negInf = new AInexact(CONSTANT_CTX, Number.NEGATIVE_INFINITY);

const constants: Record<string, unknown> = {
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
// Constants first, then string, then the `#`-prefixed family (regex/char), then the numeric tower;
// anything that falls through is a symbol. Order matters — the cheap `Object.hasOwn` and prefix tests
// gate the expensive numeric regexes.
export function parse_argument(arg: string, strict = false): unknown {
  // Strict (the R7RS portability control) rejects the loose-mode `#void`/`#null`
  // reader literals — a program that writes them is not portable to a stock Scheme.
  // The VALUES (void/nil) still exist; only the non-standard readable LITERAL is gated.
  if (strict && (arg === "#void" || arg === "#null")) {
    throw new Error(`reader: \`${arg}' is not portable R7RS — strict mode rejects this loose-mode literal`);
  }
  if (Object.hasOwn(constants, arg)) {
    return constants[arg];
  }
  if (/^"[\s\S]*"$/.test(arg)) {
    return parse_string(arg);
  } else if (arg[0] === "#") {
    const regex = arg.match(re_re);
    if (regex) {
      return new RegExp(regex[1], regex[2]);
    } else if (char_re.test(arg)) {
      return parse_character(arg);
    }
    // characters with more than one codepoint
    const m = arg.match(/#\\(.+)/);
    if (m && ucs2decode(m[1]).length === 1) {
      return parse_character(arg);
    }
  }
  if (/[0-9a-f]|[+-]i/i.test(arg)) {
    if (arg.match(int_re)) {
      return parse_integer(arg);
    } else if (float_re.test(arg)) {
      return parse_float(arg);
    } else if (arg.match(rational_re)) {
      return parse_rational(arg);
    } else if (arg.match(complex_re)) {
      return parse_complex(arg);
    }
  }
  invariant(!/^#[iexobd]/.test(arg), `Invalid numeric constant: ${arg}`);
  return parse_symbol(arg);
}

import { LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * `scheme-sweet` — a StreamLanguage covering BOTH canonical Scheme s-expressions
 * AND our "sweet expression" superset (the readable lens from
 * `@here.build/arrival-chain/sweet`). Forked from the structure of
 * `@codemirror/legacy-modes/mode/scheme` (the radix-number matchers and the
 * string/symbol/block-comment sub-modes are lifted faithfully) and extended with
 * the sweet-only surface: curly-infix `{a + b}`, colon keyword-pairs (`k:` /
 * `:key`), arrow lambdas `=>`, and the glyph operators `== && ||`.
 *
 * It emits ONLY `@lezer/highlight` semantic tags — no colors. Sweet-only token
 * kinds go through the `tokenTable` (the mapping MUST live on the spec passed to
 * `StreamLanguage.define`, or those tokens highlight as nothing).
 */

// ── keyword classification ────────────────────────────────────────────────
// Definition forms get t.definitionKeyword; control forms get t.controlKeyword.
// Everything else that is a known builtin stays a plain variableName (we do not
// over-paint the standard library — only the structural special forms read as
// keywords, matching how the sweet lens treats `define`/`lambda`/`if`).
const set = (str: string): Set<string> => new Set(str.split(/\s+/).filter(Boolean));

const DEFINITION_KEYWORDS = set(`
  define define-values define-syntax define-macro defmacro define-class define-record-type
  lambda λ case-lambda opt-lambda
  let let* letrec letrec-syntax let-syntax let-values let*-values let/ec let/cc
  syntax-rules syntax-case
`);

const CONTROL_KEYWORDS = set(`
  if cond when unless case else
  and or not
  begin do for-each map
  delay force dynamic-wind call/cc call-with-current-continuation
  quote quasiquote unquote unquote-splicing
  set! require import
`);

// ── number matchers (lifted from the legacy scheme mode) ──────────────────
const binaryMatcher =
  /^(?:[-+]i|[-+][01]+#*(?:\/[01]+#*)?i|[-+]?[01]+#*(?:\/[01]+#*)?@[-+]?[01]+#*(?:\/[01]+#*)?|[-+]?[01]+#*(?:\/[01]+#*)?[-+](?:[01]+#*(?:\/[01]+#*)?)?i|[-+]?[01]+#*(?:\/[01]+#*)?)(?=[()\s;"]|$)/i;
const octalMatcher =
  /^(?:[-+]i|[-+][0-7]+#*(?:\/[0-7]+#*)?i|[-+]?[0-7]+#*(?:\/[0-7]+#*)?@[-+]?[0-7]+#*(?:\/[0-7]+#*)?|[-+]?[0-7]+#*(?:\/[0-7]+#*)?[-+](?:[0-7]+#*(?:\/[0-7]+#*)?)?i|[-+]?[0-7]+#*(?:\/[0-7]+#*)?)(?=[()\s;"]|$)/i;
const hexMatcher =
  /^(?:[-+]i|[-+][\da-f]+#*(?:\/[\da-f]+#*)?i|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?@[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?[-+](?:[\da-f]+#*(?:\/[\da-f]+#*)?)?i|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?)(?=[()\s;"]|$)/i;
const decimalMatcher =
  /^(?:[-+]i|[-+](?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)i|[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)@[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)|[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)[-+](?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)?i|(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*))(?=[()\s;"]|$)/i;

// A symbol body — same character class the sweet reader treats as atom chars,
// minus the colon (colon is handled separately so `k:` / `:key` can tokenize).
const SYMBOL_BODY = /[\w\-!$%&*+./<=>?@^~]/;

interface SchemeSweetState {
  mode: false | "string" | "comment";
  // Are we the head (first datum) of a freshly-opened list? Used so that the
  // defined name in `(define foo ...)` can read as t.definition(variableName).
  afterDefineHead: boolean;
}

// Custom token names → resolved through tokenTable below.
const KEY = "sweetKey"; // :key / k: colon-pairs → propertyName
const ARROW = "sweetArrow"; // => → controlOperator
const COMPARE = "sweetCompare"; // == → compareOperator
const LOGIC = "sweetLogic"; // && || → logicOperator
const CURLY = "sweetCurly"; // { } infix braces → brace
const DEFNAME = "sweetDefName"; // defined name → definition(variableName)

const parser: StreamParser<SchemeSweetState> = {
  name: "scheme-sweet",
  startState: () => ({ mode: false, afterDefineHead: false }),

  token(stream, state): string | null {
    // continue multi-line string
    if (state.mode === "string") {
      let escaped = false;
      let next: string | void;
      while ((next = stream.next()) != null) {
        if (next === '"' && !escaped) {
          state.mode = false;
          break;
        }
        escaped = !escaped && next === "\\";
      }
      return "string";
    }
    // continue #| |# block comment
    if (state.mode === "comment") {
      let maybeEnd = false;
      let next: string | void;
      while ((next = stream.next()) != null) {
        if (next === "#" && maybeEnd) {
          state.mode = false;
          break;
        }
        maybeEnd = next === "|";
      }
      return "blockComment";
    }

    if (stream.eatSpace()) return null;

    const ch = stream.next();
    if (ch == null) return null;

    // strings
    if (ch === '"') {
      state.mode = "string";
      // re-enter string mode handling for the rest of this line
      let escaped = false;
      let next: string | void;
      while ((next = stream.next()) != null) {
        if (next === '"' && !escaped) {
          state.mode = false;
          break;
        }
        escaped = !escaped && next === "\\";
      }
      return "string";
    }

    // quote / quasiquote / unquote shorthand → meta
    if (ch === "'" || ch === "`") return "meta";
    if (ch === ",") {
      stream.eat("@");
      return "meta";
    }

    // # forms: block comment, booleans, radix numbers
    if (ch === "#") {
      if (stream.eat("|")) {
        state.mode = "comment";
        return "blockComment";
      }
      if (stream.eat(/[tf]/i)) return "atom"; // #t / #f
      if (stream.eat(/b/i)) {
        if (stream.match(binaryMatcher)) return "number";
      } else if (stream.eat(/o/i)) {
        if (stream.match(octalMatcher)) return "number";
      } else if (stream.eat(/x/i)) {
        if (stream.match(hexMatcher)) return "number";
      } else if (stream.eat(/d/i)) {
        if (stream.match(decimalMatcher)) return "number";
      }
      stream.eatWhile(SYMBOL_BODY);
      return "atom";
    }

    // line comment
    if (ch === ";") {
      stream.skipToEnd();
      return "lineComment";
    }

    // ── sweet curly-infix braces ──
    if (ch === "{" || ch === "}") return CURLY;

    // ── round/square brackets ──
    if (ch === "(" || ch === "[") {
      // Peek the head word to detect `(define NAME …)`-style definitions so the
      // bound name can read as a definition. We do NOT consume it — the head is
      // tokenized on the next pass — we only set a flag if the head is a def form.
      const rest = stream.string.slice(stream.pos);
      const head = /^\s*([\w\-!$%&*+./<=>?@^~λ]+)/.exec(rest)?.[1];
      state.afterDefineHead = head != null && DEFINITION_KEYWORDS.has(head) && /^def/.test(head);
      return ch === "(" ? "paren" : "squareBracket";
    }
    if (ch === ")" || ch === "]") {
      return ch === ")" ? "paren" : "squareBracket";
    }

    // ── leading-colon accessor `:key` ──
    if (ch === ":" && SYMBOL_BODY.test(stream.peek() ?? "")) {
      stream.eatWhile(SYMBOL_BODY);
      return KEY;
    }

    // ── sweet glyph operators (only when they are standalone tokens) ──
    if (ch === "=" && stream.peek() === ">") {
      stream.next();
      return ARROW; // =>
    }
    if (ch === "=" && stream.peek() === "=") {
      stream.next();
      return COMPARE; // ==
    }
    if (ch === "&" && stream.peek() === "&") {
      stream.next();
      return LOGIC; // &&
    }
    if (ch === "|" && stream.peek() === "|") {
      stream.next();
      return LOGIC; // ||
    }

    // ── numbers (non-prefixed decimal) ──
    if (/[-+0-9.]/.test(ch)) {
      stream.backUp(1);
      if (stream.match(decimalMatcher)) return "number";
      stream.next(); // not a number after all; fall through as a symbol char
    }

    // ── symbol / keyword / trailing-colon key ──
    stream.eatWhile(SYMBOL_BODY);
    // trailing-colon keyword pair `k:` — consume the colon and tag as a key.
    if (stream.peek() === ":") {
      stream.next();
      return KEY;
    }
    const word = stream.current();

    if (state.afterDefineHead) {
      // The token right after a definition head is the bound name.
      state.afterDefineHead = false;
      // unless it is itself a keyword (e.g. nested lambda), then keep keyword.
      if (!DEFINITION_KEYWORDS.has(word) && !CONTROL_KEYWORDS.has(word)) return DEFNAME;
    }

    if (DEFINITION_KEYWORDS.has(word)) return "definitionKeyword";
    if (CONTROL_KEYWORDS.has(word)) return "controlKeyword";
    return "variableName";
  },

  languageData: {
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    commentTokens: { line: ";", block: { open: "#|", close: "|#" } },
  },

  // CRITICAL: every custom token name returned above must resolve here, or it
  // highlights as nothing. The non-custom names ("string", "number", "paren",
  // "variableName", …) resolve through CodeMirror's built-in legacy-mode tag map.
  tokenTable: {
    [KEY]: t.propertyName,
    [ARROW]: t.controlOperator,
    [COMPARE]: t.compareOperator,
    [LOGIC]: t.logicOperator,
    [CURLY]: t.brace,
    [DEFNAME]: t.definition(t.variableName),
  },
};

/** `LanguageSupport` for `.scm` (classic + sweet). Tags only — no theme. */
export function schemeSweet(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

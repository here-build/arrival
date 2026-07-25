import { LanguageSupport, StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * StreamLanguage for classic Scheme + sugarcoat superset (readable lens).
 *
 * Covers s-exprs + curly-infix, `k:` / `:key`, `=>`, `== && ||`.
 * Radix/string/comment handling lifted from the CodeMirror scheme mode.
 *
 * Emits ONLY tags (bring your own theme). Every custom token in tokenTable
 * or it renders as nothing — this is the contract with StreamLanguage.
 */

// ── keyword classification ────────────────────────────────────────────────
// Definition forms get t.definitionKeyword; control forms get t.controlKeyword.
// Everything else that is a known builtin stays a plain variableName (we do not
// over-paint the standard library — only the structural special forms read as
// keywords, matching how the sugarcoat lens treats `define`/`lambda`/`if`).
const set = (str: string): Set<string> => new Set(str.split(/\s+/).filter(Boolean));

export const DEFINITION_KEYWORDS = set(`
  define define-values define-syntax define-macro defmacro define-class define-record-type
  define/overridable
  lambda λ case-lambda opt-lambda
  let let* letrec letrec-syntax let-syntax let-values let*-values let/ec let/cc
  syntax-rules syntax-case
`);

export const CONTROL_KEYWORDS = set(`
  if cond when unless case else
  and or not
  begin do for-each map
  delay force dynamic-wind call/cc call-with-current-continuation
  quote quasiquote unquote unquote-splicing
  set! require import
`);

// ── number matchers (lifted from the CodeMirror scheme mode) ──────────────────
const binaryMatcher =
  /^(?:[-+]i|[-+][01]+#*(?:\/[01]+#*)?i|[-+]?[01]+#*(?:\/[01]+#*)?@[-+]?[01]+#*(?:\/[01]+#*)?|[-+]?[01]+#*(?:\/[01]+#*)?[-+](?:[01]+#*(?:\/[01]+#*)?)?i|[-+]?[01]+#*(?:\/[01]+#*)?)(?=[()\s;"]|$)/i;
const octalMatcher =
  /^(?:[-+]i|[-+][0-7]+#*(?:\/[0-7]+#*)?i|[-+]?[0-7]+#*(?:\/[0-7]+#*)?@[-+]?[0-7]+#*(?:\/[0-7]+#*)?|[-+]?[0-7]+#*(?:\/[0-7]+#*)?[-+](?:[0-7]+#*(?:\/[0-7]+#*)?)?i|[-+]?[0-7]+#*(?:\/[0-7]+#*)?)(?=[()\s;"]|$)/i;
const hexMatcher =
  /^(?:[-+]i|[-+][\da-f]+#*(?:\/[\da-f]+#*)?i|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?@[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?[-+](?:[\da-f]+#*(?:\/[\da-f]+#*)?)?i|[-+]?[\da-f]+#*(?:\/[\da-f]+#*)?)(?=[()\s;"]|$)/i;
const decimalMatcher =
  /^(?:[-+]i|[-+](?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)i|[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)@[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)|[-+]?(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)[-+](?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*)?i|(?:(?:(?:\d+#+\.?#*|\d+\.\d*#*|\.\d+#*|\d+)(?:[esfdl][-+]?\d+)?)|\d+#*\/\d+#*))(?=[()\s;"]|$)/i;

// A symbol body — same character class the sugarcoat reader treats as atom chars,
// minus the colon (colon is handled separately so `k:` / `:key` can tokenize).
const SYMBOL_BODY = /[\w\-!$%&*+./<=>?@^~]/;

interface SchemeSugarcoatState {
  mode: false | "string" | "comment" | "attext";
  afterDefineHead: boolean; // next atom after `(define ...` → DEFNAME
  atDepth: number;          // literal {} depth inside @head{...} (0 closes)
}

// @head{ opener (mirrors arrival-sugarcoat AT_HEAD) + balanced literal {} inside body.
const AT_OPENER = /^[^\s{}()[\]"@]*\{/;
const AT_INTERP = /[A-Za-z0-9!$%&*/:<=>?^_~+-]/;

/** @text body tokenizer. atDepth tracks literal braces (close only at 0).
 *  Returns null at EOL for multi-line @dedent bodies. Bare @ (no {) falls
 *  through to symbols. */
function tokenizeAtText(stream: StringStream, state: SchemeSugarcoatState): string | null {
  const c = stream.peek();
  if (c == null) return null; // end of line — stay in attext (multi-line body)
  if (c === "}") {
    stream.next();
    if (state.atDepth === 0) {
      state.mode = false;
      return CURLY; // body close
    }
    state.atDepth--;
    return "string"; // literal closing brace
  }
  if (c === "{") {
    stream.next();
    state.atDepth++;
    return "string"; // literal opening brace
  }
  if (c === "@") {
    stream.next(); // consume `@`
    const n = stream.peek();
    if (n === "(") {
      // graft — consume the balanced `(…)` on this line (string-aware so a
      // quoted `)` inside the graft doesn't close early).
      let depth = 0;
      let inStr = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (inStr) {
          if (ch === "\\") stream.next();
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) break;
      }
      return INTERP;
    }
    if (n === "|") {
      stream.next(); // opening `|`
      stream.eatWhile((x: string) => x !== "|");
      stream.eat("|"); // closing `|`
      return INTERP;
    }
    stream.eatWhile(AT_INTERP); // bare `@id` (or a nested `@head` — its `{` bumps atDepth)
    // Tight `@id[…][…]` subscript chain — part of the same interpolation
    // (mirrors sugarcoat-read's bare-interp + trailing subscripts). Spaced
    // `@id […]` leaves the brackets as prose.
    while (stream.peek() === "[") {
      let depth = 0;
      let inStr = false;
      let ch: string | void;
      while ((ch = stream.next()) != null) {
        if (inStr) {
          if (ch === "\\") stream.next();
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "[") depth++;
        else if (ch === "]" && --depth === 0) break;
      }
    }
    return INTERP;
  }
  stream.eatWhile((x: string) => x !== "@" && x !== "{" && x !== "}"); // prose run
  return "string";
}

// Custom token names → resolved through tokenTable below.
const KEY = "sugarcoatKey"; // :key / k: colon-pairs → propertyName
const ARROW = "sugarcoatArrow"; // => → controlOperator
const COMPARE = "sugarcoatCompare"; // == → compareOperator
const LOGIC = "sugarcoatLogic"; // && || → logicOperator
const CURLY = "sugarcoatCurly"; // { } infix braces → brace
const DEFNAME = "sugarcoatDefName"; // defined name → definition(variableName)
const ATOPEN = "sugarcoatAtOpen"; // @head{ opener → keyword (the tagged-template head)
const INTERP = "sugarcoatInterp"; // @id / @(…) / @|…| inside a text body → variableName pop

export const parser: StreamParser<SchemeSugarcoatState> = {
  name: "scheme-sugarcoat",
  startState: () => ({ mode: false, afterDefineHead: false, atDepth: 0 }),

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
    // continue an `@…{…}` text body (possibly multi-line)
    if (state.mode === "attext") return tokenizeAtText(stream, state);

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
      // NB: `stream.match(re)` CONSUMES the matched run — `re.test(...)` is not
      // equivalent (unicorn/prefer-regexp-test autofix breaks this; rule off in
      // eslint.config.mjs for this file).
      if (stream.eat(/b/i)) {
        if (stream.match(binaryMatcher)) return "number";
      } else if (stream.eat(/o/i)) {
        if (stream.match(octalMatcher)) return "number";
      } else if (stream.eat(/x/i)) {
        if (stream.match(hexMatcher)) return "number";
      } else if (stream.eat(/d/i) && stream.match(decimalMatcher)) return "number";
      stream.eatWhile(SYMBOL_BODY);
      return "atom";
    }

    // line comment
    if (ch === ";") {
      stream.skipToEnd();
      return "lineComment";
    }

    // ── sugarcoat curly-infix braces ──
    if (ch === "{" || ch === "}") return CURLY;

    // ── round/square brackets ──
    if (ch === "(" || ch === "[") {
      // Peek the head word to detect `(define NAME …)`-style definitions so the
      // bound name can read as a definition. We do NOT consume it — the head is
      // tokenized on the next pass — we only set a flag if the head is a def form.
      const rest = stream.string.slice(stream.pos);
      const head = /^\s*([\w\-!$%&*+./<=>?@^~λ]+)/.exec(rest)?.[1];
      state.afterDefineHead = head != null && DEFINITION_KEYWORDS.has(head) && head.startsWith("def");
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

    // ── sugarcoat glyph operators (only when they are standalone tokens) ──
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

    // ── at-expression opener `@head{` / `@{` ── enter the text-body sub-mode. A bare
    // `@` / `@foo` (no following `{`) is NOT one — it falls through to symbol handling
    // (the accessor `@` / an `@`-symbol stay variableName).
    if (ch === "@" && AT_OPENER.test(stream.string.slice(stream.pos))) {
      stream.match(AT_OPENER); // consume head + `{`
      state.mode = "attext";
      state.atDepth = 0;
      return ATOPEN;
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

  // CRITICAL: custom tokens (KEY/ARROW/...) must map here or they are invisible.
  // Non-customs go through CM's built-in tag map.
  tokenTable: {
    [KEY]: t.propertyName,
    [ARROW]: t.controlOperator,
    [COMPARE]: t.compareOperator,
    [LOGIC]: t.logicOperator,
    [CURLY]: t.brace,
    [DEFNAME]: t.definition(t.variableName),
    [ATOPEN]: t.keyword, // @head{ — the tagged-template head reads as a keyword
    [INTERP]: t.variableName, // @id / @(…) / @|…| — interpolation pops against the prose
  },
};

/** `LanguageSupport` for `.scm` (classic + sugarcoat). Tags only — no theme. */
export function schemeSugarcoat(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

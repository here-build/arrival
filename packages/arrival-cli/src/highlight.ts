/**
 * Terminal syntax highlighting for Scheme / sugarcoat INPUT and settled source — the fuller
 * sibling of `sexpr-color.ts` (which is deliberately parens-only-subtle for VALUE output).
 * Here we colour code: definition forms, control forms, strings, comments, keywords,
 * booleans. Same discipline as the codemirror eject — the tokenizer emits colour, the
 * terminal is the theme; no `@codemirror/language` runtime is dragged in.
 *
 * Same hard invariant as the value colorizer: colour adds ONLY escapes, never a byte.
 * `stripAnsi(highlightScheme(s)) === s` for every input; `mode "none"` is exact identity.
 * The tokenizer preserves every character (whitespace, unterminated strings, partial input
 * mid-keystroke) and only wraps whole tokens.
 */
import { paint, type TintName } from "./tints.js";
import { colorMode } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

// Keyword classification — copied from arrival-codemirror's `scheme-sugarcoat.ts`
// (DEFINITION_KEYWORDS / CONTROL_KEYWORDS), the source of truth. Duplicated (not imported)
// because that module pulls the CodeMirror runtime; these sets are small and stable, and a
// terminal has no lezer highlighter to read from. If they drift, re-sync from there.
const DEFINITION_KEYWORDS = new Set(
  `define define-values define-syntax define-macro defmacro define-class define-record-type
   define/overridable lambda λ case-lambda opt-lambda
   let let* letrec letrec-syntax let-syntax let-values let*-values let/ec let/cc
   syntax-rules syntax-case`
    .split(/\s+/)
    .filter(Boolean),
);
const CONTROL_KEYWORDS = new Set(
  `if cond when unless case else and or not begin do for-each map
   delay force dynamic-wind call/cc call-with-current-continuation
   quote quasiquote unquote unquote-splicing set! require import`
    .split(/\s+/)
    .filter(Boolean),
);

const DELIM = new Set(["(", ")", "[", "]", "{", "}"]);

/** Classify an atom (a maximal run of non-delimiter, non-space chars) → its tint, or `null`
 *  to leave it the terminal's own foreground (plain symbols, numbers — kept quiet). */
function atomTint(atom: string): TintName | null {
  if (DEFINITION_KEYWORDS.has(atom)) return "variant";
  if (CONTROL_KEYWORDS.has(atom)) return "accent";
  if (atom === "#t" || atom === "#f" || atom === "#true" || atom === "#false") return "accent";
  if (atom.length > 1 && atom.startsWith(":")) return "accent"; // :keyword
  return null;
}

function tint(text: string, name: TintName, mode: ColorMode): string {
  return mode === "none" ? text : paint(text, name, mode);
}

/** Highlight Scheme/sugarcoat source. `mode` defaults to the live terminal capability;
 *  `"none"` is exact identity. */
export function highlightScheme(src: string, mode: ColorMode = colorMode()): string {
  if (mode === "none") return src;
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += tint(src.slice(i, j), "done", mode);
      i = j;
      continue;
    }

    if (ch === "#" && src[i + 1] === "|") {
      const end = src.indexOf("|#", i + 2);
      const j = end === -1 ? n : end + 2;
      out += tint(src.slice(i, j), "gutter", mode);
      i = j;
      continue;
    }

    if (ch === ";") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += tint(src.slice(i, j), "gutter", mode);
      i = j;
      continue;
    }

    if (DELIM.has(ch)) {
      out += tint(ch, "gutter", mode);
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i += 1;
      continue;
    }

    let j = i;
    while (j < n) {
      const c = src[j]!;
      if (DELIM.has(c) || c === '"' || c === ";" || c === " " || c === "\t" || c === "\n" || c === "\r") break;
      j += 1;
    }
    const atom = src.slice(i, j);
    const name = atomTint(atom);
    out += name === null ? atom : tint(atom, name, mode);
    i = j;
  }
  return out;
}

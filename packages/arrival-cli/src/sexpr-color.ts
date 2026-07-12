/**
 * Type-aware ANSI coloring of serializer s-expr output — the "human looking at a TTY" view
 * of a value. A darcula-style palette dispatched on the LEAF TYPE, so a value reads by type
 * at a glance: strings & chars green, numbers blue, `:keywords` / booleans / `nil` the
 * constant purple, symbols the terminal's own foreground, delimiters dim. (Structure itself
 * is the sugarcoat lens's job — it already renders dicts as `key:` and breaks big forms; this
 * only paints the tokens.)
 *
 * The one hard invariant: coloring adds ONLY escape sequences, never a character of text.
 * `stripAnsi(colorizeSexpr(s)) === s` for every input, and `colorizeSexpr(s, "none") === s`
 * exactly. The tokenizer preserves every byte (whitespace included) and only wraps whole
 * tokens — never reflows, trims, or normalizes. Safe over the serializer's extras
 * (`#| … |#` truncation markers, `#attachment` tags): an unrecognized run is just a symbol,
 * passed through in the default foreground.
 */
import { paint, type TintName } from "./tints.js";
import { colorMode } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

const DELIM = new Set(["(", ")", "[", "]", "{", "}"]);

/** A number literal — decimal, signed, rational (`1/2`), or radix-prefixed (`#xff`). */
function isNumber(atom: string): boolean {
  return /^[+-]?(\d|\.\d|#[xbodei])/i.test(atom);
}

/** The darcula tint for a leaf atom, or `null` to leave it in the default foreground (a
 *  symbol / anything unrecognized). */
function atomTint(atom: string): TintName | null {
  if (atom.length > 1 && atom.startsWith(":")) return "variant"; // :keyword → purple constant
  if (atom === "#t" || atom === "#f" || atom === "#true" || atom === "#false" || atom === "nil") return "variant";
  if (atom.startsWith("#\\")) return "done"; // char literal → green (like a string)
  if (isNumber(atom)) return "accent"; // number → blue
  return null; // symbol → terminal foreground
}

/** Emit `text` in `tint` unless the mode is `none` (then raw). */
function tint(text: string, name: TintName, mode: ColorMode): string {
  return mode === "none" ? text : paint(text, name, mode);
}

/**
 * Color a serializer s-expr string by leaf type. `mode` defaults to the live terminal's
 * capability; pass `"none"` for a guaranteed-identity pass. The POLICY of whether to color
 * lives in `output-mode.ts` — this only renders once that's decided yes.
 */
export function colorizeSexpr(src: string, mode: ColorMode = colorMode()): string {
  if (mode === "none") return src;
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    // String literal — consume through the closing quote, honoring `\` escapes. An
    // unterminated string (truncated output) runs to end-of-input, still round-trips.
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
      out += tint(src.slice(i, j), "done", mode); // string → green
      i = j;
      continue;
    }

    // Block comment `#| … |#` — the serializer's truncation marker.
    if (ch === "#" && src[i + 1] === "|") {
      const end = src.indexOf("|#", i + 2);
      const j = end === -1 ? n : end + 2;
      out += tint(src.slice(i, j), "gutter", mode);
      i = j;
      continue;
    }

    // Line comment `; …` to end of line.
    if (ch === ";") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      out += tint(src.slice(i, j), "gutter", mode);
      i = j;
      continue;
    }

    // Delimiter — one dim character (structure recedes).
    if (DELIM.has(ch)) {
      out += tint(ch, "gutter", mode);
      i += 1;
      continue;
    }

    // Whitespace — passed through verbatim.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i += 1;
      continue;
    }

    // Atom — a run up to the next delimiter / whitespace / string / comment start. `#\ ` (a
    // space char literal) is kept whole so it isn't split on its own space.
    let j = i;
    if (ch === "#" && src[i + 1] === "\\") j = i + 3; // #\<one char>, incl. #\space
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

/**
 * Subtle ANSI coloring of serializer s-expr output — the "human looking at a TTY" view
 * of a run's value. SUBTLE by design (CLAUDE.md's scrub-widget bar): structure recedes,
 * content stays. Only the scaffolding is tinted — parens dim into the background, strings
 * and `:keywords` get a soft hue — so the eye reads the SHAPE first and the value second.
 * No rainbow, no per-nesting-depth carnival: one dim for delimiters, two soft hues for
 * the two leaf classes that most help scanning.
 *
 * The one hard invariant: coloring adds ONLY escape sequences, never a character of text.
 * `stripAnsi(colorizeSexpr(s)) === s` for every input, and `colorizeSexpr(s, "none") === s`
 * exactly. The tokenizer therefore preserves every byte (whitespace included) and only
 * wraps whole tokens — it never reflows, trims, or normalizes. That makes it safe over the
 * serializer's own extras (`#| … |#` truncation markers, `#attachment` tags): an
 * unrecognized run is just an atom, passed through untouched but for its own tint.
 */
import { paint, type TintName } from "./tints.js";
import { colorMode } from "./tints.js";

type ColorMode = ReturnType<typeof colorMode>;

/** Delimiter, comment, string, keyword — everything else renders in the terminal's own
 *  foreground (numbers, symbols, booleans: default, so the palette stays quiet). */
const DELIM = new Set(["(", ")", "[", "]", "{", "}"]);

function isKeyword(atom: string): boolean {
  // `:verdict`, `:x` — the accessor/keyword head. A bare `:` is not one.
  return atom.length > 1 && atom.startsWith(":");
}

/** Emit `text` in `tint` unless the mode is `none` (then raw). */
function tint(text: string, name: TintName, mode: ColorMode): string {
  return mode === "none" ? text : paint(text, name, mode);
}

/**
 * Color a serializer s-expr string. `mode` defaults to the live terminal's capability
 * (truecolor / 256 / none from `colorMode`); pass `"none"` for a guaranteed-identity
 * pass. The POLICY of whether to color at all lives in `output-mode.ts` — this only
 * renders once that's decided yes.
 */
export function colorizeSexpr(src: string, mode: ColorMode = colorMode()): string {
  if (mode === "none") return src;
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    // String literal — consume through the closing quote, honoring `\` escapes so an
    // escaped quote doesn't end it early. An unterminated string (truncated output) runs
    // to end-of-input, still round-trips.
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

    // Block comment `#| … |#` — the serializer's truncation marker. Nesting-agnostic:
    // consume to the first `|#`, which is what the serializer emits.
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

    // Delimiter — one dim character.
    if (DELIM.has(ch)) {
      out += tint(ch, "gutter", mode);
      i += 1;
      continue;
    }

    // Whitespace — passed through verbatim (never tinted; keeps the diff minimal).
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out += ch;
      i += 1;
      continue;
    }

    // Atom — a run up to the next delimiter / whitespace / string / comment start.
    let j = i;
    while (j < n) {
      const c = src[j]!;
      if (DELIM.has(c) || c === '"' || c === ";" || c === " " || c === "\t" || c === "\n" || c === "\r") break;
      j += 1;
    }
    const atom = src.slice(i, j);
    out += isKeyword(atom) ? tint(atom, "accent", mode) : atom;
    i = j;
  }
  return out;
}

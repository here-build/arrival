/**
 * The tint palette (D4): derived from Delta's OKLCH emphasis scale
 * (`second-foundation/delta-css/src/factors-properties.css` — the `--⚙️hue-emphasis-*`
 * custom properties), NOT a standalone terminal palette invented ad hoc. Delta is the
 * studio's internal design system (CLAUDE.md's Delta⊥Mercury boundary), and this is an
 * internal-tooling consumer of it — the recipe (hue in degrees, a lightness/chroma
 * pair per Delta's own tiering) is copied here as plain numbers because Delta ships
 * CSS custom properties, not a JS palette export; a terminal has no CSS cascade to
 * evaluate them in. If Delta ever exports its emphasis scale as data, this table
 * should read from it instead of duplicating the constants.
 *
 * Projection: OKLCH → linear sRGB → gamma-encoded sRGB (Björn Ottosson's OKLab matrices,
 * https://bottosson.github.io/posts/oklab/) → truecolor ANSI, with a nearest-xterm-256
 * fallback (ansi.ts) for terminals that don't advertise `COLORTERM`.
 */
import { Chalk, type ChalkInstance } from "chalk";

import { RESET } from "./ansi.js";

/** Delta's own hue degrees (factors-properties.css `--⚙️hue-emphasis-*` defaults) —
 *  copied, not invented: accent=211 (Apple's cognitive blue), success=142, danger=35,
 *  variant=285 (purple, "specialized contexts" — the wordmark's gradient far end); a
 *  neutral gray has no hue (chroma 0, hue irrelevant). */
const HUE = {
  accent: 211,
  success: 142,
  danger: 35,
  variant: 285,
} as const;

/** Delta's chroma tiers (factors.css §"CHROMA TIERS"): primary (accent/warning/danger)
 *  pulls focus, tertiary (success/info) stays ambient/low-urgency. Neutral pending/
 *  skipped blocks get chroma 0 — Delta's own `Δemphasis-unset` posture. */
const CHROMA = { primary: 0.15, tertiary: 0.08, neutral: 0 } as const;

/** Delta's `oklch(0.6 …)` mid-lightness (application.css) for saturated foreground
 *  text on a dark terminal background; dim/neutral text sits lower for the
 *  desaturated-card read (§5's "pending: dim gray"). */
const LIGHTNESS = { normal: 0.72, dim: 0.5 } as const;

function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  const rl = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gl = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  const gamma = (c1: number): number => (c1 <= 0.0031308 ? 12.92 * c1 : 1.055 * Math.max(c1, 0) ** (1 / 2.4) - 0.055);
  const clamp255 = (c1: number): number => Math.max(0, Math.min(255, Math.round(gamma(c1) * 255)));
  return [clamp255(rl), clamp255(gl), clamp255(bl)];
}

export type TintName = "pending" | "running" | "done" | "error" | "skipped" | "accent" | "gutter" | "variant";

/** One entry per tint (§5's vocabulary table, terminal column). `[L, C, H]` — `H`
 *  unused when `C` is 0 (neutral gray, spec-honest: OKLCH hue is undefined at zero
 *  chroma). */
const TINT_LCH: Record<TintName, readonly [number, number, number]> = {
  pending: [LIGHTNESS.dim, CHROMA.neutral, 0],
  running: [LIGHTNESS.normal, CHROMA.primary, HUE.accent],
  done: [LIGHTNESS.normal, CHROMA.tertiary, HUE.success],
  error: [LIGHTNESS.normal, CHROMA.primary, HUE.danger],
  skipped: [LIGHTNESS.dim, CHROMA.neutral, 0],
  accent: [LIGHTNESS.normal, CHROMA.primary, HUE.accent],
  gutter: [LIGHTNESS.dim, CHROMA.neutral, 0],
  // The wordmark's gradient far end (purple, "specialized contexts") — reused by the
  // syntax highlighter for definition forms (define/lambda/let), distinct from control's
  // accent blue.
  variant: [LIGHTNESS.normal, CHROMA.tertiary, HUE.variant],
};

/** Truecolor iff the terminal says so (`COLORTERM=truecolor|24bit`) and colors are
 *  wanted at all (`NO_COLOR` unset — https://no-color.org). Otherwise the nearest-256
 *  fallback (D4) — never a bare, un-tinted terminal as long as ANY color support
 *  exists. `force` lets tests/tape-recording pin a mode regardless of the host TTY. */
export function colorMode(env: NodeJS.ProcessEnv = process.env, force?: "truecolor" | "256" | "none"): "truecolor" | "256" | "none" {
  if (force !== undefined) return force;
  if (env.NO_COLOR !== undefined) return "none";
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  return "256";
}

/** One chalk instance per capability rung — chalk owns the escape emission and the
 *  truecolor→256→16 DOWNSAMPLE (a `.rgb()` at level 2 renders the nearest xterm-256), so
 *  this file no longer hand-rolls SGR. `level: 0` short-circuits to the raw text. The OKLCH
 *  → sRGB projection (Delta's perceptual hues, chalk has no OKLCH) stays ours. */
const CHALK: Record<"truecolor" | "256" | "none", ChalkInstance> = {
  none: new Chalk({ level: 0 }),
  "256": new Chalk({ level: 2 }),
  truecolor: new Chalk({ level: 3 }),
};

/** Render `text` through `tint`, honoring `mode` (defaults to the live terminal's). */
export function paint(text: string, tint: TintName, mode: ReturnType<typeof colorMode> = colorMode()): string {
  if (mode === "none") return text;
  const [l, c, h] = TINT_LCH[tint];
  const [r, g, b] = oklchToSrgb(l, c, h);
  return CHALK[mode].rgb(r, g, b)(text);
}

/**
 * The repo's compensated-Darcula TOKEN palette — copied from
 * `second-foundation/editor-theme/theme-darcula.ts` (the source of truth; re-sync if it
 * changes). Used by BOTH the code highlighter (`highlight.ts`) and the value colorizer
 * (`sexpr-color.ts`) so the input line, the settled-block source, and the output value all
 * share ONE palette — a `:keyword` is the same purple everywhere, a number the same blue.
 * (The semantic STATE tints above — the ✓/▸/✗ glyph, the dim gutter — are a separate axis.)
 */
export const DARCULA = {
  keyword: "#bb6b25", // define/lambda/if/cond/… — one orange for all structural keywords
  symbol: "#a9b5c1", // plain identifiers (variableName/name)
  string: "#728e60", // strings + char literals
  number: "#5b89ad", // numbers
  constant: "#5b89ad", // #t/#f/nil — darcula colors these as numbers (blue)
  property: "#9673a7", // :keyword / propertyName
  comment: "#717171",
  delimiter: "#717171", // parens/brackets/braces
  heading: "#b4b4b4", // markdown heading/strong (bold)
} as const;

/** Paint `text` a specific hex — chalk downsamples per the mode's rung; `none` → raw. */
export function paintHex(text: string, hex: string, mode: ReturnType<typeof colorMode> = colorMode()): string {
  return mode === "none" ? text : CHALK[mode].hex(hex)(text);
}

/** Raw RGB for a tint — exposed for the wordmark's gradient (interpolates hue/lightness
 *  itself, then reuses this projection so both consumers agree on the math). */
export function tintRgb(l: number, c: number, hDeg: number): [number, number, number] {
  return oklchToSrgb(l, c, hDeg);
}

export { HUE, CHROMA, LIGHTNESS, RESET };

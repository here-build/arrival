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
import { fg256, fgTruecolor, RESET, wrap } from "./ansi.js";

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

export type TintName = "pending" | "running" | "done" | "error" | "skipped" | "accent" | "gutter";

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

/** Render `text` through `tint`, honoring `mode` (defaults to the live terminal's). */
export function paint(text: string, tint: TintName, mode: ReturnType<typeof colorMode> = colorMode()): string {
  if (mode === "none") return text;
  const [l, c, h] = TINT_LCH[tint];
  const [r, g, b] = oklchToSrgb(l, c, h);
  const open = mode === "truecolor" ? fgTruecolor(r, g, b) : fg256(r, g, b);
  return wrap(open, text);
}

/** Raw RGB for a tint — exposed for the wordmark's gradient (interpolates hue/lightness
 *  itself, then reuses this projection so both consumers agree on the math). */
export function tintRgb(l: number, c: number, hDeg: number): [number, number, number] {
  return oklchToSrgb(l, c, hDeg);
}

export { HUE, CHROMA, LIGHTNESS, RESET };

/**
 * The painter's ENTIRE ANSI vocabulary (D2 — hand-rolled, no ink, no flexbox need: the
 * render surface is blocks + tints + a gutter, not a widget tree). Every function here
 * emits raw escape sequences; nothing else in the painter touches `\x1b` directly, so
 * this file is the one place a terminal-compat fix ever lands.
 *
 * SGR ground rules: every open code is paired with an explicit `RESET` at the string's
 * end (never rely on the next paint to clean up) — cheap insurance against a truncated
 * write leaving the user's terminal stuck bold/colored.
 */

const ESC = "\x1b[";
export const RESET = `${ESC}0m`;

const SGR = {
  bold: "1",
  dim: "2",
  italic: "3",
} as const;

export type Sgr = keyof typeof SGR;

/** Truecolor (24-bit) foreground — used when the terminal advertises `COLORTERM`. */
export function fgTruecolor(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`;
}

/** Nearest xterm-256 foreground — the fallback ladder's second rung (D4). The
 *  well-known cube+grayscale approximation (6×6×6 color cube at indices 16–231,
 *  24-step grayscale ramp at 232–255): good enough to keep hue identity legible
 *  without truecolor, exact color match isn't the point. */
export function fg256(r: number, g: number, b: number): string {
  return `${ESC}38;5;${nearest256(r, g, b)}m`;
}

export function nearest256(r: number, g: number, b: number): number {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    // near-gray: the 24-step ramp reproduces neutral tints far better than the cube.
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const step = (c: number): number => Math.round((c / 255) * 5);
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

export function sgr(...codes: Sgr[]): string {
  return codes.length === 0 ? "" : `${ESC}${codes.map((c) => SGR[c]).join(";")}m`;
}

/** Wrap `text` in `open`…`RESET` — the one composition rule every paint helper uses. */
export function wrap(open: string, text: string): string {
  return open === "" ? text : `${open}${text}${RESET}`;
}

// ── Cursor / region control — the painter's "full-frame diff" primitive: move the
// cursor up `n` lines (to the top of the region just painted), then clear from there
// to the end of the screen, then repaint. No partial line-diffing — a small enough
// region (a handful of blocks + a prompt) that redrawing it whole is imperceptible,
// and "no jank" (arrival-repl-viral-research.md §1.4) matters more than cleverness here.
export function cursorUp(n: number): string {
  return n <= 0 ? "" : `${ESC}${n}A`;
}
export const CLEAR_TO_END = `${ESC}0J`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const CARRIAGE_RETURN = "\r";
/** Full clear + cursor-home — `,lens`'s replay uses this (repl.ts): unlike
 *  `paintRegion`'s cursor-up (which only reaches lines still on-screen), a lens flip
 *  re-renders the WHOLE turn history, so it starts from a known blank slate instead of
 *  guessing how many lines have scrolled off. */
export const CLEAR_SCREEN = `${ESC}2J`;
export const CURSOR_HOME = `${ESC}H`;

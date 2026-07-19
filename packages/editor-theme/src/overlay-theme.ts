// overlay-theme — the editor's overlay chrome in the studio's visual language.
//
// ONE container vocabulary across every floating/docked surface (V's spec,
// 2026-06-10/11): dark panel #2b2b2b, oklch hairline border, layered oklch
// shadows, squircle corners (corner-shape superellipse(4) @ radius 100px,
// runtime-feature-detected — the fallback is a DIFFERENT radius, 4px, so a JS
// branch beats @supports inside style-mod). Applied to:
//   • the completion popup (+ its row/section/detail typography),
//   • the diagnostics HOVER tooltip,
//   • the diagnostics PANEL — the container minus the corners (a docked panel
//     squares off against the editor edge).
// Consumes the studio's tokens (--font-mono / --font-heading /
// --color-text-*) with self-sufficient fallbacks so the bench renders sanely
// outside the studio shell too.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { FONT_READING_TYPES, FONT_READING_VALUES, FONT_WRITING } from "./stacks.js";

const MONO = `var(--font-mono, ${FONT_WRITING})`;
const HEADING = "var(--font-heading, system-ui, sans-serif)";

const squircle = typeof CSS !== "undefined" && CSS.supports("corner-shape", "superellipse(4)");

/** The shared container: every overlay surface speaks this. */
const container = {
  backgroundColor: "#2b2b2b",
  color: "oklch(0.77 0 0 / 1)",
  boxShadow: "0 0px 16px 8px oklch(0 0 0 / 0.07), 0 4px 8px oklch(0 0 0 / 0.15)",
  border: "1px solid oklch(0.34 0 0 / 1)",
};

/** The corner treatment — floating surfaces only. */
const corners: Record<string, string> = squircle
  ? { cornerShape: "superellipse(4)", borderRadius: "100px" }
  : { borderRadius: "4px" };

export const overlayTheme: Extension = EditorView.theme({
  // ── completion popup ───────────────────────────────────────────────────
  // Popup rows are READING surfaces (rendered, never edited), so they get
  // Monaspace and its texture healing: Argon (humanist) for the candidate
  // VALUES, Krypton (mechanical) for the TYPE signatures in the detail. The
  // editor itself stays on the writing font — healing jiggles under a caret.
  ".cm-tooltip.cm-tooltip-autocomplete": { ...container, ...corners },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: FONT_READING_VALUES,
    fontFeatureSettings: '"calt" 1', // texture healing rides calt
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "oklch(1 0 0 / 0.1)",
    color: "var(--color-text-primary, oklch(0.92 0 0 / 1))",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    justifyContent: "space-between",
    width: "100%",
    boxSizing: "border-box",
    fontFamily: FONT_READING_VALUES,
  },
  ".cm-completionIcon": {
    display: "none",
  },
  ".cm-completionDetail": {
    marginLeft: "0",
    fontFamily: FONT_READING_TYPES,
    fontStyle: "normal",
    fontWeight: "200", // Krypton VF floor (100 falls off the wght axis)
    color: "var(--color-text-tertiary, oklch(0.55 0 0 / 1))",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    display: "list-item",
    borderBottom: "1px solid oklch(1 0 0 / 0.1)",
    color: "var(--color-text-secondary, oklch(0.7 0 0 / 1))",
    textAlign: "right",
    fontFamily: HEADING,
    fontVariantCaps: "all-petite-caps",
  },
  // ── hover tooltips ───────────────────────────────────────────────────────
  // `.cm-tooltip-hover` is the OUTER container of every hoverTooltip-produced
  // surface (the diagnostics hover AND the type-info quickinfo — one
  // vocabulary across both); `.cm-tooltip-lint` standalone covers the lint
  // GUTTER's marker tooltips, which bypass the hover container.
  ".cm-tooltip.cm-tooltip-hover": { ...container, ...corners },
  ".cm-tooltip.cm-tooltip-lint": { ...container, ...corners },
  ".cm-tooltip-hover .cm-tooltip-lint": { backgroundColor: "transparent", border: "none" },
  // ── diagnostics panel (docked → the container WITHOUT the corners) ─────
  ".cm-panel.cm-panel-lint": { ...container },
  // CM's base theme paints the FOCUSED list's selected row with OS SYSTEM
  // COLORS — `ul:focus [aria-selected] { background: Highlight; color:
  // HighlightText }` (+ a #bdf fallback) — an accessibility default that
  // ignores the dark container entirely (the "weird styles on ul:focus").
  // Re-state the popup's selection vocabulary in BOTH focus states; both
  // `background` and `backgroundColor` because the base declares both forms.
  ".cm-panel.cm-panel-lint ul [aria-selected]": {
    background: "oklch(1 0 0 / 0.1)",
    backgroundColor: "oklch(1 0 0 / 0.1)",
    color: "var(--color-text-primary, oklch(0.92 0 0 / 1))",
  },
  ".cm-panel.cm-panel-lint ul:focus [aria-selected]": {
    background: "oklch(1 0 0 / 0.1)",
    backgroundColor: "oklch(1 0 0 / 0.1)",
    color: "var(--color-text-primary, oklch(0.92 0 0 / 1))",
  },
  // Selection already communicates focus — no browser ring on the list.
  ".cm-panel.cm-panel-lint ul:focus": { outline: "none" },
  ".cm-panel.cm-panel-lint [name=close]": { background: "none" },
  // The `scheme-ts(NNNN)` source line under each diagnostic: tsc codes mean
  // nothing to a scheme author — keep just the error itself. (The code stays
  // on the diagnostic object for tooling; this hides only the UI line.)
  ".cm-diagnosticSource": { display: "none" },
});

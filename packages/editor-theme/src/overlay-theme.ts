// overlay-theme — floating/docked overlay chrome in the shared vocabulary.
//
// ONE container across every floating/docked surface (from chrome.ts): dark
// panel, oklch hairline, layered shadows, squircle corners when available.
// Applied to:
//   • base .cm-tooltip (+ arrow so it matches the panel, not stock white)
//   • completion popup (+ row/section/detail typography + info side panel)
//   • diagnostics HOVER tooltip
//   • diagnostics PANEL — container minus corners (docked squares to the edge)
//
// Host tokens (--font-mono / --font-heading / --color-text-*) with
// self-sufficient fallbacks so Storybook and non-studio hosts stay sane.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  HAIRLINE,
  SELECTION_WASH,
  SURFACE,
  TEXT,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  container,
  corners,
} from "./chrome.js";
import { FONT_READING_TYPES, FONT_READING_VALUES, FONT_WRITING } from "./stacks.js";

const HEADING = "var(--font-heading, system-ui, sans-serif)";

export const overlayTheme: Extension = EditorView.theme({
  // ── base tooltip shell (every CM tooltip inherits) ─────────────────────
  ".cm-tooltip": {
    ...container,
    ...corners,
    fontFamily: FONT_READING_VALUES,
  },
  // Arrow fill must match SURFACE or you get a white triangle on dark chrome.
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: SURFACE,
    borderBottomColor: SURFACE,
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "oklch(0.34 0 0 / 1)",
    borderBottomColor: "oklch(0.34 0 0 / 1)",
  },
  ".cm-tooltip-section:not(:first-child)": {
    borderTop: HAIRLINE,
  },

  // ── completion popup ───────────────────────────────────────────────────
  // Popup rows are READING surfaces (never edited) → Monaspace + texture
  // healing. Editor body stays on the writing font.
  ".cm-tooltip.cm-tooltip-autocomplete": {
    ...container,
    ...corners,
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: FONT_READING_VALUES,
    fontFeatureSettings: '"calt" 1',
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: SELECTION_WASH,
    color: TEXT_PRIMARY,
  },
  ".cm-tooltip-autocomplete-disabled ul li[aria-selected]": {
    background: "oklch(1 0 0 / 0.06)",
    color: TEXT_SECONDARY,
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    justifyContent: "space-between",
    width: "100%",
    boxSizing: "border-box",
    fontFamily: FONT_READING_VALUES,
    padding: "2px 8px",
  },
  ".cm-completionIcon": {
    display: "none",
  },
  ".cm-completionDetail": {
    marginLeft: "0",
    fontFamily: FONT_READING_TYPES,
    fontStyle: "normal",
    fontWeight: "200",
    color: TEXT_TERTIARY,
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: TEXT_PRIMARY,
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    display: "list-item",
    borderBottom: HAIRLINE,
    color: TEXT_SECONDARY,
    textAlign: "right",
    fontFamily: HEADING,
    fontVariantCaps: "all-petite-caps",
    padding: "4px 8px 2px",
  },
  ".cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after": {
    color: TEXT_TERTIARY,
    opacity: 0.7,
  },

  // Side info panel (completion.info) — same shell, no double corners clash.
  ".cm-tooltip.cm-completionInfo": {
    ...container,
    ...corners,
    fontFamily: FONT_READING_VALUES,
    fontSize: "12px",
    padding: "6px 10px",
    maxWidth: "360px",
    color: TEXT,
  },

  // Snippet tabstops
  ".cm-snippetField": {
    backgroundColor: "oklch(0.7 0.08 250 / 0.18)",
  },
  ".cm-snippetFieldPosition": {
    borderLeft: `1.4px dotted ${TEXT_TERTIARY}`,
  },

  // ── hover tooltips ─────────────────────────────────────────────────────
  ".cm-tooltip.cm-tooltip-hover": {
    ...container,
    ...corners,
  },
  ".cm-tooltip.cm-tooltip-lint": {
    ...container,
    ...corners,
  },
  // Nested lint list inside hover: shell already painted — drop inner box.
  ".cm-tooltip-hover .cm-tooltip-lint": {
    backgroundColor: "transparent",
    border: "none",
    boxShadow: "none",
  },

  // ── diagnostics panel (docked → no corners) ────────────────────────────
  ".cm-panel.cm-panel-lint": {
    ...container,
    boxShadow: "none",
  },
  // Kill OS system Highlight on focused list selection.
  ".cm-panel.cm-panel-lint ul [aria-selected]": {
    background: SELECTION_WASH,
    backgroundColor: SELECTION_WASH,
    color: TEXT_PRIMARY,
  },
  ".cm-panel.cm-panel-lint ul:focus [aria-selected]": {
    background: SELECTION_WASH,
    backgroundColor: SELECTION_WASH,
    color: TEXT_PRIMARY,
  },
  ".cm-panel.cm-panel-lint ul:focus": { outline: "none" },
  ".cm-panel.cm-panel-lint [name=close]": { background: "none" },
  ".cm-diagnosticSource": { display: "none" },
});

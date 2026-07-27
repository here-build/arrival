// lint-marks — severity colors for squiggles, points, actions, gutter markers.
// Complements overlayTheme (which owns the tooltip/panel shell + selection).

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  SELECTION_WASH,
  SEV_ERROR,
  SEV_HINT,
  SEV_INFO,
  SEV_WARNING,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
} from "./chrome.js";
import { FONT_READING_VALUES } from "./stacks.js";

function underline(color: string): string {
  // Same SVG wave pattern as @codemirror/lint, recolored.
  const path = encodeURIComponent(
    `<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${color}" fill="none" stroke-width=".7"/>`,
  );
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3">${path}</svg>')`;
}

export const lintMarks: Extension = EditorView.theme({
  ".cm-diagnostic": {
    padding: "4px 8px",
    fontFamily: FONT_READING_VALUES,
    fontSize: "12px",
    lineHeight: "1.4",
  },
  ".cm-diagnostic-error": { borderLeft: `3px solid ${SEV_ERROR}` },
  ".cm-diagnostic-warning": { borderLeft: `3px solid ${SEV_WARNING}` },
  ".cm-diagnostic-info": { borderLeft: `3px solid ${SEV_INFO}` },
  ".cm-diagnostic-hint": { borderLeft: `3px solid ${SEV_HINT}` },

  ".cm-diagnosticAction": {
    font: "inherit",
    fontSize: "11px",
    border: "1px solid oklch(0.34 0 0 / 1)",
    padding: "2px 6px",
    backgroundColor: "oklch(1 0 0 / 0.08)",
    color: TEXT_PRIMARY,
    borderRadius: "4px",
    marginLeft: "8px",
    cursor: "pointer",
    "&:hover": { backgroundColor: SELECTION_WASH },
  },

  ".cm-diagnosticSource": { display: "none" },

  ".cm-lintRange": {
    backgroundPosition: "left bottom",
    backgroundRepeat: "repeat-x",
    paddingBottom: "0.7px",
  },
  ".cm-lintRange-error": { backgroundImage: underline(SEV_ERROR) },
  ".cm-lintRange-warning": { backgroundImage: underline(SEV_WARNING) },
  ".cm-lintRange-info": { backgroundImage: underline(SEV_INFO) },
  ".cm-lintRange-hint": { backgroundImage: underline(SEV_HINT) },
  ".cm-lintRange-active": { backgroundColor: "oklch(0.75 0.1 85 / 0.22)" },

  ".cm-lintPoint": {
    position: "relative",
    "&:after": {
      content: '""',
      position: "absolute",
      bottom: 0,
      left: "-2px",
      borderLeft: "3px solid transparent",
      borderRight: "3px solid transparent",
      borderBottom: `4px solid ${SEV_ERROR}`,
    },
  },
  ".cm-lintPoint-warning": {
    "&:after": { borderBottomColor: SEV_WARNING },
  },
  ".cm-lintPoint-info": {
    "&:after": { borderBottomColor: SEV_INFO },
  },
  ".cm-lintPoint-hint": {
    "&:after": { borderBottomColor: SEV_HINT },
  },

  // Gutter markers — tint toward severity (stock uses fixed pastel SVG content
  // via CSS content:; opacity wash keeps them in the dark palette).
  ".cm-gutter-lint": {
    width: "1.2em",
  },
  ".cm-lint-marker": {
    opacity: 0.9,
  },
  ".cm-panel.cm-panel-lint [name=close]": {
    color: TEXT_SECONDARY,
    cursor: "pointer",
    fontSize: "14px",
    "&:hover": { color: TEXT_PRIMARY },
  },
});

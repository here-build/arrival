// form-theme — stock CM form primitives (search, goto-line, dialogs).
// Replaces Win95 gradients / silver borders with the shared chrome vocabulary.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  BORDER,
  HAIRLINE,
  SELECTION_WASH,
  SURFACE,
  TEXT,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  container,
} from "./chrome.js";
import { FONT_WRITING } from "./stacks.js";

export const formTheme: Extension = EditorView.theme({
  // ── panel strips (search, lint, custom showPanel) ───────────────────────
  ".cm-panels": {
    backgroundColor: SURFACE,
    color: TEXT,
    fontFamily: FONT_WRITING,
  },
  ".cm-panels-top": {
    borderBottom: HAIRLINE,
  },
  ".cm-panels-bottom": {
    borderTop: HAIRLINE,
  },

  // ── shared button / field (search, goto-line, showDialog) ───────────────
  ".cm-button": {
    verticalAlign: "middle",
    color: TEXT_PRIMARY,
    fontSize: "11px",
    fontFamily: FONT_WRITING,
    padding: "0.25em 0.75em",
    borderRadius: "4px",
    border: BORDER,
    backgroundColor: "oklch(1 0 0 / 0.06)",
    backgroundImage: "none",
    cursor: "pointer",
    "&:hover": {
      backgroundColor: SELECTION_WASH,
    },
    "&:active": {
      backgroundColor: "oklch(1 0 0 / 0.14)",
      backgroundImage: "none",
    },
  },
  ".cm-textfield": {
    verticalAlign: "middle",
    color: TEXT_PRIMARY,
    fontSize: "12px",
    fontFamily: FONT_WRITING,
    border: BORDER,
    borderRadius: "4px",
    padding: "0.25em 0.5em",
    backgroundColor: "oklch(0 0 0 / 0.25)",
    outline: "none",
    "&:focus": {
      border: "1px solid oklch(0.55 0.04 250 / 0.8)",
    },
  },

  // ── search panel layout (if host keeps stock createPanel) ───────────────
  ".cm-panel.cm-search": {
    ...container,
    boxShadow: "none", // strip already sits in panels; no double elevation
    padding: "6px 28px 6px 8px",
    fontFamily: FONT_WRITING,
    "& input, & button, & label": {
      margin: "0.15em 0.45em 0.15em 0",
    },
    "& label": {
      fontSize: "11px",
      color: TEXT_SECONDARY,
      whiteSpace: "pre",
    },
    "& [name=close]": {
      position: "absolute",
      top: "4px",
      right: "6px",
      background: "none",
      border: "none",
      color: TEXT_SECONDARY,
      font: "inherit",
      fontSize: "14px",
      cursor: "pointer",
      padding: "2px 4px",
      "&:hover": { color: TEXT_PRIMARY },
    },
  },

  // ── generic dialogs ────────────────────────────────────────────────────
  ".cm-dialog": {
    ...container,
    boxShadow: "none",
    padding: "6px 28px 6px 8px",
    fontFamily: FONT_WRITING,
    "& label": {
      fontSize: "11px",
      color: TEXT_SECONDARY,
    },
  },
  ".cm-dialog-close": {
    color: TEXT_SECONDARY,
    cursor: "pointer",
    "&:hover": { color: TEXT_PRIMARY },
  },
});

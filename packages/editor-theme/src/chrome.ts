// Shared chrome vocabulary — one container language for every floating/docked
// surface. Overlay, form controls, and panel themes import from here so a
// host never re-derives greys.

/** Panel / tooltip fill — slightly above Darcula's editor ground. */
export const SURFACE = "#2b2b2b";

/** Primary text on chrome surfaces. */
export const TEXT = "oklch(0.77 0 0 / 1)";
export const TEXT_PRIMARY = "var(--color-text-primary, oklch(0.92 0 0 / 1))";
export const TEXT_SECONDARY = "var(--color-text-secondary, oklch(0.7 0 0 / 1))";
export const TEXT_TERTIARY = "var(--color-text-tertiary, oklch(0.55 0 0 / 1))";

export const BORDER = "1px solid oklch(0.34 0 0 / 1)";
export const HAIRLINE = "1px solid oklch(1 0 0 / 0.1)";

export const SHADOW =
  "0 0px 16px 8px oklch(0 0 0 / 0.07), 0 4px 8px oklch(0 0 0 / 0.15)";

/** Selected row wash — completion, lint panel, etc. */
export const SELECTION_WASH = "oklch(1 0 0 / 0.1)";

/** Severity colors — leveled to Darcula's alarm tier, not stock CM pastels. */
export const SEV_ERROR = "#af3434";
export const SEV_WARNING = "#c48a2b";
export const SEV_INFO = "#5b89ad";
export const SEV_HINT = "#9673a7";

/** Search / selection-match marks — restrained, not neon cyan/magenta. */
export const MATCH = "oklch(0.75 0.12 85 / 0.28)";
export const MATCH_SELECTED = "oklch(0.7 0.14 45 / 0.42)";
export const SELECTION_MATCH = "oklch(0.72 0.08 220 / 0.22)";

/** Bracket match wash. */
export const BRACKET_MATCH = "oklch(0.55 0.06 175 / 0.32)";
export const BRACKET_MISMATCH = "oklch(0.55 0.14 25 / 0.28)";

const squircle =
  typeof CSS !== "undefined" && CSS.supports("corner-shape", "superellipse(4)");

/** Floating surfaces: container + corners. Docked panels drop corners. */
export const container = {
  backgroundColor: SURFACE,
  color: TEXT,
  boxShadow: SHADOW,
  border: BORDER,
};

/** Corner treatment — floating only. Superellipse when available; 4px else. */
export const corners: Record<string, string> = squircle
  ? { cornerShape: "superellipse(4)", borderRadius: "100px" }
  : { borderRadius: "4px" };

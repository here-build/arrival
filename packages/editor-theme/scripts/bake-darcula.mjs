/*
 * Build-time theme generator — bakes a "compensated Darcula" CodeMirror theme.
 *
 * Philosophy: Darcula's HUES are its signature and are LOCKED. Every token's LIGHTNESS
 * is re-solved through the Nayatani 3-harmonic H-K model (same as Delta foundation.css /
 * postcss-oklch-plus / quickdraw-theme) so all tokens on one salience tier read equally
 * bright. Math runs ONCE here → static hex (zero runtime calc).
 *
 * H-K SSOT: here.build/docs/thinking/raw-data/design-science/helmholtz-kohlrausch-models.md
 * Live CSS: delta/delta-css/src/foundation.css (--🧮hue-factor)
 *
 *   perceived_AL = L + 0.14 · C · hue_factor(h)
 *   L_nominal    = target_AL − 0.14 · C · hue_factor(h)
 */

// Nayatani-1997 VAC shape: 3-harmonic Fourier on OKLCH hue° (R²≈0.98).
// Inherently ~[0.54, 0.92] — no clamp.
function hueFactor(h) {
  const r = (h * Math.PI) / 180;
  return (
    0.77911 +
    0.08091 * Math.cos(r) - 0.13593 * Math.sin(r) +
    0.06202 * Math.cos(2 * r) - 0.00365 * Math.sin(2 * r) -
    0.01415 * Math.cos(3 * r) + 0.03377 * Math.sin(3 * r)
  );
}
const HK_K = 0.14;
// nominal OKLCH L that lands (C,h) on a target apparent-lightness tier
const solveL = (target, C, h) => target - HK_K * C * hueFactor(h);

// ---- OKLCH -> sRGB hex, with in-gamut chroma clamp ----
const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklab2lin(L, a, b) {
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}
const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
function oklch2hex(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  // clamp L into displayable range, then shrink chroma until the color fits sRGB
  L = Math.min(0.999, Math.max(0.001, L));
  let c = C;
  while (c > 0) {
    const rgb = oklab2lin(L, c * Math.cos(h), c * Math.sin(h));
    if (inGamut(rgb)) break;
    c -= 0.002;
  }
  const rgb = oklab2lin(L, c * Math.cos(h), c * Math.sin(h)).map((x) =>
    Math.round(Math.min(1, Math.max(0, lin2srgb(x))) * 255),
  );
  return "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- Tiers (apparent-lightness targets against the #2B2B2B / aL 0.289 ground) ----
const TIER = { recede: 0.55, baseline: 0.77, differentiate: 0.62, anchor: 0.85, alarm: 0.53 };

// ---- Seed table: Darcula hues LOCKED (h,C from converting JetBrains' hex);
//      novel sweet/dotprompt tokens get a chosen hue + the tier does the rest. ----
// tag = @lezer/highlight tag name(s); style = extra css (italic/weight)
const SEED = [
  // --- shared / scheme-sweet ---
  { tags: ["definitionKeyword", "controlKeyword", "keyword", "operatorKeyword", "moduleKeyword"], h: 57, C: 0.13, tier: "differentiate" }, // Darcula keyword orange
  { tags: ["definition(variableName)", "function(variableName)"], h: 77, C: 0.125, tier: "anchor" }, // function-decl yellow (bright anchor)
  { tags: ["variableName", "name"], h: 250, C: 0.022, tier: "baseline" }, // default text — the neutral 75%
  { tags: ["string", "docString", "character"], h: 134, C: 0.075, tier: "differentiate" }, // string green
  { tags: ["number", "integer", "float"], h: 242, C: 0.074, tier: "differentiate" }, // number blue
  { tags: ["bool", "atom", "null"], h: 242, C: 0.074, tier: "differentiate" }, // constants share number-blue
  { tags: ["propertyName", "labelName"], h: 314, C: 0.086, tier: "differentiate" }, // :key / k: -> constant purple
  { tags: ["comment", "lineComment", "blockComment"], h: 140, C: 0.0, tier: "recede" }, // gray, receded
  { tags: ["docComment"], h: 140, C: 0.09, tier: "recede" }, // doc-comment green, still receded
  { tags: ["meta"], h: 57, C: 0.05, tier: "differentiate" }, // quote ' ` , ,@ — dim keyword family
  { tags: ["paren", "squareBracket"], h: 250, C: 0.0, tier: "recede" }, // brackets recede (gray)
  // SWEET superset — marked with a hue in the keyword family + ITALIC = "this is sugar"
  { tags: ["brace"], h: 57, C: 0.04, tier: "recede", italic: true }, // curly-infix braces, faint sweet tint
  { tags: ["compareOperator", "logicOperator", "controlOperator", "arithmeticOperator", "operator"], h: 57, C: 0.1, tier: "differentiate", italic: true }, // == && || =>
  // --- dotprompt ---
  { tags: ["processingInstruction"], h: 314, C: 0.14, tier: "anchor", bold: true }, // {{role}} turn-delimiter — reserved bright anchor
  { tags: ["contentSeparator"], h: 57, C: 0.03, tier: "recede" }, // --- fences
  { tags: ["bracket"], h: 250, C: 0.0, tier: "recede" }, // {{ }} mustache braces
  { tags: ["content"], h: 250, C: 0.0, tier: "baseline" }, // prose body — readable neutral
  { tags: ["heading", "strong"], h: 250, C: 0.0, tier: "baseline", bold: true },
  { tags: ["emphasis"], h: 250, C: 0.0, tier: "baseline", italic: true },
  // --- alarm (reserved) ---
  { tags: ["invalid"], h: 25, C: 0.16, tier: "alarm" }, // error red — power from rarity
];

// resolve each seed row to a baked hex
const rows = SEED.map((s) => {
  const L = solveL(TIER[s.tier], s.C, s.h);
  return { ...s, color: oklch2hex(L, s.C, s.h), L, aL: TIER[s.tier] };
});

// ---- Darcula editor chrome ----
const CHROME = {
  // The editor paints its OWN ground — and it must. Every syntax tier's apparent-
  // lightness, plus the active-line / selection fills, is leveled against the backdrop
  // tokens are viewed on; a transparent canvas keeps the contrast math but discards the
  // ground it was solved against, so the fills float on whatever the host paints and the
  // leveling reads wrong. Background and foreground contrast are ONE entity — they ship
  // together. Ground is a near-black neutral (oklch L=0.2, chroma 0); shipped as a static
  // color literal, so no runtime calc.
  bg: "oklch(0.2 0 211)",
  fg: "#A9B7C6",
  caret: "#BBBBBB",
  selection: "#214283",
  gutterBg: "oklch(0.2 0 211)",
  gutterFg: "#606366",
  activeLine: "#323232",
  activeGutter: "#323232",
};

// ---- emit the TS module ----
const esc = (t) => `tags.${t.replace(/(\w+)\((\w+)\)/, "$1(tags.$2)")}`;
const styleEntries = rows
  .map((r) => {
    const tagExpr = r.tags.length === 1 ? esc(r.tags[0]) : `[${r.tags.map(esc).join(", ")}]`;
    const extra = [r.italic && `fontStyle: "italic"`, r.bold && `fontWeight: "600"`].filter(Boolean);
    const props = [`color: "${r.color}"`, ...extra].join(", ");
    return `  { tag: ${tagExpr}, ${props} }, // ${r.tier} aL≈${r.aL} h${r.h} -> L${r.L.toFixed(3)}`;
  })
  .join("\n");

const out = `// GENERATED by scripts/bake-darcula.mjs — DO NOT EDIT BY HAND.
// "Compensated Darcula": JetBrains' Darcula hues, lightness re-solved through the
// Nayatani 3-harmonic H-K model (Delta / postcss-oklch-plus) so every salience tier
// reads level. Baked to static hex. Re-bake: \`node scripts/bake-darcula.mjs\`.
// H-K SSOT: here.build/docs/thinking/raw-data/design-science/helmholtz-kohlrausch-models.md
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const highlightStyle = HighlightStyle.define([
${styleEntries}
]);

const chrome = EditorView.theme(
  {
    "&": { color: "${CHROME.fg}", backgroundColor: "${CHROME.bg}" },
    ".cm-content": { caretColor: "${CHROME.caret}" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "${CHROME.caret}" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "${CHROME.selection}",
    },
    ".cm-activeLine": { backgroundColor: "${CHROME.activeLine}" },
    ".cm-gutters": { backgroundColor: "${CHROME.gutterBg}", color: "${CHROME.gutterFg}", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "${CHROME.activeGutter}" },
  },
  { dark: true },
);

/** Compensated-Darcula theme: editor chrome + H-K-leveled syntax highlighting. */
export const darcula: Extension = [chrome, syntaxHighlighting(highlightStyle)];
`;

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "theme-darcula.ts");
writeFileSync(target, out);
console.log("baked ->", target, "\n");
console.log("tier".padEnd(14), "h".padStart(4), "C".padStart(6), "L".padStart(6), "  color   tags");
for (const r of rows) console.log(r.tier.padEnd(14), String(r.h).padStart(4), r.C.toFixed(3).padStart(6), r.L.toFixed(3).padStart(6), " " + r.color, " " + r.tags.join(","));

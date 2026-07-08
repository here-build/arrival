// sugarcoatIdeBackend — SchemeIdeBackend wrapper for sugarcoat buffers.
//
// Derives classic via alignSugarcoatClassic, translates all positions/spans.
// Same seam in/out. Three lenses end-to-end: sugarcoat → classic → TS.
//
// Degradation: unparseable sugarcoat → null alignment → all answers empty
// (editor keeps last good). Sugar positions have no classic token → empty.
// Diagnostics inside sugar lift to enclosing paired node.

import { alignSugarcoatClassic, type SugarcoatAlignment } from "@here.build/arrival-sugarcoat";

import type {
  SchemeIdeBackend,
  SchemeIdeCompletionContext,
  SchemeIdeCompletionEntry,
  SchemeIdeDefinition,
  SchemeIdeDiagnostic,
  SchemeIdeQuickInfo,
} from "./ide.js";

/** Diagnostic code namespace for sugarcoat-surface lints (not tsc codes). */
const SURFACE_LINT_INTERP_SUBSCRIPT = 90001;

/**
 * Surface-face lints — patterns that are VALID sugarcoat (so the reader must not
 * reject them; prose is prose) but near-certainly not what the author meant.
 *
 * `@id[` — an at-body interpolation stops at the bare name, so a tight `[:key]`
 * after it is literal prose, silently. Found by the LEARN.md custdev loop
 * (LongCat wrote `@s[:baseline]` expecting keyed access). Excluded: `,@` splices,
 * spaced brackets, and the explicit-boundary form `@|id|[` — an author who wrote
 * the boundary already decided where the name ends, so trailing prose brackets
 * are plausibly deliberate. A bare tight `@id[` has no other plausible intent.
 */
export function sugarcoatSurfaceLints(sugarcoat: string): SchemeIdeDiagnostic[] {
  const out: SchemeIdeDiagnostic[] = [];
  const interpThenBracket = /(?<!,)@([A-Za-z!$%&*/<=>?^_~][\w!$%&*/<=>?^_~-]*)\[/g;
  for (const m of sugarcoat.matchAll(interpThenBracket)) {
    out.push({
      start: m.index,
      length: m[0].length,
      severity: "warning",
      code: SURFACE_LINT_INTERP_SUBSCRIPT,
      messageText:
        "interpolation stops at the name — the '[…]' here is literal prose; " +
        "for keyed access graft a form: @(:key name)",
    });
  }
  return out;
}

/** Per-buffer memo (all queries see same doc between edits). */
function makeAligner(): (sugarcoat: string) => SugarcoatAlignment | null {
  let lastText: string | null = null;
  let lastAlignment: SugarcoatAlignment | null = null;
  return (sugarcoat) => {
    if (sugarcoat !== lastText) {
      lastText = sugarcoat;
      lastAlignment = alignSugarcoatClassic(sugarcoat);
    }
    return lastAlignment;
  };
}

/** Completion anchor: prefer exact token map. Else inject ws after prior
 *  token so `(f |` works (canonical print may glue `)`). Completion has no
 *  spans so patch is invisible to mapping. */
function completionAnchor(a: SugarcoatAlignment, sugarcoat: string, pos: number): { classic: string; pos: number } | null {
  const direct = a.toClassic(pos);
  if (direct !== null) return { classic: a.classic, pos: direct };
  let k = pos;
  while (k > 0 && /[ \t]/.test(sugarcoat[k - 1])) k--;
  if (k === pos || k === 0) return null;
  const end = a.toClassic(k); // inclusive end of the preceding token
  if (end === null) return null;
  return { classic: `${a.classic.slice(0, end)} ${a.classic.slice(end)}`, pos: end + 1 };
}

/**
 * Wrap a classic-coordinate backend for a SWEET buffer. Same seam in, same
 * seam out — `schemeIde(sugarcoatIdeBackend(backend))` mounts the full IDE on the
 * sugarcoat lens. Optional capabilities are forwarded only when the inner backend
 * has them (presence-gated, like the seam itself).
 */
export function sugarcoatIdeBackend(backend: SchemeIdeBackend): SchemeIdeBackend {
  const align = makeAligner();

  const wrapped: SchemeIdeBackend = {
    async getSemanticDiagnostics(sugarcoat: string): Promise<SchemeIdeDiagnostic[]> {
      // Surface lints are face-only (sugarcoat coordinates already) — they fire even
      // when alignment degrades, since they need no classic projection.
      const out: SchemeIdeDiagnostic[] = sugarcoatSurfaceLints(sugarcoat);
      const a = align(sugarcoat);
      if (a === null) return out;
      const diags = await backend.getSemanticDiagnostics(a.classic);
      for (const d of diags) {
        const span = a.toSugarcoat(d.start, d.length);
        if (span !== null) out.push({ ...d, start: span.start, length: span.length });
      }
      return out;
    },

    async getQuickInfoAtPosition(sugarcoat: string, pos: number): Promise<SchemeIdeQuickInfo | null> {
      const a = align(sugarcoat);
      if (a === null) return null;
      const cPos = a.toClassic(pos);
      if (cPos === null) return null;
      const info = await backend.getQuickInfoAtPosition(a.classic, cPos);
      if (info === null) return null;
      const span = info.span === null ? null : a.toSugarcoat(info.span.start, info.span.length);
      return { ...info, span };
    },

    async getCompletionsAtPosition(sugarcoat: string, pos: number): Promise<SchemeIdeCompletionEntry[]> {
      const a = align(sugarcoat);
      if (a === null) return [];
      const anchor = completionAnchor(a, sugarcoat, pos);
      if (anchor === null) return [];
      return backend.getCompletionsAtPosition(anchor.classic, anchor.pos);
    },

    async getDefinitionAtPosition(sugarcoat: string, pos: number): Promise<SchemeIdeDefinition[]> {
      const a = align(sugarcoat);
      if (a === null) return [];
      const cPos = a.toClassic(pos);
      if (cPos === null) return [];
      const defs = await backend.getDefinitionAtPosition(a.classic, cPos);
      return defs.map((d) => {
        // A cross-file definition's span is in THAT file's (classic) coordinates
        // — leave it; the studio opens required files in the classic lens.
        if (d.file !== undefined || d.span === null) return d;
        return { ...d, span: a.toSugarcoat(d.span.start, d.span.length) };
      });
    },
  };

  if (backend.getSemanticClassifications) {
    // Exact-token spans only: classification paints identifiers; lifting an
    // unmapped one to its whole enclosing form would paint sugar wholesale.
    wrapped.getSemanticClassifications = async (sugarcoat: string) => {
      const a = align(sugarcoat);
      if (a === null) return [];
      const spans = await backend.getSemanticClassifications!(a.classic);
      const out: typeof spans = [];
      for (const s of spans) {
        const span = a.toSugarcoat(s.start, s.length);
        if (span !== null && span.length === s.length) out.push({ ...s, start: span.start, length: span.length });
      }
      return out;
    };
  }

  if (backend.getCompletionContext) {
    wrapped.getCompletionContext = async (sugarcoat: string, pos: number): Promise<SchemeIdeCompletionContext> => {
      const a = align(sugarcoat);
      const anchor = a === null ? null : completionAnchor(a, sugarcoat, pos);
      if (anchor === null) return { position: "top", entries: [] };
      return backend.getCompletionContext!(anchor.classic, anchor.pos);
    };
  }

  return wrapped;
}

// sweet-ide — the sweet-lens IDE backend: a SchemeIdeBackend → SchemeIdeBackend
// coordinate compositor. The wrapped backend keeps answering in CLASSIC scheme
// coordinates over a classic text; this wrapper derives that classic from the
// sweet buffer itself (readSweet → printScheme, via alignSweetClassic) and
// translates every position/span through the sweet↔classic span pairing. Three
// lenses compose end-to-end: sweet ↔ classic ↔ virtual TS ↔ tsc.
//
// Degradation contract (mirrors the save-back path's): a sweet buffer that
// doesn't parse mid-edit aligns to null → every query answers empty, and the
// editor keeps its last good diagnostics. A query position on sweet sugar
// (infix glyphs, elided parens) has no classic token → empty, never a wrong
// token's answer. Diagnostics whose classic span falls inside sugar lift to
// the innermost enclosing paired node — visible, just wider.

import { alignSweetClassic, type SweetAlignment } from "@here.build/arrival-chain/sweet";

import type {
  SchemeIdeBackend,
  SchemeIdeCompletionContext,
  SchemeIdeCompletionEntry,
  SchemeIdeDefinition,
  SchemeIdeDiagnostic,
  SchemeIdeQuickInfo,
} from "./ide.js";

/** Memoized per-buffer alignment — lint/hover/completion all query the same
 *  doc text between keystrokes, so the parse+reprint+walk runs once per edit. */
function makeAligner(): (sweet: string) => SweetAlignment | null {
  let lastText: string | null = null;
  let lastAlignment: SweetAlignment | null = null;
  return (sweet) => {
    if (sweet !== lastText) {
      lastText = sweet;
      lastAlignment = alignSweetClassic(sweet);
    }
    return lastAlignment;
  };
}

/** Map a cursor for COMPLETION: direct exact-token mapping first (typing a
 *  prefix — the common case), else anchor after the preceding token — the
 *  `(f |` argument position. The wrapper OWNS the derived classic, so for the
 *  after-token case it injects the whitespace seam the backend's sentinel
 *  needs (the canonical print may have `)` right after the token); completion
 *  answers carry no spans, so the patched text never skews a mapping. */
function completionAnchor(a: SweetAlignment, sweet: string, pos: number): { classic: string; pos: number } | null {
  const direct = a.toClassic(pos);
  if (direct !== null) return { classic: a.classic, pos: direct };
  let k = pos;
  while (k > 0 && /[ \t]/.test(sweet[k - 1])) k--;
  if (k === pos || k === 0) return null;
  const end = a.toClassic(k); // inclusive end of the preceding token
  if (end === null) return null;
  return { classic: `${a.classic.slice(0, end)} ${a.classic.slice(end)}`, pos: end + 1 };
}

/**
 * Wrap a classic-coordinate backend for a SWEET buffer. Same seam in, same
 * seam out — `schemeIde(sweetIdeBackend(backend))` mounts the full IDE on the
 * sweet lens. Optional capabilities are forwarded only when the inner backend
 * has them (presence-gated, like the seam itself).
 */
export function sweetIdeBackend(backend: SchemeIdeBackend): SchemeIdeBackend {
  const align = makeAligner();

  const wrapped: SchemeIdeBackend = {
    async getSemanticDiagnostics(sweet: string): Promise<SchemeIdeDiagnostic[]> {
      const a = align(sweet);
      if (a === null) return [];
      const diags = await backend.getSemanticDiagnostics(a.classic);
      const out: SchemeIdeDiagnostic[] = [];
      for (const d of diags) {
        const span = a.toSweet(d.start, d.length);
        if (span !== null) out.push({ ...d, start: span.start, length: span.length });
      }
      return out;
    },

    async getQuickInfoAtPosition(sweet: string, pos: number): Promise<SchemeIdeQuickInfo | null> {
      const a = align(sweet);
      if (a === null) return null;
      const cPos = a.toClassic(pos);
      if (cPos === null) return null;
      const info = await backend.getQuickInfoAtPosition(a.classic, cPos);
      if (info === null) return null;
      const span = info.span === null ? null : a.toSweet(info.span.start, info.span.length);
      return { ...info, span };
    },

    async getCompletionsAtPosition(sweet: string, pos: number): Promise<SchemeIdeCompletionEntry[]> {
      const a = align(sweet);
      if (a === null) return [];
      const anchor = completionAnchor(a, sweet, pos);
      if (anchor === null) return [];
      return backend.getCompletionsAtPosition(anchor.classic, anchor.pos);
    },

    async getDefinitionAtPosition(sweet: string, pos: number): Promise<SchemeIdeDefinition[]> {
      const a = align(sweet);
      if (a === null) return [];
      const cPos = a.toClassic(pos);
      if (cPos === null) return [];
      const defs = await backend.getDefinitionAtPosition(a.classic, cPos);
      return defs.map((d) => {
        // A cross-file definition's span is in THAT file's (classic) coordinates
        // — leave it; the studio opens required files in the classic lens.
        if (d.file !== undefined || d.span === null) return d;
        return { ...d, span: a.toSweet(d.span.start, d.span.length) };
      });
    },
  };

  if (backend.getSemanticClassifications) {
    // Exact-token spans only: classification paints identifiers; lifting an
    // unmapped one to its whole enclosing form would paint sugar wholesale.
    wrapped.getSemanticClassifications = async (sweet: string) => {
      const a = align(sweet);
      if (a === null) return [];
      const spans = await backend.getSemanticClassifications!(a.classic);
      const out: typeof spans = [];
      for (const s of spans) {
        const span = a.toSweet(s.start, s.length);
        if (span !== null && span.length === s.length) out.push({ ...s, start: span.start, length: span.length });
      }
      return out;
    };
  }

  if (backend.getCompletionContext) {
    wrapped.getCompletionContext = async (sweet: string, pos: number): Promise<SchemeIdeCompletionContext> => {
      const a = align(sweet);
      const anchor = a === null ? null : completionAnchor(a, sweet, pos);
      if (anchor === null) return { position: "top", entries: [] };
      return backend.getCompletionContext!(anchor.classic, anchor.pos);
    };
  }

  return wrapped;
}

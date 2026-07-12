// One program, two faces — the SAME backend on both.
//
// The left editor shows canonical Scheme; the right shows the Sugarcoat
// rendering of the same program (derived once via schemeToSugarcoat). The
// classic editor mounts the IDE directly; the Sugarcoat editor mounts the SAME
// backend through sugarcoatIdeBackend, the sugarcoat↔classic span aligner —
// hover/lint/completion answers travel sugarcoat → classic → TypeScript.

import { EditorView, lineNumbers } from "@codemirror/view";
import { schemeToSugarcoat } from "@here.build/arrival-sugarcoat";
import { createBrowserSchemeLanguageService } from "@inhuman.tools/arrival-type-lens/browser";

import { paramHintsExtension, schemeIde, schemeSugarcoat, sugarcoatIdeBackend } from "@here.build/arrival-codemirror";

const canonical = `(define (loud-names names)
  (map string-upcase names))

(loud-names (list "ada" "grace"))
`;

const backend = createBrowserSchemeLanguageService();

export const classicView = new EditorView({
  parent: document.querySelector("#classic")!,
  doc: canonical,
  extensions: [lineNumbers(), schemeSugarcoat(), paramHintsExtension("scheme"), schemeIde(backend)],
});

export const sugarcoatView = new EditorView({
  parent: document.querySelector("#sugarcoat")!,
  doc: schemeToSugarcoat(canonical),
  extensions: [
    lineNumbers(),
    schemeSugarcoat(), // one language mode covers both faces
    paramHintsExtension("sugarcoat"),
    schemeIde(sugarcoatIdeBackend(backend)), // same seam in, same seam out
  ],
});

// ghost — inline preview of the Σ∩T-best candidate, accepted by Tab.
//
// The "discussion with the compiler", zero-popup edition: when the cursor sits
// somewhere an insertion is PROVABLY SAFE — end of line, or only closers/
// whitespace after it — the top-ranked candidate from the same Σ∩T context
// that powers the completion popup renders as dimmed inline text after the
// cursor. Tab accepts it: ONE SYMBOL PER PRESS (never a multi-token paste —
// each Tab inserts exactly the ghost symbol's remainder, then the next ghost
// recomputes from the new state). Escape dismisses until the next edit.
//
// Tab's precedence ladder (CM facets resolve it):
//   snippet field nav (snippet keymap, highest prec — untouched)
//   > popup accept (completionStatus active → acceptCompletion)
//   > ghost accept
//   > whatever Tab means downstream (indentation etc.)
// The ghost HIDES while the popup is open — two previews of the same answer
// is noise; the popup carries strictly more information.
//
// Candidate choice mirrors the popup's tiers: fitting > local > builtin,
// prefix-extending only (a ghost equal to what's typed is no ghost at all).
// Unprompted (empty-prefix) ghosts appear ONLY where the unprompted popup
// would: an argument slot the mask narrowed — and never at a form head, where
// ghosting one arbitrary callable would be guessing, not proving.

import { acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import type { SchemeIdeBackend, SchemeIdeRichCompletion, SchemeNeuralRanker } from "./ide.js";

// Same atom-character class as the completion source's SYMBOL_BEFORE. A single
// character class under `*` cannot backtrack — the slow-regex flag is a false
// positive on the `$` anchor (same verdict as ide.ts's SYMBOL_BEFORE).
// eslint-disable-next-line sonarjs/slow-regex
const ATOM_TAIL = /[\w\-!$%&*+./<=>?@^~]*$/;

/** Insertion is safe iff nothing but whitespace and closers follows on the line
 *  (exported for tests). The cursor mid-expression must never grow a ghost —
 *  accepting it would splice a symbol into existing text. */
export function lineTailIsSafe(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return /^[\s)\]]*$/.test(state.doc.sliceString(pos, line.to));
}

/** Pick the ghost: the best candidate that EXTENDS the typed prefix (exported
 *  for tests). Empty prefix → only slot-fitting candidates qualify (the same
 *  gate as the unprompted popup). Tiers mirror the popup's boosts; codepoint
 *  tie-break keeps the choice deterministic. */
export function pickGhost(
  entries: readonly SchemeIdeRichCompletion[],
  prefix: string,
  position: "operator" | "argument" | "top",
): string | null {
  const pool = entries.filter((e) =>
    prefix === ""
      ? e.fits === true && position === "argument"
      : e.name.startsWith(prefix) && e.name !== prefix && e.fits !== false,
  );
  const score = (e: SchemeIdeRichCompletion): number =>
    (e.fits === true ? 4 : 0) +
    (e.kind === "method" ? 0 : 1) +
    (position === "operator" && e.callable === true ? 2 : 0);
  let best: SchemeIdeRichCompletion | null = null;
  for (const e of pool) {
    if (best === null) {
      best = e;
      continue;
    }
    const d = score(e) - score(best);
    if (d > 0 || (d === 0 && e.name < best.name)) best = e;
  }
  return best?.name ?? null;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-scheme-ghost";
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

interface GhostValue {
  /** Cursor position the ghost was computed for. */
  pos: number;
  /** The REMAINDER to insert (the symbol minus the typed prefix). */
  remainder: string;
}

const setGhost = StateEffect.define<GhostValue | null>();

const ghostField = StateField.define<GhostValue | null>({
  create: () => null,
  update(value, tr) {
    // Any document or selection movement invalidates the ghost — the plugin
    // recomputes for the new state (Escape sets null explicitly).
    let next = tr.docChanged || tr.selection !== undefined ? null : value;
    for (const e of tr.effects) if (e.is(setGhost)) next = e.value;
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (value) =>
      value === null
        ? Decoration.none
        : Decoration.set([Decoration.widget({ widget: new GhostWidget(value.remainder), side: 1 }).range(value.pos)]),
    ),
});

const ghostTheme = EditorView.baseTheme({
  ".cm-scheme-ghost": {
    opacity: "0.4",
    fontStyle: "italic",
    pointerEvents: "none",
  },
});

/** Accept the ghost: insert the remainder, cursor lands after the symbol. */
const acceptGhost = (view: EditorView): boolean => {
  const ghost = view.state.field(ghostField, false);
  if (ghost === null || ghost === undefined) return false;
  if (view.state.selection.main.head !== ghost.pos) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.remainder },
    selection: { anchor: ghost.pos + ghost.remainder.length },
    effects: setGhost.of(null),
    userEvent: "input.complete.ghost",
  });
  return true;
};

const dismissGhost = (view: EditorView): boolean => {
  const ghost = view.state.field(ghostField, false);
  if (ghost === null || ghost === undefined) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
};

export interface SchemeGhostOptions {
  /** Debounce after the last edit before computing a ghost (ms). Default 250. */
  delay?: number;
  /** The on-device neural ranker: when present, the ghost is the MODEL'S pick
   *  within the proven set — the highest-probability nucleus member among the
   *  type-fitting candidates. Provable ∩ probable, one symbol at a time. */
  ranker?: SchemeNeuralRanker;
  /** The frame floor (probability ≥ → 'likely'). Default 0.05. */
  minProb?: number;
}

/** The ghost extension: inline Σ∩T-best preview + the Tab ladder. */
export function schemeGhost(backend: SchemeIdeBackend, options?: SchemeGhostOptions): Extension {
  const rich = backend.getCompletionContext?.bind(backend);
  if (rich === undefined) return [];

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private generation = 0;
      constructor(private readonly view: EditorView) {}
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet) this.schedule();
      }
      destroy(): void {
        this.generation += 1;
        if (this.timer !== null) clearTimeout(this.timer);
      }
      private schedule(): void {
        const gen = ++this.generation;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(gen), options?.delay ?? 250);
      }
      private async run(gen: number): Promise<void> {
        const state = this.view.state;
        const sel = state.selection.main;
        // Only at a lone cursor, in safe tail position, with the popup closed.
        if (!sel.empty || !lineTailIsSafe(state, sel.head) || completionStatus(state) !== null) return;
        const head = sel.head;
        const prefix = ATOM_TAIL.exec(state.doc.sliceString(state.doc.lineAt(head).from, head))?.[0] ?? "";
        let ghostName: string | null = null;
        try {
          const context = await rich(state.doc.toString(), head);
          if (options?.ranker !== undefined) {
            // Neural ghost: the model's nucleus pick WITHIN the proven set.
            const names = context.entries.map((e) => e.name);
            const ranks = await options.ranker.rank(
              state.doc.toString().slice(0, head - prefix.length),
              names,
              options.minProb ?? 0.05,
            );
            let bestProb = 0;
            for (const [i, e] of context.entries.entries()) {
              const r = ranks[i];
              if (r === undefined || !r.inNucleus || r.prob <= bestProb) continue;
              if (prefix === "" ? !(e.fits === true && context.position === "argument") : !e.name.startsWith(prefix) || e.name === prefix || e.fits === false) continue;
              bestProb = r.prob;
              ghostName = e.name;
            }
            // Model silent (nothing proven is in its nucleus) → structural pick.
            ghostName ??= pickGhost(context.entries, prefix, context.position);
          } else {
            ghostName = pickGhost(context.entries, prefix, context.position);
          }
        } catch {
          return; // mid-edit parse trouble — no ghost
        }
        if (gen !== this.generation || this.view.state.selection.main.head !== head) return; // stale
        if (ghostName === null) return;
        this.view.dispatch({
          effects: setGhost.of({ pos: head, remainder: ghostName.slice(prefix.length) }),
        });
      }
    },
  );

  return [
    ghostField,
    plugin,
    ghostTheme,
    Prec.high(
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            // Popup open → Tab accepts the popup's selection; else the ghost.
            if (completionStatus(view.state) === "active") return acceptCompletion(view);
            return acceptGhost(view);
          },
        },
        { key: "Escape", run: dismissGhost },
      ]),
    ),
  ];
}

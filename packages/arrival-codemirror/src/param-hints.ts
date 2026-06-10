import { type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { paramHints, paramHintsSweet, type ParamHint } from "@here.build/arrival-chain/sweet";

/**
 * Parameter inlay hints for `.scm`: a subtle, non-interactive `param:` void widget
 * before each positional arg of a call to a local `(define (f …))` — the IDE
 * inlay-hint idea. The hint is a VIEW decoration that occupies no document range, so
 * it's inherently non-selectable and the caret slips straight past it to the arg;
 * the buffer text never contains it. Resolution is the pure hint analysis
 * (arrival-chain `/sweet`, runtime-free), per lens: `paramHints` over the classic
 * parse, `paramHintsSweet` over a span-bearing sweet parse — both in the coordinate
 * space of the text the editor shows.
 */

class HintWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }
  eq(other: HintWidget): boolean {
    return other.name === this.name;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-param-hint";
    el.textContent = this.name; // brackets + dimming are CSS (theme below)
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent(): boolean {
    return true; // non-interactive
  }
}

function buildDecorations(view: EditorView, resolve: (src: string) => ParamHint[]): DecorationSet {
  let hints: ParamHint[] = [];
  try {
    hints = resolve(view.state.doc.toString());
  } catch {
    // A malformed / unsupported buffer yields no hints — never break the editor.
  }
  const builder = new RangeSetBuilder<Decoration>();
  // RangeSetBuilder wants ascending `from`; the resolver emits in walk order.
  for (const h of hints.toSorted((a, b) => a.pos - b.pos)) {
    builder.add(h.pos, h.pos, Decoration.widget({ widget: new HintWidget(h.name), side: -1 }));
  }
  return builder.finish();
}

const hintTheme = EditorView.theme({
  ".cm-param-hint": {
    opacity: "0.4",
    fontVariant: "all-petite-caps",
    fontSize: "1em",
    padding: "0 0 0 0",
    userSelect: "none",
    pointerEvents: "none",
    margin: "0 0.5ch 0 0",
    translate: "0 0",
    display: "inline-block",
  },
  ".cm-param-hint::before": { content: '""' },
  ".cm-param-hint::after": { content: '":"' },
});

/** The CodeMirror extension: a ViewPlugin that recomputes the hint widgets when the
 *  document changes, plus their styling. `lens` selects the resolver — `"scheme"`
 *  reads the classic buffer, `"sweet"` the sweet buffer. */
export function paramHintsExtension(lens: "scheme" | "sweet" = "scheme"): Extension {
  const resolve = lens === "sweet" ? paramHintsSweet : paramHints;
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, resolve);
        }
        update(u: ViewUpdate): void {
          if (u.docChanged) this.decorations = buildDecorations(u.view, resolve);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    hintTheme,
  ];
}

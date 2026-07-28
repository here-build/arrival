// IDEA-style find / find-replace panel for CodeMirror 6.
//
// Same SearchQuery state as @codemirror/search; custom createPanel UI:
//   • collapsed by default (find only) — Mod-f
//   • chevron expands replace row — or Mod-Alt-f opens already expanded
//   • icon toggles: Cc (case) · W (word) · .* (regexp)
//   • ↑ / ↓ for prev/next, result count, no file-scope filters
//
// Wire-up:
//   extensions: [theme, ideaSearch()]
//   // ideaSearch includes search({ createPanel }) + theme + keymap

import { redo, undo } from "@codemirror/commands";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  getPanel,
  keymap,
  runScopeHandlers,
  type Command,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";

// ── open intent (collapsed find vs expanded replace) ─────────────────────

export type SearchOpenMode = "find" | "replace";

/** Dispatched so the panel knows expand + focus target. */
export const setSearchOpenMode = StateEffect.define<SearchOpenMode>();

const searchOpenMode = StateField.define<SearchOpenMode>({
  create: () => "find",
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSearchOpenMode)) return e.value;
    return value;
  },
});

// ── DOM helpers ──────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void) | undefined> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else if (typeof v === "string") {
      node.setAttribute(k, v);
    }
  }
  for (const kid of kids) node.append(kid);
  return node;
}

function iconBtn(
  name: string,
  title: string,
  label: string,
  onClick: () => void,
  opts: { pressed?: boolean; className?: string } = {},
): HTMLButtonElement {
  const b = el(
    "button",
    {
      type: "button",
      name,
      title,
      "aria-label": title,
      class: `cm-search-idea-iconbtn${opts.className ? ` ${opts.className}` : ""}`,
      onclick: (e) => {
        e.preventDefault();
        onClick();
      },
    },
    label,
  ) as HTMLButtonElement;
  b.setAttribute("aria-pressed", opts.pressed ? "true" : "false");
  if (opts.pressed) b.classList.add("cm-search-idea-on");
  return b;
}

// ── match count ──────────────────────────────────────────────────────────

const COUNT_CAP = 9999;

function formatMatchCount(view: EditorView, query: SearchQuery): string {
  if (!query.valid) return "";
  const { from, to } = view.state.selection.main;
  let n = 0;
  let idx = -1;
  // SearchQuery.create() is @internal — count via the public cursor instead.
  const cursor = query.getCursor(view.state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (n >= COUNT_CAP) return `${COUNT_CAP}+`;
    if (step.value.from === from && step.value.to === to) idx = n;
    n++;
  }
  if (n === 0) return "0 results";
  if (idx >= 0) return `${idx + 1}/${n}`;
  return `${n} results`;
}

// ── Panel ────────────────────────────────────────────────────────────────

class IdeaSearchPanel implements Panel {
  dom: HTMLElement;
  searchField: HTMLInputElement;
  replaceField: HTMLInputElement;
  caseBtn: HTMLButtonElement;
  wordBtn: HTMLButtonElement;
  reBtn: HTMLButtonElement;
  countEl: HTMLElement;
  /** Second-row grid cells (replace field + actions). Hidden when collapsed. */
  row2: HTMLElement[];
  expandBtn: HTMLButtonElement;
  query: SearchQuery;
  expanded: boolean;

  constructor(readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.expanded = view.state.field(searchOpenMode) === "replace" && !view.state.readOnly;
    this.commit = this.commit.bind(this);

    this.searchField = el("input", {
      value: this.query.search,
      placeholder: "Search",
      "aria-label": "Search",
      class: "cm-textfield cm-search-idea-input",
      name: "search",
      form: "",
      "main-field": "true",
      onchange: this.commit,
      oninput: this.commit,
    }) as HTMLInputElement;

    this.replaceField = el("input", {
      value: this.query.replace,
      placeholder: "Replace",
      "aria-label": "Replace",
      class: "cm-textfield cm-search-idea-input",
      name: "replace",
      form: "",
      onchange: this.commit,
      oninput: this.commit,
    }) as HTMLInputElement;

    this.caseBtn = iconBtn("case", "Match Case", "Cc", () => this.toggle("caseSensitive"), {
      pressed: this.query.caseSensitive,
    });
    this.wordBtn = iconBtn("word", "Words", "W", () => this.toggle("wholeWord"), {
      pressed: this.query.wholeWord,
    });
    this.reBtn = iconBtn("re", "Regex", ".*", () => this.toggle("regexp"), {
      pressed: this.query.regexp,
    });

    this.countEl = el(
      "span",
      { class: "cm-search-idea-count" },
      formatMatchCount(view, this.query),
    );

    this.expandBtn = el(
      "button",
      {
        type: "button",
        class: "cm-search-idea-expand",
        title: "Toggle Replace",
        "aria-label": "Toggle Replace",
        "aria-expanded": this.expanded ? "true" : "false",
        onclick: (e) => {
          e.preventDefault();
          this.setExpanded(!this.expanded, true);
        },
      },
      this.expanded ? "▾" : "▸",
    ) as HTMLButtonElement;

    const findField = el(
      "div",
      { class: "cm-search-idea-field cm-search-idea-find-field" },
      el("span", { class: "cm-search-idea-leading", "aria-hidden": "true" }, "⌕"),
      this.searchField,
    );

    const toggles = el(
      "div",
      { class: "cm-search-idea-toggles" },
      this.caseBtn,
      this.wordBtn,
      this.reBtn,
    );

    const prevBtn = iconBtn("prev", "Previous Match", "↑", () => {
      findPrevious(view);
    }, { className: "cm-search-idea-nav cm-search-idea-prev" });
    const nextBtn = iconBtn("next", "Next Match", "↓", () => {
      findNext(view);
    }, { className: "cm-search-idea-nav cm-search-idea-next" });

    const closeBtn = el(
      "button",
      {
        type: "button",
        name: "close",
        class: "cm-search-idea-close",
        title: "Close",
        "aria-label": "Close",
        onclick: (e) => {
          e.preventDefault();
          closeSearchPanel(view);
          view.focus();
        },
      },
      "×",
    );

    // Row 2 cells — always in the tree; grid + .cm-search-idea-expanded shows them.
    const replaceField = el(
      "div",
      { class: "cm-search-idea-field cm-search-idea-replace-field cm-search-idea-row2" },
      el("span", { class: "cm-search-idea-leading", "aria-hidden": "true" }, "⌕"),
      this.replaceField,
    );

    const replaceActions = el(
      "div",
      { class: "cm-search-idea-replace-actions cm-search-idea-row2" },
      ...(view.state.readOnly
        ? []
        : [
            el(
              "button",
              {
                type: "button",
                name: "replace",
                class: "cm-search-idea-action",
                onclick: (e) => {
                  e.preventDefault();
                  replaceNext(view);
                },
              },
              "Replace",
            ),
            el(
              "button",
              {
                type: "button",
                name: "replaceAll",
                class: "cm-search-idea-action",
                onclick: (e) => {
                  e.preventDefault();
                  replaceAll(view);
                },
              },
              "Replace All",
            ),
          ]),
    );

    this.row2 = [replaceField, replaceActions];

    // Flat grid children — columns: expand | field | toggles | count | prev | next | close
    this.dom = el(
      "div",
      {
        class: "cm-search cm-search-idea",
        onkeydown: (e) => this.keydown(e as KeyboardEvent),
      },
      this.expandBtn,
      findField,
      toggles,
      this.countEl,
      prevBtn,
      nextBtn,
      closeBtn,
      replaceField,
      replaceActions,
    );

    this.applyExpanded();
  }

  /** Expand/collapse replace row; optionally move focus. */
  setExpanded(on: boolean, focus = false) {
    if (this.view.state.readOnly) on = false;
    this.expanded = on;
    this.applyExpanded();
    if (focus) {
      if (on) this.focusReplace();
      else this.focusFind();
    }
  }

  focusFind() {
    this.searchField.focus();
    this.searchField.select();
  }

  focusReplace() {
    if (this.view.state.readOnly) {
      this.focusFind();
      return;
    }
    this.expanded = true;
    this.applyExpanded();
    this.replaceField.focus();
    this.replaceField.select();
  }

  /** Sync DOM + a11y with `expanded`. CSS grid uses `.cm-search-idea-expanded` for row 2. */
  private applyExpanded() {
    const show = this.expanded && !this.view.state.readOnly;
    this.dom.classList.toggle("cm-search-idea-expanded", show);
    this.expandBtn.setAttribute("aria-expanded", show ? "true" : "false");
    this.expandBtn.textContent = show ? "▾" : "▸";
    for (const cell of this.row2) cell.hidden = !show;
  }

  private toggle(key: "caseSensitive" | "wholeWord" | "regexp") {
    const q = this.query;
    const next = new SearchQuery({
      search: q.search,
      replace: q.replace,
      caseSensitive: key === "caseSensitive" ? !q.caseSensitive : q.caseSensitive,
      wholeWord: key === "wholeWord" ? !q.wholeWord : q.wholeWord,
      regexp: key === "regexp" ? !q.regexp : q.regexp,
    });
    this.applyQuery(next);
    this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  private press(btn: HTMLButtonElement, on: boolean) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("cm-search-idea-on", on);
  }

  private applyQuery(q: SearchQuery) {
    this.query = q;
    this.searchField.value = q.search;
    this.replaceField.value = q.replace;
    this.press(this.caseBtn, q.caseSensitive);
    this.press(this.wordBtn, q.wholeWord);
    this.press(this.reBtn, q.regexp);
    this.countEl.textContent = formatMatchCount(this.view, q);
  }

  commit() {
    const q = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp,
    });
    if (!q.eq(this.query)) {
      this.query = q;
      this.countEl.textContent = formatMatchCount(this.view, q);
      this.view.dispatch({ effects: setSearchQuery.of(q) });
    }
  }

  keydown(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
    } else if (e.key === "Enter" && e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(this.view);
      this.view.focus();
    }
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.applyQuery(effect.value);
        }
        if (effect.is(setSearchOpenMode)) {
          // Mode owns row-2 visibility; focus follows.
          if (effect.value === "replace") this.setExpanded(true, true);
          else this.setExpanded(false, true);
        }
      }
    }
    if (update.docChanged || update.selectionSet) {
      this.countEl.textContent = formatMatchCount(this.view, this.query);
    }
  }

  mount() {
    if (this.view.state.field(searchOpenMode) === "replace") this.focusReplace();
    else this.focusFind();
  }

  get pos() {
    return 80;
  }

  get top() {
    return true;
  }
}

export function createIdeaSearchPanel(view: EditorView): Panel {
  return new IdeaSearchPanel(view);
}

function ideaPanel(view: EditorView): IdeaSearchPanel | null {
  return getPanel(view, createIdeaSearchPanel) as IdeaSearchPanel | null;
}

// ── commands ─────────────────────────────────────────────────────────────

/** Open find (collapsed). Focuses the search field. */
export const openIdeaSearch: Command = (view) => {
  view.dispatch({ effects: setSearchOpenMode.of("find") });
  openSearchPanel(view);
  // openSearchPanel focuses main-field; ensure collapsed if was expanded
  const panel = ideaPanel(view);
  if (panel) panel.setExpanded(false, true);
  return true;
};

/** Open find-replace (expanded). Focuses the replace field. */
export const openIdeaReplace: Command = (view) => {
  if (view.state.readOnly) return openIdeaSearch(view);
  view.dispatch({ effects: setSearchOpenMode.of("replace") });
  openSearchPanel(view);
  // Stock openSearchPanel re-focuses main-field when already open — override.
  const panel = ideaPanel(view);
  if (panel) panel.focusReplace();
  return true;
};

/**
 * Keymap: Mod-f find, Mod-Alt-f replace; rest of searchKeymap without Mod-f.
 * Undo/redo are re-bound for `search-panel` scope — stock historyKeymap is
 * editor-only, so Mod-z in the strip would otherwise no-op (or undo the input).
 */
export const ideaSearchKeymap: readonly KeyBinding[] = [
  { key: "Mod-f", run: openIdeaSearch, scope: "editor search-panel" },
  { key: "Mod-Alt-f", run: openIdeaReplace, scope: "editor search-panel" },
  // History — panel-scoped only (editor already has historyKeymap).
  { key: "Mod-z", run: undo, scope: "search-panel", preventDefault: true },
  { key: "Mod-y", mac: "Mod-Shift-z", run: redo, scope: "search-panel", preventDefault: true },
  { linux: "Ctrl-Shift-z", run: redo, scope: "search-panel", preventDefault: true },
  ...searchKeymap.filter((b) => b.key !== "Mod-f"),
];

// ── chrome styles (IDEA Darcula strip) ────────────────────────────────────

export const ideaSearchTheme: Extension = EditorView.theme({
  // Single grid: row1 = find chrome, row2 = replace (only when .cm-search-idea-expanded).
  // Columns: expand | field | toggles | count | prev | next | close
  ".cm-panel.cm-search.cm-search-idea": {
    display: "grid",
    // Last track is a dedicated close column (form-theme absolutely positions stock [name=close]).
    gridTemplateColumns: "1lh minmax(12ch, 1fr) auto auto auto auto 1lh",
    gridTemplateRows: "1lh",
    alignItems: "center",
    gap: "0",
    padding: "0",
    fontFamily: 'var(--font-mono, "JetBrains Mono", ui-monospace, monospace)',
    backgroundColor: "inherit",
    border: "none",
    boxShadow: "none",
    fontSize: "1rem",
    boxSizing: "border-box",
    // Kill stock search-panel absolute close + side padding for this panel only.
    position: "relative",
    "& [name=close]": {
      position: "static",
      top: "auto",
      right: "auto",
    },
  },
  ".cm-panel.cm-search.cm-search-idea.cm-search-idea-expanded": {
    gridTemplateRows: "1lh 1lh",
  },

  // ── placement ──────────────────────────────────────────────────────────
  ".cm-search-idea-expand": {
    gridColumn: "1",
    gridRow: "1",
    width: "100%",
    height: "100%",
    padding: "0",
    border: "none",
    background: "transparent",
    color: "oklch(0.75 0 0)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: "1",
    "&:hover": {
      color: "oklch(0.92 0 0)",
    },
  },
  ".cm-search-idea-find-field": {
    gridColumn: "2",
    gridRow: "1",
  },
  ".cm-search-idea-toggles": {
    gridColumn: "3",
    gridRow: "1",
    display: "flex",
    alignItems: "center",
    gap: "2px",
    margin: "0 1ch",
  },
  ".cm-search-idea-count": {
    gridColumn: "4",
    gridRow: "1",
    minWidth: "4.5em",
    textAlign: "right",
    color: "oklch(0.6 0 0)",
    fontSize: "11px",
    userSelect: "none",
    padding: "0 4px",
  },
  ".cm-search-idea-prev": {
    gridColumn: "5",
    gridRow: "1",
  },
  ".cm-search-idea-next": {
    gridColumn: "6",
    gridRow: "1",
  },
  ".cm-search-idea-close": {
    gridColumn: "7",
    gridRow: "1",
    width: "100%",
    height: "100%",
    padding: "0",
    margin: "0",
    border: "none",
    background: "transparent",
    color: "oklch(0.6 0 0)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: "1",
    "&:hover": {
      color: "oklch(0.92 0 0)",
    },
  },
  // Row 2 — participate only when expanded (hidden attr + class both gate)
  ".cm-search-idea-replace-field": {
    gridColumn: "2",
    gridRow: "2",
  },
  // Span toggles→next only — leave close column free
  ".cm-search-idea-replace-actions": {
    gridColumn: "3 / 7",
    gridRow: "2",
    display: "flex",
    alignItems: "center",
    gap: "1ch",
    margin: "0 1ch",
  },
  // Collapsed: ensure row2 never paints even if hidden is stripped
  ".cm-search-idea:not(.cm-search-idea-expanded) > .cm-search-idea-row2": {
    display: "none",
  },

  // ── field chrome ───────────────────────────────────────────────────────
  ".cm-search-idea-field": {
    display: "flex",
    alignItems: "center",
    gap: "1ch",
    minWidth: "0",
    background: "transparent",
    borderStyle: "solid",
    borderColor: "oklch(1 0 0 / 0.1)",
    borderWidth: "0 1px",
    borderRadius: "0",
    padding: "0 0.5ch",
    height: "1lh",
    boxSizing: "border-box",
  },
  // Continuous border box when both fields stack in column 2
  ".cm-search-idea-expanded .cm-search-idea-find-field": {
    borderWidth: "0 1px 0",
  },
  ".cm-search-idea-expanded .cm-search-idea-replace-field": {
    borderWidth: "1px 1px 0",
  },
  ".cm-search-idea-leading": {
    color: "oklch(0.55 0 0)",
    userSelect: "none",
  },
  ".cm-search-idea-input.cm-textfield, .cm-search-idea .cm-textfield": {
    flex: "1 1 auto",
    minWidth: "0",
    border: "none",
    background: "transparent",
    padding: "0",
    margin: "0",
    fontSize: "12px",
    height: "20px",
    color: "oklch(0.92 0 0)",
    fontFamily: "inherit",
    borderRadius: "0",
    boxShadow: "none",
    outline: "none",
    "&:focus": {
      border: "none",
      outline: "none",
    },
  },
  ".cm-search-idea-iconbtn": {
    minWidth: "22px",
    height: "22px",
    padding: "0 4px",
    margin: "0",
    border: "1px solid transparent",
    borderRadius: "3px",
    background: "transparent",
    color: "oklch(0.7 0 0)",
    fontFamily: "inherit",
    fontSize: "11px",
    fontWeight: "600",
    lineHeight: "20px",
    cursor: "pointer",
    "&:hover": {
      background: "oklch(1 0 0 / 0.08)",
      color: "oklch(0.9 0 0)",
    },
  },
  ".cm-search-idea-iconbtn.cm-search-idea-on": {
    background: "oklch(0.55 0.08 250 / 0.35)",
    borderColor: "oklch(0.55 0.1 250 / 0.5)",
    color: "oklch(0.92 0.04 250)",
  },
  ".cm-search-idea-iconbtn.cm-search-idea-nav": {
    fontSize: "12px",
    fontWeight: "500",
  },
  ".cm-search-idea-action": {
    height: "1lh",
    padding: "0 1ch",
    margin: "0",
    border: "1px solid oklch(1 0 0 / 0.18)",
    borderRadius: "4px",
    background: "transparent",
    color: "oklch(0.85 0 0)",
    fontFamily: "inherit",
    fontSize: "11px",
    cursor: "pointer",
    "&:hover": {
      background: "oklch(1 0 0 / 0.08)",
      borderColor: "oklch(1 0 0 / 0.28)",
    },
    "&:active": {
      background: "oklch(1 0 0 / 0.12)",
    },
  },
  ".cm-panel.cm-search.cm-search-idea input, .cm-panel.cm-search.cm-search-idea button, .cm-panel.cm-search.cm-search-idea label":
    {
      margin: "0",
    },
});

// ── public extension ─────────────────────────────────────────────────────

export interface IdeaSearchOptions {
  /** Prefer top strip (IDEA default). Default true. */
  top?: boolean;
  /** Case-sensitive by default when the panel opens. */
  caseSensitive?: boolean;
  literal?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}

/**
 * Hermetic IDEA-style search. Compose with `theme` — do not also add bare `search()`
 * or `searchKeymap` (this includes both).
 */
export function ideaSearch(options: IdeaSearchOptions = {}): Extension {
  const { top = true, caseSensitive, literal, wholeWord, regexp } = options;
  return [
    searchOpenMode,
    ideaSearchTheme,
    search({
      top,
      caseSensitive,
      literal,
      wholeWord,
      regexp,
      createPanel: createIdeaSearchPanel,
    }),
    keymap.of(ideaSearchKeymap),
  ];
}

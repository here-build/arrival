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
  replaceRow: HTMLElement;
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

    const findRow = el(
      "div",
      { class: "cm-search-idea-row cm-search-idea-find" },
      this.expandBtn,
      el(
        "div",
        { class: "cm-search-idea-field" },
        el("span", { class: "cm-search-idea-leading", "aria-hidden": "true" }, "⌕"),
        this.searchField,
      ),
      el("div", { class: "cm-search-idea-toggles" }, this.caseBtn, this.wordBtn, this.reBtn),
      this.countEl,
      iconBtn("prev", "Previous Match", "↑", () => {
        findPrevious(view);
      }, { className: "cm-search-idea-nav" }),
      iconBtn("next", "Next Match", "↓", () => {
        findNext(view);
      }, { className: "cm-search-idea-nav" }),
      el(
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
      ),
    );

    const replaceActions: Node[] = view.state.readOnly
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
        ];

    this.replaceRow = el(
      "div",
      { class: "cm-search-idea-row cm-search-idea-replace" },
      el("div", { class: "cm-search-idea-expand-spacer", "aria-hidden": "true" }),
      el(
        "div",
        { class: "cm-search-idea-field" },
        el("span", { class: "cm-search-idea-leading", "aria-hidden": "true" }, "⌕"),
        this.replaceField,
      ),
      el("div", { class: "cm-search-idea-replace-actions" }, ...replaceActions),
    );

    this.dom = el(
      "div",
      {
        class: "cm-search cm-search-idea",
        onkeydown: (e) => this.keydown(e as KeyboardEvent),
      },
      findRow,
      this.replaceRow,
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

  private applyExpanded() {
    this.dom.classList.toggle("cm-search-idea-expanded", this.expanded);
    this.expandBtn.setAttribute("aria-expanded", this.expanded ? "true" : "false");
    this.expandBtn.textContent = this.expanded ? "▾" : "▸";
    this.replaceRow.hidden = !this.expanded || this.view.state.readOnly;
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
          if (effect.value === "replace") this.focusReplace();
          else this.focusFind();
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

/** Keymap: Mod-f find, Mod-Alt-f replace; rest of searchKeymap without Mod-f. */
export const ideaSearchKeymap: readonly KeyBinding[] = [
  { key: "Mod-f", run: openIdeaSearch, scope: "editor search-panel" },
  { key: "Mod-Alt-f", run: openIdeaReplace, scope: "editor search-panel" },
  ...searchKeymap.filter((b) => b.key !== "Mod-f"),
];

// ── chrome styles (IDEA Darcula strip) ────────────────────────────────────

export const ideaSearchTheme: Extension = EditorView.theme({
  ".cm-panel.cm-search.cm-search-idea": {
    padding: "0",
    fontFamily: 'var(--font-mono, "JetBrains Mono", ui-monospace, monospace)',
    backgroundColor: "#3c3f41",
    color: "oklch(0.85 0 0)",
    border: "none",
    boxShadow: "none",
    fontSize: "12px",
  },
  ".cm-search-idea-row": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    minHeight: "28px",
    boxSizing: "border-box",
  },
  ".cm-search-idea-find": {
    borderBottom: "1px solid oklch(1 0 0 / 0.06)",
  },
  ".cm-search-idea-expand": {
    flex: "0 0 auto",
    width: "20px",
    height: "20px",
    padding: "0",
    border: "1px solid oklch(1 0 0 / 0.12)",
    borderRadius: "4px",
    background: "oklch(0 0 0 / 0.2)",
    color: "oklch(0.75 0 0)",
    cursor: "pointer",
    fontSize: "10px",
    lineHeight: "18px",
    textAlign: "center",
    "&:hover": {
      background: "oklch(1 0 0 / 0.08)",
      color: "oklch(0.92 0 0)",
    },
  },
  ".cm-search-idea-expand-spacer": {
    flex: "0 0 auto",
    width: "20px",
  },
  ".cm-search-idea-field": {
    flex: "1 1 auto",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "120px",
    background: "oklch(0 0 0 / 0.28)",
    border: "1px solid oklch(1 0 0 / 0.1)",
    borderRadius: "4px",
    padding: "0 6px",
    height: "22px",
    boxSizing: "border-box",
  },
  ".cm-search-idea-leading": {
    color: "oklch(0.55 0 0)",
    fontSize: "13px",
    userSelect: "none",
  },
  ".cm-search-idea-input.cm-textfield, .cm-search-idea .cm-textfield": {
    flex: "1 1 auto",
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
  ".cm-search-idea-toggles": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    flex: "0 0 auto",
  },
  ".cm-search-idea-iconbtn": {
    flex: "0 0 auto",
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
  ".cm-search-idea-count": {
    flex: "0 0 auto",
    minWidth: "4.5em",
    textAlign: "right",
    color: "oklch(0.6 0 0)",
    fontSize: "11px",
    userSelect: "none",
    padding: "0 4px",
  },
  ".cm-search-idea-close": {
    flex: "0 0 auto",
    width: "22px",
    height: "22px",
    padding: "0",
    margin: "0",
    border: "none",
    background: "transparent",
    color: "oklch(0.6 0 0)",
    fontSize: "14px",
    lineHeight: "20px",
    cursor: "pointer",
    borderRadius: "3px",
    "&:hover": {
      color: "oklch(0.92 0 0)",
      background: "oklch(1 0 0 / 0.08)",
    },
  },
  ".cm-search-idea-replace-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flex: "0 0 auto",
    marginLeft: "auto",
  },
  ".cm-search-idea-action": {
    height: "22px",
    padding: "0 10px",
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

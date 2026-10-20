// Read-only CodeMirror for `.scheme-sample` blocks. The highlighter is the
// product language mode; the fallback `<pre>` stays in the DOM for search.

type SampleModules = {
  EditorState: typeof import("@codemirror/state").EditorState;
  EditorView: typeof import("@codemirror/view").EditorView;
  schemeSugarcoat: typeof import("@here.build/arrival-codemirror/language").schemeSugarcoat;
  theme: typeof import("@here.build/editor-theme").theme;
};

let modules: Promise<SampleModules> | undefined;

function loadModules(): Promise<SampleModules> {
  modules ??= Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@here.build/arrival-codemirror/language"),
    import("@here.build/editor-theme"),
  ]).then(([state, view, language, editorTheme]) => ({
    EditorState: state.EditorState,
    EditorView: view.EditorView,
    schemeSugarcoat: language.schemeSugarcoat,
    theme: editorTheme.theme,
  }));
  return modules;
}

export async function mountSchemeSamples(root: ParentNode = document): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>(".scheme-sample:not([data-mounted])")];
  if (nodes.length === 0) return;
  const { EditorState, EditorView, schemeSugarcoat, theme } = await loadModules();

  for (const el of nodes) {
    const source = el.querySelector(".scheme-sample-source");
    const doc = source?.textContent ?? "";
    const host = document.createElement("div");
    host.className = "scheme-sample-editor";
    el.append(host);
    new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-readonly": "true" }),
          schemeSugarcoat(),
          theme,
        ],
      }),
    });
    el.dataset.mounted = "true";
    el.classList.add("is-live");
  }
}

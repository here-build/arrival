// Turn scheme / scm / sugarcoat fences into a read-only sample the page can
// mount with arrival-codemirror. The source stays in the HTML for no-JS readers.

const schemeLangs = new Set(["scheme", "scm", "sugarcoat"]);

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function schemeSamplePlugin() {
  return {
    name: "scheme-samples",
    code(node) {
      if (!schemeLangs.has(node.lang)) return;
      const code = escapeHtml(node.value ?? "");
      return {
        type: "html",
        value: `<div class="scheme-sample" data-lang="${node.lang}"><pre class="scheme-sample-source"><span>${code}</span></pre></div>`,
      };
    },
  };
}

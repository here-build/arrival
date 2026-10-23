// Routing table for the documentation site. Each entry is a view of a file
// that already owns the text. `out` is the Starlight path under src/content/docs/.
// `label` is only the sidebar name; the page title stays the source heading.

export const site = "https://here-build.github.io";
export const base = "/arrival";

/** @type {{ source: string, out: string, order: number, label: string }[]} */
export const mounts = [
  { source: "packages/arrival-sugarcoat/LEARN.md", out: "language/sugarcoat.md", order: 1, label: "Learn Sugarcoat" },
  {
    source: "packages/arrival-sugarcoat/GRAMMAR.md",
    out: "language/sugarcoat-grammar.md",
    order: 2,
    label: "Sugarcoat grammar",
  },

  {
    source: "packages/arrival/docs/writing-capabilities.md",
    out: "capabilities/authoring.md",
    order: 1,
    label: "Writing capabilities",
  },

  {
    source: "packages/arrival/docs/reference/r7rs-coverage.md",
    out: "reference/r7rs.md",
    order: 1,
    label: "R7RS coverage",
  },
  {
    source: "packages/arrival/docs/reference/srfi-coverage.md",
    out: "reference/srfi.md",
    order: 2,
    label: "SRFI coverage",
  },
  {
    source: "packages/arrival/docs/reference/r7rs-symbol-map.md",
    out: "reference/symbols.md",
    order: 3,
    label: "Symbol index",
  },

  { source: "packages/arrival/docs/llm-agent-card.md", out: "agents/card.md", order: 1, label: "Agent card" },
  {
    source: "packages/arrival/docs/llm-language-guide.md",
    out: "agents/language.md",
    order: 2,
    label: "Language inventory",
  },

  { source: "packages/arrival/README.md", out: "packages/arrival.md", order: 1, label: "@here.build/arrival" },
  {
    source: "packages/arrival-cli/README.md",
    out: "packages/arrival-cli.md",
    order: 2,
    label: "@here.build/arrival-cli",
  },
  {
    source: "packages/arrival-codemirror/README.md",
    out: "packages/arrival-codemirror.md",
    order: 3,
    label: "@here.build/arrival-codemirror",
  },
  {
    source: "packages/arrival-env/README.md",
    out: "packages/arrival-env.md",
    order: 13,
    label: "@here.build/arrival-env",
  },
  {
    source: "packages/arrival-internals-types-prelude/README.md",
    out: "packages/arrival-internals-types-prelude.md",
    order: 4,
    label: "@here.build/arrival-internals-types-prelude",
  },
  {
    source: "packages/arrival-lsp/README.md",
    out: "packages/arrival-lsp.md",
    order: 5,
    label: "@here.build/arrival-lsp",
  },
  {
    source: "packages/arrival-modules/README.md",
    out: "packages/arrival-modules.md",
    order: 6,
    label: "@here.build/arrival-modules",
  },
  {
    source: "packages/arrival-overridable-lens/README.md",
    out: "packages/arrival-overridable-lens.md",
    order: 7,
    label: "@here.build/arrival-overridable-lens",
  },
  {
    source: "packages/arrival-provenance/README.md",
    out: "packages/arrival-provenance.md",
    order: 8,
    label: "@here.build/arrival-provenance",
  },
  {
    source: "packages/arrival-serializer/README.md",
    out: "packages/arrival-serializer.md",
    order: 9,
    label: "@here.build/arrival-serializer",
  },
  {
    source: "packages/arrival-sugarcoat/README.md",
    out: "packages/arrival-sugarcoat.md",
    order: 10,
    label: "@here.build/arrival-sugarcoat",
  },
  {
    source: "packages/arrival-syntax/README.md",
    out: "packages/arrival-syntax.md",
    order: 11,
    label: "@here.build/arrival-syntax",
  },
  {
    source: "packages/arrival-types-bridge/README.md",
    out: "packages/arrival-types-bridge.md",
    order: 12,
    label: "@here.build/arrival-types-bridge",
  },

  { source: "packages/arrival/docs/README.md", out: "internals/index.md", order: 1, label: "Overview" },
  { source: "packages/arrival/docs/PRINCIPLES.md", out: "internals/principles.md", order: 2, label: "Principles" },
  { source: "packages/arrival/docs/RULINGS.md", out: "internals/rulings.md", order: 3, label: "Rulings" },
  { source: "packages/arrival/docs/GLOSSARY.md", out: "internals/glossary.md", order: 4, label: "Glossary" },
  { source: "packages/arrival/docs/strata.md", out: "internals/strata.md", order: 5, label: "Strata" },
  { source: "packages/arrival/docs/grammar.md", out: "internals/grammar.md", order: 6, label: "Grammar" },
  {
    source: "packages/arrival/docs/environments.md",
    out: "internals/environments.md",
    order: 7,
    label: "Environments",
  },
  { source: "packages/arrival/docs/membrane.md", out: "internals/membrane.md", order: 8, label: "Membrane" },
  { source: "packages/arrival/docs/execution.md", out: "internals/execution.md", order: 9, label: "Run model" },
  { source: "packages/arrival/docs/PROVENANCE.md", out: "internals/provenance.md", order: 10, label: "Provenance" },
  {
    source: "packages/arrival/docs/static-plane.md",
    out: "internals/static-plane.md",
    order: 11,
    label: "Static plane",
  },
  {
    source: "packages/arrival/docs/test-suite-architecture.md",
    out: "internals/test-suite.md",
    order: 12,
    label: "Test suite",
  },
];

/** Directories the generator owns. Handwritten pages must not live here. */
export const generatedDirs = ["internals", "packages", "reference", "agents"];

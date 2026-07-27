import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useRef } from "react";
import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { linter, lintGutter, lintKeymap, openLintPanel, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";

import { ideaSearch, openIdeaReplace, openIdeaSearch, theme } from "../index.js";
import { EditorHarness, StoryShell } from "./EditorHarness.js";
import "../fonts.css";

const SAMPLE = `/**
 * Compensated Darcula + full chrome.
 * Try: Ctrl/Cmd-F · Ctrl/Cmd-Alt-F · Ctrl-Space · hover the bad call · F8
 */
function greet(name: string): string {
  return "hello, " + name;
}

// deliberate issues for lint + completion demos
const n = greett("world");
const unused = 42;

export { greet, n };
`;

function baseExtensions(extra: Extension[] = []): Extension[] {
  return [
    theme,
    ideaSearch(),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    javascript({ typescript: true }),
    history(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    ...extra,
  ];
}

const completions = [
  { label: "greet", type: "function", detail: "(name: string) => string" },
  { label: "console", type: "variable", detail: "Console" },
  { label: "const", type: "keyword" },
  { label: "function", type: "keyword" },
  { label: "return", type: "keyword" },
  { label: "export", type: "keyword" },
];

function demoCompletions(context: CompletionContext) {
  const word = context.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: completions,
  };
}

function demoLinter(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  const out: Diagnostic[] = [];
  const bad = text.indexOf("greett");
  if (bad >= 0) {
    out.push({
      from: bad,
      to: bad + 6,
      severity: "error",
      message: "Cannot find name 'greett'. Did you mean 'greet'?",
      source: "demo-ts(2304)",
      actions: [
        {
          name: "Replace with greet",
          apply(v, from, to) {
            v.dispatch({ changes: { from, to, insert: "greet" } });
          },
        },
      ],
    });
  }
  const unused = text.indexOf("unused");
  if (unused >= 0) {
    out.push({
      from: unused,
      to: unused + 6,
      severity: "warning",
      message: "'unused' is declared but never used.",
      source: "demo-ts(6133)",
    });
  }
  return out;
}

// ── stories ──────────────────────────────────────────────────────────────

function BasicStory() {
  return (
    <StoryShell title="Theme · body + syntax" hint="Darcula body, gutters, selection, active line, H-K syntax.">
      <EditorHarness doc={SAMPLE} extensions={baseExtensions().slice(1)} height={420} />
    </StoryShell>
  );
}

function SearchStory() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: SAMPLE,
        // baseExtensions already includes ideaSearch(); open find collapsed.
        extensions: baseExtensions(),
      }),
    });
    openIdeaSearch(view);
    return () => view.destroy();
  }, []);
  return (
    <StoryShell
      title="Theme · IDEA find panel"
      hint="Collapsed find (Mod-F). Chevron or Mod-Alt-F expands replace. Cc · W · .* toggles, ↑↓ nav."
    >
      <div
        ref={host}
        style={{
          height: 420,
          background: "oklch(0.2 0 211)",
          border: "1px solid oklch(0.34 0 0)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      />
    </StoryShell>
  );
}

function CompletionStory() {
  return (
    <StoryShell
      title="Theme · completion popup"
      hint="Ctrl-Space (or type a letter). Icons hidden; detail in Monaspace Krypton; selected row wash."
    >
      <EditorHarness
        doc={SAMPLE}
        height={420}
        extensions={baseExtensions([
          autocompletion({
            override: [demoCompletions],
            activateOnTyping: true,
            defaultKeymap: true,
          }),
        ]).slice(1)}
      />
    </StoryShell>
  );
}

function LintStory() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: baseExtensions([
          linter(demoLinter, { delay: 200 }),
          lintGutter(),
        ]),
      }),
    });
    openLintPanel(view);
    return () => view.destroy();
  }, []);
  return (
    <StoryShell
      title="Theme · lint squiggles + panel"
      hint="Severity colors match Darcula alarm tiers. Panel selection is not OS Highlight. Source line hidden."
    >
      <div
        ref={host}
        style={{
          height: 480,
          background: "oklch(0.2 0 211)",
          border: "1px solid oklch(0.34 0 0)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      />
    </StoryShell>
  );
}

function ReplaceStory() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: baseExtensions(),
      }),
    });
    openIdeaReplace(view);
    return () => view.destroy();
  }, []);
  return (
    <StoryShell
      title="Theme · IDEA find + replace"
      hint="Mod-Alt-F opens expanded with replace focused. Same panel as find — chevron toggles the row."
    >
      <div
        ref={host}
        style={{
          height: 420,
          background: "oklch(0.2 0 211)",
          border: "1px solid oklch(0.34 0 0)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      />
    </StoryShell>
  );
}

function FullIdeStory() {
  return (
    <StoryShell
      title="Theme · full IDE surface"
      hint="IDEA search + lint + completion + fold + brackets. Mod-F / Mod-Alt-F."
    >
      <EditorHarness
        doc={SAMPLE}
        height="70vh"
        extensions={baseExtensions([
          linter(demoLinter, { delay: 200 }),
          lintGutter(),
          autocompletion({ override: [demoCompletions], activateOnTyping: true }),
          placeholder("Type here…"),
        ]).slice(1)}
      />
    </StoryShell>
  );
}

const meta = {
  title: "Editor Theme",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const BodyAndSyntax: Story = { render: () => <BasicStory /> };
export const SearchFind: Story = { render: () => <SearchStory /> };
export const SearchReplace: Story = { render: () => <ReplaceStory /> };
export const Completion: Story = { render: () => <CompletionStory /> };
export const Lint: Story = { render: () => <LintStory /> };
export const FullIdeSurface: Story = { render: () => <FullIdeStory /> };

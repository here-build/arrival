// Minimal React host for Storybook — mounts a real EditorView, no uiw wrapper.
import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { theme } from "../index.js";
import "../fonts.css";

export interface EditorHarnessProps {
  doc: string;
  extensions?: Extension[];
  /** Extra height for the story frame. Default 360. */
  height?: number | string;
}

export function EditorHarness({
  doc,
  extensions = [],
  height = 360,
}: EditorHarnessProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        extensions: [theme, ...extensions],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once per story identity; doc/extensions are initial only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        height: typeof height === "number" ? `${height}px` : height,
        minHeight: 0,
        background: "oklch(0.2 0 211)",
        border: "1px solid oklch(0.34 0 0)",
        borderRadius: 6,
        overflow: "hidden",
      }}
      ref={host}
    />
  );
}

export function StoryShell({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        boxSizing: "border-box",
        background: "#1a1a1a",
        color: "oklch(0.77 0 0)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600 }}>{title}</h1>
      {hint ? (
        <p style={{ margin: "0 0 16px", fontSize: 12, opacity: 0.65 }}>{hint}</p>
      ) : (
        <div style={{ height: 12 }} />
      )}
      {children}
    </div>
  );
}

// repl-ink — the Ink bottom-anchored TUI. Driven headlessly via ink-testing-library:
// write keystrokes to the mock stdin, assert the rendered frames. `mode="none"` keeps
// frames uncolored so assertions read the plain text. A real loader session backs it, so
// `(+ 1 2)` genuinely evaluates through emitForms/foldReplEvent.
import { render } from "ink-testing-library";
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReplApp } from "../repl-ink.js";
import { loaderSession, type LoaderSession } from "../session.js";

let session: LoaderSession;

beforeAll(async () => {
  session = await loaderSession(process.cwd(), "test-repl-ink");
});
afterAll(async () => {
  await session.ambient.dispose();
});

function mount() {
  return render(
    <ReplApp session={session} budgetMs={30_000} heapBudget={100_000_000} capabilityCount={0} version="test" mode="none" />,
  );
}

async function waitUntil(get: () => string | undefined, pred: (s: string) => boolean, ms = 3000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const frame = get() ?? "";
    if (pred(frame)) return frame;
    await new Promise((r) => setTimeout(r, 20));
  }
  return get() ?? "";
}

describe("replInk", () => {
  it("shows the prompt at the bottom on mount", () => {
    const { lastFrame, unmount } = mount();
    expect(lastFrame()).toContain("arrival>");
    unmount();
  });

  it("echoes typed input on the prompt line before submit", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)");
    const frame = await waitUntil(lastFrame, (f) => f.includes("(+ 1 2)"));
    expect(frame).toContain("(+ 1 2)");
    expect(frame).toContain("arrival>"); // still at the prompt, not yet submitted
    unmount();
  });

  it("evaluates a submitted form and shows the value in scrollback", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r"); // \r = Enter
    const frame = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(frame).toMatch(/\b3\b/); // the value
    unmount();
  });

  it("holds a multi-line form open until it closes (continuation)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1\r"); // unbalanced → continuation, NOT submitted
    const cont = await waitUntil(lastFrame, (f) => f.includes("..."));
    expect(cont).toContain("..."); // the CONTINUE prompt
    stdin.write(" 2)\r"); // now it closes
    const done = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(done).toMatch(/\b3\b/);
    unmount();
  });
});

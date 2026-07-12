// repl-ink — the Ink bottom-anchored TUI. Driven headlessly via ink-testing-library:
// write keystrokes to the mock stdin, assert the rendered frames. `mode="none"` keeps
// frames uncolored so assertions read the plain text. A real loader session backs it, so
// `(+ 1 2)` genuinely evaluates through emitForms/foldReplEvent.
import { render } from "ink-testing-library";
import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReplApp } from "../repl-ink.js";
import { loaderSession, type LoaderSession } from "../session.js";
import { stripAnsi } from "./ansi-strip.js";

const UP = "[A";
const DOWN = "[B";

/** The live input line (last line carrying the `>` / `.` prompt), stripped of color/cursor
 *  escapes. When at a fresh prompt it also carries the right-aligned `arrival …` status. */
function promptLine(frame: string | undefined): string {
  const lines = stripAnsi(frame ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    // `>`/`.` prompt (a trailing-space-only line is trimmed to just the glyph by Ink).
    if (l.startsWith(">") || l.startsWith(".")) return l;
  }
  return "";
}

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
  it("shows a minimal `>` prompt with right-aligned version status on mount", () => {
    const { lastFrame, unmount } = mount();
    const p = promptLine(lastFrame());
    expect(p.startsWith(">")).toBe(true);
    expect(p).toContain("arrival test"); // the far-right status
    unmount();
  });

  it("echoes typed input and HIDES the status once typing starts", async () => {
    const { stdin, lastFrame, unmount } = mount();
    expect(promptLine(lastFrame())).toContain("arrival test"); // shown at a fresh prompt
    stdin.write("(+ 1 2)");
    const frame = await waitUntil(lastFrame, (f) => promptLine(f).includes("(+ 1 2)"));
    expect(promptLine(frame)).toContain("(+ 1 2)");
    expect(promptLine(frame).startsWith(">")).toBe(true); // still at the prompt
    expect(promptLine(frame)).not.toContain("arrival test"); // status vanished on typing
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
    const cont = await waitUntil(lastFrame, (f) => promptLine(f).startsWith("."));
    expect(promptLine(cont).startsWith(".")).toBe(true); // the `.` continuation prompt
    expect(stripAnsi(cont)).toContain("(+ 1"); // the pending line held above
    stdin.write(" 2)\r"); // now it closes
    const done = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(done).toMatch(/\b3\b/);
    unmount();
  });

  it("arrow-up recalls previous submissions (newest first)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r");
    await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    stdin.write("(* 6 7)\r");
    await waitUntil(lastFrame, (f) => /\b42\b/.test(f));

    stdin.write(UP); // recall the newest — "(* 6 7)" — onto the prompt line
    const up1 = await waitUntil(lastFrame, (f) => promptLine(f).includes("(* 6 7)"));
    expect(promptLine(up1)).toContain("(* 6 7)");

    stdin.write(UP); // older — "(+ 1 2)"
    const up2 = await waitUntil(lastFrame, (f) => promptLine(f).includes("(+ 1 2)"));
    expect(promptLine(up2)).toContain("(+ 1 2)");
    unmount();
  });

  it("prefix match: typed text filters recall to matching entries", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(define a 1)\r");
    await waitUntil(lastFrame, (f) => f.includes("define"));
    stdin.write("(list 9)\r");
    await waitUntil(lastFrame, (f) => /\b9\b/.test(f));

    // type "(def" then Up → should jump past "(list 9)" straight to "(define a 1)"
    stdin.write("(def");
    await waitUntil(lastFrame, (f) => promptLine(f).includes("(def"));
    stdin.write(UP);
    const recalled = await waitUntil(lastFrame, (f) => promptLine(f).includes("(define a 1)"));
    expect(promptLine(recalled)).toContain("(define a 1)");
    expect(promptLine(recalled)).not.toContain("(list 9)"); // prefix filtered it out
    unmount();
  });
});

const CTRL_A = "";
const CTRL_W = "";
const ALT_F = "f";

describe("replInk block render", () => {
  it("shows execution time on the right, and no heap", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("(+ 1 2)\r");
    const frame = await waitUntil(lastFrame, (f) => /\b3\b/.test(f));
    expect(stripAnsi(frame)).toMatch(/\dms/); // elapsed time present
    expect(stripAnsi(frame)).not.toContain("heap"); // heap dropped
    unmount();
  });
});

describe("replInk cursor navigation", () => {
  const line = (f: string | undefined): string => promptLine(f).replace(/^>\s?/, "");
  it("Ctrl-A jumps to line start (insert lands at the front)", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("abc");
    await waitUntil(lastFrame, (f) => line(f).includes("abc"));
    stdin.write(CTRL_A);
    stdin.write("X");
    const f = await waitUntil(lastFrame, (ff) => line(ff).includes("Xabc"));
    expect(line(f)).toContain("Xabc");
    unmount();
  });
  it("Ctrl-W deletes the word before the cursor", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("foo bar");
    await waitUntil(lastFrame, (f) => line(f).includes("foo bar"));
    stdin.write(CTRL_W);
    const f = await waitUntil(lastFrame, (ff) => !line(ff).includes("bar"));
    expect(line(f).trimEnd()).toBe("foo");
    unmount();
  });
  it("Alt-f moves forward by word", async () => {
    const { stdin, lastFrame, unmount } = mount();
    stdin.write("foo bar");
    await waitUntil(lastFrame, (f) => line(f).includes("foo bar"));
    stdin.write(CTRL_A); // → line start
    stdin.write(ALT_F); // → after "foo"
    stdin.write("Z");
    const f = await waitUntil(lastFrame, (ff) => line(ff).includes("fooZ"));
    expect(line(f)).toContain("fooZ bar");
    unmount();
  });
});

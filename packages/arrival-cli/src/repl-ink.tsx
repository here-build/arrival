/**
 * The bottom-anchored TUI repl (V's "harness" layout, Ink): settled turns accumulate as
 * scrollback via `<Static>`, and the live region — the in-flight turn plus the input line —
 * stays pinned at the bottom, re-rendered each keystroke. This is the default TTY repl now;
 * `repl.ts`'s `replPlain` still serves the non-TTY (piped) path byte-identically.
 *
 * What's REUSED, not rebuilt: `emitForms` (parse → run each form → stream `ReplEvent`s) and
 * `foldReplEvent` (the Elm fold → `ReplBlock`s). Ink replaces only the OUTPUT mechanism —
 * the painter's cursor-up region repaint becomes Ink's declarative re-render, and `<Static>`
 * owns the scrollback the painter hand-managed. Source is syntax-highlighted (`highlight.ts`)
 * through the active lens; values are subtly colored (`sexpr-color.ts`).
 *
 * Input state lives in a ref (not useState) so the keystroke handler never reads a stale
 * line/cursor — a terminal editor cannot afford React's async-state lag mid-word.
 */
import React, { useCallback, useReducer, useRef, useState } from "react";
import { Box, render, Static, Text, useApp, useInput } from "ink";

import { scan } from "@here.build/arrival/oracle";
import {
  EMPTY_REPL_MODEL,
  foldReplEvent,
  type ReplBlock,
  type ReplBlockState,
  type ReplFoldModel,
} from "@here.build/mcp-substrate";

import { DISABLE_AUTOWRAP, ENABLE_AUTOWRAP } from "./ansi.js";
import { emitForms } from "./form-emitter.js";
import { pushHistory, recallNext, recallPrev, type NavState } from "./history-nav.js";
import { highlightScheme } from "./highlight.js";
import { colorizeSexpr } from "./sexpr-color.js";
import { toLens, type Lens } from "./lens.js";
import { paint, colorMode, type TintName } from "./tints.js";
import type { LoaderSession } from "./session.js";

type ColorMode = ReturnType<typeof colorMode>;

const GLYPH: Record<ReplBlockState, string> = { pending: "·", running: "▸", done: "✓", error: "✗", skipped: "·" };
const TINT: Record<ReplBlockState, TintName> = {
  pending: "pending",
  running: "running",
  done: "done",
  error: "error",
  skipped: "skipped",
};

const PROMPT = "> ";
const CONTINUE = ". ";

/** Does the buffer close (balanced parens/strings/blocks)? The oracle's own scanner — the
 *  one lexer that reads `#\(`, strings, `#|…|#` faithfully. Unscannable ⇒ let it submit and
 *  the reader's door teach. */
function closeable(src: string): boolean {
  try {
    return scan(src).closeable;
  } catch {
    return true;
  }
}

/** Previous word boundary from `cursor` (readline/Emacs M-b): skip trailing whitespace, then
 *  the word. */
function wordLeft(line: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(line[i - 1]!)) i -= 1;
  while (i > 0 && !/\s/.test(line[i - 1]!)) i -= 1;
  return i;
}
/** Next word boundary from `cursor` (M-f): skip whitespace, then the word. */
function wordRight(line: string, cursor: number): number {
  let i = cursor;
  while (i < line.length && /\s/.test(line[i]!)) i += 1;
  while (i < line.length && !/\s/.test(line[i]!)) i += 1;
  return i;
}

/** One block's lines. Source is highlighted through the lens; content (the value) subtly
 *  colored; the glyph carries state. Mirrors painter.ts's `renderBlock` but in Ink Text. */
function BlockView({ block, lens, mode }: { block: ReplBlock; lens: Lens; mode: ColorMode }): React.ReactElement {
  const glyph = paint(GLYPH[block.state], TINT[block.state], mode);
  const src = block.source === "" ? "" : highlightScheme(toLens(block.source, lens), mode);
  const srcLines = src.split("\n");
  // Execution time rides the FAR RIGHT of the source line (space-between, like the prompt
  // row's status) — heap is dropped (noise; the wall-clock is the number that reads).
  const elapsed =
    block.counters !== undefined && (block.state === "done" || block.state === "error")
      ? paint(`${block.counters.elapsedMs}ms`, "gutter", mode)
      : "";
  const rows: React.ReactElement[] = [
    <Box key="s0" justifyContent="space-between">
      <Text>{`${glyph} ${srcLines[0] ?? ""}`}</Text>
      {elapsed !== "" ? <Text>{elapsed}</Text> : null}
    </Box>,
  ];
  srcLines.slice(1).forEach((l, i) => rows.push(<Text key={`s${i + 1}`}>{`  ${l}`}</Text>));

  if (block.state === "skipped") {
    rows.push(<Text key="skip">{paint("  (skipped — an earlier form in this submission crashed)", "skipped", mode)}</Text>);
  } else {
    let ci = 0;
    for (const c of block.content) {
      if (c.type !== "text") continue;
      for (const line of colorizeSexpr(toLens(c.text, lens), mode).split("\n")) {
        const painted = block.state === "error" ? paint(line, "error", mode) : line;
        rows.push(<Text key={`c${ci++}`}>{`  ${painted}`}</Text>);
      }
    }
  }
  return <Box flexDirection="column">{rows}</Box>;
}

function TurnView({ blocks, lens, mode }: { blocks: readonly ReplBlock[]; lens: Lens; mode: ColorMode }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} lens={lens} mode={mode} />
      ))}
    </Box>
  );
}

interface InputBuffer {
  line: string;
  cursor: number;
  /** Committed continuation lines waiting for a closing form. */
  pending: string;
}

export interface ReplAppProps {
  readonly session: LoaderSession;
  readonly budgetMs: number;
  readonly heapBudget: number;
  readonly capabilityCount: number;
  readonly version: string;
  readonly mode?: ColorMode;
}

function ReplApp({ session, budgetMs, heapBudget, version, capabilityCount, mode = colorMode() }: ReplAppProps): React.ReactElement {
  const { exit } = useApp();
  const [history, setHistory] = useState<ReplBlock[][]>([]);
  const [running, setRunning] = useState<ReplFoldModel | null>(null);
  const [lens, setLens] = useState<Lens>("sugarcoat");
  const input = useRef<InputBuffer>({ line: "", cursor: 0, pending: "" });
  const cmdHistory = useRef<string[]>([]);
  const nav = useRef<NavState | null>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  const reset = useCallback((): void => {
    input.current = { line: "", cursor: 0, pending: "" };
    nav.current = null;
  }, []);

  /** Place a recalled entry into the buffer: a multi-line form restores its own
   *  pending/line split so the continuation state is faithful, cursor at end. */
  const applyEntry = (st: InputBuffer, entry: string): void => {
    const lines = entry.split("\n");
    st.pending = lines.slice(0, -1).join("\n");
    st.line = lines[lines.length - 1] ?? "";
    st.cursor = st.line.length;
  };

  const submit = useCallback(
    async (src: string): Promise<void> => {
      let model = EMPTY_REPL_MODEL;
      setRunning(model);
      await emitForms(src, {
        ambient: session.ambient,
        scope: session.scope,
        budgetMs,
        heapBudget,
        onEvent: (event) => {
          model = foldReplEvent(model, event);
          setRunning(model);
        },
      });
      setHistory((h) => [...h, [...model.blocks]]);
      setRunning(null);
    },
    [session, budgetMs, heapBudget],
  );

  const onEnter = useCallback(
    (full: string): void => {
      if (full.trim() === "") {
        reset();
        redraw();
        return;
      }
      if (full.trim() === ",lens") {
        setLens((l) => (l === "sugarcoat" ? "scheme" : "sugarcoat"));
        reset();
        redraw();
        return;
      }
      if (!closeable(full)) {
        input.current = { line: "", cursor: 0, pending: full }; // continuation
        redraw();
        return;
      }
      cmdHistory.current = pushHistory(cmdHistory.current, full);
      reset();
      redraw();
      void submit(full);
    },
    [reset, submit],
  );

  useInput(
    (ch, key) => {
      if (running !== null) return; // input is inert while a turn evaluates
      const st = input.current;

      if (key.ctrl && ch === "d") {
        exit();
        return;
      }
      if (key.ctrl && ch === "c") {
        if (st.line === "" && st.pending === "") exit();
        else {
          reset();
          redraw();
        }
        return;
      }
      // readline/Emacs line navigation + editing.
      if (key.ctrl && ch === "a") {
        st.cursor = 0; // line start (also Home on most terminals)
        redraw();
        return;
      }
      if (key.ctrl && ch === "e") {
        st.cursor = st.line.length; // line end (also End)
        redraw();
        return;
      }
      if (key.ctrl && ch === "u") {
        st.line = st.line.slice(st.cursor); // kill to line start
        st.cursor = 0;
        nav.current = null;
        redraw();
        return;
      }
      if (key.ctrl && ch === "k") {
        st.line = st.line.slice(0, st.cursor); // kill to line end
        nav.current = null;
        redraw();
        return;
      }
      if (key.ctrl && ch === "w") {
        const w = wordLeft(st.line, st.cursor); // kill word before cursor
        st.line = st.line.slice(0, w) + st.line.slice(st.cursor);
        st.cursor = w;
        nav.current = null;
        redraw();
        return;
      }
      // Alt/Option word navigation (M-b / M-f; Option+←/→ also arrive as meta on most terminals).
      if (key.meta && ch === "b") {
        st.cursor = wordLeft(st.line, st.cursor);
        redraw();
        return;
      }
      if (key.meta && ch === "f") {
        st.cursor = wordRight(st.line, st.cursor);
        redraw();
        return;
      }
      if (key.leftArrow) {
        // A word jump when Alt/Ctrl-modified (Option/Ctrl+←), else one char.
        st.cursor = key.meta || key.ctrl ? wordLeft(st.line, st.cursor) : Math.max(0, st.cursor - 1);
        redraw();
        return;
      }
      if (key.rightArrow) {
        st.cursor = key.meta || key.ctrl ? wordRight(st.line, st.cursor) : Math.min(st.line.length, st.cursor + 1);
        redraw();
        return;
      }
      // Prefix-match history recall (zsh / Chrome-console): Up matches entries starting with
      // the typed line; Down walks forward, past-newest restores the draft. Cursor moves
      // don't reset nav; a content edit (below) does.
      if (key.upArrow) {
        const r = recallPrev(cmdHistory.current, nav.current, st.line);
        if (r !== null) {
          nav.current = r.nav;
          applyEntry(st, r.entry);
          redraw();
        }
        return;
      }
      if (key.downArrow) {
        const r = recallNext(cmdHistory.current, nav.current);
        if (r !== null) {
          nav.current = r.nav;
          applyEntry(st, r.entry);
          redraw();
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (st.cursor > 0) {
          // Alt/Option+Backspace deletes the whole word before the cursor.
          const from = key.meta ? wordLeft(st.line, st.cursor) : st.cursor - 1;
          st.line = st.line.slice(0, from) + st.line.slice(st.cursor);
          st.cursor = from;
          nav.current = null; // editing rebases the prefix
          redraw();
        }
        return;
      }

      // A chunk can batch text + Enter (a paste, or a test's single `write("form\r")`): the
      // leading text is typed, then Enter fires. An interactive single Enter arrives as
      // `key.return` with no text. Peel the first newline; insert the text before it.
      let text = ch;
      let enter = key.return === true;
      if (!enter && (ch.includes("\r") || ch.includes("\n"))) {
        text = ch.slice(0, ch.search(/[\r\n]/));
        enter = true;
      }
      text = text.replace(/[\r\n]/g, "");

      if (text !== "" && !key.ctrl && !key.meta) {
        st.line = st.line.slice(0, st.cursor) + text + st.line.slice(st.cursor);
        st.cursor += text.length;
        nav.current = null; // typing rebases the prefix
      }
      if (enter) {
        onEnter(st.pending === "" ? st.line : `${st.pending}\n${st.line}`);
        return;
      }
      redraw();
    },
    { isActive: true },
  );

  const st = input.current;
  const promptStr = st.pending === "" ? PROMPT : CONTINUE;
  // The input line with a block cursor: split the RAW line at the cursor, highlight each
  // side, and inverse-video the character under the cursor (a space when at end-of-line).
  const before = highlightScheme(st.line.slice(0, st.cursor), mode);
  const atChar = st.line.slice(st.cursor, st.cursor + 1) || " ";
  const after = highlightScheme(st.line.slice(st.cursor + 1), mode);
  const pendingLines = st.pending === "" ? [] : st.pending.split("\n");

  // The far-right status — version · lens (· N caps). Shown only at a FRESH prompt (nothing
  // typed, no continuation); it vanishes the moment the user starts typing, leaving a bare `>`.
  const caps = capabilityCount > 0 ? ` · ${capabilityCount} cap${capabilityCount === 1 ? "" : "s"}` : "";
  const info = `arrival ${version} · ${lens}${caps}`;
  const showInfo = st.line === "" && st.pending === "";

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(turn, i) => <TurnView key={i} blocks={turn} lens={lens} mode={mode} />}
      </Static>
      {running !== null && <TurnView blocks={running.blocks} lens={lens} mode={mode} />}
      {pendingLines.map((l, i) => (
        <Text key={`p${i}`}>{paint(i === 0 ? PROMPT : CONTINUE, "gutter", mode) + highlightScheme(l, mode)}</Text>
      ))}
      {running === null && (
        <Box justifyContent="space-between">
          <Text>
            {paint(promptStr, "gutter", mode)}
            {before}
            <Text inverse>{atChar}</Text>
            {after}
          </Text>
          {showInfo ? <Text>{paint(info, "gutter", mode)}</Text> : null}
        </Box>
      )}
    </Box>
  );
}

/** Mount the Ink repl over a persistent loader session. No banner, no header — the version /
 *  lens status rides the far right of the prompt line and vanishes on the first keystroke.
 *  Resolves when the user exits (Ctrl-D). Caller disposes the ambient.
 *
 *  Autowrap is disabled for the session (Ink owns line-width layout; the terminal's own
 *  autowrap adds a phantom newline when a line fills to the edge) and restored on exit — via
 *  `signal-exit` too, so a Ctrl-C / signal never leaves the user's terminal no-wrap. */
export async function replInk(props: ReplAppProps): Promise<void> {
  const restore = (): void => {
    process.stdout.write(ENABLE_AUTOWRAP);
  };
  process.stdout.write(DISABLE_AUTOWRAP);
  process.once("exit", restore); // backstop for a signal that skips the finally
  try {
    const app = render(<ReplApp {...props} />);
    await app.waitUntilExit();
  } finally {
    process.removeListener("exit", restore);
    restore();
  }
}

export { ReplApp };

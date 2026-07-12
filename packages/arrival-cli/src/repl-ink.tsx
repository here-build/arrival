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

import { emitForms } from "./form-emitter.js";
import { identityLine } from "./greeting.js";
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

const PROMPT = "arrival> ";
const CONTINUE = "     ... ";

/** `12345` heap cells → `"1.2K"`. */
function formatCells(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

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

/** One block's lines. Source is highlighted through the lens; content (the value) subtly
 *  colored; the glyph carries state. Mirrors painter.ts's `renderBlock` but in Ink Text. */
function BlockView({ block, lens, mode }: { block: ReplBlock; lens: Lens; mode: ColorMode }): React.ReactElement {
  const glyph = paint(GLYPH[block.state], TINT[block.state], mode);
  const src = block.source === "" ? "" : highlightScheme(toLens(block.source, lens), mode);
  const srcLines = src.split("\n");
  const lines: React.ReactElement[] = [<Text key="s0">{`${glyph} ${srcLines[0] ?? ""}`}</Text>];
  srcLines.slice(1).forEach((l, i) => lines.push(<Text key={`s${i + 1}`}>{`  ${l}`}</Text>));

  if (block.state === "skipped") {
    lines.push(<Text key="skip">{paint("  (skipped — an earlier form in this submission crashed)", "skipped", mode)}</Text>);
  } else {
    let ci = 0;
    for (const c of block.content) {
      if (c.type !== "text") continue;
      for (const line of colorizeSexpr(toLens(c.text, lens), mode).split("\n")) {
        const painted = block.state === "error" ? paint(line, "error", mode) : line;
        lines.push(<Text key={`c${ci++}`}>{`  ${painted}`}</Text>);
      }
    }
    if (block.counters !== undefined && (block.state === "done" || block.state === "error")) {
      const { heapUsed, elapsedMs } = block.counters;
      lines.push(<Text key="ctr">{paint(`  heap ${formatCells(heapUsed)} · ${elapsedMs}ms`, "gutter", mode)}</Text>);
    }
  }
  return <Box flexDirection="column">{lines}</Box>;
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

function ReplApp({ session, budgetMs, heapBudget, mode = colorMode() }: ReplAppProps): React.ReactElement {
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
      if (key.leftArrow) {
        st.cursor = Math.max(0, st.cursor - 1);
        redraw();
        return;
      }
      if (key.rightArrow) {
        st.cursor = Math.min(st.line.length, st.cursor + 1);
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
          st.line = st.line.slice(0, st.cursor - 1) + st.line.slice(st.cursor);
          st.cursor -= 1;
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
        <Text>
          {paint(promptStr, "gutter", mode)}
          {before}
          <Text inverse>{atChar}</Text>
          {after}
        </Text>
      )}
    </Box>
  );
}

/** Mount the Ink repl over a persistent loader session. Prints the one-line identity header
 *  above the app (Ink renders inline — no alt-screen — so the header stays as scrollback),
 *  then resolves when the user exits (Ctrl-D). Caller disposes the ambient. */
export async function replInk(props: ReplAppProps): Promise<void> {
  const mode = props.mode ?? colorMode();
  process.stdout.write(`${identityLine({ version: props.version, capabilityCount: props.capabilityCount, lens: "sugarcoat" }, mode)}\n\n`);
  const app = render(<ReplApp {...props} />);
  await app.waitUntilExit();
}

export { ReplApp };

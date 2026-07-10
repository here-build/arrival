/**
 * `arrival repl` — a node:readline loop over ONE persistent session: the
 * loader-armed ambient (require works, rooted at cwd) paired with a single
 * session scope — defines land in the scope and accumulate across lines
 * (`execState(src, { ambient, scope })` reused every line, the same continuation
 * the cut idiom gives require-free callers). Each closeable buffer evaluates,
 * values print through the serializer, errors print as their teaching-door text
 * and the session SURVIVES them.
 *
 * Multi-line continuation is the oracle's own structural scanner (`scan(src).closeable`
 * — depth-0, not mid-string/comment), not a hand-rolled paren counter: the reader is
 * the one place that lexes `#\(`, strings, and `#|…|#` faithfully. A buffer the
 * scanner can't model is handed to the evaluator, whose reader error teaches.
 */
import readline from "node:readline";

import { execState, schemeToJs } from "@here.build/arrival";
import { scan } from "@here.build/arrival/oracle";

import { budgets, loaderSession, printError, printValue } from "./session.js";

const PROMPT = "arrival> ";
const CONTINUE = "     ... ";

function closeable(src: string): boolean {
  try {
    return scan(src).closeable;
  } catch {
    return true; // outside the scanner's model — let the reader's own error teach
  }
}

export async function repl(): Promise<number> {
  const { ambient, scope } = await loaderSession(process.cwd(), "arrival-repl");
  const interactive = process.stdin.isTTY === true;
  if (interactive) process.stderr.write("arrival repl — Ctrl-D exits\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  let buffer = "";
  const prompt = (): void => {
    if (interactive) process.stdout.write(buffer === "" ? PROMPT : CONTINUE);
  };
  rl.on("SIGINT", () => {
    if (buffer === "") {
      rl.close(); // Ctrl-C on an empty line = Ctrl-D
      return;
    }
    buffer = ""; // cancel the pending multi-line input
    if (interactive) process.stdout.write("\n" + PROMPT);
  });

  prompt();
  for await (const line of rl) {
    buffer = buffer === "" ? line : `${buffer}\n${line}`;
    if (buffer.trim() === "") {
      buffer = "";
      prompt();
      continue;
    }
    if (!closeable(buffer)) {
      prompt();
      continue;
    }
    const src = buffer;
    buffer = "";
    try {
      // Per-line budgets (a REPL line hanging 5 minutes is already a teaching door);
      // `scope` carries the session — defines land there and persist across lines.
      // `execState` hands back boxed SchemeValues (the COMPLEX tier); unwrap through
      // the membrane before printing — `printValue`'s "defines are silent" REPL norm
      // checks JS `undefined`, which only a `schemeToJs`'d void satisfies (the boxed
      // `AVoid` singleton itself is not `=== undefined`).
      const { values } = await execState(src, { ambient, scope, ...budgets() });
      for (const v of values) printValue(schemeToJs(v, {}));
    } catch (e) {
      printError(e); // the session survives — same scope, next prompt
    }
    prompt();
  }
  if (interactive) process.stdout.write("\n");
  await ambient.dispose();
  return 0;
}

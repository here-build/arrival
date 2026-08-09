/**
 * Terminal-feature emitters — OSC (Operating System Command) + SGR escapes that modern
 * terminals honor and older ones ignore harmlessly. Pure string builders; the caller writes
 * them to the stream. Kept in one leaf so the terminal-compat details live in one place
 * (sibling to `ansi.ts`, which owns cursor/color escapes).
 *
 * Graceful degradation is the contract: a terminal without OSC-8 shows the plain link text,
 * without OSC-133 shows the plain output, without OSC-52 simply doesn't copy — never a
 * garbled screen. So these are safe to emit unconditionally.
 */

const ESC = "\x1b";
const BEL = "\x07";
const OSC = `${ESC}]`;
const ST = `${ESC}\\`; // string terminator (ST) — preferred over BEL for OSC where accepted

/**
 * OSC 8 hyperlink: `text` becomes clickable, pointing at `url` (`file:///abs/path:line`,
 * `https://…`). Supported by iTerm2, WezTerm, kitty, GNOME Terminal, VTE; elsewhere the
 * link markers are ignored and the bare `text` shows. `id` (optional) groups multi-run
 * links as one hover target.
 */
export function hyperlink(url: string, text: string, id?: string): string {
  const params = id === undefined ? "" : `id=${id}`;
  return `${OSC}8;${params};${url}${ST}${text}${OSC}8;;${ST}`;
}

/** A `file://` URL for `absPath`, with an optional `:line` fragment the editor-aware
 *  terminals honor. `absPath` must be absolute. */
export function fileUrl(absPath: string, line?: number): string {
  const base = `file://${absPath}`;
  return line === undefined ? base : `${base}:${line}`;
}

// ── OSC 133 shell-integration marks (FinalTerm / iTerm2) ───────────────────────
// Warp, WezTerm, kitty, and iTerm2 use these to delimit each command's regions, making a
// turn a foldable / navigable / re-runnable BLOCK. A=prompt start, B=prompt end (command
// input start), C=command executed (output start), D[;exit]=command finished.
export const PROMPT_START = `${OSC}133;A${ST}`;
export const PROMPT_END = `${OSC}133;B${ST}`;
export const COMMAND_START = `${OSC}133;C${ST}`;
export function commandDone(exitCode = 0): string {
  return `${OSC}133;D;${exitCode}${ST}`;
}

/** OSC 9 desktop notification (iTerm2, kitty, WezTerm) — a system toast with `message`. */
export function notify(message: string): string {
  return `${OSC}9;${message}${BEL}`;
}

/** OSC 52 clipboard set — copy `text` to the terminal's clipboard (`c` = system, `p` =
 *  primary/X11). base64-encoded per the spec. Lets a remote/SSH session copy without a
 *  local mouse selection. */
export function clipboardSet(text: string, clipboard: "c" | "p" = "c"): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `${OSC}52;${clipboard};${b64}${ST}`;
}

/**
 * SGR 4:3 curly underline, optionally colored (`58:2::r:g:b`) — the "squiggle under the bad
 * token" a diagnostic wants, distinct from a red foreground. Closes with `4:0` (no
 * underline) and, when colored, `59` (default underline color). Terminals without the
 * extended SGR fall back to a plain underline or none.
 */
export function curlyUnderline(text: string, rgb?: readonly [number, number, number]): string {
  const openColor = rgb === undefined ? "" : `${ESC}[58:2::${rgb[0]}:${rgb[1]}:${rgb[2]}m`;
  const closeColor = rgb === undefined ? "" : `${ESC}[59m`;
  return `${ESC}[4:3m${openColor}${text}${ESC}[4:0m${closeColor}`;
}

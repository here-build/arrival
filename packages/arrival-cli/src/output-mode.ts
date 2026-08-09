/**
 * The display boundary (clig.dev discipline): one PURE function deciding how a run's
 * values reach the sink, from the sink's own shape — not scattered `isTTY` checks. Every
 * `arrival run` value passes through the mode this resolves; the decision is a pure
 * function of (stdout-is-a-TTY, env, --json) so it is testable with zero real terminal.
 *
 * Two axes, deliberately orthogonal:
 *   • FORMAT — `sexpr` (the human/default, the runtime's own stdout contract) vs `json`
 *     (machine, opt-in via `--json`, one JSON value per top-level form → NDJSON a `| jq`
 *     consumes). We do NOT auto-switch to JSON when stdout is piped: arrival's stdout has
 *     always been s-expr, so a pipe-triggered flip would silently break every existing
 *     consumer. Machine output is a thing you ASK for, not a thing that happens to you.
 *   • COLOR — subtle ANSI on the s-expr, gated purely on "is a human looking?": on when
 *     stdout is a TTY, off when piped (so `| jq`, `> file`, tests stay byte-identical to
 *     the pre-color output). `NO_COLOR` disables unconditionally (no-color.org); a
 *     `CLICOLOR_FORCE` forces it back through a pipe; `TERM=dumb` disables. JSON is never
 *     colored — it's a payload, not a view.
 *
 * The truecolor-vs-256 ladder is NOT decided here — that is a terminal-CAPABILITY
 * question `tints.ts`'s `colorMode` already owns. This resolves POLICY (format + whether
 * to color at all); the painter resolves capability. Composed, never duplicated.
 */

export type OutputFormat = "sexpr" | "json";

export interface OutputMode {
  readonly format: OutputFormat;
  /** Whether to ANSI-color the s-expr. Always false for `json`. */
  readonly color: boolean;
}

export interface OutputContext {
  /** `process.stdout.isTTY === true` — passed in, never read from a global, so tests pin it. */
  readonly stdoutIsTTY: boolean;
  readonly env: NodeJS.ProcessEnv;
  /** The `--json` flag. */
  readonly json: boolean;
}

/** `CLICOLOR_FORCE` present and not `"0"` — the "color through a pipe anyway" override. */
function colorForced(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLICOLOR_FORCE;
  return v !== undefined && v !== "" && v !== "0";
}

/**
 * Should the s-expr be colored? Precedence (highest first): `NO_COLOR` off →
 * `CLICOLOR_FORCE` on → `TERM=dumb` off → is-a-TTY. Mirrors `tints.ts`'s `colorMode`
 * NO_COLOR-first rule so the two agree on "colors wanted at all".
 */
function wantsColor(ctx: OutputContext): boolean {
  if (ctx.env.NO_COLOR !== undefined) return false;
  if (colorForced(ctx.env)) return true;
  if (ctx.env.TERM === "dumb") return false;
  return ctx.stdoutIsTTY;
}

/** Resolve the display mode for a run. Pure — no globals, no side effects. */
export function resolveOutputMode(ctx: OutputContext): OutputMode {
  if (ctx.json) return { format: "json", color: false };
  return { format: "sexpr", color: wantsColor(ctx) };
}

/**
 * The ONE run posture every CLI verb shares: the entry-point budgets (100M heap /
 * 300s wall, env-tunable — the same knobs `arrival-run` reads), the loader-armed
 * GLASS env for require-using programs (the `buildArrivalEnv` idiom: base +
 * `arrivalLoaderCapability` assembled once, jailed to a root dir), and the two
 * output surfaces — values through arrival-serializer (budgeted), errors as their
 * teaching-door TEXT (never a stack trace; the doors ARE the UX).
 *
 * TWO PATHS, by the program's own shape (the same split `exec` documents as
 * glass-vs-cut): a require-FREE program runs the CUT (default base, static
 * validation available); a require-USING program runs GLASS (assembled env,
 * `__parent__`-chained builtins — the path the loader's production consumers
 * use, and the reason: under the cut, a required module's forms evaluate through
 * `execExpr({ env })` where builtins live on the resolver's capability base, not
 * the env chain, so the module can't see the stdlib. Glass has no seal, so no
 * static pass — the runtime doors are the backstop there, stated out loud.)
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  assembleEnv,
  exec,
  sandboxedEnv,
  StaticValidationError,
  tokenize,
  type Diagnostic,
  type ExecOptions,
} from "@here.build/arrival";
import { arrivalLoaderCapability } from "@here.build/arrival-scheme-env-loader";
import { toSExprString } from "@here.build/arrival-serializer";

/** Per-run ALLOCATION cap — same default + env var as arrival-run's entry point. */
function heapDefault(): number {
  const raw = Number(process.env.ARRIVAL_HEAP_MAX);
  return Number.isFinite(raw) && raw > 0 ? raw : 100_000_000;
}

/** Wall-clock budget — the 5-minute program class (V2 ruling), same env var as arrival-run. */
function wallDefault(): number {
  const raw = Number(process.env.ARRIVAL_RUN_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/** The entry-point budgets, shared by every verb and both env paths. */
export function budgets(): Pick<ExecOptions, "budgetMs" | "heapBudget"> {
  return { budgetMs: wallDefault(), heapBudget: heapDefault() };
}

/**
 * The loader-armed GLASS env, rooted at `root` (the entry file's dir for `run`,
 * cwd for the repl). The capability derives its own `Loader` from the raw fs
 * slice; `dirname: ""` makes `root` the jail root — the loader's own path
 * normalization refuses `..` escapes, and every resolved path is jail-relative,
 * re-anchored here via `path.resolve(root, p)`. Assembled ONCE per session:
 * defines land in the env (glass accumulation) and the require cache lives for
 * the env's lifetime.
 */
export async function loaderEnv(root: string, name: string): Promise<NonNullable<ExecOptions["env"]>> {
  const base = sandboxedEnv.inherit(name);
  const { env } = await assembleEnv(base, [
    arrivalLoaderCapability.lower({
      config: {
        fs: { readFile: (p: string) => fs.readFile(path.resolve(root, p), "utf8") },
        dirname: "",
      },
      evalScheme: (env, src) => exec(src, { env: env as never }),
    }),
  ]);
  return env;
}

/**
 * Does the program reference `require` at all? The static pass cannot see the bindings
 * a `(require "mod.scm")` SPILLS at runtime (module-graph awareness is the LSP problem,
 * not v1's), so a require-using program would false-fail validation on every spilled
 * name. The CLI downgrades: validation runs IFF the program is require-free; otherwise
 * the runtime doors remain the backstop. Detection uses the real FSM lexer (`tokenize`
 * counts `#\(`, strings, and comments faithfully — a symbol token equal to `require`
 * is a genuine reference, a string/comment mention is not).
 */
export function usesRequire(source: string): boolean {
  try {
    return tokenize(source, true).some((t) => t.token === "require");
  } catch {
    return false; // unlexable source — let the reader's own error teach downstream
  }
}

export const REQUIRE_SKIP_NOTE =
  "note: static validation skipped — (require …) bindings are invisible to the pass; runtime doors remain the backstop.";

/** Output budget: enough to see, never a flood (the serializer shrink-to-fit machinery). */
const PRINT_OPTS = { maxItems: 64, maxStringChars: 1024, maxTotalChars: 16_384 };

/** One top-level form's value → stdout. `undefined` (define / void) prints nothing — REPL norm. */
export function printValue(v: unknown): void {
  if (v === undefined) return;
  console.log(toSExprString(v, PRINT_OPTS));
}

export function formatDiagnostic(d: Diagnostic): string {
  const suggestions =
    d.suggestions !== undefined && d.suggestions.length > 0 ? `\n    did you mean: ${d.suggestions.join(", ")}` : "";
  return `${d.severity}: ${d.message}${suggestions}`;
}

/**
 * Errors as their teaching text. A `StaticValidationError` fans out to its COMPLETE
 * diagnostic list (cause + every site, cascade-fused); everything else prints its
 * message — arrival's runtime doors (unbound-variable with suggestions, budget,
 * purity) already speak in cures, so the message IS the UX. No stack traces.
 */
export function printError(e: unknown): void {
  if (e instanceof StaticValidationError) {
    for (const d of e.diagnostics) console.error(formatDiagnostic(d));
    return;
  }
  console.error(e instanceof Error ? e.message : String(e));
}

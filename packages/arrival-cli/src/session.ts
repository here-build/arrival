/**
 * The ONE run posture every CLI verb shares: the entry-point budgets (100M heap /
 * 300s wall, env-tunable — the same knobs `arrival-run` reads), the loader-armed
 * AMBIENT for require-using programs (the CUT, capability-refined: `arrivalLoaderCapability`
 * assembled once via {@link assembleAmbient}, jailed to a root dir, paired with a
 * {@link LexicalScope.fresh} session scope), and the two output surfaces — values through
 * arrival-serializer (budgeted), errors as their teaching-door TEXT (never a stack trace;
 * the doors ARE the UX).
 *
 * TWO PATHS, by the program's own shape: a require-FREE program runs the bare CUT
 * (default base, static validation available); a require-USING program runs the CUT
 * with the loader capability's ambient + a session scope (the path the loader's
 * production consumers use) — a required module's forms evaluate through the
 * requiring run's COMPOSED resolver (`execExpr({ resolver })` — arrival's
 * src/loader/), so `(require …)` sees the stdlib too. The split stays because the
 * static pass cannot see require-spilled bindings (module-graph awareness is an LSP
 * problem, not v1's — see {@link usesRequire}), not because of any seal asymmetry —
 * and because the once-assembled ambient + scope keep defines + the require cache
 * alive for the whole session.
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  LexicalScope,
  StaticValidationError,
  tokenize,
  type Diagnostic,
  type ExecOptions,
  type SessionScope,
} from "@here.build/arrival";
import { assembleAmbient, type AssembledAmbient } from "@here.build/arrival/env";
import { arrivalLoaderCapability } from "@here.build/arrival/loader";
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

/** The two session handles a loader-armed run continues on: a caller-owned
 *  {@link AssembledAmbient} (dispose it when the session ends) and the
 *  {@link SessionScope} its top-level `define`s land in. */
export interface LoaderSession {
  readonly ambient: AssembledAmbient;
  readonly scope: SessionScope;
}

/**
 * The loader-armed session, rooted at `root` (the entry file's dir for `run`,
 * cwd for the repl). The capability derives its own `Loader` from the raw fs
 * slice; `dirname: ""` makes `root` the jail root — the loader's own path
 * normalization refuses `..` escapes, and every resolved path is jail-relative,
 * re-anchored here via `path.resolve(root, p)`. The kernel wires the canonical
 * prelude `evalScheme` internally — no closure to supply here. Assembled ONCE
 * per session: `scope` accumulates defines across calls (`execState(src, {
 * ambient, scope })`, the REPL continuation idiom) and the require cache lives
 * for the ambient's lifetime — dispose it when the session (run/repl) ends.
 */
export async function loaderSession(root: string, name: string): Promise<LoaderSession> {
  const ambient = await assembleAmbient({
    capabilities: [arrivalLoaderCapability],
    config: {
      fs: { readFile: (p: string) => fs.readFile(path.resolve(root, p), "utf8") },
      dirname: "",
    },
  });
  const scope = LexicalScope.fresh(name);
  return { ambient, scope };
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

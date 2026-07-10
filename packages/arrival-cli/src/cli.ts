#!/usr/bin/env node
/**
 * The `arrival` command — three verbs over the public exec surface:
 *
 *   arrival run <file.scm>    parse → whole-program static validation (the eslint-style
 *                             pass, staticValidation:"on") → execute with the loader
 *                             capability rooted at the file's dir, budgets bounded;
 *                             one printed value per top-level form.
 *   arrival repl              persistent-scope readline session (see repl.ts).
 *   arrival check <file.scm>  the validation pass ALONE — the complete Diagnostic list,
 *                             exit 1 iff any error-tier diagnostic; NOTHING evaluates.
 *
 * `check` needs validate-without-execute, and the public surface deliberately keeps
 * vocabulary assembly inside `execState` (the sealed chain isn't exported). The honest
 * public-API cut: run `execState({ staticValidation: "on" })` with an ALREADY-ABORTED
 * signal whose reason is our sentinel — the trampoline fast-fails BEFORE the first
 * form's first step (evaluator.ts run(): "if the caller passed an already-aborted
 * signal, refuse"), so validation completes and zero evaluation happens, by the
 * evaluator's own contract rather than a re-implementation of its assembly.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { exec, execState, LexicalScope, StaticValidationError } from "@here.build/arrival";

import { repl } from "./repl.js";
import {
  budgets,
  formatDiagnostic,
  loaderEnv,
  printError,
  printValue,
  REQUIRE_SKIP_NOTE,
  usesRequire,
} from "./session.js";

const USAGE = `usage: arrival <command>

  arrival run <file.scm>    validate, then execute (require-root = the file's dir)
  arrival repl              interactive session (persistent defines, Ctrl-D exits)
  arrival check <file.scm>  static diagnostics only — nothing is evaluated

environment:
  ARRIVAL_HEAP_MAX          per-run allocation budget (default 100000000 cells)
  ARRIVAL_RUN_BUDGET_MS     wall-clock budget in ms   (default 300000)
`;

async function readSource(file: string): Promise<string> {
  try {
    return await readFile(path.resolve(file), "utf8");
  } catch (e) {
    throw new Error(`arrival: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runFile(file: string): Promise<number> {
  const source = await readSource(file);
  try {
    let values: unknown[];
    if (usesRequire(source)) {
      // GLASS: the loader-armed env, jailed to the file's dir. No seal ⇒ no static
      // pass (see session.ts header) — runtime doors are the backstop, stated out loud.
      process.stderr.write(`${REQUIRE_SKIP_NOTE}\n`);
      const env = await loaderEnv(path.dirname(path.resolve(file)), `arrival-run:${path.basename(file)}`);
      values = await exec(source, { env, ...budgets() });
    } else {
      // THE CUT: default base, whole-program diagnostics before the first form fires.
      values = await exec(source, { ...budgets(), staticValidation: "on" });
    }
    for (const v of values) printValue(v);
    return 0;
  } catch (e) {
    printError(e);
    return 1;
  }
}

async function checkFile(file: string): Promise<number> {
  const source = await readSource(file);
  if (usesRequire(source)) {
    // The pass would false-report every require-spilled name; it makes no claims here.
    console.log(`${REQUIRE_SKIP_NOTE}\n${file}: skipped`);
    return 0;
  }
  const sentinel = new Error("arrival check: validation-only — evaluation refused by design");
  const controller = new AbortController();
  controller.abort(sentinel);
  try {
    await execState(source, {
      ...budgets(),
      staticValidation: "on",
      scope: LexicalScope.fresh("arrival-check"),
      signal: controller.signal,
    });
    // Only an EMPTY program reaches here (no form ever touched the aborted signal).
    console.log(`${file}: ok`);
    return 0;
  } catch (e) {
    if (e === sentinel) {
      console.log(`${file}: ok`);
      return 0;
    }
    if (e instanceof StaticValidationError) {
      for (const d of e.diagnostics) console.log(formatDiagnostic(d));
      const errors = e.diagnostics.filter((d) => d.severity === "error").length;
      console.log(`${e.diagnostics.length} problem${e.diagnostics.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})`);
      return errors > 0 ? 1 : 0;
    }
    printError(e); // reader/parse error — still a diagnostic outcome
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, file] = positionals;
  switch (command) {
    case "run":
    case "check": {
      if (file === undefined) {
        process.stderr.write(`arrival ${command}: missing <file.scm>\n${USAGE}`);
        return 2;
      }
      return command === "run" ? runFile(file) : checkFile(file);
    }
    case "repl":
      return repl();
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`arrival: unknown command ${JSON.stringify(command)}\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    printError(e);
    process.exitCode = 1;
  },
);

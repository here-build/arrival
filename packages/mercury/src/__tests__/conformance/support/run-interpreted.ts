/**
 * Execute a corpus program through the REAL interpreter (`@here.build/arrival-run`'s
 * `runProgram`), armed with the shared echo-infer oracle — the other half of the
 * agreement law's comparison (see `run-compiled.ts` for the compiled half).
 */
import { runProgram } from "@inhuman.tools/arrival-run";

import { createEchoInferStore } from "./echo-infer.js";

/** Run `source` and return its JS-peeled final value (`runProgram`'s handle is a
 *  thenable that resolves to the same `schemeToJs`-peeled value `.finished` does).
 *  No `loader` — the corpus is require-free by design (single-file rows only), so
 *  `(require …)` staying unbound is correct, not a gap. */
export async function runInterpreted(source: string): Promise<unknown> {
  return runProgram(source, { infer: createEchoInferStore() });
}

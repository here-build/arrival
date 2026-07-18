/**
 * W2 — the compiler's OWN agreement law (design doc §3/§8): compiled-output,
 * EXECUTED for real via `tsx`, ≡ `runProgram` (the interpreter), over a shared
 * `.scm` corpus.
 *
 * This suite doubles as the desugar-drift guard named in §4.2/§7: `desugar.ts` is a
 * hand-written SECOND implementation of `cut`/threading/`compose`/`pipe` with no law
 * tying it to the bootstrap macros it's meant to mirror ("the view must agree with
 * execution" — desugar.ts's own header comment). Until `expandProgram` (seam 7)
 * lands and `desugar.ts` deletes, THIS is the law: every sugar-form row below fails
 * loudly the moment a hand-written expansion drifts from what the real macros do.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { STRATEGIES } from "../../strategy/index.js";
import { ROWS, STRATEGY_IDS } from "./support/rows.js";
import { cleanupCompiledTmp, runCompiled } from "./support/run-compiled.js";
import { runInterpreted } from "./support/run-interpreted.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const read = (name: string): string => readFileSync(`${corpusDir}${name}`, "utf8");

describe("mercury conformance — compiled ≡ interpreted", () => {
  afterAll(() => {
    cleanupCompiledTmp();
  });

  describe.each(STRATEGY_IDS)("strategy: %s", (strategyId) => {
    const strategy = STRATEGIES[strategyId];

    it.each(ROWS)("$name", async ({ file }) => {
      const source = read(file);
      const [compiled, interpreted] = await Promise.all([
        runCompiled(source, `${strategyId}-${file.replace(/\.scm$/, "")}`, strategy),
        runInterpreted(source),
      ]);
      // Round-trip both sides through JSON so the comparison is over the same
      // canonical shape regardless of which runtime produced which JS-native
      // representation — a mismatch here is a real compiler bug, never a
      // serialization artifact of the harness itself. NOT `structuredClone`
      // (eslint's usual preference): the interpreter's `schemeToJs`-peeled value
      // can be a non-plain array-like (LIPS's own list representation), which the
      // structured-clone algorithm rejects outright — `JSON.stringify` doesn't care.
      // eslint-disable-next-line unicorn/prefer-structured-clone -- see comment above
      expect(JSON.parse(JSON.stringify(compiled))).toEqual(JSON.parse(JSON.stringify(interpreted)));
    });
  });
});

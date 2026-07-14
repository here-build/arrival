// B4 (second-foundation/arrival-manifold/docs/benchmark-defect-register.md) — a
// POSITIONAL/variadic `symbol.rosetta` verb's decode gate (`common/symbols/rosetta.ts`)
// used to let a raw `ZodError` propagate. zod v4's `ZodError.message` IS the
// pretty-printed JSON of `.issues` — a 25-line nested-union dump naming no verb and no
// argument. One model in the 89x2 benchmark corpus misread that dump as an invented
// `:limit max 500` schema constraint and voluntarily shrank its dataset 388→80, losing
// the task.
//
// Fix: `common/symbols/positional-rejection.ts` (this arm's own sibling of
// kwargs-rejection.ts's `issueLines`, keyed on ARG INDEX not kwarg NAME), wired into
// rosetta.ts's positional decode arm via try/catch(ZodError).
import { describe, expect, it } from "vitest";
import { execState } from "../eval/generator-exec.js";
import { mintFrame } from "../AmbientRuntime.js";
import { inferenceEnv } from "../inference-env.js";

const run = (code: string) => execState(code, { env: mintFrame(inferenceEnv, "positional-decode-humanizer") });

describe("B4 — a positional decode rejection is humanized, not a raw ZodError dump", () => {
  it("(concat \"a\" 5) names the verb and the offending arg position", async () => {
    await expect(run('(concat "a" 5)')).rejects.toThrow(/concat/);
    await expect(run('(concat "a" 5)')).rejects.toThrow(/arg 2/);
  });

  it("(concat \"a\" 5) message does NOT contain the raw zod issues JSON", async () => {
    try {
      await run('(concat "a" 5)');
      throw new Error("expected concat to throw, it didn't");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toMatch(/"code"/);
      expect(message).not.toMatch(/invalid_union/);
      expect(message).not.toMatch(/invalid_type/);
    }
  });
});

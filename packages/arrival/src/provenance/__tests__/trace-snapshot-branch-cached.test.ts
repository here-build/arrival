/**
 * trace fixes: (1) a branch form's test/arm child keeps its runtime `value` through the
 * per-exit prune, so `snapshotTrace` can carry the decision outcome; (2) a replay-mode
 * RunCache hit marks the served rosetta invocation `cached` (the free-vs-paid signal),
 * and the snapshot shows it.
 */
import type { CallCtx } from "../../run/CallCtx.js";
import { describe, expect, it } from "vitest";
import { inferenceEnv } from "../../env/inference-env.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { EnvCapability } from "../../common/capability.js";
import { applyCapability } from "../../__tests__/_fresh-env.js";
import { MemoryRunCache } from "../../run/run-cache.js";
import { EvalTrace } from "../trace.js";
import { snapshotTrace } from "../trace-snapshot.js";

const headOf = (inv: { node: unknown }): string | undefined =>
  ((inv.node as { car?: { __name__?: unknown } }).car?.__name__ as string | undefined) ?? undefined;

describe("snapshotTrace — branch-child value capture", () => {
  it("carries the test value and the chosen arm's value", async () => {
    const trace = new EvalTrace();
    const env = inferenceEnv.child("trace-branch-values");
    await execState("(define x 5) (if (> x 1) (+ x 1) (- x 1))", { env, tap: trace });
    const { invocations } = snapshotTrace(trace);
    const ifInv = invocations.find((i) => headOf(i) === "if");
    expect(ifInv).toBeDefined();
    const byHead = new Map(ifInv!.children.map((c) => [headOf(c), c]));
    expect(byHead.get(">")?.value).toBe(true); // the test outcome
    expect(byHead.get("+")?.value).toBe(6); // the chosen arm
    expect(byHead.has("-")).toBe(false); // the untaken arm never ran
  });
});

describe("Invocation.cached — replay-mode RunCache hit", () => {
  async function runWith(mode: "record" | "replay", entries?: MemoryRunCache["entries"]) {
    let fires = 0;
    const env = inferenceEnv.child(`trace-cached-${mode}`);
    await applyCapability(env, [
      EnvCapability.define("test/cached-view", {
        symbols: (symbol, z) => ({
          "cv-double": symbol.rosetta`cv-double: a view`(
            { input: [z.number], output: [z.number], cacheClass: "view" },
            function (this: CallCtx, n: number) {
              fires++;
              return n * 2;
            },
          ),
        }),
      }),
    ]);
    const cache = new MemoryRunCache(mode, entries);
    const trace = new EvalTrace();
    await execState("(cv-double 21)", { env, tap: trace, cache });
    const point = snapshotTrace(trace).invocations.find((i) => headOf(i) === "cv-double");
    return { fires, cache, point };
  }

  it("record: fires, not cached. replay: served from cache, cached=true in the snapshot", async () => {
    const rec = await runWith("record");
    expect(rec.fires).toBe(1);
    expect(rec.point?.cached).toBeFalsy();

    const rep = await runWith("replay", rec.cache.entries);
    expect(rep.fires).toBe(0);
    expect(rep.point?.cached).toBe(true);
    expect(rep.point?.value).toBe(42);
  });

  it("replay miss fires fresh and is not marked cached", async () => {
    const rep = await runWith("replay");
    expect(rep.fires).toBe(1);
    expect(rep.point?.cached).toBeFalsy();
  });
});

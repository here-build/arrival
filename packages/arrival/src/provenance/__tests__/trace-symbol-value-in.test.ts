import { describe, expect, it } from "vitest";
import { execState } from "../../eval/generator-exec.js";
import { EvalTrace } from "../trace.js";

describe("EvalTrace.symbolValueIn (public read API)", () => {
  it("returns the value a symbol resolved to inside an invocation", async () => {
    const trace = new EvalTrace();
    await execState("(define x 41) (+ x 1)", { tap: trace });
    const plus = trace.invocationLog.find((inv) => trace.symbolValues.get(inv)?.has("x"));
    expect(plus).toBeDefined();
    expect(String(trace.symbolValueIn(plus!, "x"))).toBe("41");
    expect(trace.symbolValueIn(plus!, "missing")).toBeUndefined();
  });
});

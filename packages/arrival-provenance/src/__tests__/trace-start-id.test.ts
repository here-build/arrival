import { execState } from "@here.build/arrival";
import { describe, expect, it } from "vitest";
import { EvalTrace } from "../trace.js";

describe("observable EvalTrace forwards the core constructor params", () => {
  it("startId floors the minted invocation ids", async () => {
    const trace = new EvalTrace(1000, 100);
    await execState("(+ 1 2)", { tap: trace });
    const ids = [...trace.records.values()].flatMap((r) => [...r.bindings].map((i) => i.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(Math.min(...ids)).toBe(100);
  });

  it("maxEntries still caps", () => {
    expect(new EvalTrace(7, 3).maxEntries).toBe(7);
  });
});

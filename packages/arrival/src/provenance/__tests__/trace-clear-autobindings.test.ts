/**
 * `EvalTrace.clear()` resets the auto-binding sidecar: its `byInvocation` map is keyed by
 * invocation ids of the graph being dropped, so surviving a clear would grow it across runs.
 */
import { describe, expect, it } from "vitest";
import { EvalTrace } from "../trace.js";

describe("EvalTrace.clear — auto-bindings sidecar", () => {
  it("empties autoBindings.byInvocation and keeps the sidecar attached", () => {
    const trace = new EvalTrace();
    const sink = trace.withAutoBindings();
    sink.byInvocation.set(7, new Map([["x", new Set([1])]]));
    trace.clear();
    expect(sink.byInvocation.size).toBe(0);
    expect(trace.autoBindings).toBe(sink);
  });

  it("is a no-op when no sidecar is attached", () => {
    expect(() => new EvalTrace().clear()).not.toThrow();
  });
});

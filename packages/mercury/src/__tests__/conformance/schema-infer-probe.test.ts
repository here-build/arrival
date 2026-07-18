/**
 * W2 open flag (design doc §5): "One conformance flag to resolve in W2: whether a
 * schema-constrained `(infer …)` yields the decoded object or its JSON string in
 * the interpreter — the corpus asserts whichever `runProgram` does."
 *
 * Resolved empirically, by reading the actual code path a real backend runs (the
 * interpreter itself is agnostic — `(infer …)`'s rosetta only `inferList()`-wraps
 * whatever `configuration.infer` returns; the DECODE decision lives entirely in the
 * host's backend):
 *
 *   `foundations/llm-plane/llm-plane-backends/src/backends/_shared.ts::
 *   parseModelValue` —
 *     `if (spec.schema === null) return text;`
 *     `const coerced = coerceModelJson(text, diag);`
 *     `if (coerced.ok) return coerced.value;`
 *   — a REAL `JSON.parse` (via `coerceModelJson`'s fenced/repair/reasoning-channel
 *   recovery ladder), executed BEFORE the value ever becomes `Completion.value`.
 *
 *   `foundations/llm-plane/llm-plane-arrival-env/src/infer.ts`'s `infer`/`infer/chat`
 *   verbs only call `inferList(out)` on whatever `configuration.infer` resolves to —
 *   no JSON.stringify, no re-encoding, anywhere in that path.
 *
 * So by the time a schema'd `(infer …)` call reaches scheme-land, the value is
 * ALREADY the decoded object, on every host in this codebase that wires a real
 * backend. No host re-stringifies it afterward.
 *
 * PINNED ANSWER: decoded object, not a JSON string.
 *
 * `echo-infer.ts::echoInferValue` encodes this ruling (schema present ⇒ a plain
 * object, never a string) — that's what lets `infer-schema.scm`'s agreement row
 * assert real equality instead of "well, it's a string on one side and an object on
 * the other, so we just check both are truthy". This test locks the RULING itself
 * (independent of any one corpus program), so a future change to it fails HERE
 * first, with the citation attached, rather than surfacing as an unexplained
 * agreement-row diff three files away.
 */
import { describe, expect, it } from "vitest";

import { echoInferValue } from "./support/echo-infer.js";

describe("schema-constrained infer — decoded object, not JSON string (pinned)", () => {
  it("no schema → a plain string (the model's raw text)", () => {
    const value = echoInferValue("m", "prompt", null);
    expect(typeof value).toBe("string");
  });

  it("schema present → a decoded object, never its JSON-stringified form", () => {
    const schema = JSON.stringify(["s/object", ":severity", ["s/enum", "low", "high"]]);
    const value = echoInferValue("m", "prompt", schema);
    expect(typeof value).not.toBe("string");
    expect(value).toEqual(expect.objectContaining({ echo: true }));
  });
});

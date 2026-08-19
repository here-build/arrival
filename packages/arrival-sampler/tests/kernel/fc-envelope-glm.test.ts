// fc-envelope-glm.test.ts — model-free proof that the GLM frame walks its XML key/value stages correctly:
// forced structure, free intent, oracle-delegated expr — terminated by `</arg_value>` (not `"`), with RAW
// (un-escaped) expr. The Hermes mirror of this lives in fc-envelope.test.ts. No model, no oracle.

import { describe, expect, it } from "vitest";

import { EXECUTE_SCHEME_TOOL, GLM_FRAME, GLM_STAGES } from "../../src/runners/local/fc-envelope.js";

const { decide, locate } = GLM_FRAME;

const G1 = "<tool_call>";
const TN = EXECUTE_SCHEME_TOOL;
const G2 = "\n<arg_key>intent</arg_key>\n<arg_value>";
const G3 = "\n<arg_key>expr</arg_key>\n<arg_value>";
const G4 = "\n</tool_call>";
const CLOSE = "</arg_value>"; // GLM's slot terminator (a single special token live)

describe("fc-envelope GLM frame — the XML key/value state machine", () => {
  it("the GLM envelope is the visible script (7 stages, 2 generated slots)", () => {
    expect(GLM_STAGES.map((s) => s.id)).toEqual(["literal", "tool-name", "literal", "intent", "literal", "expr", "literal"]);
  });

  it("forces the opening <tool_call> from token 0, then the tool name", () => {
    expect(decide("")).toEqual({ kind: "force", bytes: G1, stage: "literal" });
    expect(decide(G1)).toEqual({ kind: "force", bytes: TN, stage: "tool-name" });
  });

  it("forces the intent arg frame once the tool name is complete", () => {
    expect(decide(G1 + TN)).toEqual({ kind: "force", bytes: G2, stage: "literal" });
  });

  it("enters the free intent slot, and stays until the model emits </arg_value>", () => {
    expect(decide(G1 + TN + G2)).toEqual({ kind: "free", stage: "intent" });
    expect(decide(G1 + TN + G2 + "set a timer")).toEqual({ kind: "free", stage: "intent" });
  });

  it("forces the expr arg frame once the model closes intent with </arg_value>", () => {
    expect(decide(G1 + TN + G2 + "set a timer" + CLOSE)).toEqual({ kind: "force", bytes: G3, stage: "literal" });
  });

  it("FORCES `(` at the expr opening — a call, not a bare symbol", () => {
    expect(decide(G1 + TN + G2 + "i" + CLOSE + G3)).toEqual({ kind: "force", bytes: "(", stage: "expr" });
  });

  it("hands the growing scheme to the oracle as the expr prefix — RAW (no JSON unescaping)", () => {
    // GLM arg values are not JSON-escaped: a quote in the expr is a literal quote, passed through unchanged.
    expect(decide(G1 + TN + G2 + "i" + CLOSE + G3 + '(send-message "Mom" "hi")')).toEqual({
      kind: "scheme",
      exprPrefix: '(send-message "Mom" "hi")',
    });
  });

  it("does NOT treat a backslash-quote as an escape (raw frame — unlike Hermes)", () => {
    // `\"` is two literal chars in GLM; it must reach the oracle verbatim, not de-escaped to `"`.
    expect(decide(G1 + TN + G2 + "i" + CLOSE + G3 + '(f "a\\"b")')).toEqual({
      kind: "scheme",
      exprPrefix: '(f "a\\"b")',
    });
  });

  it("forces the closing </tool_call> once the model closes expr with </arg_value>", () => {
    expect(decide(G1 + TN + G2 + "i" + CLOSE + G3 + "(set-timer 600)" + CLOSE)).toEqual({
      kind: "force",
      bytes: G4,
      stage: "literal",
    });
  });

  it("reports DONE on a complete, well-formed call", () => {
    const full = G1 + TN + G2 + "set a timer" + CLOSE + G3 + "(set-timer 600)" + CLOSE + G4;
    expect(decide(full)).toEqual({ kind: "done" });
  });

  it("forceOpenParen:false leaves the first expr token free (abstention probe)", () => {
    expect(decide(G1 + TN + G2 + "i" + CLOSE + G3, { forceOpenParen: false })).toEqual({
      kind: "scheme",
      exprPrefix: "",
    });
  });

  it("locate exposes the expr stage + raw exprSoFar (terminator = </arg_value>)", () => {
    const cur = locate(G1 + TN + G2 + "i" + CLOSE + G3 + "(car xs");
    expect(cur.stage?.id).toBe("expr");
    expect(cur.exprSoFar).toBe("(car xs");
  });
});

describe("GLM frame — the per-family variance", () => {
  it("uses RAW unescapeWire (identity), the </arg_value> close delimiter, and special-token mode", () => {
    expect(GLM_FRAME.unescapeWire('(f "x")')).toBe('(f "x")');
    expect(GLM_FRAME.exprCloseDelimiter).toBe("</arg_value>");
    expect(GLM_FRAME.forceSpecialTokens).toBe(true);
  });

  it("reports NO wire hazards — a raw arg value never breaks JSON (there is none)", () => {
    expect(GLM_FRAME.wireHazards("(a)\n(b)", 0)).toEqual([]);
  });
});

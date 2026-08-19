// fc-envelope.test.ts — model-free proof that the FC envelope FSM walks its stages correctly: forced
// structure, free intent, oracle-delegated expr, and the escape-hazard observability. No model, no oracle.

import { describe, expect, it } from "vitest";

import {
  decide,
  ENVELOPE,
  EXECUTE_SCHEME_TOOL,
  exprHazards,
  firstUnescapedQuote,
  jsonUnescape,
  locate,
} from "../../src/runners/local/fc-envelope.js";

const L1 = '<tool_call>\n{"name": "';
const TN = EXECUTE_SCHEME_TOOL;
const L2 = '", "arguments": {"intent": "';
const L3 = ', "expr": "';
const L4 = "}}\n</tool_call>";

describe("fc-envelope — the explicit state machine", () => {
  it("the envelope is the visible script (7 stages, 2 generated slots)", () => {
    expect(ENVELOPE.map((s) => s.id)).toEqual(["literal", "tool-name", "literal", "intent", "literal", "expr", "literal"]);
  });

  it("forces the opening frame from token 0", () => {
    expect(decide("")).toEqual({ kind: "force", bytes: L1, stage: "literal" });
  });

  it("forces the tool name after the opening frame", () => {
    expect(decide(L1)).toEqual({ kind: "force", bytes: TN, stage: "tool-name" });
  });

  it("forces only the REMAINING bytes of a half-emitted forced run", () => {
    expect(decide(L1 + "execu")).toEqual({ kind: "force", bytes: "te-scheme", stage: "tool-name" });
  });

  it("forces the args frame once the tool name is complete", () => {
    expect(decide(L1 + TN)).toEqual({ kind: "force", bytes: L2, stage: "literal" });
  });

  it("enters the free intent slot at the intent opening", () => {
    expect(decide(L1 + TN + L2)).toEqual({ kind: "free", stage: "intent" });
  });

  it("stays in the free intent slot mid-value", () => {
    expect(decide(L1 + TN + L2 + "set a timer")).toEqual({ kind: "free", stage: "intent" });
  });

  it("forces the expr frame once the model closes intent with an unescaped quote", () => {
    expect(decide(L1 + TN + L2 + 'set a timer"')).toEqual({ kind: "force", bytes: L3, stage: "literal" });
  });

  it("FORCES `(` at the expr opening — a call, not a bare symbol (the dropped-prefill fix)", () => {
    expect(decide(L1 + TN + L2 + 'set a timer"' + L3)).toEqual({ kind: "force", bytes: "(", stage: "expr" });
  });

  it("deserializes the wire expr to RAW Scheme for the oracle (\\\" → \", \\n → newline)", () => {
    // wire: send-message \"Mom\" — the oracle must see the unescaped Scheme.
    expect(decide(L1 + TN + L2 + 'i"' + L3 + '(send-message \\"Mom\\"')).toEqual({
      kind: "scheme",
      exprPrefix: '(send-message "Mom"',
    });
  });

  it("hands the growing scheme to the oracle as the expr prefix", () => {
    expect(decide(L1 + TN + L2 + 'set a timer"' + L3 + "(set-timer 600)")).toEqual({
      kind: "scheme",
      exprPrefix: "(set-timer 600)",
    });
  });

  it("forces the closing frame once the model closes expr", () => {
    expect(decide(L1 + TN + L2 + 'set a timer"' + L3 + '(set-timer 600)"')).toEqual({
      kind: "force",
      bytes: L4,
      stage: "literal",
    });
  });

  it("reports DONE on a complete, well-formed call (and the call is valid JSON)", () => {
    const full = L1 + TN + L2 + 'set a timer"' + L3 + '(set-timer 600)"' + L4;
    expect(decide(full)).toEqual({ kind: "done" });
    const json = full.replace(/^<tool_call>\n/, "").replace(/\n<\/tool_call>$/, "");
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual({
      name: "execute-scheme",
      arguments: { intent: "set a timer", expr: "(set-timer 600)" },
    });
  });

  it("does NOT treat an escaped quote inside intent as the terminator", () => {
    // intent value contains \" — still inside intent, not closed.
    expect(decide(L1 + TN + L2 + 'a \\"quoted\\" word')).toEqual({ kind: "free", stage: "intent" });
    // the FIRST unescaped quote (after the escaped pair) closes it.
    expect(decide(L1 + TN + L2 + 'a \\"quoted\\" word"')).toEqual({ kind: "force", bytes: L3, stage: "literal" });
  });

  it("locate exposes the cursor stage + exprSoFar", () => {
    const cur = locate(L1 + TN + L2 + 'i"' + L3 + "(car xs");
    expect(cur.stage?.id).toBe("expr");
    expect(cur.exprSoFar).toBe("(car xs");
  });
});

describe("firstUnescapedQuote", () => {
  it("finds a bare quote", () => expect(firstUnescapedQuote('ab"c')).toBe(2));
  it("skips an escaped quote, finds the next bare one", () => expect(firstUnescapedQuote('a\\"b"c')).toBe(4));
  it("treats \\\\\" as an unescaped quote (even backslashes)", () => expect(firstUnescapedQuote('a\\\\"b')).toBe(3));
  it("returns -1 when there is no unescaped quote", () => expect(firstUnescapedQuote('a\\"b')).toBe(-1));
});

describe("jsonUnescape — deserialize the wire expr for the oracle", () => {
  it("de-escapes quotes", () => expect(jsonUnescape('send-message \\"Mom\\"')).toBe('send-message "Mom"'));
  it("de-escapes a newline control symbol", () => expect(jsonUnescape("(a)\\n(b)")).toBe("(a)\n(b)"));
  it("de-escapes a backslash", () => expect(jsonUnescape("a\\\\b")).toBe("a\\b"));
  it("de-escapes \\uXXXX", () => expect(jsonUnescape("x\\u0041y")).toBe("xAy"));
  it("drops a trailing lone backslash (pending the next token)", () => expect(jsonUnescape("(car \\")).toBe("(car "));
  it("passes clean scheme through unchanged", () => expect(jsonUnescape("(set-timer (* 10 60))")).toBe("(set-timer (* 10 60))"));
});

describe("exprHazards — observe-first control-symbol logging", () => {
  it("flags a BARE newline (the rewrite-strategy target)", () => {
    expect(exprHazards("(a)\n(b)")).toEqual([{ kind: "newline", text: "\n", at: 3 }]);
  });
  it("does NOT flag quotes (the model escapes them itself on the wire)", () => {
    expect(exprHazards('(f "x")')).toEqual([]);
  });
  it("is silent on clean single-line scheme", () => {
    expect(exprHazards("(set-timer 600)")).toEqual([]);
  });
});

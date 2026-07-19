// The DiscoveryTool event-stream laws:
//
//   • EVENT-ORDER law — topology strictly FIRST (before index 0 ever runs), statement events
//     strictly ordered by index, TERMINAL-ON-ERROR (no event follows the error statement).
//   • AGGREGATE law — the final result ≡ the ordered concatenation of the statement events'
//     FULL ContentBlock lists (text and binary extras alike append into the same lists).
//   • BUDGET law — the per-form serialization budget is computed ONCE from the PARSED form
//     count (parse-first), so the SUM across a batch stays bounded by MCP_OUTPUT_BUDGET.
//   • COUNTERS law — heapUsed contributions are monotonic (session heapUsedTotal ≡ Σ statement
//     heapUsed), heapMax is the default-ON 100M bound, elapsed is sane.
//   • NON-STREAMING byte-identity — a call with no listener returns the byte-identical
//     aggregate (events are additive observation, never altering the response shape).

import type { ReplEvent, ReplStatementEvent, ReplTopologyEvent } from "@inhuman.tools/mcp-substrate";
import { describe, expect, it } from "vitest";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { isSessionRunState } from "../session-run-state.js";

function demoTool(options: { statementCap?: number } = {}): DiscoveryTool {
  return new DiscoveryTool("demo", new McpEnvCapability("demo-caps", { symbols: {}, annotations: {} }), {
    description: "demo tool",
    ...options,
  });
}

/** Run one call collecting the event stream alongside the aggregate. `call` returns
 *  `(string | Blob)[]` — every program in THIS suite is blob-free, so `out` stays all-string;
 *  the type rides the wider union. */
async function callWithEvents(
  tool: DiscoveryTool,
  expr: string,
  session?: { id: string; state: Record<string, unknown> },
): Promise<{ out: (string | Blob)[]; events: ReplEvent[] }> {
  const events: ReplEvent[] = [];
  const sess = session ?? { id: "s1", state: {} };
  const out = await tool.call({ expr }, { session: sess, onEvent: (event) => events.push(event) });
  return { out, events };
}

const statements = (events: ReplEvent[]): ReplStatementEvent[] =>
  events.filter((e): e is ReplStatementEvent => e.kind === "statement");

/** Assert-and-narrow: a blob-free program's aggregate is all-string (any Blob here is a bug). */
const textsOf = (out: (string | Blob)[]): string[] =>
  out.map((element) => {
    if (typeof element !== "string") throw new Error("unexpected binary element in a blob-free program");
    return element;
  });

describe("R5 — event-order law", () => {
  it("topology is strictly FIRST, carries total + exact source slices, and statements fill slots in order", async () => {
    const { events } = await callWithEvents(demoTool(), "(+ 1 1)\n(+ 2 2)\n(+ 3 3)");
    expect(events[0]!.kind).toBe("topology");
    const topology = events[0] as ReplTopologyEvent;
    expect(topology.total).toBe(3);
    expect(topology.forms).toEqual([
      { index: 0, source: "(+ 1 1)" },
      { index: 1, source: "(+ 2 2)" },
      { index: 2, source: "(+ 3 3)" },
    ]);
    const stmts = statements(events);
    expect(stmts.map((s) => s.index)).toEqual([0, 1, 2]);
    // exactly one topology + one statement per form — nothing else in the stream
    expect(events).toHaveLength(4);
  });

  it("terminal-on-error: the error statement is the LAST event; later forms emit nothing", async () => {
    const { events } = await callWithEvents(demoTool(), "(+ 1 1)\n(this-verb-does-not-exist)\n(+ 999 999)");
    const stmts = statements(events);
    expect(stmts).toHaveLength(2); // NOT 3 — the third form never executes, never events
    expect(stmts[0]!.error).toBeUndefined();
    expect(stmts[1]!.error).toBeDefined();
    expect(events.at(-1)).toBe(stmts[1]); // nothing after the terminal statement
  });

  it("a parse crash emits an EMPTY topology + ONE synthetic terminal statement at index 0 (the repl-event.ts convention)", async () => {
    const { out, events } = await callWithEvents(demoTool(), "(unterminated");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: "topology", total: 0, forms: [] });
    const stmt = events[1] as ReplStatementEvent;
    expect(stmt.index).toBe(0);
    expect(stmt.error).toBeDefined();
    expect(stmt.content).toEqual([{ type: "text", text: out[0] }]);
  });

  it("an empty expr emits ONE empty topology and no statements", async () => {
    const { out, events } = await callWithEvents(demoTool(), "");
    expect(out).toEqual([]);
    expect(events).toEqual([{ kind: "topology", total: 0, forms: [] }]);
  });

  it("the statement-cap door is a TERMINAL statement event at the capped form's own topology slot", async () => {
    const { out, events } = await callWithEvents(demoTool({ statementCap: 1 }), "(+ 1 1)\n(+ 2 2)");
    expect((events[0] as ReplTopologyEvent).total).toBe(2);
    const stmts = statements(events);
    expect(stmts).toHaveLength(2);
    expect(stmts[1]!.index).toBe(1);
    expect(stmts[1]!.error).toMatch(/statement cap/);
    expect(stmts[1]!.content).toEqual([{ type: "text", text: out.at(-1) }]);
    expect(events.at(-1)).toBe(stmts[1]);
  });
});

describe("R5 — aggregate law (result ≡ ordered concat of statement events' FULL content)", () => {
  it("success batch: flattened statement texts ARE the call's string[] output, in order", async () => {
    const { out, events } = await callWithEvents(demoTool(), '(+ 1 1)\n(list 1 "two" 3.0)\n(+ 3 3)');
    const concat = statements(events).flatMap((s) => s.content.map((b) => (b.type === "text" ? b.text : "")));
    expect(concat).toEqual(out);
  });

  it("crash batch: the (error …) door rides the terminal statement's content — the concat still equals the aggregate", async () => {
    const { out, events } = await callWithEvents(demoTool(), "(+ 1 1)\n(nope-verb)");
    const concat = statements(events).flatMap((s) => s.content.map((b) => (b.type === "text" ? b.text : "")));
    expect(concat).toEqual(out);
    expect(out.at(-1)).toMatch(/^\(error /);
  });
});

describe("R5 — budget law (parse-first per-form budget; the SUM stays bounded)", () => {
  // A ~30k-char rendering per form: 100 list items of 300 chars each (the serializer's default
  // per-string cap is 2000 and per-collection cap 100, so MANY medium strings — not one huge
  // string — is the shape whose render actually scales to the total budget).
  const bigItem = `"${"a".repeat(300)}"`;
  const bigListForm = `(list ${Array.from({ length: 100 }, () => bigItem).join(" ")})`;

  it("a single ~30k form is NOT truncated (it fits the whole 40k budget alone)", async () => {
    const { out } = await callWithEvents(demoTool(), bigListForm);
    const texts = textsOf(out);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.length).toBeGreaterThanOrEqual(25_000);
  });

  it("four ~30k forms each serialize under their FAIR SHARE (≈10k), so the batch SUM is bounded by the 40k output budget", async () => {
    const expr = Array.from({ length: 4 }, () => bigListForm).join("\n");
    const { out } = await callWithEvents(demoTool(), expr);
    const texts = textsOf(out);
    expect(texts).toHaveLength(4);
    for (const element of texts) expect(element.length).toBeLessThanOrEqual(12_000); // 40k/4 + shrink-loop slack
    const sum = texts.reduce((n, element) => n + element.length, 0);
    expect(sum).toBeLessThanOrEqual(45_000); // bounded SUM — the batch budget, not a per-form one
  });
});

describe("R5 — counters law", () => {
  it("heapMax is the default-ON 100M bound; heapUsed/elapsed are sane; session heapUsedTotal ≡ Σ statement heapUsed", async () => {
    const session = { id: "s-counters", state: {} as Record<string, unknown> };
    const { events } = await callWithEvents(
      demoTool(),
      "(define xs (list 1 2 3 4 5))\n(map (lambda (x) (* x 2)) xs)",
      session,
    );
    const stmts = statements(events);
    expect(stmts).toHaveLength(2);
    for (const s of stmts) {
      expect(s.counters.heapMax).toBe(100_000_000);
      expect(s.counters.heapUsed).toBeGreaterThanOrEqual(0);
      expect(s.counters.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(s.counters.budgetMsRemaining).toBeGreaterThanOrEqual(0);
      expect(s.counters.budgetMsRemaining).toBeLessThanOrEqual(5000);
    }
    const run = session.state.__run__;
    if (!isSessionRunState(run)) throw new Error("session run state missing");
    const contributed = stmts.reduce((n, s) => n + s.counters.heapUsed, 0);
    expect(run.counters.heapUsedTotal).toBe(contributed); // monotonic contributions, fully accounted
  });

  it("a second call keeps ACCRUING heapUsedTotal (monotonic across calls)", async () => {
    const tool = demoTool();
    const session = { id: "s-accrue", state: {} as Record<string, unknown> };
    await callWithEvents(tool, "(define xs (list 1 2 3))", session);
    const afterFirstState = session.state.__run__;
    if (!isSessionRunState(afterFirstState)) throw new Error("session run state missing");
    const afterFirst = afterFirstState.counters.heapUsedTotal;
    const { events } = await callWithEvents(tool, "(map (lambda (x) (+ x 1)) xs)", session);
    const contributed = statements(events).reduce((n, s) => n + s.counters.heapUsed, 0);
    expect(afterFirstState.counters.heapUsedTotal).toBe(afterFirst + contributed);
  });
});

describe("R5 — non-streaming byte-identity (events are additive observation)", () => {
  it("the same program returns the byte-identical aggregate with and without a listener", async () => {
    const expr = '(define x 21)\n(* x 2)\n(list 1 "two" 3.0)';
    const plain = await demoTool().call({ expr }, { session: { id: "p1", state: {} } });
    const { out: streamed } = await callWithEvents(demoTool(), expr, { id: "p2", state: {} });
    expect(streamed).toEqual(plain);
  });

  it("sessionless calls stream the same laws (topology first, aggregate ≡ concat)", async () => {
    const events: ReplEvent[] = [];
    const out = await demoTool().call({ expr: "(+ 1 1)\n(+ 2 2)" }, { onEvent: (event) => events.push(event) });
    expect(events[0]!.kind).toBe("topology");
    const concat = statements(events).flatMap((s) => s.content.map((b) => (b.type === "text" ? b.text : "")));
    expect(concat).toEqual(out);
  });
});

// repl-fold — verdict coverage for the headless REPL core (arrival-awesome-repl wave 1,
// D6). Pure `(model, event) → model`, so every case here is a plain transition table:
// no ambient, no execState, no IO. See ../repl-fold.ts for the state-machine rationale.

import { describe, expect, it } from "vitest";

import type { ReplEvent, StatementCounters } from "../repl-event.js";
import { EMPTY_REPL_MODEL, foldReplEvent, type ReplFoldModel } from "../repl-fold.js";

const counters = (over: Partial<StatementCounters> = {}): StatementCounters => ({
  heapUsed: 10,
  heapMax: 100_000_000,
  elapsedMs: 1,
  ...over,
});

const topology3: ReplEvent = {
  kind: "topology",
  total: 3,
  forms: [
    { index: 0, source: "(define x 1)" },
    { index: 1, source: "(+ x 1)" },
    { index: 2, source: "(* x 2)" },
  ],
};

describe("foldReplEvent — topology", () => {
  it("paints slot 0 running and the rest pending", () => {
    const model = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    expect(model.blocks.map((b) => b.state)).toEqual(["running", "pending", "pending"]);
    expect(model.blocks.map((b) => b.source)).toEqual(["(define x 1)", "(+ x 1)", "(* x 2)"]);
  });

  it("an empty topology (parse-crash convention) yields an empty skeleton", () => {
    const model = foldReplEvent(EMPTY_REPL_MODEL, { kind: "topology", total: 0, forms: [] });
    expect(model.blocks).toEqual([]);
  });

  it("total: 0 with a nonempty forms array never happens on the wire, but even so nothing is inferred running", () => {
    const model = foldReplEvent(EMPTY_REPL_MODEL, { kind: "topology", total: 0, forms: [{ index: 0, source: "()" }] });
    expect(model.blocks[0]?.state).toBe("pending");
  });
});

describe("foldReplEvent — statement, success path", () => {
  it("fills the settled slot done and advances the NEXT pending slot to running", () => {
    const t0 = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    const t1 = foldReplEvent(t0, {
      kind: "statement",
      index: 0,
      content: [{ type: "text", text: "1" }],
      counters: counters(),
    });
    expect(t1.blocks.map((b) => b.state)).toEqual(["done", "running", "pending"]);
    expect(t1.blocks[0]?.content).toEqual([{ type: "text", text: "1" }]);
    expect(t1.blocks[0]?.source).toBe("(define x 1)"); // the topology slice survives the fill
  });

  it("settled blocks never repaint on a later event (scrollback is a provenance record)", () => {
    let model: ReplFoldModel = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    model = foldReplEvent(model, { kind: "statement", index: 0, content: [], counters: counters() });
    const doneBlock0 = model.blocks[0];
    model = foldReplEvent(model, { kind: "statement", index: 1, content: [], counters: counters() });
    expect(model.blocks[0]).toBe(doneBlock0); // same reference — untouched by the index:1 fold step
  });

  it("running the last slot leaves nothing pending or running behind", () => {
    let model: ReplFoldModel = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    for (const index of [0, 1, 2]) {
      model = foldReplEvent(model, { kind: "statement", index, content: [], counters: counters() });
    }
    expect(model.blocks.map((b) => b.state)).toEqual(["done", "done", "done"]);
  });
});

describe("foldReplEvent — statement, terminal error", () => {
  it("tints the failing slot error and flips every not-yet-settled slot to skipped", () => {
    // Statement events are strictly ordered by index (the event-order law) — index 0
    // settles first, THEN index 1 crashes.
    const t0 = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    const t1 = foldReplEvent(t0, { kind: "statement", index: 0, content: [], counters: counters() });
    const t2 = foldReplEvent(t1, {
      kind: "statement",
      index: 1,
      content: [{ type: "text", text: '(error "boom")' }],
      counters: counters(),
      error: "boom",
    });
    expect(t2.blocks.map((b) => b.state)).toEqual(["done", "error", "skipped"]);
    expect(t2.blocks[1]?.error).toBe("boom");
  });

  it("an earlier already-done block stands (REPL semantics) — error only reaches undone slots", () => {
    let model: ReplFoldModel = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    model = foldReplEvent(model, { kind: "statement", index: 0, content: [], counters: counters() });
    model = foldReplEvent(model, {
      kind: "statement",
      index: 1,
      content: [],
      counters: counters(),
      error: "boom",
    });
    expect(model.blocks.map((b) => b.state)).toEqual(["done", "error", "skipped"]);
  });
});

describe("foldReplEvent — parse-crash convention", () => {
  it("an empty topology plus a synthetic terminal statement at index 0 still renders one block", () => {
    const t0 = foldReplEvent(EMPTY_REPL_MODEL, { kind: "topology", total: 0, forms: [] });
    const t1 = foldReplEvent(t0, {
      kind: "statement",
      index: 0,
      content: [{ type: "text", text: '(error "unexpected EOF")' }],
      counters: counters(),
      error: "unexpected EOF",
    });
    expect(t1.blocks).toHaveLength(1);
    expect(t1.blocks[0]).toMatchObject({ index: 0, state: "error", source: "", error: "unexpected EOF" });
  });
});

describe("foldReplEvent — validation (D5, wave 1 reserved)", () => {
  it("is a no-op — nothing emits this event yet, but the fold must not crash on it", () => {
    const model = foldReplEvent(EMPTY_REPL_MODEL, topology3);
    const after = foldReplEvent(model, { kind: "validation", diagnostics: [] });
    expect(after).toBe(model); // identity no-op, not merely equal
  });
});

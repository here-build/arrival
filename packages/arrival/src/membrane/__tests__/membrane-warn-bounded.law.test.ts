// A MEMBRANE WARNING IS BOUNDED BY ITS SHAPES, NOT BY THE DATA.
//
// Found the hard way (2026-07-14). A benchmark facade died mid-run:
//
//     FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
//
// and its log held ~400k copies of ONE line:
//
//     [arrival membrane] a JS `undefined` crossed into Scheme and materialized to #void — …
//
// A tool had returned a large JSON array whose objects carried nulls. Every null crossing the
// membrane logged a full paragraph. 8 benchmark tasks were lost to the crash ("facade unavailable").
//
// The warning is RIGHT to exist — "a JS `undefined` has no portable Scheme representation" is worth
// saying. It is worth saying ONCE. Said per value, an O(1) diagnostic becomes an O(n) cost on the
// hot path, and the one useful line becomes unfindable among 400k identical ones.
//
// Same law as the note sink: a fact ABOUT the crossing belongs to the RUN, not to each value that
// makes it. This test pins the bound — and that the budget is PER RUN: lines land on the run's
// NoteSink (core has no console), counts live per RunContext.

import { beforeEach, describe, expect, it } from "vitest";

import { RunContext } from "../../run/RunContext.js";
import { createNoteSink, type NoteSink } from "../../run/note-sink.js";
import { warnMembrane } from "../membrane-warn.js";

let notes: NoteSink;
let run: RunContext;

beforeEach(() => {
  notes = createNoteSink();
  run = new RunContext({ notes });
});

describe("POSITIVE — the warning still teaches", () => {
  it("the first crossing of a shape is reported, in full", () => {
    warnMembrane(run, "a JS `undefined`");
    const lines = notes.drain();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[arrival membrane]");
    expect(lines[0]).toContain("a JS `undefined`");
    expect(lines[0]).toContain("no portable"); // the teaching clause survives
  });

  it("DISTINCT shapes each get their own report — the bound is per-shape, not global", () => {
    warnMembrane(run, "a JS `undefined`");
    warnMembrane(run, "a JS function");
    warnMembrane(run, "a unique symbol");
    const texts = notes.drain();
    expect(texts.some((t) => t.includes("undefined"))).toBe(true);
    expect(texts.some((t) => t.includes("function"))).toBe(true);
    expect(texts.some((t) => t.includes("unique symbol"))).toBe(true);
  });

  it("a custom outcome is a distinct shape and is not swallowed by the default one", () => {
    warnMembrane(run, "a class instance", "crossed to a borrowed wrapper");
    expect(notes.drain()[0]).toContain("borrowed wrapper");
  });
});

// ─── THE NEGATIVE SIDE — the part that actually killed a process ────────────────────────────────
describe("NEGATIVE — the warning cannot scale with the data", () => {
  it("400_000 identical crossings do NOT produce 400_000 lines", () => {
    for (let i = 0; i < 400_000; i++) warnMembrane(run, "a JS `undefined`");
    // The NoteSink dedups identical lines (the model needs the fact once): 1 teaching line + 1
    // suppression notice. NOT 400k. This is the whole point of the file: the number below must not
    // be a function of the loop bound above.
    expect(notes.drain()).toHaveLength(2);
  });

  it("the suppression is ANNOUNCED — silence must never be mistaken for absence", () => {
    for (let i = 0; i < 50; i++) warnMembrane(run, "a JS `undefined`");
    // Errors-as-doors: a truncation that is not signaled is a lie.
    expect(notes.drain().some((t) => t.includes("further identical crossings will not be reported"))).toBe(true);
  });

  it("the suppression notice itself is emitted ONCE, not once per suppressed crossing", () => {
    for (let i = 0; i < 1000; i++) warnMembrane(run, "a JS `undefined`");
    expect(notes.drain().filter((t) => t.includes("further identical crossings"))).toHaveLength(1);
  });

  it("a run without a note sink is SILENT — core has no console to fall back on", () => {
    const bare = new RunContext();
    expect(() => {
      for (let i = 0; i < 10; i++) warnMembrane(bare, "a JS `undefined`");
    }).not.toThrow();
  });
});

describe("PER RUN — the budget belongs to the run, not the process", () => {
  it("two runs each get their own warnings and their own limit", () => {
    const notesB = createNoteSink();
    const runB = new RunContext({ notes: notesB });
    for (let i = 0; i < 20; i++) {
      warnMembrane(run, "a JS `undefined`");
      warnMembrane(runB, "a JS `undefined`");
    }
    const a = notes.drain();
    const b = notesB.drain();
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a).toEqual(b);
  });

  it("run A exhausting a shape does not silence run B", () => {
    for (let i = 0; i < 10; i++) warnMembrane(run, "a JS function");
    notes.drain();
    const notesB = createNoteSink();
    warnMembrane(new RunContext({ notes: notesB }), "a JS function");
    expect(notesB.drain()).toHaveLength(1);
  });
});

// runner.test — end-to-end regression coverage for the 2026-07-06 migration off the retired
// arrival-sugarcoat spike parser (statement-facts.ts's module header has the full account). Two
// things this file exists to prove, neither provable at the `statement-facts.ts`
// unit level alone, because both require the REAL `createDoorsRunner(...).run(...)` loop
// (runner.ts) — the syntax gate, the forms/statements alignment logic, and real `exec()`:
//
//   1. THE CRASH REGRESSION: a live MCP-Atlas benchmark run crashed twice on ordinary R7RS code
//      (`(char=? #\" (car chars))`, a model writing a CSV parser) because `runner.ts`'s
//      `analyzeStatement` call used to run that retired spike parser on the SAME source text
//      independently of the real interpreter — and that spike parser's own file header listed
//      "no vectors / #\char" as a known v0 limitation. Feeding the exact crash shape through the
//      REAL `run()` must now return a normal (non-throwing, non-crashing) result, proving the
//      production bug is fixed by the actual migration (not merely by the earlier, narrower
//      character-literal patch to that retired reader, which is now provably UNREACHABLE from
//      this path — see Point 6's dependency removal in the migration task).
//   2. THE `#;` R7RS-CORRECTNESS CASE: `runner.ts` now executes/analyzes exclusively from
//      `forms` (the real parser's output), never from `splitTopLevel`'s text-statement count —
//      so a `#;`-commented-out form must never execute. THIS WAS A LATENT, PRE-EXISTING BUG,
//      NOW FIXED BY THIS MIGRATION — confirmed empirically (not assumed): `splitTopLevel`'s
//      `isSkippable` only skips the bare `#;` MARKER token itself; it does NOT skip the datum
//      that follows. Tracing the real tokenizer on `(define x 1) #;(set! x 999) x` shows `#;`
//      and the following `(` arrive as two SEPARATE tokens, and `between` is left `true` across
//      the skipped `#;` token — so the very next token still starts a FRESH text statement.
//      `splitTopLevel` therefore yields THREE text statements for that input — `(define x 1)`,
//      `(set! x 999)`, and `x` — with the `#;` marker simply stripped out of the slice, not the
//      datum it comments out. The OLD code's statement loop `exec`'d each of `splitTopLevel`'s
//      text statements directly, so it WOULD have executed `(set! x 999)` for real, mutating
//      `x` to 999 — a real R7RS-incorrectness bug that predates this migration. The NEW
//      forms-based loop fixes this as a side effect: `parse()` genuinely drops a `#;`-commented
//      form from `forms` (never a text-slicing approximation), so it is never handed to `exec`
//      at all. This test pins the NOW-correct behavior and guards against regressing back to
//      text-based execution.

import { sandboxedEnv, type SchemeEnv } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import type { AttachmentSink } from "../attachment-sink.js";
import type { BoundTool } from "../bound-tool.js";
import { createDoorsRunner } from "../runner.js";
import { KWARGS_STRATEGIES } from "../strategies.js";

/** No captured binary attachments in these tests — a no-op sink is a valid implementation
 *  (attachment-sink.ts's own doc: "arrival-mcp's positional/native-verb world has no equivalent
 *  binary-leak problem today; a no-op sink is a valid implementation there"). */
const noopSink: AttachmentSink = {
  beginCall(): void {},
  drainBlocks: () => [],
  drainNote: () => undefined,
};

function makeRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({
    toolNaming: { toolName: "eval", argName: "expr" },
    strategies: KWARGS_STRATEGIES,
    attachmentSink: noopSink,
  });
}

/** A fresh, isolated real R7RS env for one test — `sandboxedEnv.inherit(...)`'s return type is
 *  the internal (unexported) concrete `Environment` class, which satisfies `SchemeEnv`
 *  STRUCTURALLY but can't be named across the package boundary (the same `unknown`-then-cast
 *  pattern render-observation.test.ts's own `freshEnv()` already uses in this package). */
function freshEnv(name: string): unknown {
  return sandboxedEnv.inherit(name, {});
}

const noTools = new Map<string, BoundTool>();

describe("createDoorsRunner(...).run(...) — end-to-end regression, real reader + real exec", () => {
  it("the exact MCP-Atlas crash shape (char=? against a quote-character literal) runs without throwing", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-crash-regression") as SchemeEnv;
    const result = await runner.run({
      expr: String.raw`(char=? #\" (car (string->list ",")))`,
      env,
      tools: noTools,
    });
    // This is the actual production crash: the statement-facts analysis step used to throw on
    // a bare #\" character literal BEFORE any real execution happened, killing the whole call
    // even though arrival's real interpreter handles this code fine.
    expect(result.isError).not.toBe(true);
    expect(result.content.some((b) => b.type === "text" && /Error:/.test(b.text))).toBe(false);
  });

  it("the fuller CSV-parser shape from the original crash report runs cleanly end to end", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-crash-regression-csv") as SchemeEnv;
    const result = await runner.run({
      expr: String.raw`(define (split-csv-row row)
  (let loop ((chars (string->list row)) (current '()) (fields '()))
    (cond
      ((null? chars)
       (reverse (cons (list->string (reverse current)) fields)))
      ((char=? #\" (car chars))
       (loop (cdr chars) current fields))
      ((char=? #\, (car chars))
       (loop (cdr chars) '() (cons (list->string (reverse current)) fields)))
      (else
       (loop (cdr chars) (cons (car chars) current) fields)))))
(split-csv-row "a,\"b\",c")`,
      env,
      tools: noTools,
    });
    expect(result.isError).not.toBe(true);
  });

  it("R7RS `#;` datum comment: the commented-out form is never executed", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-hash-semicolon") as SchemeEnv;
    const result = await runner.run({
      expr: "(define x 1) #;(set! x 999) x",
      env,
      tools: noTools,
    });
    expect(result.isError).not.toBe(true);
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    // x must reflect the un-mutated define (1), never the datum-commented-out (set! x 999).
    expect(rendered).toContain("1");
    expect(rendered).not.toContain("999");
  });

  it("a `#;`-commented form alongside real forms does not shift execution onto the wrong statement", async () => {
    // `(a) #;(b) (c)` is the exact shape statement-facts.ts's module header cites: 2 real forms,
    // but splitTopLevel's TEXT split would still count 3 statements if it were (wrongly) used as
    // the execution source. Using `define`s so each statement's effect is independently visible.
    const runner = makeRunner();
    const env = freshEnv("runner-hash-semicolon-alignment") as SchemeEnv;
    const result = await runner.run({
      expr: "(define a 10) #;(define bogus 999) (define c (+ a 5)) c",
      env,
      tools: noTools,
    });
    expect(result.isError).not.toBe(true);
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("15"); // c = a + 5 = 15, proving `a` resolved correctly (not shadowed by "bogus")
  });
});

describe("createDoorsRunner(...).run(...) — the import-form door (doors.ts's importDoor)", () => {
  // Forensic finding (2026-07-06): a benchmark model prepended `(import (scheme base))` (a
  // malformed R7RS import — this REPL has no module system at all) to every program in an
  // 11-repeat run, never redirected. `importDoor` fires on the two unbound heads that produces
  // (`import`, `scheme`); these tests drive it through the REAL runner, not the pure door builder.

  it("`(scheme base)` alone: the door teaches (stdlib already in scope / drop the form), and the rest of the program still computes", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-import-form-scheme-head") as SchemeEnv;
    const result = await runner.run({
      expr: "(scheme base) (+ 1 2)",
      env,
      tools: noTools,
    });
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("Error: Unbound variable");
    expect(rendered).toContain("standard library is already fully bound");
    expect(rendered).toContain("Drop that form and resend the rest of the program unchanged");
    expect(rendered).toContain("3"); // (+ 1 2) still computed despite the first statement's error
  });

  it("`(import (scheme base))`: the outer `import` head also gets the door", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-import-form-import-head") as SchemeEnv;
    const result = await runner.run({
      expr: "(import (scheme base))",
      env,
      tools: noTools,
    });
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("Error: Unbound variable");
    expect(rendered).toContain("standard library is already fully bound");
    expect(rendered).toContain("Drop that form and resend the rest of the program unchanged");
  });

  it("an unrelated unbound variable never gets the import-form door", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-import-form-unrelated") as SchemeEnv;
    const result = await runner.run({
      expr: "(frobnicate 1 2)",
      env,
      tools: noTools,
    });
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("Error: Unbound variable");
    expect(rendered).not.toContain("standard library is already fully bound");
    expect(rendered).not.toContain("module form");
  });

  it("an 11-repeat run teaches the lesson VERBOSE once, then collapses to terse (no 11 verbose repeats)", async () => {
    const runner = makeRunner();
    const env = freshEnv("runner-import-form-repeats") as SchemeEnv;
    const renders: string[] = [];
    for (let i = 0; i < 11; i++) {
      const result = await runner.run({ expr: "(scheme base)", env, tools: noTools });
      renders.push(result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
    }
    expect(renders[0]).toContain("standard library is already fully bound");
    for (let i = 1; i < renders.length; i++) {
      expect(renders[i]).not.toContain("standard library is already fully bound");
      expect(renders[i]).toContain("standard library is already in scope");
    }
  });
});

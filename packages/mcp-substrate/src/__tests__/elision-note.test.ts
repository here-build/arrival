// elision-note — runner.ts's aggregation of arrival-serializer's `ElisionRecord`s into ONE
// trailing `;; Note:` content block per `run()` call (serializer-elision plan §6). The
// middle-elision feature itself is OPT-IN via `calibration.observationElision` — a runner that
// never sets it (every OTHER test in this package) keeps today's tail-truncation, no note
// block, ever. This file is the one place that turns it on and exercises the note.

import { LexicalScope } from "@here.build/arrival";
import { assembleAmbient, type AssembledAmbient } from "@here.build/arrival/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttachmentSink } from "../attachment-sink.js";
import type { BoundTool } from "../bound-tool.js";
import { createDoorsRunner } from "../runner.js";
import { KWARGS_STRATEGIES } from "../strategies.js";

const noopSink: AttachmentSink = {
  beginCall(): void {},
  drainBlocks: () => [],
  drainNote: () => undefined,
};

/** A runner with middle-elision turned ON — the manifold's own defaults (serializer-elision
 *  plan §7): a small per-array display cap, a generous topLevelArrayLimit so a
 *  moderately-sized array isn't ALSO caught by the plain maxItems, and a 5/5 head/tail
 *  window. */
function makeElidingRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({
    toolNaming: { toolName: "eval", argName: "expr" },
    strategies: KWARGS_STRATEGIES,
    attachmentSink: noopSink,
    calibration: {
      observationElision: {
        maxItems: 20,
        topLevelArrayLimit: 100,
        secondLevelArrayLimit: 100,
        elideHead: 5,
        elideTail: 5,
      },
    },
  });
}

function makePlainRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({ toolNaming: { toolName: "eval", argName: "expr" }, strategies: KWARGS_STRATEGIES, attachmentSink: noopSink });
}

let ambient: AssembledAmbient;
beforeAll(async () => {
  ambient = await assembleAmbient({});
});
afterAll(async () => {
  await ambient.dispose();
});

function freshScope(name: string): LexicalScope {
  return LexicalScope.fresh(name);
}

const noTools = new Map<string, BoundTool>();

describe("runner.ts — trailing elision note (serializer-elision plan §6)", () => {
  it("a manifold-style 100-item array observation produces ONE trailing note block", async () => {
    const runner = makeElidingRunner();
    const scope = freshScope("elision-note-single");
    const result = await runner.run({ expr: "(iota 100)", ambient, scope, tools: noTools });

    expect(result.isError).not.toBe(true);
    const noteBlocks = result.content.filter((b) => b.type === "text" && b.text.startsWith(";; Note:"));
    expect(noteBlocks).toHaveLength(1);
    expect(noteBlocks[0]!.type).toBe("text");
    expect((noteBlocks[0] as { text: string }).text).toContain(
      "arrays were shortened for display — the shown items are NOT the full result.",
    );
    expect((noteBlocks[0] as { text: string }).text).toContain("array of 100 items:");
    expect((noteBlocks[0] as { text: string }).text).toContain("not rendered");
  });

  it("two forms that each elide produce ONE note block with two lines", async () => {
    const runner = makeElidingRunner();
    const scope = freshScope("elision-note-two-forms");
    const result = await runner.run({
      expr: "(iota 100)\n(iota 200)",
      ambient,
      scope,
      tools: noTools,
    });

    expect(result.isError).not.toBe(true);
    const noteBlocks = result.content.filter((b) => b.type === "text" && b.text.startsWith(";; Note:"));
    expect(noteBlocks).toHaveLength(1);
    const text = (noteBlocks[0] as { text: string }).text;
    const lines = text.split("\n").filter((l) => l.startsWith(";;   array of"));
    expect(lines).toHaveLength(2);
    expect(text).toContain("array of 100 items:");
    expect(text).toContain("array of 200 items:");
  });

  it("no elision configured → no note block, ever", async () => {
    const runner = makePlainRunner();
    const scope = freshScope("elision-note-off");
    const result = await runner.run({ expr: "(iota 100)", ambient, scope, tools: noTools });

    expect(result.isError).not.toBe(true);
    const noteBlocks = result.content.filter((b) => b.type === "text" && b.text.startsWith(";; Note:"));
    expect(noteBlocks).toHaveLength(0);
  });

  it("a small array that fits under the limits elides nothing → no note block", async () => {
    const runner = makeElidingRunner();
    const scope = freshScope("elision-note-small");
    const result = await runner.run({ expr: "(iota 5)", ambient, scope, tools: noTools });

    expect(result.isError).not.toBe(true);
    const noteBlocks = result.content.filter((b) => b.type === "text" && b.text.startsWith(";; Note:"));
    expect(noteBlocks).toHaveLength(0);
  });
});

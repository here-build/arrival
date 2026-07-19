// COMBINED-TEACHING GOLDEN/CHARACTERIZATION TEST — the zero-behavior-change regression net that
// did not exist in any form (docs/working-proposals/arrival-manifold-package-split-2026-07-05.md,
// "Test safety net" gap #4). Every teaching mechanism is tested in ISOLATION elsewhere in this
// package, but block ORDERING and COEXISTENCE when several fire on the SAME call are load-bearing
// and were completely untested: `manifold-tool.ts`'s statement loop appends, in a FIXED order,
// statement-result blocks → futility `Note:` blocks → the type-hint trailing block → the
// attachment hidden-note → the attachment pass-through blocks. A future binder→runner extraction
// that re-homes these drains into the new package could reorder or silently drop a block class
// while every mechanism's OWN isolated test still passes — this is the one test that would catch
// that. There was NO `toMatchSnapshot`/`toMatchInlineSnapshot`/`__snapshots__` anywhere in this
// package before this file.
//
// One representative call fires FOUR mechanisms at once, through the REAL `buildManifoldServer` →
// `CallTool` path (never a hand-injected `createManifoldTool` call):
//   • a plain statement result                          (baseline — always present)
//   • a futility `Note:` (the 3rd distinct-arg call to a degraded tool, futility.ts)
//   • a type-hint trailing block (a genuine runtime type error, the real `createSpineLens`)
//   • BOTH attachment grades — one WITHIN quota (pass-through content block) and one HIDDEN past
//     quota (the trailing note + the stub-only text)
//
// Own this as a deliberate characterization LOCK: it should change only when block semantics
// intentionally change, never as a side effect of refactor plumbing.
//
// RE-PINNED per second-foundation/arrival-bench/docs/benchmark-defect-register.md §E3 (mcp-substrate runner.ts consolidation,
// landed in @inhuman.tools/mcp-substrate): the futility `Note:` block and the attachment
// hidden-note are NO LONGER separate peer text blocks interleaved with real data — the old
// assertion pinned exactly the channel-hygiene bug §E3 diagnosed (note-shaped producers reading
// as PEER DATA, one of them unshifted so it LED the response). Every note-shaped producer now
// accumulates into `notes: string[]` and renders as exactly ONE trailing block, labelled
// `── environment notes ──`, AFTER every real block (statement results, type-hint, attachment
// pass-through content) — never interleaved. The invariant this test protects — "every teaching
// class is present, in a stable order, when several fire on the same call" — still holds; only
// the futility-note and attachment-hidden-note CLASSES now co-occupy one combined block instead
// of two separate ones.

import { createSpineLens } from "@inhuman.tools/mcp-substrate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildManifoldEnv, toBoundTools } from "../bind.js";
import { connectServer } from "../connect.js";
import { TOOL_NAME } from "../names.js";
import { buildManifoldServer } from "../server.js";

// Warm the TS worker's first compile OUTSIDE the hint race budget — same discipline as
// type-hints/server-activation.test.ts, to keep the type-hint assertion below from flaking under
// parallel-suite load (skip:"race" on a cold first `ts.createProgram`).
beforeAll(async () => {
  const manifoldEnv = await buildManifoldEnv([], { attestation: "off" });
  await createSpineLens(toBoundTools(manifoldEnv)).diagnose("(warm_up 1)", []);
});

/** One deterministic 1x1 PNG's worth of base64 — small, fixed, so any byte-count text in a
 *  stub is stable across runs. Content doesn't matter; only that it decodes as SOME base64. */
const FAKE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** A fake upstream with three tools: a DEGRADED search (always the same body regardless of
 *  args — fires futility's trigger-1 on the 3rd distinct-arg call), an IMAGE tool (fires the
 *  attachment machinery, both grades depending on call order), and a SELF-VALIDATING counter
 *  (fires the type-hint on a wrongly-typed call, identical fixture shape to
 *  type-hints/server-activation.test.ts). */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "degraded",
        description: "degraded search",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
      {
        name: "img",
        description: "returns an image",
        inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      },
      {
        name: "set_count",
        description: "Set the counter",
        inputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "degraded") {
      return { content: [{ type: "text", text: "no results found - bot detection triggered" }] };
    }
    if (name === "img") {
      return { content: [{ type: "image", data: FAKE_PNG_BASE64, mimeType: "image/png" }] };
    }
    // set_count — self-validates like a real upstream would; a wrongly-typed :count is an
    // isError result (H-5 rule 1 re-raises it as the standard `Error:` observation).
    const count: unknown = (args as Record<string, unknown> | undefined)?.count;
    if (typeof count !== "number") {
      return { content: [{ type: "text", text: "set_count: expected :count to be a number" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify({ count }) }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

type Block = { type: string; text?: string };
const blocksOf = (r: { content: unknown }): Block[] => r.content as Block[];

describe("combined-teaching golden — statement result, futility Note, type hint, and BOTH attachment grades, all in ONE call, through the real server", () => {
  it("pins the exact block ORDER and the presence of every class", async () => {
    const upstream = await connectServer("fx", await fakeUpstream());
    const manifoldServer = await buildManifoldServer([upstream], {
      typeHints: { mode: "on-error" },
      attestation: "off",
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await manifoldServer.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(clientTransport);

    const call = async (expr: string | string[], extra?: Record<string, unknown>) =>
      (await client.callTool({
        name: TOOL_NAME,
        arguments: { "repl-input-scheme-program": expr, ...extra },
      })) as { content: unknown; isError?: boolean };

    // Two priming calls to the degraded tool with DISTINCT args — no note yet (futility needs a
    // 3rd identical-shaped result to confirm degradation).
    await call('(fx/degraded :q "alpha")');
    await call('(fx/degraded :q "beta")');

    // THE COMBINED CALL: one program, four statements, each firing a different mechanism —
    // plus `response-attachments: 1` so the FIRST image is within quota (pass-through) and the
    // SECOND is hidden (both attachment grades observed in one call).
    const result = await call(
      [
        '(fx/degraded :q "gamma")', // 3rd distinct-arg call → futility Note
        "(fx/img :id 1)", // within quota (1) → pass-through content block
        "(fx/img :id 2)", // over quota → hidden stub only
        '(fx/set_count :count "five")', // runtime type error → type-hint trailing block
      ],
      { "response-attachments": 1 },
    );

    expect(result.isError).toBeFalsy(); // partial success: 3 of 4 statements succeeded (REPL-continue)
    const blocks = blocksOf(result);

    // THE GOLDEN SHAPE: exactly 7 blocks, in this fixed order (was 8 before the §E3 note
    // consolidation — the futility Note and the attachment hidden-note used to be TWO separate
    // trailing blocks; they now render as lines inside ONE combined `environment-notes` block).
    // A normalized "class" descriptor per block (never the full text — attachment byte counts /
    // hash-derived note wording would make a literal full-text snapshot brittle for no safety
    // benefit) is what's actually pinned.
    const shapeOf = (b: Block): string => {
      if (b.type !== "text") return `block:${b.type}`;
      const text = b.text ?? "";
      if (text.startsWith("Type (")) return "type-hint";
      // §E3: the futility `Note:` line and the attachment hidden-note line both live INSIDE this
      // one `#| ── environment notes ── ... |#` block now — there is no longer a standalone
      // "Note:"-prefixed block to distinguish (renderEnvironmentNotes wraps every note-shaped
      // producer together, in declaration order: introduced-bindings, elision, futility, attachment).
      if (text.startsWith("#|")) return "environment-notes";
      if (text.startsWith("Error:")) return "statement-error";
      return "statement-result";
    };
    expect(blocks.map(shapeOf)).toEqual([
      "statement-result", // stmt0: (fx/degraded :q "gamma")'s own result text
      "statement-result", // stmt1: (fx/img :id 1) → the within-quota attachment stub STRING
      "statement-result", // stmt2: (fx/img :id 2) → the hidden-grade attachment stub STRING
      "statement-error", // stmt3: (fx/set_count :count "five") → Error: ...
      "type-hint", // the lens's trailing block
      "block:image", // the ONE within-quota block, passed through as its ORIGINAL content type
      "environment-notes", // §E3: futility Note + attachment hidden-note, ONE consolidated trailing block, LAST
    ]);

    // Spot-check the substantive content behind each class — proves the classes are the RIGHT
    // ones, not just correctly counted.
    expect(blocks[0]!.text).toContain("bot detection triggered");
    expect(blocks[1]!.text).toContain("#<attachment 1: image/png");
    expect(blocks[2]!.text).toContain("#<image 2: image/png");
    expect(blocks[3]!.text).toBe("Error: set_count: expected :count to be a number");
    expect(blocks[4]!.text).toContain("(string->number");
    expect(blocks[5]!.type).toBe("image");
    // §E3/C2: the old assertion pinned "...returned effectively the same result" and asserted a
    // standalone block; the door text itself changed too (benchmark-defect-register.md §C2 — the
    // "give your best final answer" outcome-fine-tuning script was removed, and "effectively"
    // dropped since the door no longer claims to know the results are only APPROXIMATELY equal).
    expect(blocks[6]!.text).toContain("── environment notes ──");
    expect(blocks[6]!.text).toContain("the last 3 calls to fx/degraded returned the same result despite different arguments");
    expect(blocks[6]!.text).toContain("1 images hidden (quota 1) — raise the 'response-attachments' tool argument");
  });
});

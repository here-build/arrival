// The FUTILITY DOOR's MCP-WIRING half (futility.ts + doors.ts futile/duplicate generators +
// manifold-tool drain + DoorSession.renderNote), driven through a REAL manifold server + a fake
// upstream. Measured problem: a model retries a degraded upstream tool many times (a search tool
// returning the identical "no results / bot detection" body under varied queries), burning the
// turn budget with no answer. Shape-based, semantics-free detection tells it to stop: the door is
// an advisory line ("Note: ...") appended to the SUCCESSFUL call's output — the tool result
// itself flows through untouched. Two triggers: futile-retry (last 3 results identical despite
// ≥2 distinct arg sets) and duplicate-call (same tool + same args + same result twice in a row).
//
// The PURE shape-logic half (`FutilityTracker`/`normalizeResultText` exercised directly, no MCP
// transport) moved to `@inhuman.tools/mcp-substrate`'s own `futility.test.ts` (2026-07-05 package
// split) — this file keeps only the wiring-through-a-real-server coverage.
//
// RE-PINNED per second-foundation/arrival-bench/docs/benchmark-defect-register.md §E3/§C2 — not one of the 4 files the re-pin
// task named, but broken by the exact same landed fix: the futility Note used to be its OWN
// standalone content block (`Note: ...`, first-word-prefixed). It now rides the consolidated
// `#| ── environment notes ── … |#` trailing block alongside every other note-shaped producer,
// and the door TEXT itself changed (§C2 — "give your best final answer" / "stop retrying" outcome
// fine-tuning removed; "effectively the same result" — asserting degradation as settled fact —
// became "the same result despite different arguments", a fact framed conditionally). See the
// `notes()` helper and the two TRIGGER-1 assertions below for the concrete diffs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";
import { buildManifoldServer } from "../server.js";

const TOOL = "scheme-repl-with-all-mcp-tools";

/** A fake upstream with four tools, each a controlled result shape:
 *   • degraded  — returns the SAME body no matter the args (the bot-wall / no-results case).
 *   • distinct  — echoes its `q` arg, so different args ⇒ different result.
 *   • clocked   — the same body except for an incrementing counter (differs ONLY in digits).
 * Every tool takes one required string `q`. */
async function fakeUpstream() {
  let clock = 0;
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["degraded", "distinct", "clocked"].map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as { q?: string };
    let text: string;
    switch (request.params.name) {
      case "distinct":
        text = `results for ${args.q}`;
        break;
      case "clocked":
        clock += 137;
        text = `rate limited, retry after ${clock} seconds`;
        break;
      default: // degraded
        text = "no results found - bot detection triggered";
    }
    return { content: [{ type: "text", text }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("up", await fakeUpstream());
  // attestation "off": tools still bind; no unattested-arg warnings on bare `:q "x"` literals.
  const manifoldServer = await buildManifoldServer([upstream], { attestation: "off" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

type Block = { type: string; text: string };
const blocksOf = (r: { content: unknown }): Block[] => r.content as Block[];
const textOf = (r: { content: unknown }): string =>
  blocksOf(r)
    .map((b) => b.text)
    .join("\n");
// RE-PINNED per second-foundation/arrival-bench/docs/benchmark-defect-register.md §E3 — NOT one of the 4 files named in the
// re-pin task, but the SAME root cause: mcp-substrate's runner.ts no longer emits a futility
// advisory as its OWN standalone `Note:`-prefixed content block. Every note-shaped producer
// (introduced-bindings, elision, futility, attachment) now accumulates and renders as ONE
// trailing block labelled `#| ── environment notes ── … |#`; the individual door's `Note: …`
// text (doors.ts DoorSession.renderNote, unchanged prefix) is just a LINE inside it. None of
// these fixtures ever trigger a second note-shaped producer in the same call, so "does the
// consolidated block exist" is still exactly the invariant "did a futility note fire" — the
// helper below adapts to the new envelope without weakening what it protects.
const notes = (r: { content: unknown }): Block[] => blocksOf(r).filter((b) => b.text.includes("── environment notes ──"));
const call = async (client: Client, expr: string): Promise<{ content: unknown; isError?: boolean }> =>
  (await client.callTool({ name: TOOL, arguments: { "repl-input-scheme-program": expr } })) as {
    content: unknown;
    isError?: boolean;
  };

describe("futility door — TRIGGER 1: degraded tool (futile-retry)", () => {
  it("3 distinct-arg calls across SEVERAL manifold calls → the 3rd carries the note; results untouched", async () => {
    const client = await manifoldClient();

    const r1 = await call(client, '(up/degraded :q "alpha")');
    const r2 = await call(client, '(up/degraded :q "beta")');
    const r3 = await call(client, '(up/degraded :q "gamma")');

    // First two calls: no note yet (need the third identical result to confirm degradation).
    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(0);

    // Third call: the futile-retry Note appears, and the tool's OWN result block is untouched.
    expect(r3.isError).toBeFalsy();
    expect(blocksOf(r3)).toHaveLength(2);
    expect(blocksOf(r3)[0]!.text).toContain("bot detection triggered"); // the real result, verbatim
    const note = notes(r3);
    expect(note).toHaveLength(1);
    // §C2 (benchmark-defect-register.md) — the door TEXT itself changed, not just the channel:
    // "effectively the same result" (implying degradation as a settled fact) became "the same
    // result despite different arguments" (a fact, framed conditionally); "stop retrying X" (an
    // outcome-fine-tuning imperative — load-bearing constraint #6 — that pushed a model to
    // abandon a recoverable search) was replaced with "change the arguments materially, or take
    // a different route", which prescribes nothing about whether to keep using the tool.
    expect(note[0]!.text).toContain("the last 3 calls to up/degraded returned the same result despite different arguments");
    expect(note[0]!.text).toContain("change the arguments to up/degraded materially, or take a different route");
    // §E3: the door's own text still leads with "Note: " (doors.ts DoorSession.renderNote is
    // unchanged) — it just isn't the block's OWN prefix anymore; it's a line inside the
    // consolidated `#| ── environment notes ── … |#` block.
    expect(note[0]!.text.startsWith("#| ── environment notes ──")).toBe(true);
    expect(note[0]!.text).toContain("Note:");
    expect(note[0]!.text).not.toContain("Error:");
  });

  // RE-PINNED, but NOT a §E3 channel/text change — a genuine, DELIBERATE behavior change from
  // mcp-substrate's C1b "trigger surgery" (benchmark-defect-register.md ADDENDUM, REVISED WAVE
  // ORDER item 3 / `futility.ts`'s `RingEntry.callId`): statements written in ONE program are
  // authored by the model WITHOUT having seen any sibling statement's result yet — three
  // identical results among THEM is not an "informed retry" (the door's whole premise), so both
  // triggers now require `distinctCalls >= 2` (each `run()` bumps `callId` once via
  // `tracker.beginCall()`). Unit-covered directly in mcp-substrate's own
  // `futility.test.ts`: "(a) three identical results from ONE program's statements (no
  // beginCall between them) fire NOTHING". This e2e case now asserts the SAME invariant through
  // the real wire: same-call batching is silent, never a false "you're retrying" note.
  it("3 distinct-arg statements in ONE manifold call → NO note (C1b: same-call statements are not an informed retry)", async () => {
    const client = await manifoldClient();
    const r = await call(client, '(up/degraded :q "a") (up/degraded :q "b") (up/degraded :q "c")');

    expect(r.isError).toBeFalsy();
    // three result blocks only — no consolidated environment-notes block at all.
    expect(blocksOf(r)).toHaveLength(3);
    expect(notes(r)).toHaveLength(0);
  });
});

describe("futility door — TRIGGER 2: pure repeat (duplicate-call)", () => {
  it("same tool + same args + same result twice → a duplicate-call note", async () => {
    const client = await manifoldClient();
    const r1 = await call(client, '(up/degraded :q "same")');
    const r2 = await call(client, '(up/degraded :q "same")');

    expect(notes(r1)).toHaveLength(0);
    const note = notes(r2);
    expect(note).toHaveLength(1);
    expect(note[0]!.text).toContain("you already have this exact up/degraded result above");
    // §E3: same header/line split as the futile-retry case above — the door text (duplicate-call
    // door, unchanged by §C2) still leads with "Note: " as a LINE inside the consolidated block.
    expect(note[0]!.text.startsWith("#| ── environment notes ──")).toBe(true);
    expect(note[0]!.text).toContain("Note:");
    expect(note[0]!.text).not.toContain("Error:");
    // the result block is still present and untouched
    expect(blocksOf(r2)[0]!.text).toContain("bot detection triggered");
  });
});

describe("futility door — negative / discrimination cases", () => {
  it("a tool returning DIFFERENT results is silent — no note ever", async () => {
    const client = await manifoldClient();
    const r1 = await call(client, '(up/distinct :q "a")');
    const r2 = await call(client, '(up/distinct :q "b")');
    const r3 = await call(client, '(up/distinct :q "c")');
    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(0);
    expect(notes(r3)).toHaveLength(0);
    expect(textOf(r3)).toContain("results for c");
  });

  it("a constant tool called with the SAME args 3× → duplicate-call fires, futile-retry does NOT (needs ≥2 distinct args)", async () => {
    const client = await manifoldClient();
    const r1 = await call(client, '(up/degraded :q "x")');
    const r2 = await call(client, '(up/degraded :q "x")'); // duplicate fires here
    const r3 = await call(client, '(up/degraded :q "x")'); // suppressed — no re-fire, and never futile

    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(1);
    expect(notes(r2)[0]!.text).toContain("you already have this exact up/degraded result");
    // r3 must NOT carry a futile-retry note (only one distinct argsHash), nor re-fire duplicate.
    expect(notes(r3)).toHaveLength(0);
  });

  // RE-PINNED — INVERTED, not a §E3 channel/text change. This test used to prove digit-stripping
  // (the old `DIGIT_RUN` regex in `normalizeResultText`) collapsed three byte-distinct "retry
  // after N seconds" bodies to one shape key. §C1 (benchmark-defect-register.md) — V RULING:
  // DELETE `DIGIT_RUN`. The 178-trajectory audit found digit-stripping never enabled a single
  // TRUE positive (every real degraded-tool firing was byte-identical prose with NO digits at
  // all — bot-detection pages, "No objects found") — it only manufactured FALSE ones:
  // `get_file_info`'s pure labels+digits body normalized three genuinely DIFFERENT files (sizes
  // 40435 / 810402 / 10266) to the same shape key, firing the door on legitimately distinct
  // results. Digits are frequently the PAYLOAD (file sizes, counts, ids, prices), not a volatile
  // token. The invariant this test protects is now the OPPOSITE of its old name: results that
  // differ only in digits must NOT be treated as identical.
  it("NO NORMALIZATION on digits (C1: DIGIT_RUN deleted) — results differing only in a counter are genuinely distinct, futile-retry does NOT fire", async () => {
    const client = await manifoldClient();
    // clocked returns "rate limited, retry after <n> seconds" with n incrementing each call —
    // three byte-DISTINCT bodies, and (post-C1) three distinct shape-hashes too.
    const r1 = await call(client, '(up/clocked :q "a")');
    const r2 = await call(client, '(up/clocked :q "b")');
    const r3 = await call(client, '(up/clocked :q "c")');
    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(0);
    // Pre-C1 this would have wrongly fired (digit-stripped shapes collided); post-C1 the digits
    // ARE the payload distinguishing three separate answers, so nothing fires.
    expect(notes(r3)).toHaveLength(0);
  });

  it("no re-fire spam on the 4th/5th identical call", async () => {
    const client = await manifoldClient();
    await call(client, '(up/degraded :q "a")');
    await call(client, '(up/degraded :q "b")');
    const r3 = await call(client, '(up/degraded :q "c")'); // futile fires
    const r4 = await call(client, '(up/degraded :q "d")');
    const r5 = await call(client, '(up/degraded :q "e")');

    expect(notes(r3)).toHaveLength(1);
    expect(notes(r4)).toHaveLength(0);
    expect(notes(r5)).toHaveLength(0);
  });
});

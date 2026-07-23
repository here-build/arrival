// The provenance-offloaded confirmation flow end to end.
//
// A tiny capability with ONE risky sink (`create-widget`, tool.risky) and ONE non-risky sink
// (`log-note`, tool.effect) drives every scenario: the hold rule fires only when a RISKY row
// is present — any risky row present ⇒ the ENTIRE burst holds — never on plain effects.

import { z } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";

import { ConfirmBurstTool } from "../confirm-burst.js";
import { DiscoveryTool, type DiscoveryToolOptions } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { tool } from "../tool.js";

interface Log {
  created: string[];
  notes: string[];
}

function confirmCapability(log: Log): McpEnvCapability {
  return new McpEnvCapability("confirm-caps", {
    symbols: {
      "create-widget": tool.risky`create-widget: creates a widget (irreversible)`(
        { shape: { name: z.string } },
        (args: { name: string }) => {
          log.created.push(args.name);
        },
      ),
      "log-note": tool.effect`log-note: appends a note (harmless)`({ shape: { text: z.string } }, (args: { text: string }) => {
        log.notes.push(args.text);
      }),
      "list-created": { fn: () => log.created.join(",") },
    },
    annotations: {
      "list-created": { description: "lists created widgets, comma-joined" },
    },
  });
}

function makeTool(log: Log, options: DiscoveryToolOptions = {}): DiscoveryTool {
  return new DiscoveryTool("t", confirmCapability(log), options);
}

/** Parse the manifest out of a held response — `[explanation, JSON]` (DiscoveryTool.call's
 *  hold-path shape). */
function parseManifest(out: readonly (string | Blob)[]): { digest: string; rows: { effectIndex: number; verb: string; risky: boolean; argLineage?: unknown }[] } {
  return JSON.parse(out[1] as string);
}

describe("risky-free run bursts immediately — unchanged behavior, zero tax", () => {
  it("a program with only non-risky effects fires them right away; no manifest, no hold", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const out = await t.call({ expr: `(log-note :text "hello") (log-note :text "world")` }, { session });

    expect(log.notes).toEqual(["hello", "world"]);
    expect(log.created).toEqual([]);
    // No manifest surfaced — this is the ordinary REPL response shape.
    expect(out.some((o) => typeof o === "string" && o.includes("\"digest\""))).toBe(false);
    expect((session.state.__run__ as { pendingManifest?: unknown }).pendingManifest).toBeUndefined();
  });
});

describe("a risky effect holds the WHOLE burst", () => {
  it("returns a manifest instead of bursting — even the non-risky sibling effect does not fire", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const out = await t.call({ expr: `(log-note :text "before") (create-widget :name "bomb")` }, { session });

    // NOTHING committed — fill-or-kill: the whole burst holds, not just the risky row.
    expect(log.notes).toEqual([]);
    expect(log.created).toEqual([]);

    const manifest = parseManifest(out);
    expect(manifest.rows).toHaveLength(2);
    const widgetRow = manifest.rows.find((r) => r.verb === "create-widget")!;
    const noteRow = manifest.rows.find((r) => r.verb === "log-note")!;
    expect(widgetRow.risky).toBe(true);
    expect(noteRow.risky).toBe(false);
    expect(manifest.digest).toBeTruthy();
    expect((session.state.__run__ as { pendingManifest?: unknown }).pendingManifest).toBeDefined();
  });
});

describe("confirm-burst — full approval", () => {
  it("bursts every approved effect in original program order", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const confirm = new ConfirmBurstTool("confirm-burst", t);
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const held = await t.call({ expr: `(log-note :text "before") (create-widget :name "bomb")` }, { session });
    const manifest = parseManifest(held);

    const result = await confirm.call(
      { digest: manifest.digest, approvedEffectIndexes: manifest.rows.map((r) => r.effectIndex) },
      { session },
    );

    expect(log.notes).toEqual(["before"]);
    expect(log.created).toEqual(["bomb"]);
    expect(result[0]).toMatch(/2\/2 effect\(s\) fired/);
    expect((session.state.__run__ as { pendingManifest?: unknown }).pendingManifest).toBeUndefined();
  });
});

describe("confirm-burst — partial approval", () => {
  it("bursts only the approved subset; the declined effect leaves no trace and is re-offered on re-run", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const confirm = new ConfirmBurstTool("confirm-burst", t);
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const held1 = await t.call({ expr: `(create-widget :name "a") (create-widget :name "b")` }, { session });
    const manifest1 = parseManifest(held1);
    const rowA = manifest1.rows.find((r) => JSON.stringify(r).includes('"a"'))!;

    // Approve ONLY "a" — decline "b".
    await confirm.call({ digest: manifest1.digest, approvedEffectIndexes: [rowA.effectIndex] }, { session });
    expect(log.created).toEqual(["a"]);

    // "b" left NO durable trace — nothing to confirm against the old digest anymore.
    await expect(
      confirm.call({ digest: manifest1.digest, approvedEffectIndexes: manifest1.rows.map((r) => r.effectIndex) }, { session }),
    ).rejects.toThrow(/no manifest is pending|does not match/i);

    // Re-issuing the ORIGINAL program re-offers "b" (and "a" again, honestly — fill-or-kill has
    // no memory of prior partial approvals; the client controls what to (re-)approve).
    const held2 = await t.call({ expr: `(create-widget :name "a") (create-widget :name "b")` }, { session });
    const manifest2 = parseManifest(held2);
    const rowB2 = manifest2.rows.find((r) => JSON.stringify(r).includes('"b"'))!;
    await confirm.call({ digest: manifest2.digest, approvedEffectIndexes: [rowB2.effectIndex] }, { session });
    expect(log.created).toEqual(["a", "b"]);
  });
});

describe("confirm-burst — wrong digest", () => {
  it("doors as 'which manifest?' rather than silently accepting", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const confirm = new ConfirmBurstTool("confirm-burst", t);
    const session = { id: "s1", state: {} as Record<string, unknown> };

    await t.call({ expr: `(create-widget :name "bomb")` }, { session });

    await expect(confirm.call({ digest: "not-a-real-digest", approvedEffectIndexes: [0] }, { session })).rejects.toThrow(
      /which manifest|does not match/i,
    );
    expect(log.created).toEqual([]);
  });

  it("with no session at all, refuses (nothing to confirm sessionlessly)", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const confirm = new ConfirmBurstTool("confirm-burst", t);
    await expect(confirm.call({ digest: "x", approvedEffectIndexes: [] })).rejects.toThrow(/requires a session/i);
  });
});

describe("a NEW program kills any pending manifest — fill-or-kill", () => {
  it("running a fresh program discards the held manifest; the old digest no longer confirms", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log);
    const confirm = new ConfirmBurstTool("confirm-burst", t);
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const held = await t.call({ expr: `(create-widget :name "bomb")` }, { session });
    const manifest = parseManifest(held);

    // A completely unrelated new call — even a harmless read — kills the pending order.
    await t.call({ expr: `(list-created)` }, { session });

    await expect(
      confirm.call({ digest: manifest.digest, approvedEffectIndexes: manifest.rows.map((r) => r.effectIndex) }, { session }),
    ).rejects.toThrow(/no manifest is pending/i);
    expect(log.created).toEqual([]); // the bomb never fired
  });
});

describe("lineage annotation — default-on, with a disable knob (§7.6)", () => {
  it("is present by default", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log); // lineage default (true)
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const held = await t.call({ expr: `(create-widget :name "bomb")` }, { session });
    const manifest = parseManifest(held);
    const row = manifest.rows[0]!;
    expect(row.argLineage).toBeDefined();
    expect((row.argLineage as unknown[]).length).toBeGreaterThan(0);
  });

  it("is absent when options.lineage is false — the manifest still builds (digest, invocationSource)", async () => {
    const log: Log = { created: [], notes: [] };
    const t = makeTool(log, { lineage: false });
    const session = { id: "s1", state: {} as Record<string, unknown> };

    const held = await t.call({ expr: `(create-widget :name "bomb")` }, { session });
    const manifest = parseManifest(held);
    const row = manifest.rows[0]!;
    expect(row.argLineage).toBeUndefined();
    expect(manifest.digest).toBeTruthy();
    expect((row as { invocationSource?: string }).invocationSource).toContain("create-widget");
  });
});

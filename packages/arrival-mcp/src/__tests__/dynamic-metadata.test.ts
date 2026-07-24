/**
 * The MCP metadata read path pins the closed drop + the activation channel end-to-end:
 *   • tool``'s `dynamicDescription` is forwarded into the baked def's metadata bag and
 *     lifted into the catalog annotation.
 *   • catalog resolution binds `this` = the owning capability's describe-ambient
 *     activation (host config + host resources — actor args don't exist at describe
 *     time), per read, no memo.
 *   • `undefined` resolution falls back to the static description, never flagged
 *     session-generated (the honest-failure contract).
 *   • a config schema requiring actor keys has no describe ambient — static catalog
 *     is the honest floor (and the legacy closure-form thunk still fires, receiver-free).
 */
import type { Activation } from "@inhuman.tools/arrival/capability";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { defineMcpCapability, mcpCatalogEntries } from "../defineMcpCapability.js";
import { tool } from "../tool.js";

function liveCapability(counters: { fired: number }) {
  return defineMcpCapability("live-caps", {
    configuration: { region: z.string().optional() },
    tools: () => ({
      status: tool`status: dashboard`(
        {
          input: [],
          output: [],
          shape: {},
          dynamicDescription(this: Activation<{ region: z.ZodOptional<z.ZodString> }, any>) {
            counters.fired += 1;
            const region = this?.configuration?.region;
            return region === undefined ? undefined : `status for ${region}`;
          },
        },
        () => "ok",
      ),
    }),
  });
}

describe("tool`` dynamicDescription — the closed drop, end to end", () => {
  it("forwards into the baked def's metadata, read straight off the catalog", () => {
    const counters = { fired: 0 };
    const cap = liveCapability(counters);
    const entry = mcpCatalogEntries(cap).find((e) => e.name === "status");
    expect(entry).toBeDefined();
    expect(typeof entry!.metadata.dynamicDescription).toBe("function");
    expect(entry!.metadata.description).toBe("dashboard");
    expect(counters.fired).toBe(0); // nothing resolved yet — read-time only
  });

  it("describe(): resolves against the describe-ambient activation (host config), flags live", async () => {
    const counters = { fired: 0 };
    const discovery = new DiscoveryTool("live", liveCapability(counters), {
      description: "live tool",
      hostConfig: { region: "eu-west" }, // HOST config — the describe ambient's whole world
    });
    try {
      const def = await discovery.describe();
      const expr = (def.inputSchema.properties!.expr as { description: string }).description;
      expect(expr).toContain("status for eu-west"); // the activation's config, through `this`
      expect(expr).toContain("NOT STATIC"); // flagged session-generated
      expect(counters.fired).toBeGreaterThan(0);
      const before = counters.fired;
      await discovery.describe();
      expect(counters.fired).toBeGreaterThan(before); // per read, no memo
    } finally {
      await discovery.dispose(); // tears the describe ambient down with the tool
    }
  });

  it("undefined resolution → static description stands, NOT flagged dynamic", async () => {
    const counters = { fired: 0 };
    // No hostConfig at all: `region` is optional ⇒ the describe ambient assembles, the
    // field resolves undefined ⇒ the honest fallback.
    const discovery = new DiscoveryTool("live", liveCapability(counters), { description: "live tool" });
    try {
      const def = await discovery.describe();
      const expr = (def.inputSchema.properties!.expr as { description: string }).description;
      expect(expr).toContain("(status) - dashboard"); // the static sibling
      expect(expr).not.toContain("NOT STATIC"); // and no session-generated claim
      expect(counters.fired).toBeGreaterThan(0); // the thunk DID fire — it answered undefined
    } finally {
      await discovery.dispose();
    }
  });

  it("actor-key-requiring config ⇒ no describe ambient — the static floor, no crash", async () => {
    const counters = { fired: 0 };
    const cap = defineMcpCapability("actor-caps", {
      configuration: { who: z.string() }, // REQUIRED actor key — underivable at describe time
      tools: () => ({
        status: tool`status: dashboard`(
          {
            input: [],
            output: [],
            shape: {},
            dynamicDescription() {
              counters.fired += 1;
              return undefined; // receiver-free legacy behavior — must not throw
            },
          },
          () => "ok",
        ),
      }),
    });
    const discovery = new DiscoveryTool("actor", cap, { description: "actor tool" });
    try {
      const def = await discovery.describe();
      const expr = (def.inputSchema.properties!.expr as { description: string }).description;
      expect(expr).toContain("(status) - dashboard");
      expect(counters.fired).toBeGreaterThan(0);
    } finally {
      await discovery.dispose();
    }
  });
});

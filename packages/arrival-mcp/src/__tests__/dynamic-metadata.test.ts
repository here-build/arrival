/**
 * A2 — the MCP metadata read path (exec-phases-and-dynamic-metadata.md §2.7).
 *
 * Pins the closed drop + the activation channel end-to-end:
 *   • tool``'s `dynamicDescription` is FORWARDED into the baked def's metadata bag
 *     (previously declared-and-dropped) and lifted into the catalog annotation.
 *   • catalog resolution binds `this` = the OWNING capability's describe-ambient
 *     activation (host config + host resources — decision #6: actor args don't exist
 *     at describe time), per read, no memo.
 *   • `undefined` resolution falls back to the static description, NOT flagged
 *     session-generated (the honest-failure contract, preserved verbatim).
 *   • a config schema requiring ACTOR keys ⇒ no describe ambient — static catalog,
 *     the honest floor (and the legacy closure-form thunk still fires, receiver-free).
 */
import type { Activation } from "@here.build/arrival/capability";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { DiscoveryTool } from "../DiscoveryTool.js";
import { McpEnvCapability } from "../McpEnvCapability.js";
import { tool } from "../tool.js";

function liveCapability(counters: { fired: number }): McpEnvCapability {
  return new McpEnvCapability("live-caps", {
    configuration: { region: z.string().optional() },
    symbols: {
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
    },
  });
}

describe("tool`` dynamicDescription — the closed drop, end to end", () => {
  it("forwards into the baked def's metadata AND the lifted annotation", () => {
    const counters = { fired: 0 };
    const cap = liveCapability(counters);
    const annotation = cap.allAnnotations().status;
    expect(annotation).toBeDefined();
    expect(typeof annotation!.dynamicDescription).toBe("function");
    expect(annotation!.description).toBe("dashboard");
    expect(counters.fired).toBe(0); // lift resolved nothing — read-time only
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
    const cap = new McpEnvCapability("actor-caps", {
      configuration: { who: z.string() }, // REQUIRED actor key — underivable at describe time
      symbols: {
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
      },
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

// greeting — the composed identity shot (wordmark + ONE fetch-style identity line, per
// V's ruling). identityLine is the testable, pure half; readOwnVersion touches the
// filesystem and is exercised implicitly by the cli.test.ts e2e suite (the printed
// version there is whatever package.json says).
import { describe, expect, it } from "vitest";

import { greetingLines, identityLine } from "../greeting.js";
import { stripAnsi } from "./ansi-strip.js";

describe("identityLine", () => {
  it("names version, capability count, and lens mode — the fetch-style facts", () => {
    const line = stripAnsi(identityLine({ version: "0.1.0", capabilityCount: 0, lens: "sugarcoat" }, "none"));
    expect(line).toBe("arrival 0.1.0 — no capabilities armed · sugarcoat lens · ,lens to flip, ? for help");
  });

  it("pluralizes capability count and reflects the classic lens", () => {
    const one = stripAnsi(identityLine({ version: "0.1.0", capabilityCount: 1, lens: "scheme" }, "none"));
    expect(one).toContain("1 capability armed");
    expect(one).toContain("classic lens");

    const many = stripAnsi(identityLine({ version: "0.1.0", capabilityCount: 3, lens: "scheme" }, "none"));
    expect(many).toContain("3 capabilities armed");
  });
});

describe("greetingLines", () => {
  it("composes six wordmark rows + a blank line + the identity line — eight lines total", () => {
    const lines = greetingLines({ version: "0.1.0", capabilityCount: 0, lens: "sugarcoat" }, "none");
    expect(lines).toHaveLength(8);
    expect(lines[6]).toBe("");
    expect(stripAnsi(lines[7] ?? "")).toContain("arrival 0.1.0");
  });
});

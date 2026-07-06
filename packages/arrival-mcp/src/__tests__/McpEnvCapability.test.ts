// McpEnvCapability — the builder-form `symbols` guard.
//
// `liftInlineAnnotations` can only inspect the RECORD form of `symbols` (a plain object literal)
// — a builder (`(activation) => {...}`) can't be peeked without invoking it, and invoking it here
// would need a fake activation before `lower()` ever supplies real configuration/resources. Before
// this guard, a builder-form `symbols` silently skipped annotation-lifting: any inline
// `description`/`inputSchema` on a verb inside the builder's returned record just vanished, with
// no catalog entry and no arg validation, and no signal anything went wrong. This proves the loud
// door instead.
import { describe, expect, it } from "vitest";

import { McpEnvCapability } from "../McpEnvCapability.js";

describe("McpEnvCapability — builder-form symbols", () => {
  it("doors at construction rather than silently dropping inline annotations", () => {
    expect(
      () =>
        new McpEnvCapability("builder-caps", {
          symbols: () => ({
            greet: { fn: () => "hi", description: "greets" },
          }),
        }),
    ).toThrow(/builder-form `symbols`/);
  });

  it("the record form is unaffected — no throw, annotations lift as before", () => {
    expect(
      () =>
        new McpEnvCapability("record-caps", {
          symbols: {
            greet: { fn: () => "hi", description: "greets" },
          },
        }),
    ).not.toThrow();
  });
});

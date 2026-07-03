// overridable.test.ts — the `arrival/overridable` capability through the ONE consumer door:
// `exec(src, { capabilities: [overridableCapability], config: { params } })`. The capability
// validates its own `params` slice of the shared config bag; `overridable/resolve` is an
// ORDINARY RUNTIME verb (no preludeOnly assembly-time bridge left to test) — the macro is pure
// ergonomics over it, and calling the verb directly from user code is a supported, undecorated
// path.
//
// "plain define plus validation": an override validates against the declared type when one is
// supplied by the host; the in-form default validates against the SAME type when none is — a
// bad default is exactly as loud as a bad override.

import { describe, expect, it } from "vitest";

import { exec } from "../../index.js";
import { AExact } from "../../values/primitives/AExact.js";
import { AString } from "../../values/primitives/AString.js";
import { APair } from "../../values/primitives/APair.js";
import { overridableCapability } from "../overridable.js";

const capabilities = [overridableCapability];

describe("arrival/overridable — plain define plus validation, through the consumer door", () => {
  it("a host-supplied override wins over the in-form default, and validates", async () => {
    const result = await exec(`(define/overridable city "string" "Berlin") city`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString).toJs()).toBe("Paris");
  });

  it("default fallback: absent params ⇒ the in-form default fires (and validates)", async () => {
    const result = await exec(`(define/overridable city "string" "Berlin") city`, {
      capabilities,
      config: { params: {} },
    });
    expect((result.at(-1) as AString).toJs()).toBe("Berlin");
  });

  it("config-less lower succeeds (`params` defaults to {}) — every in-form default fires", async () => {
    const result = await exec(`(define/overridable city "string" "Berlin") city`, {
      capabilities,
      // no config at all — the shared-bag posture: lower({ config: undefined }) parses to {}.
    });
    expect((result.at(-1) as AString).toJs()).toBe("Berlin");
  });

  it("multiple inputs in one program resolve independently (override + default mixed)", async () => {
    const result = await exec(
      `(define/overridable city "string" "Berlin")
       (define/overridable country "string" "France")
       (list city country)`,
      { capabilities, config: { params: { city: "Paris" } } },
    );
    const list = result.at(-1) as APair;
    expect(list.to_array().map((v) => (v as AString).toJs())).toEqual(["Paris", "France"]);
  });

  it("a bad OVERRIDE throws legibly, naming the binding, the declared type, and the source", async () => {
    await expect(
      exec(`(define/overridable age "number" 30) age`, {
        capabilities,
        config: { params: { age: "not-a-number" } },
      }),
    ).rejects.toThrow(
      /define\/overridable age: expected number, got "not-a-number" \(from an environment override\)/,
    );
  });

  it("a bad DEFAULT throws exactly as loud as a bad override — validated the same", async () => {
    await expect(
      exec(`(define/overridable age "number" "thirty") age`, {
        capabilities,
        config: { params: {} },
      }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "thirty" \(from the in-form default\)/);
  });

  it("an unrecognized type tag DOORS with the binding name, not a silent passthrough", async () => {
    await expect(
      exec(`(define/overridable age "not-a-real-type" 30) age`, {
        capabilities,
        config: { params: {} },
      }),
    ).rejects.toThrow(/define\/overridable age: unrecognized type tag/);
  });

  it("an `/optional`-suffixed tag is tolerated (the suffix is inert here) — validation still applies", async () => {
    const result = await exec(`(define/overridable size "number/optional" 10) size`, {
      capabilities,
      config: { params: {} },
    });
    expect((result.at(-1) as AExact).toJs()).toBe(10);
  });

  it("`overridable/resolve` is a real RUNTIME verb — callable directly by user code, no sealing", async () => {
    const result = await exec(`(overridable/resolve 'city "string" "Berlin")`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString).toJs()).toBe("Paris");
  });
});

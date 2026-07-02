// pipeline-input.test.ts — the `pipeline/input` capability through the ONE consumer door:
// `exec(src, { capabilities: [pipelineInputCapability], config: { params } })`. The capability
// validates its own `params` slice of the shared config bag; `assembleEnv`'s kernel-internal
// phase-gated prelude scope makes the `preludeOnly` verb (`pipeline-input/params`) callable
// during assembly (the capability's own prelude materializes the record ONCE into
// `%pipeline-params`) and a plain unbound-variable error from user code at runtime.
//
// The old two-wirings split (attached-overlay vs torn-down-overlay) is GONE with the overlay
// model itself: there is no caller wiring left to vary. One env now exhibits BOTH properties —
// the macro resolves params AND the hidden verb is unbound — which is exactly the preludeOnly
// contract (assembly-time-only; bridge by capturing the call's result, never the verb).

import { describe, expect, it } from "vitest";

import { exec } from "../../index.js";
import { AString } from "../../values/primitives/AString.js";
import { APair } from "../../values/primitives/APair.js";
import { pipelineInputCapability } from "../pipeline-input.js";

const capabilities = [pipelineInputCapability];

describe("pipeline/input — assembly-time materialization through the consumer door", () => {
  it("a host-supplied override wins over the in-form default", async () => {
    const result = await exec(`(define/pipeline-input city "string" "Berlin") city`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString).toJs()).toBe("Paris");
  });

  it("BOTH properties in one env: the macro resolves, AND (pipeline-input/params) from user code is unbound", async () => {
    // Form 1 (the macro) succeeds — proving the prelude's assembly-time bridge worked in THIS
    // env — and form 2 (naming the preludeOnly verb directly) is a plain unbound error at
    // runtime. One exec call = one assembled env exhibiting both halves of the contract.
    await expect(
      exec(`(define/pipeline-input city "string" "Berlin") (pipeline-input/params)`, {
        capabilities,
        config: { params: { city: "Paris" } },
      }),
    ).rejects.toThrow(/Unbound variable/);
  });

  it("default fallback: absent params ⇒ the in-form default fires", async () => {
    const result = await exec(`(define/pipeline-input city "string" "Berlin") city`, {
      capabilities,
      config: { params: {} },
    });
    expect((result.at(-1) as AString).toJs()).toBe("Berlin");
  });

  it("config-less lower succeeds (`params` defaults to {}) — every in-form default fires", async () => {
    const result = await exec(`(define/pipeline-input city "string" "Berlin") city`, {
      capabilities,
      // no config at all — the shared-bag posture: lower({ config: undefined }) parses to {}.
    });
    expect((result.at(-1) as AString).toJs()).toBe("Berlin");
  });

  it("multiple inputs in one program resolve independently (override + default mixed)", async () => {
    const result = await exec(
      `(define/pipeline-input city "string" "Berlin")
       (define/pipeline-input country "string" "France")
       (list city country)`,
      { capabilities, config: { params: { city: "Paris" } } },
    );
    const list = result.at(-1) as APair;
    expect(list.to_array().map((v) => (v as AString).toJs())).toEqual(["Paris", "France"]);
  });
});

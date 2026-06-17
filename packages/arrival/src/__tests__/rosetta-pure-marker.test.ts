/**
 * The `pure?: boolean` rosetta marker (design note §5 — Rosetta source/pure roles).
 * A registered fn defaults to a Rosetta-IN SOURCE (mints a provenance leaf); `pure:
 * true` declares it a transparent transform (propagates its inputs' provenance, a
 * pipe — like string-append). This proves the marker round-trips onto the env and
 * drives the lineage classifier's source-vs-pipe cut. The richer role taxonomy and
 * the live runtime propagation are deferred; this is the starting-point foothold.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { parse } from "../eval/generator-exec";
import { sandboxedEnv } from "../sandbox-env";
import { classify, fullCone, type Classifier } from "../values/lineage";

describe("rosetta pure marker", () => {
  it("round-trips onto the env (sibling to __rosettaTypes__), default is NOT pure", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("pure-marker-roundtrip");
    env.defineRosetta("dedent", { fn: (s: string) => s, pure: true });
    env.defineRosetta("infer-x", { fn: (p: unknown) => p }); // default → source
    expect(env.__rosettaPure__.has("dedent")).toBe(true);
    expect(env.__rosettaPure__.has("infer-x")).toBe(false);
  });

  it("drives classification: a pure rosetta is a PIPE (propagates); the default is a SOURCE (mints)", async () => {
    await initBridge();
    const env = sandboxedEnv.inherit("pure-marker-classify");
    env.defineRosetta("dedent", { fn: (s: string) => s, pure: true });
    env.defineRosetta("infer-x", { fn: (p: unknown) => p });

    // The op-taxonomy reads the env's pure set — exactly how the real classifier will.
    const C: Classifier = {
      isPure: (op) => env.__rosettaPure__.has(op) || ["string-append", "+"].includes(op),
      isRosettaIn: (op) => !env.__rosettaPure__.has(op) && ["infer-x", "infer"].includes(op),
      isFan: () => false,
      isOpaque: () => false,
    };

    const dedented = classify((await parse(`(dedent s)`, env))[0], C);
    expect(dedented.kind).toBe("pipe"); // transforms its arg → pass-through
    expect(fullCone(dedented, { s: [100] })).toEqual([100]); // propagates s, mints nothing

    const inferred = classify((await parse(`(infer-x p)`, env))[0], C);
    expect(inferred.kind).toBe("source"); // introduces external data → a fresh leaf
  });
});

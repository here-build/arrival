/**
 * The `pure?: boolean` rosetta marker (design note §5 — Rosetta source/pure roles).
 * A registered fn defaults to a Rosetta-IN SOURCE (mints a provenance leaf); `pure:
 * true` declares it a transparent transform (propagates its inputs' provenance, a
 * pipe — like string-append). This proves the marker round-trips onto the env and
 * drives the lineage classifier's source-vs-pipe cut. The richer role taxonomy and
 * the live runtime propagation are deferred; this is the starting-point foothold.
 *
 * [STAGING: rosetta-pure-marker] (2026-07-08 test-invariant-atlas sweep, [P14]
 * docs/test-invariant-atlas/verdicts/membrane.md): honestly self-labeled above as a
 * "starting-point foothold," but the `Classifier` consumed below (the `C` object in the
 * second test) is assembled INLINE in the test itself — not read from any production
 * wiring — unlike P14's model case (the static lineage classifier), which is staged via
 * an `it.todo`/gate-ledger naming the production wiring gate. This file needs the same:
 * a named gate for "when does a REAL production classifier read `rosettaPureOf` this
 * way" rather than reading as an already-shipped classification.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../index.js";
import { parse } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { classify, fullCone, type Classifier } from "../values/lineage.js";
import { rosettaPureOf } from "../env-registries.js";

describe("rosetta pure marker", () => {
  it("round-trips into the pure registry (sibling to the type registry), default is NOT pure", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("pure-marker-roundtrip");
    env.defineRosetta("dedent", { fn: (s: string) => s, pure: true });
    env.defineRosetta("infer-x", { fn: (p: unknown) => p }); // default → source
    expect(rosettaPureOf(env).has("dedent")).toBe(true);
    expect(rosettaPureOf(env).has("infer-x")).toBe(false);
  });

  it("drives classification: a pure rosetta is a PIPE (propagates); the default is a SOURCE (mints)", async () => {
    await initBridge();
    const env = inferenceEnv.inherit("pure-marker-classify");
    env.defineRosetta("dedent", { fn: (s: string) => s, pure: true });
    env.defineRosetta("infer-x", { fn: (p: unknown) => p });

    // The op-taxonomy reads the env's pure registry — exactly how the real classifier will.
    const C: Classifier = {
      isPure: (op) => rosettaPureOf(env).has(op) || ["string-append", "+"].includes(op),
      isRosettaIn: (op) => !rosettaPureOf(env).has(op) && ["infer-x", "infer"].includes(op),
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

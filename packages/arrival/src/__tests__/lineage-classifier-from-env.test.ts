/**
 * Slice 1 of W3 (serial-spine wiring): `classifierFromEnv` reproduces the
 * hand-built test Classifiers (lineage-spike.test.ts:15-20, rosetta-pure-
 * marker.test.ts:32-37) by reading a live env — the env-derived op-taxonomy the
 * runtime wiring will use. Additive: no live caller changes; classify() stays
 * test-only until Slice 2 (the --ir-lineage load hook).
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../bridge";
import { parse } from "../eval/generator-exec";
import { inferenceEnv } from "../inference-env";
import { classify, fullCone, type LineageNode } from "../values/lineage";
import { classifierFromEnv } from "../values/lineage-classifier-from-env";
import { SchemeJSFunction } from "../membrane";

let seq = 0;
const env = () => inferenceEnv.inherit(`cfe-${seq++}`);
const node = async (src: string, e: ReturnType<typeof env>, sources: Iterable<string> = []): Promise<LineageNode> =>
  classify((await parse(src, e))[0], classifierFromEnv(e, new Set(sources)));

describe("classifierFromEnv — reproduces the hand-built classifier from live env state", () => {
  it("pure rosetta → PIPE; default (declared source) → SOURCE (reproduces rosetta-pure-marker)", async () => {
    await initBridge();
    const e = env();
    e.defineRosetta("dedent", { fn: (s: string) => s, pure: true });
    e.defineRosetta("infer-x", { fn: (p: unknown) => p }); // default → source

    const dedented = await node("(dedent s)", e, ["infer-x"]);
    expect(dedented.kind).toBe("pipe"); // pure rosetta propagates → pass-through
    expect(fullCone(dedented, { s: [100] })).toEqual([100]); // mints nothing

    const inferred = await node("(infer-x p)", e, ["infer-x"]);
    expect(inferred.kind).toBe("source"); // declared source mints a fresh leaf
    expect(fullCone(inferred, { "infer-x": [42] })).toEqual([42]);
  });

  it("the source guard: a name that is BOTH declared-source AND pure stays a PIPE (never mints)", async () => {
    await initBridge();
    const e = env();
    e.defineRosetta("weird", { fn: (x: unknown) => x, pure: true });
    // Even though "weird" is passed as a source, `&& !pure` demotes it to a pipe.
    const n = await node("(weird x)", e, ["weird"]);
    expect(n.kind).toBe("pipe");
  });

  it("isPure walks the env chain (__rosettaPure__ is per-env): a parent's pure rosetta is seen by a child", async () => {
    await initBridge();
    const parent = env();
    parent.defineRosetta("dedent", { fn: (s: string) => s, pure: true });
    const child = parent.inherit("cfe-child");
    // classified on the CHILD, but dedent is pure on the PARENT → still a pipe, not a source.
    const n = await node("(dedent s)", child, ["dedent"]);
    expect(n.kind).toBe("pipe");
  });

  it("isFan: map/filter classify to a fan (map length-preserving, filter not)", async () => {
    await initBridge();
    const e = env();
    e.defineRosetta("infer-x", { fn: (p: unknown) => p });

    const mapped = await node("(map infer-x xs)", e, ["infer-x"]);
    expect(mapped.kind).toBe("fan");
    if (mapped.kind !== "fan") return;
    expect(mapped.introduces).toBe(true); // the per-element transform is a source
    expect(mapped.lengthPreserving).toBe(true);

    const filtered = await node("(filter pred xs)", e, ["infer-x"]);
    expect(filtered.kind).toBe("fan");
    if (filtered.kind !== "fan") return;
    expect(filtered.lengthPreserving).toBe(false);
  });

  it("isOpaque: a name bound to a SchemeJSFunction (foreign call) → opaque black box", async () => {
    await initBridge();
    const e = env();
    e.set("ext-call", new SchemeJSFunction((...xs: unknown[]) => xs) as unknown as never);
    const n = await node("(ext-call a b)", e);
    expect(n.kind).toBe("opaque");
    expect(fullCone(n, { a: [1], b: [2] })).toEqual([1, 2]); // holistic merge of inputs
  });

  it("a pure builtin (+) classifies as a pure application (merge/pipe), never a source or opaque", async () => {
    await initBridge();
    const e = env();
    const n = await node("(* val1 (+ 1 val2))", e); // no declared sources
    expect(n.kind).toBe("merge");
    expect(fullCone(n, { val1: [100], val2: [200] })).toEqual([100, 200]);
  });
});

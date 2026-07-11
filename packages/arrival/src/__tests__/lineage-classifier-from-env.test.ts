/**
 * `classifierFromEnv` reads the ONE declared `provenance` role stamped onto each
 * bound callable (`.provenanceRole` — `common/capability.ts`, resolved from
 * `Contract.provenance` at bake time, `common/symbols/_bake.ts`). Q3
 * (PROVENANCE-PLAN.md) retired the caller-supplied `sources: ReadonlySet<string>`
 * seam this test used to exercise via `env.defineRosetta` + an explicit source
 * list — that heuristic no longer exists (docs/PROVENANCE.md §2 EXCLUDED). These
 * cases bind plain marker values directly (`.provenanceRole` stamped, no real
 * rosetta wrapper needed — `classify()` never calls the bound value, it only
 * reads the role off it), proving the classifier follows the DECLARATION alone.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../index.js";
import { parse } from "../eval/generator-exec.js";
import { inferenceEnv } from "../inference-env.js";
import { classify, fullCone, type DeclaredRole, type LineageNode } from "../values/lineage.js";
import { classifierFromEnv } from "../values/lineage-classifier-from-env.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue, mintFrame } from "../AmbientRuntime.js";

let seq = 0;
const env = () => mintFrame(inferenceEnv, `cfe-${seq++}`);

/** A marker value carrying ONLY a declared role — classify() never invokes the bound
 *  value, so a bare stamped function is enough to exercise the declaration read. */
const declared = (role: DeclaredRole): ((...args: unknown[]) => unknown) => Object.assign(() => undefined, { provenanceRole: role });

const node = async (src: string, e: ReturnType<typeof env>): Promise<LineageNode> =>
  classify((await parse(src))[0], classifierFromEnv(e));

describe("classifierFromEnv — reads the declared `.provenanceRole` off the bound value", () => {
  it("a declared `pipe` propagates; a declared `source` mints, regardless of NAME", async () => {
    await initBridge();
    const e = env();
    // Names picked to defeat any residual name-based guess — a "pure"-sounding name
    // declared `source`, and a name with no semantic hint declared `pipe`.
    bindValue(e, "dedent", declared("pipe"));
    bindValue(e, "infer-x", declared("source"));

    const dedented = await node("(dedent s)", e);
    expect(dedented.kind).toBe("pipe"); // declared pipe propagates → pass-through
    expect(fullCone(dedented, { s: [100] })).toEqual([100]); // mints nothing

    const inferred = await node("(infer-x p)", e);
    expect(inferred.kind).toBe("source"); // declared source mints a fresh leaf
    expect(fullCone(inferred, { "infer-x": [42] })).toEqual([42]);
  });

  it("the declared role is visible through env inheritance (chain-walk is env.get's, not the classifier's)", async () => {
    await initBridge();
    const parent = env();
    bindValue(parent, "dedent", declared("pipe"));
    const child = mintFrame(parent, "cfe-child");
    // classified on the CHILD, but `dedent` is bound on the PARENT → still a pipe.
    const n = await node("(dedent s)", child);
    expect(n.kind).toBe("pipe");
  });

  it("declared `fan`: map/filter classify to a fan (map length-preserving, filter not)", async () => {
    await initBridge();
    const e = env();
    bindValue(e, "infer-x", declared("source"));
    bindValue(e, "map", declared("fan"));
    bindValue(e, "filter", declared("fan"));

    const mapped = await node("(map infer-x xs)", e);
    expect(mapped.kind).toBe("fan");
    if (mapped.kind !== "fan") return;
    expect(mapped.introduces).toBe(true); // the per-element transform is a declared source
    expect(mapped.lengthPreserving).toBe(true);

    const filtered = await node("(filter pred xs)", e);
    expect(filtered.kind).toBe("fan");
    if (filtered.kind !== "fan") return;
    expect(filtered.lengthPreserving).toBe(false);
  });

  it("an UNDECLARED name (no `.provenanceRole` at all — an unbound name or a plain Scheme lambda) classifies as a pure application, never a source or opaque", async () => {
    await initBridge();
    const e = env();
    const n = await node("(* val1 (+ 1 val2))", e); // "*"/"+" carry no declared role in this bare test env
    expect(n.kind).toBe("merge");
    expect(fullCone(n, { val1: [100], val2: [200] })).toEqual([100, 200]);
  });

  it("declared `sink`/`transparent`/`opaque` reach their matching graph-layer kinds", async () => {
    await initBridge();
    const e = env();
    bindValue(e, "log!", declared("sink"));
    bindValue(e, "passthrough", declared("transparent"));
    bindValue(e, "ext-call", declared("opaque"));

    const sunk = await node("(log! v)", e);
    expect(sunk.kind).toBe("sink");

    const crossed = await node("(passthrough v)", e);
    expect(crossed.kind).toBe("transparent");
    expect(fullCone(crossed, { v: [7] })).toEqual([7]); // cone-identical to pipe

    const opaque = await node("(ext-call a b)", e);
    expect(opaque.kind).toBe("opaque");
    expect(fullCone(opaque, { a: [1], b: [2] })).toEqual([1, 2]);
  });
});

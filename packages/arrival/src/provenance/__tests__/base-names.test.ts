/** `baseNamePredicate(env)` — env membership ∪ the Resolver's c[ad]+r synthesis. */
import { beforeAll, describe, expect, it } from "vitest";
import { ensureInferenceEnvPopulated, parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import type { Classifier } from "../lineage.js";
import { baseNamePredicate } from "../index.js";
import { buildWireframe } from "../wireframe/builder.js";

beforeAll(async () => {
  await ensureInferenceEnvPopulated();
});

describe("baseNamePredicate", () => {
  it("accepts env-bound names (natives, macros, packs) and the c[ad]+r synthesis family", () => {
    const isBase = baseNamePredicate(inferenceEnv);
    for (const n of ["+", "map", "list", "car", "cadr", "caddr", "cdddar"]) expect(isBase(n), n).toBe(true);
  });

  it("refuses program-level names and near-misses of the cxr family", () => {
    const isBase = baseNamePredicate(inferenceEnv);
    for (const n of ["my-helper", "xs", "cars", "cxr", "car-x"]) expect(isBase(n), n).toBe(false);
  });

  it("buildWireframe keeps a synthesized cxr by name instead of lifting it to ingress", async () => {
    const classifier: Classifier = { roleOf: () => undefined };
    const forms = await parse("(+ (caddr xs) (cadr ys))");
    const p = buildWireframe(forms, { classifier, isBaseName: baseNamePredicate(inferenceEnv) });
    expect(p.main.wires[0].params).toEqual(["xs", "ys"]);
    expect(p.main.wires[0].source).toBe("(lambda (xs ys) (+ (caddr xs) (cadr ys)))");
  });
});

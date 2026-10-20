/**
 * A fan template's lambda formals include the dotted rest parameter (and a bare-symbol formal):
 * it SHADOWS an outer binding of the same name inside the per-element body, matching
 * wireframe/builder.ts's parameter collection.
 */
import { describe, expect, it } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import { classify, type Classifier } from "../lineage.js";

const C: Classifier = {
  roleOf: (op) => (op === "fetch" ? "source" : op === "map" ? "fan" : undefined),
};

async function templateOf(src: string) {
  const [ast] = await parse(src);
  const n = classify(ast, C);
  if (n.kind !== "fan") throw new Error(`expected fan, got ${n.kind}`);
  return n.template;
}

describe("lineage fan template — rest parameters shadow outer bindings", () => {
  it("(a . rest): `rest` in the body is the element leaf, not the outer let-bound source", async () => {
    const t = await templateOf(`(let ((rest (fetch))) (map (lambda (a . rest) rest) xs))`);
    expect(t).toEqual({ kind: "leaf", slot: "rest" });
  });

  it("bare-symbol formal `(lambda rest rest)` likewise shadows", async () => {
    const t = await templateOf(`(let ((rest (fetch))) (map (lambda rest rest) xs))`);
    expect(t).toEqual({ kind: "leaf", slot: "rest" });
  });

  it("a non-shadowing outer binding still flows through", async () => {
    const t = await templateOf(`(let ((o (fetch))) (map (lambda (a . r) o) xs))`);
    expect(t?.kind).toBe("source");
  });
});

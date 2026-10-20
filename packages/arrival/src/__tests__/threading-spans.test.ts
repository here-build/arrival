/**
 * Threading macros (-> ->> ~> ~>>) stamp each rebuilt step call with the span of the user's
 * step form, not the threading form's use-site span.
 */

import { describe, expect, it } from "vitest";
import { exec } from "../eval/generator-exec.js";
import { EvalTrace, type Invocation } from "../provenance/trace.js";

const code = (inv: Invocation): string => inv.node["arrival/print"]();
const at = (inv: Invocation): string => `${inv.node.location?.line}:${inv.node.location?.col}`;

async function run(src: string): Promise<{ result: unknown; log: readonly Invocation[] }> {
  const trace = new EvalTrace();
  const result = await exec(src, { tap: trace });
  return { result, log: trace.invocationLog };
}
const find = (log: readonly Invocation[], text: string): Invocation => {
  const hit = log.find((i) => code(i) === text);
  if (hit === undefined) throw new Error(`no invocation ${text}; have ${log.map(code).join(" | ")}`);
  return hit;
};

describe("threading step spans", () => {
  it("->> map step carries the user's (map …) location; callbacks parent under it", async () => {
    const src = "(->> (list 1 2) (map (lambda (x) (+ x 1))))";
    const { result, log } = await run(src);
    expect(result).toEqual([[2, 3]]);
    const map = log.find((i) => code(i).startsWith("(map "));
    expect(map).toBeDefined();
    expect(at(map!)).toBe(`1:${src.indexOf("(map")}`);
    expect(at(map!)).not.toBe("1:0");
  });

  it("map callback invocations parent under the located map invocation", async () => {
    const src = "(define (inc x) (+ x 1)) (->> (list 1 2) (map (lambda (x) (inc x))))";
    const { log } = await run(src);
    const map = log.find((i) => code(i).startsWith("(map "))!;
    expect(at(map)).toBe(`1:${src.indexOf("(map")}`);
    const incs = log.filter((i) => code(i) === "(+ x 1)");
    expect(incs.length).toBe(2);
    for (const inc of incs) {
      let p = inc.parent;
      while (p != null && p !== map) p = p.parent;
      expect(p).toBe(map);
    }
  });

  it("-> steps carry each step's location", async () => {
    const src = "(-> 1 (+ 2) (* 3))";
    const { result, log } = await run(src);
    expect(result).toEqual([9]);
    expect(at(find(log, "(+ 1 2)"))).toBe(`1:${src.indexOf("(+")}`);
    const times = log.find((i) => code(i).startsWith("(* "))!;
    expect(at(times)).toBe(`1:${src.indexOf("(*")}`);
  });

  it("a bare-symbol step is located (symbol span or use-site)", async () => {
    const src = "(-> 4 (+ 1) number->string)";
    const { log } = await run(src);
    const call = log.find((i) => code(i).startsWith("(number->string"))!;
    expect(call.node.location).toBeDefined();
    expect([`1:${src.indexOf("number->string")}`, "1:0"]).toContain(at(call));
  });

  it("nested threading keeps inner and outer step spans", async () => {
    const src = "(-> 1 (+ (-> 2 (* 5))) (* 3))";
    const { result, log } = await run(src);
    expect(result).toEqual([33]);
    expect(at(find(log, "(* 2 5)"))).toBe(`1:${src.indexOf("(* 5)")}`);
    expect(at(find(log, "(+ 1 (-> 2 (* 5)))"))).toBe(`1:${src.indexOf("(+ (")}`);
    expect(at(find(log, "(* (+ 1 (-> 2 (* 5))) 3)"))).toBe(`1:${src.indexOf("(* 3)")}`);
  });

  it("~>> (racket) steps carry the user's step location", async () => {
    const src = "(~>> (list 1 2) (map (lambda (x) (+ x 1))))";
    const { result, log } = await run(src);
    expect(result).toEqual([[2, 3]]);
    const map = log.find((i) => code(i).startsWith("(map "))!;
    expect(at(map)).toBe(`1:${src.indexOf("(map")}`);
  });
});

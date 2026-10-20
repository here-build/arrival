/**
 * A `"__proto__"` dict key egresses as an OWN data property — the lazy egress proxy must not
 * route it through the Object.prototype setter (which silently dropped the entry).
 */
import { describe, expect, it } from "vitest";
import { exec } from "../../eval/generator-exec.js";

const one = async (src: string): Promise<any> => (await exec(src))[0];

describe("egress proxy: __proto__ key", () => {
  it("scalar entry survives JSON.stringify and Object.keys", async () => {
    const d = await one('(dict "__proto__" 1 "a" 2)');
    expect(Object.keys(d).sort()).toEqual(["__proto__", "a"]);
    expect(JSON.stringify(d)).toContain('"__proto__":1');
    expect(JSON.stringify(d)).toContain('"a":2');
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
  });

  it("object-valued entry stays an own property and does not rewire the prototype", async () => {
    const d = await one('(dict "__proto__" (dict "x" 1) "a" 2)');
    expect(Object.keys(d).sort()).toEqual(["__proto__", "a"]);
    expect(Object.hasOwn(d, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(d.x).toBeUndefined();
    expect(JSON.stringify(d)).toContain('"__proto__":{"x":1}');
  });
});

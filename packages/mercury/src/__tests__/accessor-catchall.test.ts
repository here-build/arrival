/**
 * Pair-accessor catchall: the whole `c[ad]+r` family lowers with no per-word entry.
 * Before, only car/cdr/cadr/caddr were hardcoded; a mixed `caar`/`cdar`/`caadr` or a
 * deep `caddddr` fell through to a free-identifier call. The catchall reuses the one
 * shared decomposition (`decodeAccessor`) the sugarcoat lens prints as subscripts.
 */
import { describe, expect, it } from "vitest";

import { projectToJsRaw } from "../project.js";
import { accessorJs } from "../stdlib.js";

const js = (body: string): string =>
  projectToJsRaw(`(define (f x) ${body})`)
    .match(/=>\s*([^;]+);/)![1]
    .trim();

describe("accessorJs — c[ad]+r → JS member chain", () => {
  const cases: Array<[string, string]> = [
    ["car", "x[0]"],
    ["cdr", "x.slice(1)"],
    ["cadr", "x[1]"],
    ["caddr", "x[2]"],
    ["caar", "x[0][0]"],
    ["cdar", "x[0].slice(1)"],
    ["caadr", "x[1][0]"],
    ["cadadr", "x[1][1]"],
    ["caddddr", "x[4]"], // arbitrary depth — no hardcoded entry
    ["cddddr", "x.slice(4)"],
  ];
  for (const [word, expected] of cases) {
    it(`${word} → ${expected}`, () => expect(accessorJs(word, "x")).toBe(expected));
  }
  it("returns null for non-accessor heads", () => {
    expect(accessorJs("list", "x")).toBeNull();
    expect(accessorJs("first", "x")).toBeNull();
  });
});

describe("JS lowering through the full program path", () => {
  it("lowers mixed combos in call position", () => {
    expect(js("(caar x)")).toBe("x[0][0]");
    expect(js("(cdar x)")).toBe("x[0].slice(1)");
    expect(js("(caadr x)")).toBe("x[1][0]");
  });
  it("car/cdr/cadr/caddr still lower identically (regression)", () => {
    expect(js("(car x)")).toBe("x[0]");
    expect(js("(cdr x)")).toBe("x.slice(1)");
    expect(js("(cadr x)")).toBe("x[1]");
    expect(js("(caddr x)")).toBe("x[2]");
  });
  it("an accessor passed to map lowers as an arrow, not a free reference", () => {
    const out = projectToJsRaw("(define (f xss) (map caar xss))");
    expect(out).toContain("[0]");
    expect(out).not.toMatch(/\.map\(caar\)/); // never passed by reference
  });
});

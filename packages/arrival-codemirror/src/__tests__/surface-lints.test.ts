/**
 * Sugarcoat surface lints — valid-but-suspicious patterns the reader must not reject
 * (faithful-where-valid) but the editor should flag. Origin: LEARN.md custdev loop,
 * an agent wrote `@s[:baseline]` expecting keyed access and got literal prose.
 */
import { describe, it, expect } from "vitest";
import { sugarcoatSurfaceLints } from "../sugarcoat-ide.js";

describe("@id[ interpolation-subscript lint", () => {
  it("flags a tight bracket after a bare interpolation", () => {
    const src = "@{from @s[:baseline] to @s[:current]}";
    const lints = sugarcoatSurfaceLints(src);
    expect(lints).toHaveLength(2);
    expect(lints[0]!.start).toBe(src.indexOf("@s["));
    expect(lints[0]!.messageText).toMatch(/literal prose.*@\(:key name\)/s);
    expect(lints[0]!.severity).toBe("warning");
  });

  it("stays quiet on the explicit-boundary form — the author already marked the boundary", () => {
    expect(sugarcoatSurfaceLints("@{v: @|ver|[beta]}")).toHaveLength(0);
  });

  it("stays quiet on the correct graft spelling", () => {
    expect(sugarcoatSurfaceLints("@{from @(:baseline s) to @(:current s)}")).toHaveLength(0);
  });

  it("stays quiet on unquote-splicing and spaced brackets", () => {
    expect(sugarcoatSurfaceLints("`(a ,@xs[0])")).toHaveLength(0);
    expect(sugarcoatSurfaceLints("@{count @n [approx]}")).toHaveLength(0);
  });
});

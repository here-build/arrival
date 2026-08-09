// NOTE: corpus under-covers #() constant vectors — only these read cases exist. Expand when the grammar gets eval/door coverage.
import { describe, expect, it } from "vitest";
import { readAst } from "./_harness.js";

describe("vector-hash / #() constant vectors", () => {
  // POSITIVE — read: input parses to canonical AST
  it.each([
    { name: "y_r7rs_vector_constant_distinct", input: "#(a b)", ast: "#(a b)" },
    { name: "y_constant_vector_binding_distinct_from_bracket", input: "(let #(a 1) a)", ast: "(let #(a 1) a)" },
  ])("read · $name", async ({ input, ast }) => {
    expect(await readAst(input)).toBe(ast);
  });
});

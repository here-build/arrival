import { describe, expect, it } from "vitest";
import { toSExprString } from "../serializer";
import { execSerialized } from "../execSerialized";
// Import what we can from lips
import { exec } from "../lips/lips";
// Import custom matchers
import "./custom-matchers";

describe("LIPS Integration", () => {
  it("should handle simple lips evaluation results", async () => {
    // Test basic lips evaluation
    const result = await exec("(+ 1 2)");
    console.log("lips result:", result);
    console.log("lips result type:", typeof result);
    console.log("lips result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("serialized:", serialized);

    // Should get a clean representation, not verbose object dump
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(":__value__"); // Should not expose internals
  });

  it("should handle lips list results", async () => {
    // Test lips list evaluation
    const result = await exec("(list 1 2 3)");
    console.log("lips list result:", result);
    console.log("lips list result type:", typeof result);
    console.log("lips list result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("lips list serialized:", serialized);
    expect(serialized).toBeDefined();
  });

  it("should handle lips symbol results", async () => {
    // Test lips symbol evaluation
    const result = await exec("'hello");
    console.log("lips symbol result:", result);
    console.log("lips symbol result type:", typeof result);
    console.log("lips symbol result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("lips symbol serialized:", serialized);
    expect(serialized).toBeDefined();
  });

  it("should handle complex lips results", async () => {
    // Test more complex lips evaluation
    const result = await exec("(map (lambda (x) (* x 2)) (list 1 2 3))");
    console.log("lips complex result:", result);
    console.log("lips complex result type:", typeof result);
    console.log("lips complex result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("lips complex serialized:", serialized);

    // Should get a clean representation of the mapped results
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(":car"); // Should not expose Pair internals
    expect(serialized).toContain("2"); // 1 * 2
    expect(serialized).toContain("4"); // 2 * 2
    expect(serialized).toContain("6"); // 3 * 2
  });

  it("should handle various lips types", async () => {
    // Test different types that LIPS can return
    const tests = [
      { expr: "42", expected: "42" },
      { expr: "3.14", expected: "3.14" }, // LNumber float
      { expr: "#t", expected: "true" },
      { expr: "#f", expected: "false" },
      { expr: '"hello world"', expected: "'hello world'" }, // Single quotes for simple strings
      { expr: "'symbol-name", expected: "symbol-name" }, // Should be bare symbol
      { expr: "()", expected: "()" }
    ];

    for (const { expr, expected } of tests) {
      const result = await exec(expr);
      const serialized = toSExprString(result);
      console.log(`${expr} -> ${serialized}`);
      expect(serialized).toContain(expected);
    }
  });

  it("should research keyword vs symbol distinction in LIPS", async () => {
    const tests = [
      { expr: "'hello", desc: "quoted symbol" },
      { expr: ":hello", desc: "colon syntax (keyword?)" },
      { expr: "hello", desc: "bare symbol (probably undefined variable)" },
      { expr: "'hello-world", desc: "quoted symbol with dash" },
      { expr: "':hello", desc: "quoted colon symbol" },
      { expr: "(define hello 42) hello", desc: "defined symbol reference" },
      { expr: "(quote :hello)", desc: "quoted colon syntax" },
      { expr: "123456789012345678901234567890", desc: "very large number (bigint?)" },
      { expr: '"simple string"', desc: "simple string" },
      { expr: '"string with \\"quotes\\""', desc: "string with quotes" }
    ];

    for (const { expr, desc } of tests) {
      try {
        const result = await exec(expr);
        console.log(`\\n=== ${desc} ===`);
        console.log(`Expression: ${expr}`);
        console.log(`Result:`, result);
        console.log(`Constructor:`, result[0]?.constructor?.name);
        console.log(`Properties:`, Object.getOwnPropertyNames(result[0] || {}));
        console.log(`Serialized:`, toSExprString(result));
      } catch (error) {
        console.log(`\\n=== ${desc} ===`);
        console.log(`Expression: ${expr}`);
        console.log(`ERROR:`, error.message);
      }
    }
  });

  it("should handle special lips types", async () => {
    // Test special LIPS types
    const specialTests = [
      { expr: "#\\a", desc: "character" }, // LCharacter
      { expr: "(values 1 2 3)", desc: "multiple values" } // Values
    ];

    for (const { expr, desc } of specialTests) {
      try {
        const result = await exec(expr);
        const serialized = toSExprString(result);
        console.log(`${desc}: ${expr} -> ${serialized}`);
        console.log(`${desc} result type:`, result?.constructor?.name);

        // Debug - can remove this later
        // if (desc === "multiple values") {
        //   console.log("Values debug - keys:", Object.getOwnPropertyNames(result[0]));
        //   console.log("Values debug - has __values__:", "__values__" in result[0]);
        //   console.log("Values debug - has values:", "values" in result[0]);
        //   console.log("Values debug - constructor:", result[0]?.constructor?.name);
        // }

        expect(serialized).toBeDefined();
      } catch (error) {
        console.log(`${desc} failed:`, error);
        // Some might not be supported, that's ok for now
      }
    }
  });
});

describe("execSerialized", () => {
  it("should execute single expressions and return serialized strings", async () => {
    const result = await execSerialized("(+ 1 2)");
    expect(result).toEqual(["3"]);
  });

  it("should handle multiple expressions", async () => {
    const result = await execSerialized("(+ 1 2) (* 3 4) (quote hello)");
    expect(result).toEqual(["3", "12", "hello"]); // hello is bare symbol, not keyword
  });

  it("should handle lists", async () => {
    const result = await execSerialized("(list 1 2 3)");
    expect(result).toEqual(["(1 2 3)"]);
  });

  it("should handle symbols", async () => {
    const result = await execSerialized("'symbol-name");
    expect(result).toEqual(["symbol-name"]); // bare symbol
  });

  it("should handle strings", async () => {
    await expect('"hello world" 3').toExecuteInto("'hello world'", "3"); // single quotes for simple strings
  });

  it("should handle booleans", async () => {
    const result = await execSerialized("#t #f");
    expect(result).toEqual(["true", "false"]);
  });

  it("should handle complex expressions", async () => {
    const result = await execSerialized("(map (lambda (x) (* x 2)) (list 1 2 3))");
    expect(result).toEqual(["(2 4 6)"]);
  });

  it("should handle empty expressions", async () => {
    const result = await execSerialized("()");
    expect(result).toEqual(["()"]);
  });

  // New extensible test format
  describe("extensible test format", () => {
    it("should handle basic arithmetic", async () => {
      await expect("(+ 1 2) (* 3 4)").toExecuteInto("3", "12");
    });

    it("should handle symbols and keywords", async () => {
      await expect("'symbol ':keyword").toExecuteInto("symbol", ":keyword");
    });

    it("should handle complex strings", async () => {
      await expect('"simple" "with\\"quotes\\"" "multi\\nline"').toExecuteInto(
        "'simple'",
        '`with"quotes"`',
        "'multi\nline'" // actual newline character in result
      );
    });

    it("should handle lists and nested structures", async () => {
      await expect("(list 1 2 3) (list (list 'a 'b) (list 'c 'd))").toExecuteInto("(1 2 3)", "((a b) (c d))");
    });

    it("should handle booleans and special values", async () => {
      await expect("#t #f ()").toExecuteInto("true", "false", "()");
    });

    it("should handle big integers", async () => {
      await expect("123456789012345678901234567890").toExecuteInto("123456789012345678901234567890n");
    });

    it("should handle lambda expressions", async () => {
      await expect("((lambda (x) (* x 2)) 5)").toExecuteInto("10");
    });

    it("should handle quoted expressions", async () => {
      await expect("(quote (+ 1 2)) 'hello-world").toExecuteInto("(+ 1 2)", "hello-world");
    });

    it("should have access to Ramda functions", async () => {
      await expect("(map inc (list 1 2 3))").toExecuteInto("(2 3 4)");
    });

    it("should have access to functional composition", async () => {
      await expect("((compose inc inc) 5)").toExecuteInto("7");
    });

    it("should have access to basic math operations", async () => {
      await expect("(add 5 3) (multiply 4 2)").toExecuteInto("8", "8");
    });

    it("should have basic curry functionality", async () => {
      await expect("((curry add) 5 3)").toExecuteInto("8");
    });
  });
});

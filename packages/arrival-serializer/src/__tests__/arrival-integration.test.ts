import { describe, expect, it } from "vitest";
import { toSExprString } from "../serializer";
// Arrival evaluator + value types
import { exec, execState, EnvCapability, toJS, ANil, LexicalScope } from "@inhuman.tools/arrival";
import { AExact, AString, ASymbol, APair } from "@inhuman.tools/arrival/reflect-internals";
// Import custom matchers
import "@inhuman.tools/arrival";

describe("Arrival Integration", () => {
  it("should handle simple evaluation results", async () => {
    // Test basic evaluation
    const result = await exec("(+ 1 2)");
    console.log("result:", result);
    console.log("result type:", typeof result);
    console.log("result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("serialized:", serialized);

    // Should get a clean representation, not verbose object dump
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(":__value__"); // Should not expose internals
  });

  it("should handle list results", async () => {
    // Test list evaluation
    const result = await exec("(list 1 2 3)");
    console.log("list result:", result);
    console.log("list result type:", typeof result);
    console.log("list result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("list serialized:", serialized);
    expect(serialized).toBeDefined();
  });

  it("should handle symbol results", async () => {
    // Test symbol evaluation
    const result = await exec("'hello");
    console.log("symbol result:", result);
    console.log("symbol result type:", typeof result);
    console.log("symbol result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("symbol serialized:", serialized);
    expect(serialized).toBeDefined();
  });

  it("should handle complex results", async () => {
    // Test more complex evaluation
    const result = await exec("(map (lambda (x) (* x 2)) (list 1 2 3))");
    console.log("complex result:", result);
    console.log("complex result type:", typeof result);
    console.log("complex result constructor:", result?.constructor?.name);

    // Try to serialize the result
    const serialized = toSExprString(result);
    console.log("complex serialized:", serialized);

    // Should get a clean representation of the mapped results
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain(":car"); // Should not expose Pair internals
    expect(serialized).toContain("2"); // 1 * 2
    expect(serialized).toContain("4"); // 2 * 2
    expect(serialized).toContain("6"); // 3 * 2
  });

  it("should handle various scheme types", async () => {
    // Test different types the evaluator can return
    const tests = [
      { expr: "42", expected: "42" },
      { expr: "3.14", expected: "3.14" }, // LNumber float
      { expr: "#t", expected: "true" },
      { expr: "#f", expected: "false" },
      { expr: '"hello world"', expected: `"hello world"` }, // R7RS double quotes — re-parses
      { expr: "'symbol-name", expected: "symbol-name" }, // Should be bare symbol
      { expr: "()", expected: "(list nil)" }, // edge case - keeping like that for now
    ];

    for (const { expr, expected } of tests) {
      // Raw scheme values (execState), not exec's toJS-collapsed ones — nil must stay ANil
      // for the serializer's isNil check to render `nil` instead of a plain `(list)`.
      const { values } = await execState(expr);
      const serialized = toSExprString(values);
      console.log(`${expr} -> ${serialized}`);
      expect(serialized).toContain(expected);
    }
  });

  it("should research keyword vs symbol distinction", async () => {
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
      { expr: '"string with \\"quotes\\""', desc: "string with quotes" },
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

  it("should handle special scheme types", async () => {
    // Test special scheme types
    const specialTests = [
      { expr: "#\\a", desc: "character" }, // LCharacter
      { expr: "(values 1 2 3)", desc: "multiple values" }, // Values
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

describe("exec with proper environment", () => {
  it("should execute single expressions and return unwrapped values", async () => {
    // execState, not exec: a raw AExact reaches toJS directly here (exec's toJS
    // would collapse it before toJS ever saw it). `forceBigInt` itself is retired —
    // the one-number rework (docs/design-history/arrival-one-number-rework.md) makes every
    // scheme number's JS face a plain `number`; exactness is a box-class distinction
    // (AExact/AInexact), never a payload type — there is no bigint face left to force.
    const { values } = await execState("(+ 1 2)");
    const result = toJS(values[0]);
    expect(result).toBe(3);
  });

  it("should handle multiple expressions (returns first)", async () => {
    const { values: rawResults } = await execState("(+ 1 2) (* 3 4) (quote hello)");
    const results = rawResults.map((v) => toJS(v));
    expect(results[0]).toBe(3); // First result
    expect(results[1]).toBe(12); // Second result
    // Symbol needs special handling
    expect(rawResults[2]).toBeInstanceOf(ASymbol);
    expect(rawResults[2].__name__).toBe("hello");
  });

  it("should handle lists (returns Pair)", async () => {
    const result = (await execState("(list 1 2 3)")).values[0];
    expect(result).toBeInstanceOf(APair);
    expect(result.car).toBeInstanceOf(AExact);
  });

  it("should handle symbols (returns SchemeSymbol)", async () => {
    const result = (await execState("'symbol-name")).values[0];
    expect(result).toBeInstanceOf(ASymbol);
    expect(result.__name__).toBe("symbol-name");
  });

  it("should handle strings (returns SchemeString)", async () => {
    const result = (await execState('"hello world"')).values[0];
    expect(result).toBeInstanceOf(AString);
    expect(result.__string__).toBe("hello world");
  });

  it("should handle booleans", async () => {
    const result = (await exec("#t"))[0];
    expect(result).toBe(true);
  });

  it("should handle complex expressions (returns Pair structures)", async () => {
    const result = (await execState("(map (lambda (x) (* x 2)) (list 1 2 3))")).values[0];
    expect(result).toBeInstanceOf(APair);
    // Result is Pair with SchemeExact values
    expect(result.car).toBeInstanceOf(AExact);
    expect(result.car.num).toBe(2);
    expect(result.cdr.car.num).toBe(4);
  });

  it("should handle empty expressions (returns Nil)", async () => {
    const result = (await execState("()")).values[0];
    expect(result).toBeInstanceOf(ANil);
  });

  it("should have access to Ramda functions", async () => {
    const result = (await execState("(map (lambda (x) (+ x 1)) (list 1 2 3))")).values[0];
    expect(result).toBeInstanceOf(APair);

    // Convert to JS values for easier testing
    const values = toJS(result);
    expect(values).toEqual([2, 3, 4]);
  });

  it("should have access to functional composition", async () => {
    const { values } = await execState("((compose (lambda (x) (+ x 1)) (lambda (x) (+ x 1))) 5)");
    const result = toJS(values[0]);
    expect(result).toBe(7);
  });

  it("should support environment variables", async () => {
    // Host-supplied values enter as CAPABILITY data (`symbol.value` defs — the untagged
    // `{ value }` arm is retired) — the hermetic-Environment ruling retired the JS-side
    // `env.set` write surface.
    const scope = LexicalScope.fresh("test");
    const envVars = EnvCapability.define("serializer-test/env-vars", {
      symbols: (symbol) => ({ x: symbol.value`x: test constant`(10), y: symbol.value`y: test constant`(20) }),
    });
    const { values } = await execState("(+ x y)", { scope, capabilities: [envVars] });
    const result = toJS(values[0]);
    expect(result).toBe(30);
  });
});

/**
 * Fantasy Land + LIPS Integration Tests
 * 
 * Tests that LIPS classes work correctly with Ramda functions after
 * Fantasy Land monkey-patching is applied.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { createSandboxedEnvironment, sandboxedEnv } from "../enhanced-environment";
import { applyFantasyLandPatches } from "../fantasy-land-lips";
import { exec, env as lipsGlobalEnv } from "../lips/lips";
import { RAMDA_FUNCTIONS } from "../ramda-functions";
import "./custom-matchers";

// Helper function to unwrap exec results (exec always returns arrays)
async function execOne(expr: string): Promise<any> {
  const results = await exec(expr, { env: sandboxedEnv });
  return results[0];  // Get the first (and usually only) result
}

// Helper to convert LIPS list to JS array for testing
function lipsListToArray(lipsList: any): any[] {
  const result = [];
  let current = lipsList;
  const nil = sandboxedEnv.get('nil', { throwError: false }); // Use sandboxed nil
  
  while (current && current !== nil && current.car !== undefined) {
    result.push(current.car);
    current = current.cdr;
  }
  return result;
}

// Helper to extract LIPS number values
function extractLipsValue(x: any): any {
  if (x && typeof x === 'object' && x.__value__ !== undefined) {
    const value = x.__value__;
    // Convert bigints to numbers for testing consistency
    if (typeof value === 'bigint') {
      return Number(value);
    }
    return value;
  }
  return x;
}

describe("Fantasy Land + LIPS Integration", () => {
  beforeAll(() => {
    // Ensure Fantasy Land patches are applied
    applyFantasyLandPatches();
  });

  describe("LIPS Pair + Ramda Integration", () => {
    it("should work with Ramda map on LIPS lists", async () => {
      // Create a LIPS list and map over it with Ramda
      const result = await execOne(`
        (map inc (list 1 2 3))
      `);
      
      console.log("Ramda map on LIPS list result:", result);
      console.log("Result type:", result?.constructor?.name);
      
      // Should work seamlessly
      expect(result).toBeDefined();
      // Convert to array to check values - need to handle LIPS numbers
      const values = lipsListToArray(result).map(extractLipsValue);
      expect(values).toEqual([2, 3, 4]); // Extract the numeric values
    });

    it("should work with Ramda filter on LIPS lists", async () => {
      // Create a LIPS list and filter it with Ramda  
      const result = await execOne(`
        (filter (lambda (x) (> x 3)) (list 1 2 3 4 5))
      `);
      
      console.log("Ramda filter on LIPS list result:", result);
      console.log("Result type:", result?.constructor?.name);
      
      // Should filter correctly (elements > 3)
      expect(result).toBeDefined();
      const values = lipsListToArray(result).map(extractLipsValue);
      expect(values).toEqual([4, 5]); // Extract the numeric values
    });

    it("should work with Ramda reduce on LIPS lists", async () => {
      // Create a LIPS list and reduce it with Ramda
      const result = await execOne(`
        (reduce add 0 (list 1 2 3 4))
      `);
      
      console.log("Ramda reduce on LIPS list result:", result);
      
      // Should sum correctly: 0 + 1 + 2 + 3 + 4 = 10
      // Handle LIPS number types
      const value = extractLipsValue(result);
      expect(value).toBe(10); // Extract the numeric value
    });

    it("should work with car/cdr on both LIPS lists and JS arrays", async () => {
      // Test car/cdr compatibility functions
      const lipsResult = await execOne(`
        (car (list 1 2 3))
      `);
      
      console.log("car on LIPS list:", lipsResult);
      expect(extractLipsValue(lipsResult)).toBe(1);

      const cdrResult = await execOne(`
        (cdr (list 1 2 3))
      `);
      
      console.log("cdr on LIPS list:", cdrResult);
      expect(cdrResult).toBeDefined();
      // First element of cdr should be 2
      expect(extractLipsValue(cdrResult.car)).toBe(2);
    });

    it("should chain Ramda operations on LIPS lists", async () => {
      // Test complex functional composition
      const result = await exec(`
        (pipe
          (map inc)
          (filter (gt 3))
          (reduce add 0))
        (list 1 2 3 4 5)
      `, { env: sandboxedEnv });
      
      console.log("Chained operations result:", result);
      
      // Pipeline: [1,2,3,4,5] -> map(+1) -> [2,3,4,5,6] -> filter(>3) -> [4,5,6] -> sum -> 15
      expect(result).toBe(15);
    });
  });

  describe("Fantasy Land Protocol Implementation", () => {
    it("should have Fantasy Land methods on LIPS Pair instances", async () => {
      const pairResult = await execOne(`(list 1 2 3)`);
      
      console.log("Pair result from exec:", pairResult);
      console.log("Pair constructor:", pairResult?.constructor?.name);
      
      // Check that Fantasy Land methods exist
      expect(pairResult['fantasy-land/map']).toBeTypeOf('function');
      expect(pairResult['fantasy-land/filter']).toBeTypeOf('function');
      expect(pairResult['fantasy-land/reduce']).toBeTypeOf('function');
      
      console.log("Fantasy Land methods on Pair:", {
        map: typeof pairResult['fantasy-land/map'],
        filter: typeof pairResult['fantasy-land/filter'],
        reduce: typeof pairResult['fantasy-land/reduce']
      });
    });

    it("should call Fantasy Land methods directly", async () => {
      const pairResult = await exec(`(list 1 2 3)`, { env: sandboxedEnv });
      
      // Call Fantasy Land map directly
      const mapResult = pairResult['fantasy-land/map']((x: number) => x * 2);
      console.log("Direct FL map result:", mapResult);
      
      // Convert to array for easier assertion
      const values = [];
      let current = mapResult;
      while (current && current.car !== undefined) {
        values.push(current.car);
        current = current.cdr;
      }
      expect(values).toEqual([2, 4, 6]);
    });

    it("should call Fantasy Land filter directly", async () => {
      const pairResult = await exec(`(list 1 2 3 4 5)`, { env: sandboxedEnv });
      
      // Call Fantasy Land filter directly
      const filterResult = pairResult['fantasy-land/filter']((x: number) => x > 3);
      console.log("Direct FL filter result:", filterResult);
      
      // Convert to array for easier assertion
      const values = [];
      let current = filterResult;
      while (current && current.car !== undefined) {
        values.push(current.car);
        current = current.cdr;
      }
      expect(values).toEqual([4, 5]);
    });

    it("should call Fantasy Land reduce directly", async () => {
      const pairResult = await exec(`(list 1 2 3 4)`, { env: sandboxedEnv });
      
      // Call Fantasy Land reduce directly
      const reduceResult = pairResult['fantasy-land/reduce']((acc: number, x: number) => acc + x, 0);
      console.log("Direct FL reduce result:", reduceResult);
      
      expect(reduceResult).toBe(10);
    });
  });

  describe("Ramda Functions in Sandboxed Environment", () => {
    it("should have all expected Ramda functions available", async () => {
      // Test that key Ramda functions are available in the environment
      const testFunctions = ['map', 'filter', 'reduce', 'car', 'cdr', 'pipe', 'compose', 'inc', 'add'];
      
      for (const fnName of testFunctions) {
        const fn = sandboxedEnv.get(fnName, { throwError: false });
        expect(fn).toBeTypeOf('function', `${fnName} should be available as a function`);
        console.log(`✓ ${fnName} is available`);
      }
    });

    it("should handle mixed LIPS and JS data structures", async () => {
      // Test that our car/cdr functions work with both data types
      const carFn = RAMDA_FUNCTIONS.car;
      const cdrFn = RAMDA_FUNCTIONS.cdr;
      
      // Test with JS array
      expect(carFn([1, 2, 3])).toBe(1);
      expect(cdrFn([1, 2, 3])).toEqual([2, 3]);
      
      // Test with LIPS list
      const lipsList = await exec(`(list 1 2 3)`, { env: sandboxedEnv });
      expect(carFn(lipsList)).toBe(1);
      expect(cdrFn(lipsList)).toBeDefined();
      expect(cdrFn(lipsList).car).toBe(2); // First element of cdr should be 2
      
      console.log("✓ car/cdr work with both JS arrays and LIPS lists");
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should handle empty lists gracefully", async () => {
      const result = await exec(`
        (map inc (list))
      `, { env: sandboxedEnv });
      
      console.log("Map on empty list:", result);
      
      // Should return empty list (nil)
      const nil = lipsGlobalEnv.get('nil');
      expect(result).toBe(nil);
    });

    it("should handle filter that returns empty result", async () => {
      const result = await exec(`
        (filter (gt 10) (list 1 2 3))
      `, { env: sandboxedEnv });
      
      console.log("Filter with no matches:", result);
      
      // Should return empty list (nil)
      const nil = lipsGlobalEnv.get('nil');
      expect(result).toBe(nil);
    });

    it("should handle reduce on empty list", async () => {
      const result = await exec(`
        (reduce add 42 (list))
      `, { env: sandboxedEnv });
      
      console.log("Reduce on empty list:", result);
      
      // Should return initial value
      expect(result).toBe(42);
    });
  });

  describe("Complex Integration Scenarios", () => {
    it("should handle nested function composition", async () => {
      // Test the exact pattern we need for MCP: filtering nodes by CSS properties
      const result = await exec(`
        (define process-nodes
          (pipe
            (map (prop "style"))
            (filter (prop "overflow"))
            (map (prop "overflow"))
            (filter (equals "hidden"))))
        
        (process-nodes (list 
          {:style {:overflow "hidden"}}
          {:style {:overflow "visible"}}  
          {:style {:overflow "hidden"}}
          {:style {}}))
      `, { env: sandboxedEnv });
      
      console.log("Complex CSS filtering result:", result);
      
      // Should filter down to just the "hidden" values
      const values = [];
      let current = result;
      while (current && current.car !== undefined) {
        values.push(current.car);
        current = current.cdr;
      }
      expect(values).toEqual(["hidden", "hidden"]);
    });

    it("should work with the exact MCP pattern", async () => {
      // Test the exact filter pattern from our MCP debugging
      const result = await exec(`
        (filter 
          (lambda (node) 
            (equals "hidden" (get-in ["style" "overflow"] node)))
          (list 
            {:style {:overflow "hidden"}}
            {:style {:overflow "visible"}}
            {:style {:overflow "hidden"}}))
      `, { env: sandboxedEnv });
      
      console.log("MCP-style filtering result:", result);
      
      // Should return the 2 nodes with overflow: hidden
      const values = [];
      let current = result;
      while (current && current.car !== undefined) {
        values.push(current.car);
        current = current.cdr;
      }
      expect(values).toHaveLength(2);
      expect(values[0].style.overflow).toBe("hidden");
      expect(values[1].style.overflow).toBe("hidden");
    });
  });
});
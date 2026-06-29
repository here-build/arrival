/**
 * Tests for Environment Module Composition System
 *
 * Tests the composable module system where:
 * - Modules form an environment chain (first = base, last = top)
 * - Resolution order per module: bindings → resolvers → parent
 * - Resolvers can yield by returning undefined
 *
 * Note: These tests use _lookupWithResolvers directly to avoid
 * dependency on lips runtime (which patch_value requires).
 */

import { describe, expect, it } from "vitest";
import { Environment } from "../Environment.js";
import type { FallbackResolver } from "../bindings.js";

// Helper to lookup without patch_value dependency
const lookup = (env: Environment, name: string) => env._lookupWithResolvers(name);


describe("Environment Module Composition", () => {
  describe("Resolver Yielding", () => {
    it("should try multiple resolvers in order until one returns a value", () => {
      const callOrder: string[] = [];

      const resolver1: FallbackResolver = {
        id: "resolver-1",
        resolve: (name) => {
          callOrder.push("resolver-1");
          return undefined; // Yield
        },
      };

      const resolver2: FallbackResolver = {
        id: "resolver-2",
        resolve: (name) => {
          callOrder.push("resolver-2");
          return name === "target" ? "found" : undefined;
        },
      };

      const env = new Environment("test", {}, null);
      env.registerResolver(resolver1);
      env.registerResolver(resolver2);

      expect(lookup(env, "target")).toBe("found");
      expect(callOrder).toEqual(["resolver-1", "resolver-2"]);
    });

    it("should distinguish between undefined (yield) and null/nil (found)", () => {
      const resolver: FallbackResolver = {
        id: "null-resolver",
        resolve: (name) => (name === "null-value" ? null : undefined),
      };

      const env = new Environment("test", {}, null);
      env.registerResolver(resolver);

      // null is a valid return value, should not continue searching
      expect(lookup(env, "null-value")).toBe(null);
    });
  });

  describe("_lookupWithResolvers", () => {
    it("should implement correct per-module resolution order", () => {
      const env = new Environment("parent", { x: 1 }, null);
      env.registerResolver({
        id: "parent-resolver",
        resolve: (name) => (name === "y" ? 2 : undefined),
      });

      const child = new Environment("child", { z: 3 }, env);
      child.registerResolver({
        id: "child-resolver",
        resolve: (name) => (name === "w" ? 4 : undefined),
      });

      // Direct binding in child
      expect(child._lookupWithResolvers("z")).toBe(3);

      // Resolver in child
      expect(child._lookupWithResolvers("w")).toBe(4);

      // Direct binding in parent (after child resolver yields)
      expect(child._lookupWithResolvers("x")).toBe(1);

      // Resolver in parent (after child resolver yields)
      expect(child._lookupWithResolvers("y")).toBe(2);

      // Not found anywhere
      expect(child._lookupWithResolvers("not-found")).toBe(undefined);
    });
  });
});

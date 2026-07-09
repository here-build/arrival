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
 *
 * [RETAG — deliberate internal-module unit suite, not a test-only-API artifact]
 * (2026-07-08 test-invariant-atlas sweep, [P16] docs/test-invariant-atlas/verdicts/evaluator.md,
 * docs/test-suite-v2/REMOVAL-MANIFEST.md §A): `_lookupWithResolvers` is real production
 * surface (`Resolver.ts`, `Capabilities.ts`, `LexicalScope.ts`, `common/capability.ts` all
 * call it — confirmed via grep), not a test-only hack. Checked the two candidate public-
 * altitude covers: `src/common/__tests__/capability.test.ts` explicitly does NOT exercise
 * resolver ordering (its own header comment: "registerResolver / list / allBoundNames are
 * not exercised by these tests"), and `capabilities-assembled.test.ts` only tests the
 * assembled-base sentinel, not resolver yield/chain-order semantics. No public-altitude
 * survivor exists, so this file stays — parallel to `parser.test.ts`'s honest framing of
 * bypassing `exec()` for a fast internal-module unit floor.
 *
 * ENV T1 (2026-07-09, docs/working-proposals/environment-resolution-chain.md §T1): resolvers
 * relocated from every `Environment` frame onto `ResolvingEnvironment` only (the baked-root
 * specialization — see env-roots.ts). The rows below are UNCHANGED — same ordering contract,
 * same assertions — construction just targets `ResolvingEnvironment` at the two/three layers
 * that register resolvers, matching production (`global_env`/`user_env` are the real
 * `ResolvingEnvironment` instances these tests model).
 */

import { describe, expect, it } from "vitest";
import { Environment, ResolvingEnvironment } from "../Environment.js";
import type { ResolverSpec } from "../common/scheme-env.js";
import { AExact } from "../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

// Helper to lookup without patch_value dependency
const lookup = (env: Environment, name: string) => env._lookupWithResolvers(name);


describe("Environment Module Composition", () => {
  describe("Resolver Yielding", () => {
    it("should try multiple resolvers in order until one returns a value", () => {
      const callOrder: string[] = [];

      const resolver1: ResolverSpec = {
        id: "resolver-1",
        resolve: (name) => {
          callOrder.push("resolver-1");
          return undefined; // Yield
        },
      };

      const resolver2: ResolverSpec = {
        id: "resolver-2",
        resolve: (name) => {
          callOrder.push("resolver-2");
          return name === "target" ? "found" : undefined;
        },
      };

      const env = new ResolvingEnvironment("test", {}, null);
      env.registerResolver(resolver1);
      env.registerResolver(resolver2);

      expect(lookup(env, "target")).toBe("found");
      expect(callOrder).toEqual(["resolver-1", "resolver-2"]);
    });

    it("should distinguish between undefined (yield) and null/nil (found)", () => {
      const resolver: ResolverSpec = {
        id: "null-resolver",
        resolve: (name) => (name === "null-value" ? null : undefined),
      };

      const env = new ResolvingEnvironment("test", {}, null);
      env.registerResolver(resolver);

      // null is a valid return value, should not continue searching
      expect(lookup(env, "null-value")).toBe(null);
    });
  });

  describe("_lookupWithResolvers", () => {
    it("should implement correct per-module resolution order", () => {
      // Bindings are boxed SchemeValues (an env binds AExact, not a raw JS number);
      // the resolver returns below stay raw — _lookupWithResolvers is contract'd to
      // pass a resolver hit (typed `unknown`) straight through.
      const env = new ResolvingEnvironment("parent", { x: new AExact(CONSTANT_CTX, 1n) }, null);
      env.registerResolver({
        id: "parent-resolver",
        resolve: (name) => (name === "y" ? 2 : undefined),
      });

      const child = new ResolvingEnvironment("child", { z: new AExact(CONSTANT_CTX, 3n) }, env);
      child.registerResolver({
        id: "child-resolver",
        resolve: (name) => (name === "w" ? 4 : undefined),
      });

      // Direct binding in child
      expect(child._lookupWithResolvers("z")).toEqual(new AExact(CONSTANT_CTX, 3n));

      // Resolver in child
      expect(child._lookupWithResolvers("w")).toBe(4);

      // Direct binding in parent (after child resolver yields)
      expect(child._lookupWithResolvers("x")).toEqual(new AExact(CONSTANT_CTX, 1n));

      // Resolver in parent (after child resolver yields)
      expect(child._lookupWithResolvers("y")).toBe(2);

      // Not found anywhere
      expect(child._lookupWithResolvers("not-found")).toBe(undefined);
    });
  });
});

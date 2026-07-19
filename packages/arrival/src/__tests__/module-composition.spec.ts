/**
 * Tests for AmbientRuntime Module Composition System
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
 * (2026-07-09 suite consolidation, [P16]): `_lookupWithResolvers` is real production
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
 * relocated from every `AmbientRuntime` frame onto `ResolvingAmbient` only (the baked-root
 * specialization — see env-roots.ts). The rows below are UNCHANGED — same ordering contract,
 * same assertions — construction just targets `ResolvingAmbient` at the two/three layers
 * that register resolvers, matching production (`global_env`/`user_env` are the real
 * `ResolvingAmbient` instances these tests model).
 */

import { describe, expect, it } from "vitest";
import { AmbientRuntime, ResolvingAmbient, mintResolvingFrame } from "../AmbientRuntime.js";
import type { ResolverSpec } from "../common/scheme-env.js";
import { AExact } from "../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { nil } from "../values/primitives/ANil.js";

// The boxed sentinel a resolver answers with (resolvers box at their own boundary now).
const FOUND = new AExact(CONSTANT_CTX, 42);

// Helper to lookup without patch_value dependency
const lookup = (env: AmbientRuntime, name: string) => env._lookupWithResolvers(name);


describe("AmbientRuntime Module Composition", () => {
  describe("Resolver Yielding", () => {
    // INVARIANT: multiple registered resolvers are tried in registration order until one
    // returns a defined value (pins implementation, not behavior)
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
          return name === "target" ? FOUND : undefined;
        },
      };

      const env = mintResolvingFrame("test", {}, null);
      env.registerResolver(resolver1);
      env.registerResolver(resolver2);

      expect(lookup(env, "target")).toBe(FOUND);
      expect(callOrder).toEqual(["resolver-1", "resolver-2"]);
    });

    // INVARIANT: a resolver returning undefined "yields" (search continues); returning
    // any other defined value — including a found NIL — stops the search (pins
    // implementation, not behavior). Post-hermetic-ruling the raw JS `null` sentinel is
    // out of the resolver contract (boxed values only); `nil` is its in-contract twin.
    it("should distinguish between undefined (yield) and a found nil (found)", () => {
      const resolver: ResolverSpec = {
        id: "nil-resolver",
        resolve: (name) => (name === "nil-value" ? nil : undefined),
      };

      const env = mintResolvingFrame("test", {}, null);
      env.registerResolver(resolver);

      // nil is a valid FOUND value, should not continue searching
      expect(lookup(env, "nil-value")).toBe(nil);
    });
  });

  describe("_lookupWithResolvers", () => {
    // INVARIANT: resolution order per environment is direct bindings → registered
    // resolvers → parent environment, checked in that order at each level (pins
    // implementation, not behavior)
    it("should implement correct per-module resolution order", () => {
      // Bindings AND resolver answers are boxed SchemeValues — the hermetic ruling's
      // resolver contract: a resolver boxes at its own boundary, so the walk hands the
      // evaluator boxed values on every path.
      const Y = new AExact(CONSTANT_CTX, 2);
      const W = new AExact(CONSTANT_CTX, 4);
      const env = mintResolvingFrame("parent", { x: new AExact(CONSTANT_CTX, 1) }, null);
      env.registerResolver({
        id: "parent-resolver",
        resolve: (name) => (name === "y" ? Y : undefined),
      });

      const child = mintResolvingFrame("child", { z: new AExact(CONSTANT_CTX, 3) }, env);
      child.registerResolver({
        id: "child-resolver",
        resolve: (name) => (name === "w" ? W : undefined),
      });

      // Direct binding in child
      expect(child._lookupWithResolvers("z")).toEqual(new AExact(CONSTANT_CTX, 3));

      // Resolver in child
      expect(child._lookupWithResolvers("w")).toBe(W);

      // Direct binding in parent (after child resolver yields)
      expect(child._lookupWithResolvers("x")).toEqual(new AExact(CONSTANT_CTX, 1));

      // Resolver in parent (after child resolver yields)
      expect(child._lookupWithResolvers("y")).toBe(Y);

      // Not found anywhere
      expect(child._lookupWithResolvers("not-found")).toBe(undefined);
    });
  });
});

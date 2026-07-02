// env-pack-prelude-scope.test.ts — the KERNEL-INTERNAL phase-gated prelude scope (design doc
// docs/package-specific/arrival-scheme/prelude-only-symbols-and-composable-prompt-2026-07-02.md §1.3,
// reworked from the caller-built overlay to the kernel-owned mechanism).
//
// `assembleEnv` now ALWAYS provides `ctx.preludeScope` — a `.set`-only shim over a per-assembly
// Map — and, on the FIRST binding, registers a resolver on the base env (iff the base has
// `registerResolver`, probed structurally so the kernel stays env-agnostic) that answers from
// that Map only while the assembly's C3 loop is running. This file proves the GENERIC seam with
// stub envs; the scheme-level end-to-end proof lives in prelude-overlay.test.ts.

import { describe, expect, it } from "vitest";

import { assembleEnv, type EnvPack } from "../kernel.js";

/** A base that records resolver registrations, like `Environment.registerResolver` would. */
interface ResolverStub {
  resolvers: { id: string; resolve(name: string): unknown }[];
  registerResolver(r: { id: string; resolve(name: string): unknown }): void;
}
const resolverStub = (): ResolverStub => {
  const resolvers: ResolverStub["resolvers"] = [];
  return { resolvers, registerResolver: (r) => void resolvers.push(r) };
};

describe("assembleEnv — kernel-internal phase-gated preludeScope", () => {
  it("ctx.preludeScope is ALWAYS present (the kernel shim), even with no option passed", async () => {
    const seen: unknown[] = [];
    const a: EnvPack<Record<string, never>> = {
      name: "a",
      apply: (_env, ctx) => void seen.push(ctx.preludeScope),
    };
    await assembleEnv({}, [a]);
    expect(seen).toHaveLength(1);
    expect(typeof (seen[0] as { set?: unknown })?.set).toBe("function");
  });

  it("a binding set by an EARLIER pack resolves through the base's resolver DURING a later apply, and goes silent after assembly", async () => {
    const base = resolverStub();
    const duringLater: unknown[] = [];
    const contributor: EnvPack<ResolverStub> = {
      name: "contributor",
      apply: (_env, ctx) => void ctx.preludeScope!.set("hidden/verb", "the-value"),
    };
    const consumer: EnvPack<ResolverStub> = {
      name: "consumer",
      deps: [contributor],
      apply: (env) => {
        // The consumer applies AFTER its dep (C3, least-precedence first). What a prelude
        // evaluated at this point would see = what the base's resolvers answer NOW.
        duringLater.push(env.resolvers.map((r) => r.resolve("hidden/verb")).find((v) => v !== undefined));
      },
    };
    await assembleEnv(base, [consumer]);
    expect(duringLater).toEqual(["the-value"]); // visible while the C3 loop runs
    // After assembly the SAME resolver answers nothing — the phase flag is the seal.
    expect(base.resolvers).toHaveLength(1);
    expect(base.resolvers[0].resolve("hidden/verb")).toBeUndefined();
  });

  it("registers NO resolver when no preludeOnly binding is ever set (lazy — common case untouched)", async () => {
    const base = resolverStub();
    const plain: EnvPack<ResolverStub> = { name: "plain", apply: () => undefined };
    await assembleEnv(base, [plain]);
    expect(base.resolvers).toHaveLength(0);
  });

  it("two assemblies over the SAME base register DISTINCT resolver ids (per-assembly closures, dedup-safe)", async () => {
    const base = resolverStub();
    const binder = (name: string): EnvPack<ResolverStub> => ({
      name,
      apply: (_env, ctx) => void ctx.preludeScope!.set(`${name}/verb`, name),
    });
    await assembleEnv(base, [binder("first")]);
    await assembleEnv(base, [binder("second")]);
    expect(base.resolvers).toHaveLength(2);
    expect(base.resolvers[0].id).not.toBe(base.resolvers[1].id);
    // Both are spent: neither answers post-assembly.
    expect(base.resolvers.map((r) => r.resolve("first/verb"))).toEqual([undefined, undefined]);
    expect(base.resolvers.map((r) => r.resolve("second/verb"))).toEqual([undefined, undefined]);
  });

  it("a non-resolver-host base is tolerated (env-agnostic kernel): set() is a quiet Map write", async () => {
    const seen: unknown[] = [];
    const a: EnvPack<Record<string, never>> = {
      name: "a",
      apply: (_env, ctx) => void seen.push(ctx.preludeScope!.set("x", 1)),
    };
    await expect(assembleEnv({}, [a])).resolves.toBeDefined();
    expect(seen).toEqual([1]); // set returns the value; nothing consults the map
  });

  it("the phase flips false even when a pack apply FAILS (no half-open prelude scope escapes)", async () => {
    const base = resolverStub();
    const contributor: EnvPack<ResolverStub> = {
      name: "contributor",
      apply: (_env, ctx) => void ctx.preludeScope!.set("hidden/verb", "v"),
    };
    const bomb: EnvPack<ResolverStub> = {
      name: "bomb",
      deps: [contributor],
      apply: () => {
        throw new Error("boom");
      },
    };
    await expect(assembleEnv(base, [bomb])).rejects.toThrow(/boom/);
    expect(base.resolvers[0].resolve("hidden/verb")).toBeUndefined();
  });
});

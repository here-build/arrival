/**
 * LAW — RunContext channels 7+ (P19: no global state; everything inside RunContext).
 * Defaults preserve pre-migration behavior; the ambient holder is per-run and sync-windowed.
 */
import { describe, it, expect } from "vitest";
import { CONSTANT_CTX, RunContext, withAmbient, AmbientWindowError, type RunEmission } from "../RunContext.js";
import { currentRun, withCurrentRun } from "../current-run.js";
import { hermeticEnv } from "../../provenance/hermetic-env.js";
import { execState } from "../../eval/generator-exec.js";

const fakeEmission = { store: {}, payloads: {}, regionId: "r", coordinate: {} } as unknown as RunEmission;

describe("RunContext channels: defaults", () => {
  it("emission off, flags false, fresh empty ambient", () => {
    const ctx = new RunContext();
    expect(ctx.emission).toBeUndefined();
    expect(ctx.silent).toBe(false);
    expect(ctx.eagerStamps).toBe(false);
    expect(ctx.ambient).toEqual({});
    expect(Object.isFrozen(ctx.ambient)).toBe(false);
  });
  it("CONSTANT_CTX: all off, ambient frozen", () => {
    expect(CONSTANT_CTX.emission).toBeUndefined();
    expect(CONSTANT_CTX.silent).toBe(false);
    expect(CONSTANT_CTX.eagerStamps).toBe(false);
    expect(Object.isFrozen(CONSTANT_CTX.ambient)).toBe(true);
  });
  it("ctor accepts the new fields", () => {
    const ctx = new RunContext({ emission: fakeEmission, silent: true, eagerStamps: true });
    expect(ctx.emission).toBe(fakeEmission);
    expect(ctx.silent).toBe(true);
    expect(ctx.eagerStamps).toBe(true);
  });
});

describe("ExecOptions threading", () => {
  it("emission/silent/eagerStamps ride onto the minted RunContext", async () => {
    const state = await execState("1", { emission: fakeEmission, silent: true, eagerStamps: true });
    expect(state.runCtx.emission).toBe(fakeEmission);
    expect(state.runCtx.silent).toBe(true);
    expect(state.runCtx.eagerStamps).toBe(true);
  });
  it("defaults are off through execState", async () => {
    const state = await execState("1");
    expect(state.runCtx.emission).toBeUndefined();
    expect(state.runCtx.silent).toBe(false);
    expect(state.runCtx.eagerStamps).toBe(false);
  });
  it("hermetic runs are silent with eager stamps", async () => {
    const env = await hermeticEnv([], "");
    expect(env.runCtx.silent).toBe(true);
    expect(env.runCtx.eagerStamps).toBe(true);
  });
});

describe("withAmbient", () => {
  it("sets inside, restores after (value and throw)", () => {
    const ctx = new RunContext();
    const site = { id: 1 };
    expect(
      withAmbient(ctx, "dynSite", site, () => {
        expect(ctx.ambient.dynSite).toBe(site);
        return 7;
      }),
    ).toBe(7);
    expect("dynSite" in ctx.ambient).toBe(false);
    expect(() =>
      withAmbient(ctx, "dynSite", site, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect("dynSite" in ctx.ambient).toBe(false);
  });
  it("nests: inner restores the outer value", () => {
    const ctx = new RunContext();
    withAmbient(ctx, "dynSite", "outer", () => {
      withAmbient(ctx, "dynSite", "inner", () => {
        expect(ctx.ambient.dynSite).toBe("inner");
      });
      expect(ctx.ambient.dynSite).toBe("outer");
    });
  });
  it("refuses a thenable-returning body, and the slot is already restored", () => {
    const ctx = new RunContext();
    expect(() => withAmbient(ctx, "dynSite", "x", () => Promise.resolve(1))).toThrow(AmbientWindowError);
    expect("dynSite" in ctx.ambient).toBe(false);
  });
  it("refuses CONSTANT_CTX", () => {
    expect(() => withAmbient(CONSTANT_CTX, "dynSite", "x", () => 1)).toThrow(AmbientWindowError);
  });
  it("two RunContexts' ambients are independent", () => {
    const a = new RunContext();
    const b = new RunContext();
    withAmbient(a, "dynSite", "A", () => {
      expect(b.ambient.dynSite).toBeUndefined();
      withAmbient(b, "dynSite", "B", () => {
        expect(a.ambient.dynSite).toBe("A");
        expect(b.ambient.dynSite).toBe("B");
      });
    });
    expect(a.ambient).not.toBe(b.ambient);
  });
});

describe("currentRun", () => {
  it("is undefined outside, set inside, restored after, nested-safe", () => {
    const a = new RunContext();
    const b = new RunContext();
    expect(currentRun()).toBeUndefined();
    withCurrentRun(a, () => {
      expect(currentRun()).toBe(a);
      withCurrentRun(b, () => expect(currentRun()).toBe(b));
      expect(currentRun()).toBe(a);
    });
    expect(currentRun()).toBeUndefined();
  });
  it("restores on throw", () => {
    expect(() =>
      withCurrentRun(new RunContext(), () => {
        throw new Error("x");
      }),
    ).toThrow("x");
    expect(currentRun()).toBeUndefined();
  });
  it("tripwire: thenable-returning body is refused and the pointer restored", () => {
    expect(() => withCurrentRun(new RunContext(), () => Promise.resolve(1))).toThrow(AmbientWindowError);
    expect(currentRun()).toBeUndefined();
  });
});

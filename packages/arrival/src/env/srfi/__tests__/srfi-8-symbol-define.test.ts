// srfi-8-symbol-define.test.ts — SRFI-8 is doors-only under multi-return ban.
// Single export `receive` is sugar over call-with-values; both are purity-doored.
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../AmbientRuntime.js";
import type { AEntity } from "../../../common/symbol.js";
import { exec, execInFrame } from "../../../eval/generator-exec.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError, PurityError } from "../../../errors.js";
import srfi8 from "../srfi-8.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { freshEnv, nativeOnlyRoot } from "../../../__tests__/_fresh-env.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const evalScheme = (env: unknown, src: unknown): unknown => execInFrame(src as string, env as ResolvingAmbient);

describe("scheme/srfi-8 — doors-only (all-or-nothing multi-return ban)", () => {
  it("receive is kind door", () => {
    const symbols = harvestContracts(srfi8.spec.symbols);
    expect(Object.keys(symbols)).toEqual(["receive"]);
    expect(symbols.receive?.kind).toBe("door");
  });

  it("lowers standalone without bake FV errors", async () => {
    const env = mintFrame(await nativeOnlyRoot(), "srfi-8-standalone");
    await expect(srfi8.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("never throws DefineLocalityError/DefineForwardReferenceError/ProvenanceRoleShapeError on lower", async () => {
    const env = mintFrame(await nativeOnlyRoot(), "srfi-8-fv-pin");
    try {
      await srfi8.lower({ evalScheme }).apply(env, undefined as never);
    } catch (e) {
      expect(e).not.toBeInstanceOf(DefineLocalityError);
      expect(e).not.toBeInstanceOf(DefineForwardReferenceError);
      expect(e).not.toBeInstanceOf(ProvenanceRoleShapeError);
      throw e;
    }
  });

  it("receive binds as DoorProcedure and fires PurityError", async () => {
    const env = await freshEnv();
    expect(env.get("receive")).toBeInstanceOf(DoorProcedure);
    let caught: unknown;
    try {
      await exec("(receive 1 2)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const purity = caught instanceof PurityError || (caught as { cause?: unknown })?.cause instanceof PurityError;
    expect(purity).toBe(true);
    expect((caught as Error).message).toMatch(/multiple-value returns are omitted from arrival by design|continuation arity/);
  });
});

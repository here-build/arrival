// scheme/r7rs/host — §6.13/§6.14 doors totalized (implement-or-door).
import { describe, expect, it } from "vitest";
import hostPack, { HOST_DOOR_NAMES } from "../host.js";
import { exec } from "../../../eval/generator-exec.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import { PurityError } from "../../../errors.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";

const symbols = harvestContracts(hostPack.spec.symbols);

const door = async (src: string) => {
  try {
    await exec(src);
  } catch (error) {
    const purity = error instanceof PurityError || (error as { cause?: unknown })?.cause instanceof PurityError;
    return { purity, message: (error as Error)?.message ?? String(error) };
  }
  throw new Error(`expected purity door for: ${src}`);
};

describe("scheme/r7rs/host — totalized doors", () => {
  it("exports a full §6.13/§6.14 door inventory (all kind door)", () => {
    expect(HOST_DOOR_NAMES.length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(symbols).sort()).toEqual([...HOST_DOOR_NAMES].sort());
    for (const name of HOST_DOOR_NAMES) expect(symbols[name]?.kind).toBe("door");
  });

  it("base env binds each host door", async () => {
    const env = await freshEnv();
    for (const name of HOST_DOOR_NAMES) expect(env.get(name)).toBeInstanceOf(DoorProcedure);
  });

  it.each([
    ["port?", "(port? 1)"],
    ["get-output-string", "(get-output-string 1)"],
    ["file-exists?", '(file-exists? "x")'],
    ["load", "(load)"],
    ["features", "(features)"],
  ] as const)("%s → PurityError", async (_n, src) => {
    const { purity, message } = await door(src);
    expect(purity).toBe(true);
    expect(message).toMatch(/omitted from arrival by design|no file ports in this sandbox/);
  });
});

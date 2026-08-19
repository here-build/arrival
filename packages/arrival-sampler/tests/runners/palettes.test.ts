// palettes.test.ts — model-free checks on the node-side action-palettes API. Asserts all 7 schemes are
// present, each PaletteInfo is well-formed, buildPaletteEnv binds exactly the scheme's tool names,
// buildPalettePrompt lists them, and measuredCorrectness is set for exactly bdei/bang/die.

import { describe, expect, it } from "vitest";

import { buildPaletteEnv, buildPalettePrompt, PALETTES, type PaletteId, paletteTools } from "../../src/runners/palettes.js";

/** Every bound name in a palette's Σ grant — the same vocabulary `makeOracle(grant)` sees. */
async function paletteBoundNames(id: PaletteId): Promise<ReadonlySet<string>> {
  const { grant } = await buildPaletteEnv(id);
  return grant.boundSymbols();
}

const ALL_SCHEMES: PaletteId[] = ["dei", "die", "eq", "bang", "env", "bdei", "bdie"];
const MEASURED: Record<string, number> = { bdei: 0.843, bang: 0.786, die: 0.571 };

describe("PALETTES", () => {
  it("has all 7 schemes", () => {
    expect(PALETTES.map((p) => p.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...ALL_SCHEMES].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("each PaletteInfo is well-formed", () => {
    for (const p of PALETTES) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.sampleName.length).toBeGreaterThan(0);
      expect(p.toolCount).toBeGreaterThan(0);
    }
  });

  it("sets measuredCorrectness for exactly bdei/bang/die", () => {
    for (const p of PALETTES) {
      if (p.id in MEASURED) expect(p.measuredCorrectness).toBe(MEASURED[p.id]);
      else expect(p.measuredCorrectness).toBeUndefined();
    }
  });

  it("orders best→worst where measured, then the rest", () => {
    expect(PALETTES.slice(0, 3).map((p) => p.id)).toEqual(["bdei", "bang", "die"]);
  });
});

describe("palette builders", () => {
  it.each(ALL_SCHEMES)("buildPaletteEnv(%s) binds every paletteTools name", async (id) => {
    const boundNames = await paletteBoundNames(id);
    const tools = paletteTools(id);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(boundNames.has(tool.name)).toBe(true);
  });

  it.each(ALL_SCHEMES)("buildPalettePrompt(%s) lists the scheme's tool names", (id) => {
    const prompt = buildPalettePrompt(id);
    for (const tool of paletteTools(id)) expect(prompt).toContain(tool.name);
  });

  it("spot-checks the send-message tool name per scheme", async () => {
    // dei=messaging/message/send, die=messaging/send/message, bang=!effect/message/send
    const byId = Object.fromEntries(PALETTES.map((p) => [p.id, p.sampleName]));
    expect(byId.dei).toBe("messaging/message/send");
    expect(byId.die).toBe("messaging/send/message");
    expect(byId.bang).toBe("!effect/message/send");
    expect(byId.bdei).toBe("!effect/messaging/message/send");
    for (const id of ALL_SCHEMES) expect((await paletteBoundNames(id)).has(byId[id])).toBe(true);
  });
});

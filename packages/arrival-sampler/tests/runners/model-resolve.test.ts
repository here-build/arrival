// model-resolve.test.ts — model-id resolution, filesystem-driven. No GGUFs are present in the repo, so the
// resolver returns null for a known id (correctly — the binary isn't downloaded), but `/v1/models` still lists
// the roster ids, and an explicit on-disk path resolves. We exercise resolution against a TEMP roster dir we
// populate with a fake .gguf so the present-file path is covered without a real model.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  resolveModelPath,
  listModelIds,
  presentGgufs,
  quantTierOf,
  resolveEnv,
  resolvableRosterModels,
  KNOWN_ROSTER,
} from "../../src/runners/server/model-resolve.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "roster-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a zero-content fake gguf with a given byte size (for size-driven preload tests). */
function writeGguf(name: string, bytes = 4): string {
  const p = path.join(dir, name);
  writeFileSync(p, "x".repeat(bytes));
  return p;
}

describe("resolveModelPath", () => {
  it("resolves a known roster id to its file when present on disk", () => {
    // Write the file the known id maps to.
    const file = KNOWN_ROSTER["Arch-Agent-1.5B"]!;
    writeFileSync(path.join(dir, file), "fake");
    expect(resolveModelPath("Arch-Agent-1.5B", dir)).toBe(path.join(dir, file));
  });

  it("resolves a basename present in the roster dir (id === basename)", () => {
    writeFileSync(path.join(dir, "custom-model.gguf"), "fake");
    expect(resolveModelPath("custom-model", dir)).toBe(path.join(dir, "custom-model.gguf"));
    expect(resolveModelPath("custom-model.gguf", dir)).toBe(path.join(dir, "custom-model.gguf"));
  });

  it("resolves an explicit absolute .gguf path verbatim", () => {
    const p = path.join(dir, "abs.gguf");
    writeFileSync(p, "fake");
    expect(resolveModelPath(p, dir)).toBe(path.resolve(p));
  });

  it("returns null for an id with no matching file (binary not downloaded)", () => {
    expect(resolveModelPath("Arch-Agent-1.5B", dir)).toBeNull();
    expect(resolveModelPath("does-not-exist", dir)).toBeNull();
  });
});

describe("listModelIds", () => {
  it("includes every known roster id plus any present basename, deduped + sorted", () => {
    writeFileSync(path.join(dir, "extra-model.gguf"), "fake");
    const ids = listModelIds(dir);
    expect(ids).toContain("Arch-Agent-1.5B"); // known id
    expect(ids).toContain("extra-model"); // present basename
    // sorted + deduped
    expect([...ids]).toEqual([...new Set(ids)].sort());
  });
});

describe("presentGgufs", () => {
  it("lists only .gguf files in the dir", () => {
    writeFileSync(path.join(dir, "a.gguf"), "x");
    writeFileSync(path.join(dir, "readme.txt"), "x");
    expect(presentGgufs(dir)).toEqual(["a.gguf"]);
  });
});

describe("quantTierOf — filename → quant band", () => {
  it("classifies q4 markers (any case / separator)", () => {
    expect(quantTierOf("foo-q4_k_m.gguf")).toBe("q4");
    expect(quantTierOf("Foo.Q4_K_M.gguf")).toBe("q4");
    expect(quantTierOf("foo-q4_0.gguf")).toBe("q4");
  });
  it("classifies q8 markers", () => {
    expect(quantTierOf("foo-q8_0.gguf")).toBe("q8");
    expect(quantTierOf("Foo.Q8_0.gguf")).toBe("q8");
  });
  it("classifies f16/bf16/f32 AND a bare name (no marker) as the full-precision f16 band", () => {
    expect(quantTierOf("foo-f16.gguf")).toBe("f16");
    expect(quantTierOf("foo-bf16.gguf")).toBe("f16");
    expect(quantTierOf("foo-f32.gguf")).toBe("f16");
    expect(quantTierOf("foo.gguf")).toBe("f16"); // bare = unquantized full precision
  });
  it("classifies q5/q6/iq* as the catch-all 'other' band", () => {
    expect(quantTierOf("foo-q5_k_m.gguf")).toBe("other");
    expect(quantTierOf("foo-q6_k.gguf")).toBe("other");
    expect(quantTierOf("foo-q2_k.gguf")).toBe("other");
  });
});

describe("resolveEnv — NODE_ENV gate", () => {
  it("is 'dev' under the vitest default NODE_ENV (not 'production')", () => {
    // Vitest sets NODE_ENV=test, so the env is dev.
    expect(resolveEnv()).toBe("dev");
  });
  it("is 'prod' only when NODE_ENV === 'production'", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(resolveEnv()).toBe("prod");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("resolveModelPath — quant-aware ladder", () => {
  // One logical model "mymodel" with three quant variants on disk (shared stem).
  function seedThreeVariants(): { q4: string; q8: string; f16: string } {
    writeGguf("mymodel-q4_k_m.gguf");
    writeGguf("mymodel-q8_0.gguf");
    writeGguf("mymodel-f16.gguf");
    return {
      q4: path.join(dir, "mymodel-q4_k_m.gguf"),
      q8: path.join(dir, "mymodel-q8_0.gguf"),
      f16: path.join(dir, "mymodel-f16.gguf"),
    };
  }

  it("dev picks q4 when all variants are present", () => {
    const v = seedThreeVariants();
    expect(resolveModelPath("mymodel", dir, "dev")).toBe(v.q4);
  });

  it("prod picks f16/bf16 when all variants are present", () => {
    const v = seedThreeVariants();
    expect(resolveModelPath("mymodel", dir, "prod")).toBe(v.f16);
  });

  it("dev falls through q4 → q8 when q4 is absent", () => {
    writeGguf("mymodel-q8_0.gguf");
    writeGguf("mymodel-f16.gguf");
    expect(resolveModelPath("mymodel", dir, "dev")).toBe(path.join(dir, "mymodel-q8_0.gguf"));
  });

  it("prod falls through f16 → q8 when no full-precision build exists", () => {
    writeGguf("mymodel-q4_k_m.gguf");
    writeGguf("mymodel-q8_0.gguf");
    expect(resolveModelPath("mymodel", dir, "prod")).toBe(path.join(dir, "mymodel-q8_0.gguf"));
  });

  it("falls through to the 'other' band (q5/q6) when no preferred tier is present (both envs)", () => {
    writeGguf("mymodel-q6_k.gguf");
    expect(resolveModelPath("mymodel", dir, "dev")).toBe(path.join(dir, "mymodel-q6_k.gguf"));
    expect(resolveModelPath("mymodel", dir, "prod")).toBe(path.join(dir, "mymodel-q6_k.gguf"));
  });

  it("groups a known roster id's variants by the mapped filename's stem", () => {
    // Arch-Agent-1.5B maps to Arch-Agent-1.5B.Q4_K_M.gguf; add a q8 sibling and a bare full-precision one.
    writeGguf("Arch-Agent-1.5B.Q4_K_M.gguf");
    writeGguf("Arch-Agent-1.5B.Q8_0.gguf");
    expect(resolveModelPath("Arch-Agent-1.5B", dir, "dev")).toBe(path.join(dir, "Arch-Agent-1.5B.Q4_K_M.gguf"));
    expect(resolveModelPath("Arch-Agent-1.5B", dir, "prod")).toBe(path.join(dir, "Arch-Agent-1.5B.Q8_0.gguf"));
  });
});

describe("resolvableRosterModels — logical models on disk", () => {
  it("dedupes quant variants of one logical id to a single entry with the chosen path + size", () => {
    writeGguf("mymodel-q4_k_m.gguf", 10);
    writeGguf("mymodel-q8_0.gguf", 20);
    const models = resolvableRosterModels(dir, "dev");
    const mine = models.filter((m) => path.dirname(m.path) === dir);
    // One logical "mymodel" (the per-variant basenames collapse to the dev-chosen q4 file).
    expect(mine.map((m) => m.path)).toContain(path.join(dir, "mymodel-q4_k_m.gguf"));
    expect(mine.map((m) => m.path)).not.toContain(path.join(dir, "mymodel-q8_0.gguf"));
    const q4 = mine.find((m) => m.path === path.join(dir, "mymodel-q4_k_m.gguf"))!;
    expect(q4.sizeBytes).toBe(10);
  });
});

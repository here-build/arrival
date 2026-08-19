import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Integrity guard for the vitest config files (default/research/benchmarks/custdev).
// Each config builds resolve.alias entries via fileURLToPath(new URL(...)) — SOURCE aliases into
// arrival-scheme (now foundations/arrival/arrival) and arrival-lsp. A stale relative target
// (the OSS reshuffle moved arrival-scheme) silently breaks test collection: the suite resolves 0
// tests instead of erroring. This test loads each config and asserts every alias target exists on
// disk, so a future move is RED here rather than a silent no-op in CI.

const CONFIG_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.research.config.ts",
  "vitest.benchmarks.config.ts",
  "vitest.custdev.config.ts",
];

/** Normalize an alias map (record) or alias array ([{find, replacement}]) into target paths. */
function aliasTargets(alias: unknown): string[] {
  if (!alias) return [];
  if (Array.isArray(alias)) {
    return alias
      .map((entry) => (entry as { replacement?: unknown }).replacement)
      .filter((r): r is string => typeof r === "string");
  }
  if (typeof alias === "object") {
    return Object.values(alias as Record<string, unknown>).filter((v): v is string => typeof v === "string");
  }
  return [];
}

describe("vitest config alias integrity", () => {
  it.each(CONFIG_FILES)("%s: every resolve.alias target exists on disk", async (file) => {
    const configPath = path.resolve(CONFIG_DIR, file);
    expect(existsSync(configPath), `config file missing: ${configPath}`).toBe(true);

    const mod = await import(/* @vite-ignore */ configPath);
    const config = mod.default;
    const alias = config?.resolve?.alias;
    const targets = aliasTargets(alias);

    // Every config in this package carries source aliases; if none resolved, the shape changed.
    expect(targets.length, `${file} produced no alias targets`).toBeGreaterThan(0);

    for (const target of targets) {
      const abs = path.isAbsolute(target) ? target : path.resolve(path.dirname(configPath), target);
      expect(existsSync(abs), `${file}: alias target does not exist: ${abs}`).toBe(true);
    }
  });
});

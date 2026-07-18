/**
 * The golden: the full GEPA example chain → JS, both views. The committed golden
 * FILES (`fixtures/gepa.read.js`, `fixtures/gepa.run.ts`) ARE the spec — readable,
 * diffable source rather than scattered substring checks. Vitest's own
 * `toMatchFileSnapshot` owns the compare/write lifecycle (path resolves relative to
 * this test file, same as a plain relative import would); regenerate intentional
 * changes with `pnpm test -u` — vitest's standard snapshot-update flag, not a
 * bespoke env var.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { projectToJs } from "../project.js";

const fixtureDir = fileURLToPath(new URL("fixtures/sources/", import.meta.url));
const read = (name: string) => readFileSync(fixtureDir + name, "utf8");

// `.scm` spill resolution reads sibling sources (here, metric.scm). Pure injection.
const requireSource = (path: string): string | undefined => {
  try {
    return read(path);
  } catch {
    return undefined;
  }
};

describe("gepa.scm → JS (golden files)", () => {
  it("read-view matches fixtures/gepa.read.js", async () => {
    await expect(await projectToJs(read("gepa.scm"), { requireSource })).toMatchFileSnapshot(
      "fixtures/compiled/gepa.read.js",
    );
  });

  it("run-view matches fixtures/compiled/gepa.run.ts", async () => {
    // `.ts`, not `.js` — since W3 the run register emits type annotations +
    // domain interfaces (TS or nothing, dual-runtime design doc §0).
    await expect(await projectToJs(read("gepa.scm"), { target: "run", requireSource })).toMatchFileSnapshot(
      "fixtures/compiled/gepa.run.ts",
    );
  });

  it("is deterministic (same source → same output)", async () => {
    const a = await projectToJs(read("gepa.scm"), { requireSource });
    const b = await projectToJs(read("gepa.scm"), { requireSource });
    expect(a).toBe(b);
  });
});

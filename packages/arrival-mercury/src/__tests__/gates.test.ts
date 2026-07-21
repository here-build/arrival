/**
 * W9 cut-over gates — lock the migration: no legacy mercury package, no dual
 * oracle subject, type-emit stays free of type-lens (cycle-safe subpath).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const monorepoRoot = path.resolve(packageRoot, "../../..");

function walkFiles(dir: string, pred: (p: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

describe("W9 gates — migration lock", () => {
  it("no @inhuman.tools/mercury package directory remains", () => {
    expect(existsSync(path.join(monorepoRoot, "arrival/packages/mercury"))).toBe(false);
  });

  it("no workspace package.json depends on @inhuman.tools/mercury", () => {
    const packagesRoot = path.join(monorepoRoot, "arrival/packages");
    const hits: string[] = [];
    for (const pkg of walkFiles(packagesRoot, (p) => p.endsWith("package.json"))) {
      const text = readFileSync(pkg, "utf8");
      if (text.includes('"@inhuman.tools/mercury"')) hits.push(path.relative(monorepoRoot, pkg));
    }
    // also inhuman product that used to depend on it
    for (const rel of ["inhuman/public-packages", "inhuman/saas", "experimental"]) {
      const root = path.join(monorepoRoot, rel);
      for (const pkg of walkFiles(root, (p) => p.endsWith("package.json"))) {
        const text = readFileSync(pkg, "utf8");
        if (text.includes('"@inhuman.tools/mercury"')) hits.push(path.relative(monorepoRoot, pkg));
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
    // The walk is O(monorepo tree) and grows with every added package — it
    // rides the 5s default at ~4s today; give it an honest budget.
  }, 30_000);

  it("OracleSubject is greenfield-only (no legacy dual path)", () => {
    const harness = readFileSync(path.join(packageRoot, "src/oracle/harness.ts"), "utf8");
    expect(harness).not.toMatch(/subject\s*===\s*["']legacy["']/);
    expect(harness).not.toMatch(/projectToJsRaw/);
    expect(harness).toMatch(/export type OracleSubject = "greenfield"/);
  });

  it("type-emit sources never import type-lens (subpath cycle hygiene)", () => {
    const typeEmitDir = path.join(packageRoot, "src/type-emit");
    const files = walkFiles(typeEmitDir, (p) => p.endsWith(".ts"));
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // Live imports only (doc comments may mention the type-lens PRE).
      if (/^import\s.+(arrival-lsp|typefacts\/)/m.test(text)) {
        bad.push(path.relative(packageRoot, f));
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("type-lens service-core imports emitTypes only via /type-emit subpath", () => {
    const serviceCore = path.join(monorepoRoot, "arrival/packages/arrival-lsp/src/service-core.ts");
    // Loud on relocation, per the scan-gate law (TESTING.md §4.2): a missing
    // subject is a failed gate, never a silently vacuous pass.
    expect(existsSync(serviceCore), `gate subject missing: ${serviceCore}`).toBe(true);
    const text = readFileSync(serviceCore, "utf8");
    expect(text).toMatch(/from ["']@inhuman\.tools\/arrival-mercury\/type-emit["']/);
    expect(text).not.toMatch(/from ["']@inhuman\.tools\/mercury/);
  });

  it("mercury takes no arrival-lsp dep — the lsp <-> mercury cycle stays broken", () => {
    // arrival-lsp depends on arrival-mercury/type-emit (the emitter, correct
    // direction). The reverse edge — mercury/typefacts needing the prelude — was
    // cut by extracting the shared type vocabulary into
    // @inhuman.tools/arrival-internals-types-prelude, a leaf both sides depend
    // DOWN on. If mercury ever takes an arrival-lsp dep again the package graph
    // re-cycles; lock both the manifest and the one import site here.
    const pkg = readFileSync(path.join(packageRoot, "package.json"), "utf8");
    expect(pkg).not.toMatch(/"@inhuman\.tools\/arrival-lsp"/);

    const lensProgram = path.join(packageRoot, "src/typefacts/lens-program.ts");
    expect(existsSync(lensProgram), `gate subject missing: ${lensProgram}`).toBe(true);
    const text = readFileSync(lensProgram, "utf8");
    // The `/browser` subpath is the bundled, node-fs-free entry — mercury's
    // typefacts sources the prelude as inlined static data so importing the
    // semantic model never executes `node:fs` (keeps the model/`/product` graph
    // browser-safe). Root `.` (the node-disk loader) is equally valid for the
    // cycle-break; accept either.
    expect(text).toMatch(/from ["']@inhuman\.tools\/arrival-internals-types-prelude(\/browser)?["']/);
    expect(text).not.toMatch(/from ["']@inhuman\.tools\/arrival-lsp["']/);
  });
});

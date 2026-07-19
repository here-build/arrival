/**
 * W9 cut-over gates — lock the migration: no legacy mercury package, no dual
 * oracle subject, type-emit stays free of type-lens (cycle-safe subpath).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { OracleSubject } from "../oracle/harness.js";

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
  });

  it("OracleSubject is greenfield-only (no legacy dual path)", () => {
    const only: OracleSubject = "greenfield";
    expect(only).toBe("greenfield");
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
    if (!existsSync(serviceCore)) return; // optional in partial checkouts
    const text = readFileSync(serviceCore, "utf8");
    expect(text).toMatch(/from ["']@inhuman\.tools\/arrival-mercury\/type-emit["']/);
    expect(text).not.toMatch(/from ["']@inhuman\.tools\/mercury/);
  });
});

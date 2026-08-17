/**
 * Browser-safety gate — the invariant the arrival-mercury-oracle split exists to
 * protect. The compiler's browser-facing entrypoints (`/product`, `/circuit`) are
 * bundled into the studio; they MUST stay free of node-only edges. Two regressions
 * previously broke the studio at load:
 *   - a `tsx/esm/api` edge (the differential-oracle harness, since extracted to
 *     `@inhuman.tools/arrival-mercury-oracle`), whose top-level `register()` reads
 *     `process.versions.node` and throws in a browser;
 *   - a `node:fs` edge (the node-disk prelude loader), since replaced by the
 *     bundled `/browser` prelude in typefacts.
 *
 * This gate walks the RELATIVE import closure of each browser entry inside this
 * package and fails if any reachable module statically imports a forbidden
 * specifier. It is intra-package by design (self-contained, no cross-package
 * resolution): the three regression modes it guards all surface as a forbidden
 * specifier ON a mercury source file — a `tsx`/`node:*` import, an import of the
 * oracle package, or an import of the node-disk prelude root (which must be
 * `/browser`). Workspace deps that are themselves browser-safe (arrival, runner-capability)
 * are intentionally not recursed into.
 *
 * NOT gated: the root barrel (`index.ts`) legitimately re-exports node-side build
 * tooling (`buildProject`) and is not a browser surface — browser consumers import
 * the `/product` and `/circuit` subpaths (+ type-only from the root, which erases).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, ".."); // arrival-mercury/src

/** The subpaths a browser bundle actually imports (see package.json `exports`). */
const BROWSER_ENTRIES = ["product/index.ts", "circuit.ts"];

const FORBIDDEN: { test: (spec: string) => boolean; reason: string }[] = [
  { test: (s) => s === "tsx" || s.startsWith("tsx/"), reason: "tsx (differential-oracle runtime — belongs in arrival-mercury-oracle)" },
  { test: (s) => s.startsWith("node:"), reason: "a node: builtin (browser-poison)" },
  { test: (s) => s === "@inhuman.tools/arrival-mercury-oracle" || s.startsWith("@inhuman.tools/arrival-mercury-oracle/"), reason: "the oracle package (would re-introduce tsx + the package cycle)" },
  { test: (s) => s === "@inhuman.tools/arrival-internals-types-prelude", reason: "the node-disk prelude root (import the bundled `/browser` entry instead)" },
];

/** All `from "…"` specifiers in a module (import + re-export). */
function specifiersOf(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(m[1]);
  // bare side-effect imports: `import "x"`
  const bare = /\bimport\s*["']([^"']+)["']/g;
  for (let m = bare.exec(src); m !== null; m = bare.exec(src)) out.push(m[1]);
  return out;
}

/** BFS over RELATIVE imports (`.js` → `.ts`) inside this package from `entry`. */
function relativeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.join(srcRoot, entry)];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue; // a directory index resolved elsewhere, or a .d.ts — skip
    }
    for (const spec of specifiersOf(src)) {
      if (spec.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
  }
  return seen;
}

describe("browser-safety — the compiler's browser entrypoints carry no node-only edges", () => {
  for (const entry of BROWSER_ENTRIES) {
    it(`\`${entry}\` closure is free of tsx / node: / oracle / node-prelude edges`, () => {
      const violations: string[] = [];
      for (const file of relativeClosure(entry)) {
        let src: string;
        try {
          src = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        for (const spec of specifiersOf(src)) {
          const hit = FORBIDDEN.find((f) => f.test(spec));
          if (hit) violations.push(`${path.relative(srcRoot, file)}  →  "${spec}"  (${hit.reason})`);
        }
      }
      expect(violations, `browser-poison edges reachable from ${entry}:\n${violations.join("\n")}`).toEqual([]);
    });
  }
});

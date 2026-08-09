/**
 * Dependencies for a greenfield-emitted TS project (loose compile).
 * Scans printed source for known import modules the materializer can emit.
 */
import { RAMDA_MODULE } from "../runtime/runtime-manifest.js";

/** Pinned versions for modules the compiler may import into user projects. */
export const EMITTED_DEP_VERSIONS: Readonly<Record<string, string>> = {
  [RAMDA_MODULE]: "0.31.3",
};

export interface EmittedFileLike {
  readonly path: string;
  readonly content: string;
}

/** Detect npm packages referenced by `from "…"` in emitted TypeScript. */
export function collectEmittedDependencies(files: readonly EmittedFileLike[]): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const f of files) {
    for (const m of f.content.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
      // bare package or package/subpath
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      const ver = EMITTED_DEP_VERSIONS[pkg];
      if (ver !== undefined) deps[pkg] = ver;
    }
  }
  return deps;
}

export interface EmittedPackageJsonOptions {
  readonly name?: string;
  readonly private?: boolean;
}

/** Minimal package.json for `inhuman build` / compile output trees. */
export function emittedPackageJson(files: readonly EmittedFileLike[], opts: EmittedPackageJsonOptions = {}): string {
  const dependencies = collectEmittedDependencies(files);
  const body: Record<string, unknown> = {
    name: opts.name ?? "arrival-compiled",
    private: opts.private ?? true,
    type: "module",
  };
  if (Object.keys(dependencies).length > 0) body.dependencies = dependencies;
  return `${JSON.stringify(body, null, 2)}\n`;
}

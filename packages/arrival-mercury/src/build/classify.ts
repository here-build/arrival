/**
 * The pluggable file-classification seam (TASK #87, design doc §3): ONE
 * explicit function decides, per file, whether it emits as a PIPELINE
 * (thunked, parameterized `export default`), an ordinary MODULE (named
 * exports), or DATA (const-struct default) — replacing v0's in-line
 * "DAG-root + program-face" shape-detector in `project.ts`.
 *
 * V's ruling: that detector is fuzzy BY CONSTRUCTION — reusing one pipeline
 * as a dependency of another silently DEMOTES it to a module the instant
 * something else requires it, because "is this a DAG root" is a fact about
 * the WHOLE project's require graph, not a decision the file's own author
 * ever gets to make. The fix isn't a smarter detector; it's making
 * classification an EXPLICIT SEAM a project configures, with the SAME
 * derivation shipping as the default so nothing regresses today.
 *
 * `defaultClassifier` (below) reproduces v0's exact judgment — it is simply
 * now a plain VALUE of type {@link ClassifyFile}, built ONCE from precomputed
 * project facts, instead of hardcoded control flow inside `project.ts`'s main
 * loop. `pipelinesDirClassifier` is the proof the seam is real: an
 * ALTERNATIVE policy — the design doc's own originally-envisioned
 * `@/pipelines/*` convention (§3: "v0, V's programmatic rule" — never
 * actually shipped in v0 because "the acceptance project has no pipelines/
 * dir", eb77f510d3's own report) — that classifies by PATH alone, so a
 * pipeline stays a pipeline no matter who requires it.
 *
 * A project selects a policy via `inhuman.config.json`'s `build.classifier`
 * (`inhuman/public-packages/inhuman/src/config.ts`); `build.ts` resolves the
 * name to a `ClassifyFile` value and passes it through to `buildProject`.
 */
import { DATA_EXTENSIONS } from "./data-module.js";

export type FileClass = "pipeline" | "module" | "data";

/**
 * `relPath` is the project-relative path (POSIX-joined, no leading `/` —
 * `project.ts`'s own convention throughout). `absPath` is that SAME path
 * anchored at the project root with a leading `/` — `project.ts`'s own
 * `resolveSpecifier` already treats a leading `/` as "root-relative" for
 * require specifiers; this reuses that exact vocabulary rather than
 * inventing a second notion of "absolute". It is NEVER a real OS path:
 * `buildProject` stays pure, no filesystem access of its own (project.ts's
 * header). Most naming-convention policies only need `relPath`; `absPath`
 * exists for a policy that wants an unambiguous, root-anchored form to glob
 * or prefix-match against.
 */
export type ClassifyFile = (relPath: string, absPath: string) => FileClass;

function extOf(relPath: string): string {
  const i = relPath.lastIndexOf(".");
  return i < 0 ? "" : relPath.slice(i);
}

/**
 * v0's shipped default (design doc §3): a `.scm` file classifies as a
 * pipeline iff it is BOTH a require-DAG root (nothing else requires it) AND
 * ends in a genuine trailing program-face expression; every other `.scm`
 * file is an ordinary module; a data extension is always data — the EXACT
 * judgment `project.ts`'s old inline `isPipeline` computed, now a value
 * instead of control flow. Built ONCE per build from precomputed project
 * facts (`requiredBy`/`hasProgramFaceOf` — whole-project information a
 * per-file policy structurally cannot see on its own), so each
 * `classifyFile` call afterward is an O(1) lookup, not a re-derivation.
 */
export function defaultClassifier(requiredBy: ReadonlySet<string>, hasProgramFaceOf: ReadonlyMap<string, boolean>): ClassifyFile {
  return (relPath: string): FileClass => {
    const ext = extOf(relPath);
    if (DATA_EXTENSIONS.has(ext)) return "data";
    const isRoot = !requiredBy.has(relPath);
    const hasFace = hasProgramFaceOf.get(relPath) ?? false;
    return isRoot && hasFace ? "pipeline" : "module";
  };
}

/**
 * The proof-of-concept ALTERNATIVE policy: any file under a top-level
 * `pipelines/` directory is a pipeline, REGARDLESS of its require-DAG
 * position — the exact case the derivable default gets wrong (requiring a
 * pipeline from another pipeline silently demotes it to a module, since it's
 * no longer a DAG root). A data extension is still data; everything else —
 * including a `.scm` DAG root OUTSIDE `pipelines/` — is an ordinary module:
 * this policy REPLACES the default's derivation entirely rather than
 * layering on top of it, so a project opting in owns its own `pipelines/`
 * layout fully.
 */
export function pipelinesDirClassifier(): ClassifyFile {
  return (relPath: string): FileClass => {
    const ext = extOf(relPath);
    if (DATA_EXTENSIONS.has(ext)) return "data";
    return relPath === "pipelines" || relPath.startsWith("pipelines/") ? "pipeline" : "module";
  };
}

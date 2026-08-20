/**
 * Product single-file compile — organ 1 first.
 *
 * Always constructs a named {@link SchemeSemanticModel}, then materializes via
 * the same module-face path as `buildProject` / `compileScmModule`. Callers
 * that need multi-file use `buildProject`; this is the glass / single-buffer
 * entry (studio, REPL preview, tools).
 *
 * Does not open a second pipeline — greenfield Residual → ts.factory only.
 * Either `registry` (already harvested) or `capabilities` (mint a session and
 * harvest) is required — mercury does not default a product plane.
 */
import type { EnvCapability } from "@inhuman.tools/arrival";

import type { EmitRegistry } from "../registry/index.js";
import { greenfieldRegistryFor, openOracleSession } from "../registry/greenfield-session.js";
import { SchemeSemanticModel } from "../model/model.js";
import { compileScmModule } from "../build/scm-module.js";
import type { RequireResolution } from "../build/types.js";

export type CompileRegister = "read" | "run";

export interface CompileSourceOptions {
  /**
   * Run register (default): executable async plane. Read register: glass
   * (legibility); walk still receives the flag where supported.
   * Today module-face materialization uses `"run"`; the option is reserved for
   * the materializer wiring that already threads `register` on oracle wrap.
   */
  register?: CompileRegister;
  /** Pre-harvested emit registry. Skips session assembly. Wins over `capabilities`. */
  registry?: EmitRegistry;
  /** Host vocabulary used to mint a session and harvest the registry. Required when `registry` is omitted. */
  capabilities?: readonly EnvCapability[];
  /** Runtime import path emitted for stage-0 / cold stdlib. Default `./stage0.js`. */
  runtimeImportPath?: string;
}

export interface CompileSourceResult {
  /** Emitted TypeScript module text (ts.factory printer). */
  readonly code: string;
  /**
   * The semantic model used for this compile — organ 1, named and retained so
   * product code cannot treat compile as an anonymous black box.
   * Note: `compileScmModule` constructs its own model today; this field holds
   * an equivalent model over the same source+registry for introspection
   * (factsAt, importsOf, …) without re-parsing twice for the common case.
   */
  readonly model: SchemeSemanticModel;
}

/**
 * Compile one scheme source string to a TypeScript module.
 * Always materializes through {@link SchemeSemanticModel}.
 */
export async function compileSource(source: string, opts: CompileSourceOptions): Promise<CompileSourceResult> {
  const runtimeImportPath = opts.runtimeImportPath ?? "./stage0.js";

  if (opts.registry !== undefined) {
    return compileWithRegistry(source, opts.registry, runtimeImportPath);
  }

  if (opts.capabilities === undefined) {
    throw new Error(
      "compileSource: pass `registry` (pre-harvested) or `capabilities` (host vocabulary) — mercury does not default a product plane",
    );
  }

  // Assemble a session over the host vocabulary and harvest its registry.
  // `greenfield-session` is tsx-free (unlike the oracle harness), so this stays a
  // static import and the module remains browser-safe. A browser caller injects a
  // `registry` via the branch above instead of minting a session here.
  const session = await openOracleSession(opts.capabilities);
  try {
    return compileWithRegistry(source, greenfieldRegistryFor(session), runtimeImportPath);
  } finally {
    await session.dispose();
  }
}

function compileWithRegistry(source: string, registry: EmitRegistry, runtimeImportPath: string): CompileSourceResult {
  // Organ 1 — constructed by name, never buried inside an anonymous pipeline().
  const model = new SchemeSemanticModel(source, registry);

  const resolveRequire = (specifier: string): RequireResolution => ({
    kind: "unresolved",
    code: "build/unresolved-require",
    reason: ` — compileSource is single-file; (require "${specifier}") is not resolved here (use buildProject for multi-file)`,
  });

  // compileScmModule constructs its own SchemeSemanticModel over the same
  // source+registry for the walk — same organ, same inputs. We keep `model`
  // as the caller's introspection handle (views over the source as compiled).
  const { content } = compileScmModule(
    source,
    { baseRegistry: registry },
    {
      path: "<compileSource>",
      resolveRequire,
      runtimeImportPath,
      isPipeline: false,
    },
  );

  return { code: content, model };
}

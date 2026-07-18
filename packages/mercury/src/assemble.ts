/**
 * The pure, format-free core of the projection: parse → plan imports → lower → join.
 * No eslint, no prettier — so it is browser-safe and can be wrapped by either the
 * Node formatter (`project.ts`) or the browser formatter (`browser.ts`).
 */
import { parseSexprs } from "@inhuman.tools/arrival-sugarcoat";

import { computeAsyncNames, inferPrimitives } from "./async-analysis.js";
import { desugar } from "./desugar.js";
import { collectImports, type ProjectOptions } from "./imports.js";
import { makeLowerer } from "./lower.js";
import { resolveNames } from "./scheme-scope.js";
import { DEFAULT_STRATEGY, hasOpinion, type Strategy } from "./strategy/index.js";
import { inferTypes } from "./type-infer.js";

/** `runtime/invariant.ts`'s content, inlined per emitted module while the module
 *  map's `runtime/` grouping is still partial (`layout/module-map`) — a `function`
 *  declaration, because TS assertion signatures require an explicitly-typed
 *  callee. Emitted only when a precondition actually fired. */
const INVARIANT_DECL = `function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}`;

/** Parse → plan imports → lower body → join into one (unformatted) JS module string. */
export function assemble(source: string, opts: ProjectOptions = {}): string {
  const forest = desugar(parseSexprs(source));
  const { importLines, requireSubst, skipForms } = collectImports(forest, opts);
  const target = opts.target ?? "read";
  // The strategy record is the run-view's own booleans, absorbed: `strategy !==
  // undefined` IS "are we in run-view" from here down — lower.ts/stdlib.ts read
  // presence of the record instead of comparing the raw `target` string (design
  // doc §7 deletion list: "scattered ctx.target === 'run' booleans → strategy-
  // record reads"). The read-view applies no strategy — it emits no runtime calls.
  const strategy: Strategy | undefined = target === "run" ? (opts.strategy ?? DEFAULT_STRATEGY) : undefined;
  const inferReqs = strategy === undefined ? new Set<string>() : inferPrimitives(forest);
  const asyncNames = strategy === undefined ? new Set<string>() : computeAsyncNames(forest, inferReqs);
  // Scope-aware names: collision-free → every binding is its cleanName (output unchanged).
  const nameOf = resolveNames(forest, []);
  // The type-analysis plane (types/explicit-signatures · types/domain-interfaces ·
  // types/schema-zod · invariants/preconditions) — run-view only; the read-view
  // glass stays a plain, sync, annotation-free projection.
  const types =
    strategy !== undefined && hasOpinion(strategy, "types/explicit-signatures") ? inferTypes(forest) : undefined;
  const lowerer = makeLowerer({ requireSubst, strategy, types, asyncNames, inferReqs, nameOf });
  const body = forest.filter((f) => !skipForms.has(f)).map((f) => lowerer.lowerTop(f));
  // ts-vercel-ai rt/* imports (rt/plain-infer · rt/chat-messages · rt/structured-
  // output · rt/client-module) — real imports, not the bare-global placeholder
  // pre-registry read-view still emits (design doc §3: "when W4 lands real
  // imports, the ambient [test] file shrinks away").
  const vercel = lowerer.usedVercelRuntime();
  const vercelAiNames = [...vercel.ai, ...(vercel.modelMessage ? ["type ModelMessage"] : [])];
  // ts-langchain rt/* imports (rt/plain-infer · rt/chat-messages · rt/structured-
  // output · rt/client-module) — W5, the same real-imports move as ts-vercel-ai
  // above, symmetric wiring.
  const langchain = lowerer.usedLangchainRuntime();
  const imports = [
    ...(types?.usesZod ? [`import { z } from "zod";`] : []),
    ...(vercelAiNames.length > 0 ? [`import { ${vercelAiNames.join(", ")} } from "ai";`] : []),
    ...(langchain.messageClasses.length > 0
      ? [`import { ${langchain.messageClasses.join(", ")} } from "@langchain/core/messages";`]
      : []),
    ...importLines,
    ...(vercel.models || langchain.models ? [`import { models } from "./runtime/llm.js";`] : []),
  ];
  const decls = [...(lowerer.usedInvariant() ? [INVARIANT_DECL] : []), ...(types?.declarations ?? [])];
  return [imports.join("\n"), ...decls, body.join("\n\n")].filter((s) => s.length > 0).join("\n\n");
}

export { type ProjectOptions } from "./imports.js";

/**
 * Project assembly — the end-to-end step. Given a flat map of source files (the
 * `.scm` program + spilled `.scm` modules + `.prompt` files + data), an entry, and
 * a `prompts` backend, emit a complete, self-contained, runnable TS directory.
 *
 * Stage 1 is TS-only (the Python emitter + language axis were deleted the same
 * wave — see the dual-runtime design doc §7): JS imports the ORIGINAL specifiers
 * (`./metric.scm`, `./predict.prompt`, `./seed.txt`), so assembly rewrites them to
 * the emitted filenames, turns the `.txt`/`.json` imports into real loads, and adds
 * `export { … }` to spilled modules (a bare `const` isn't importable). It's a
 * tsx-runnable TS project.
 *
 * Wraps the entry's trailing expression in a print, so the program's result (the
 * GEPA-optimized candidate) actually reaches stdout.
 */
import { parseSexprs } from "@inhuman.tools/arrival-sugarcoat";

import { cleanName } from "./names.js";
import { head, isAtom, isList, type Node } from "./nodes.js";
import { projectToJs } from "./project.js";
import { getPromptBackend, type PromptBackend } from "./prompt.js";
import { DEFAULT_STRATEGY, type Strategy } from "./strategy/index.js";

export interface CompileTarget {
  /** The writing strategy (design doc §2) — resolves BOTH the runtime axis
   *  `(infer …)` lowers to (landed for `ts-vercel-ai` in W4; `ts-langchain`'s own
   *  `rt/*` fill is W5 — until then it keeps emitting the pre-registry bare-
   *  identifier placeholder) and which `.prompt` backend compiles the templates
   *  (`PROMPT_BACKEND_FOR_STRATEGY` below). Defaults to `DEFAULT_STRATEGY`
   *  (`ts-langchain`) — so omitting `strategy` reproduces byte-identical output to
   *  the pre-registry `{ prompts: "langchain-js" }` shape (the characterization
   *  gate proves it). */
  strategy?: Strategy;
}

/** Which `.prompt` backend a strategy's `.prompt` files compile through — one
 *  landed per strategy as of W4 (`langchain-js` W1-era, `vercel-ai` this wave). */
const PROMPT_BACKEND_FOR_STRATEGY: Partial<Record<Strategy["id"], PromptBackend["id"]>> = {
  "ts-langchain": "langchain-js",
  "ts-vercel-ai": "vercel-ai",
};

export interface EmittedFile {
  path: string;
  content: string;
}

// Real registry versions (resolved via `npm view … dist-tags.latest`, 2026-06-06;
// ai/@ai-sdk/openai-compatible added 2026-07-10, matching the pins already used by
// foundations/llm-plane/llm-plane-backends and second-foundation/arrival-chain) — a
// generated runnable project pins its deps rather than floating "latest" to newest-on-
// install (the supply-chain posture in .claude/rules/npm-version-pinning.md). Bump
// deliberately; verify on the registry first.
const DEP_VERSIONS: Record<string, string> = {
  "@langchain/core": "^1.1.48",
  "@langchain/openai": "^1.4.7",
  "@ai-sdk/openai-compatible": "^2.0.48", // rt/client-module — the ts-vercel-ai models registry's provider
  ai: "^6.0.201", // generateText/generateObject — rt/plain-infer · rt/chat-messages · rt/structured-output
  tsx: "^4.22.4",
  typescript: "^6.0.3",
  zod: "^4.3.6", // types/schema-zod — the emitted schema constants' runtime
};
const dep = (name: string): Record<string, string> => ({ [name]: DEP_VERSIONS[name]! });

/** Runtime dependencies pinned into the emitted project's package.json, keyed by
 *  prompt backend — each backend's client module (`_llm.ts` / `runtime/llm.ts`)
 *  needs its own deps. */
const PROMPT_DEPS: Record<PromptBackend["id"], Record<string, string>> = {
  "langchain-js": { ...dep("@langchain/core"), ...dep("@langchain/openai") },
  "vercel-ai": { ...dep("ai"), ...dep("@ai-sdk/openai-compatible") },
};

const base = (p: string): string => p.split("/").pop() ?? p;
const extOf = (p: string): string => /\.([^.]+)$/.exec(p)?.[1] ?? "";
const stemOf = (p: string): string => base(p).replace(/\.[^.]+$/, "");

/** Cleaned (JS) top-level `define` names of a scheme source — the spill/export set. */
function topLevelDefineNames(src: string): string[] {
  const out: string[] = [];
  for (const form of parseSexprs(src) as Node[]) {
    if (isList(form) && head(form) === "define") {
      const sig = form.list[1];
      if (isList(sig) && isAtom(sig.list[0])) out.push(cleanName(sig.list[0].atom));
      else if (isAtom(sig)) out.push(cleanName(sig.atom));
    }
  }
  return out;
}

/** Rewrite a JS module's require-derived imports to runnable forms. */
function rewriteJsImports(code: string): string {
  let needsReadText = false;
  let body = code.replaceAll(
    /^import (.+) from "(\.\/[^"]+)";$/gm,
    (full: string, what: string, spec: string): string => {
      switch (extOf(spec)) {
        case "scm":
          return `import ${what} from "${spec.replace(/\.scm$/, ".js")}";`;
        case "prompt":
          return `import ${what} from "${spec.replace(/\.prompt$/, ".js")}";`; // ./predict.prompt → ./predict.js, same clean swap as .scm
        case "json":
          return `import ${what} from "${spec}" with { type: "json" };`;
        case "txt":
          needsReadText = true;
          return `const ${what} = __readText(new URL("${spec}", import.meta.url), "utf8");`;
        default:
          return full;
      }
    },
  );
  if (needsReadText) body = `import { readFileSync as __readText } from "node:fs";\n${body}`;
  return body;
}

const isComment = (l: string): boolean => l.trimStart().startsWith("//");

/** Wrap the entry module's trailing expression so its value is printed. */
function printEntryResult(code: string): string {
  const lines = code.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && (lines[i]!.trim() === "" || isComment(lines[i]!))) i--;
  if (i < 0) return code;
  const expr = lines[i]!.trim().replace(/;$/, "");
  lines[i] =
    `const __result = ${expr};\nconsole.log(typeof __result === "string" ? __result : JSON.stringify(__result, null, 2));`;
  return lines.join("\n");
}

function manifest(backendId: PromptBackend["id"], entryStem: string, extraDeps: Record<string, string>): EmittedFile {
  const pkg = {
    name: `entry-${entryStem}`,
    private: true,
    type: "module",
    scripts: { start: `tsx ${entryStem}.ts` },
    dependencies: { ...PROMPT_DEPS[backendId], ...extraDeps },
    devDependencies: { ...dep("tsx"), ...dep("typescript") },
  };
  return { path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n` };
}

/**
 * Assemble a runnable TS project. `files` is a flat filename→source map (the
 * `requireSource` injection point); `entry` is the program `.scm`. Returns the
 * files to write — pure, no fs.
 */
export async function compileProject(
  files: Record<string, string>,
  entry: string,
  target: CompileTarget = {},
): Promise<EmittedFile[]> {
  const strategy = target.strategy ?? DEFAULT_STRATEGY;
  const backendId = PROMPT_BACKEND_FOR_STRATEGY[strategy.id];
  if (backendId === undefined) {
    throw new Error(
      `inhuman: strategy "${strategy.id}" has no prompt backend yet (lands in a later wave) — use "ts-langchain"`,
    );
  }
  const backend = getPromptBackend(backendId);
  const requireSource = (p: string): string | undefined => files[base(p)];
  const out: EmittedFile[] = [];

  // `.scm` and `.prompt` sources are named independently (each a clean stem-based
  // rename — no defensive suffix baked in for the common case, see prompt.ts).
  // Two DIFFERENT sources sharing a stem (`predict.scm` + `predict.prompt`) would
  // otherwise silently overwrite one output with the other; track provenance and
  // reject that loudly instead.
  const emittedBy = new Map<string, string>();
  const push = (path: string, content: string, source: string): void => {
    const prior = emittedBy.get(path);
    if (prior !== undefined && prior !== source) {
      throw new Error(`inhuman: "${source}" and "${prior}" both compile to "${path}" — rename one`);
    }
    emittedBy.set(path, source);
    out.push({ path, content });
  };

  const scmFiles = Object.keys(files).filter((f) => extOf(f) === "scm");
  const promptFiles = Object.keys(files).filter((f) => extOf(f) === "prompt");
  const dataFiles = Object.keys(files).filter((f) => !["scm", "prompt"].includes(extOf(f)));

  for (const f of scmFiles) {
    const isEntry = f === entry;
    // The entry script is named `main` — nothing imports it, and a neutral name
    // dodges collisions where the program's own filename shadows an installed
    // package.
    let code = rewriteJsImports(await projectToJs(files[f]!, { requireSource, target: "run", strategy }));
    if (isEntry) code = printEntryResult(code);
    else {
      const names = topLevelDefineNames(files[f]!);
      if (names.length > 0) code += `\nexport { ${names.join(", ")} };\n`;
    }
    push(`${isEntry ? "main" : cleanName(stemOf(f))}.ts`, code, f);
  }

  for (const f of promptFiles) {
    const m = await backend.compile(files[f]!, stemOf(f));
    push(m.filename, m.code, f);
  }

  const client = backend.client();
  push(client.filename, client.code, "(backend client)");

  for (const f of dataFiles) push(base(f), files[f]!, f);

  // types/schema-zod: a module that materialized an s/* contract imports zod —
  // pin it into the emitted manifest exactly when some emitted module does.
  const usesZod = out.some((f) => f.path.endsWith(".ts") && f.content.includes(`from "zod"`));
  out.push(manifest(backendId, "main", usesZod ? dep("zod") : {}));
  return out;
}

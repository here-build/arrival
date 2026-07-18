/**
 * Execute the mercury run-view TS artifact FOR REAL, via `tsx` — a genuine child
 * process running the emitted code, not a vitest-internal transform — matching the
 * design doc's agreement law ("compiled-output semantics ≡ `runProgram` results").
 *
 * The corpus is single-file (no `(require …)`), so this compiles ONE program
 * straight from `projectToJs`, wraps its trailing expression in a `console.log
 * (JSON.stringify(…))` (the same move `compile-project.ts::printEntryResult` makes
 * for a real emitted project — that function isn't exported and this harness has no
 * multi-file assembly to do, so it's a small reimplementation, not an import),
 * prepends the echo-infer shim as global bindings, writes the result to a scratch
 * file next to this module (a stable relative import path back to `../support/`),
 * and shells out to `tsx`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectToJs } from "../../../project.js";
import type { Strategy } from "../../../strategy/index.js";

const tmpDir = fileURLToPath(new URL("../.tmp/", import.meta.url));
const pkgRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Resolve `tsx`'s own CLI entry point by absolute path (never a bare `"npx"`/`"tsx"`
 *  PATH lookup — `tsx` is a real pinned devDependency of this package now, so this
 *  resolves deterministically through node's own module resolution). */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("tsx/package.json");
  const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsx;
  if (!bin) throw new Error("resolveTsxCli: tsx's package.json has no `bin` entry");
  return path.join(path.dirname(pkgJsonPath), bin);
}

const isBlankOrComment = (l: string): boolean => l.trim() === "" || l.trimStart().startsWith("//");

/**
 * Wrap the LAST non-blank/non-comment top-level line's expression so its value
 * prints as JSON — the read side of the compare. Mirrors `compile-project.ts::
 * printEntryResult`'s approach (private to that module; reimplemented here since
 * this harness compiles single files, not an assembled project).
 */
function printResult(code: string): string {
  const lines = code.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && isBlankOrComment(lines[i]!)) i--;
  if (i < 0) throw new Error("printResult: no trailing expression found in compiled output");
  const expr = lines[i]!.trim().replace(/;$/, "");
  lines[i] = `const __result = ${expr};\nconsole.log(JSON.stringify(__result ?? null));`;
  return lines.join("\n");
}

/**
 * The infer-family globals every emitted "run" module calls as BARE identifiers —
 * W4's runtime-strategy modules (`runtime/llm.ts`) haven't landed, so the verbs
 * stay unqualified. Since W3's `infer/scalar-fold`, the compiled contract is
 * SCALAR-returning and awaited: `(car (infer "m" p))` compiles to
 * `await infer("m", p)` (the interpreter-side `inferList` wrapper is plumbing the
 * fold dissolves), and a non-`car`'d call materializes as `[await infer(…)]`.
 * The shim returns the bare oracle value accordingly — synchronous is fine
 * (`await` on a non-Promise resolves to itself). A schema argument arrives as
 * the emitted zod schema constant (`types/schema-zod`); `normalizeSchema`
 * mirrors it back onto the interpreter's wire string.
 *
 * Mirrors `canonicalizeMessages`/`schemaSlot` and the `infer/chat/*` prelude
 * (`llm-plane-arrival-env/src/infer.ts`), over the shared oracle in
 * `echo-infer.ts` so compiled and interpreted runs consult ONE function.
 */
// Plain JS on purpose (no type annotations, no `as`/cast anywhere): this string is
// never type-checked (the scratch dir is excluded from tsconfig.test.json — it's
// generated, not authored) and only ever runs through `tsx`'s type-ERASING loader,
// so typed `globalThis` augmentation would be pure ceremony here.
const SHIM_PREAMBLE = `import { canonicalizeMessages, echoInferValue, normalizeSchema } from "../support/echo-infer.js";

globalThis.infer = (model, prompt, schema) => echoInferValue(model, prompt, normalizeSchema(schema));
globalThis.inferChat = (model, messages, schema) =>
  echoInferValue(model, canonicalizeMessages(messages), normalizeSchema(schema));
globalThis.inferChatSystem = (content) => ["system", content];
globalThis.inferChatUser = (content) => ["user", content];
globalThis.inferChatAssistant = (content) => ["assistant", content];
`;

let counter = 0;

/**
 * Per-strategy import-specifier substitutions: rewrite the real import specifiers
 * a strategy's artifact carries (the runtime package + `./runtime/llm.js`) to the
 * deterministic execution-time test double (`<strategy>-shim.ts` — see
 * `vercel-shim.ts`'s / `langchain-shim.ts`'s doc comments for the pattern's
 * rationale). A pure text substitution of the SCRATCH copy only; `projectToJs`'s
 * own output (what `strict-emit.test.ts` typechecks) is never touched.
 * Exact-match on the closing `from "...";` so an entry can't accidentally
 * rewrite an unrelated specifier (`@ai-sdk/*`, a real relative require) that
 * merely contains its package name. Both strategies emit real runtime imports as
 * of W4 (`ts-vercel-ai`) / W5 (`ts-langchain`) — every `STRATEGY_IDS` entry has a
 * substitution table now; `SHIM_PREAMBLE`'s bare-identifier globals below are
 * dead weight kept only as a defensive no-op (harmless if a future strategy
 * temporarily reverts to the pre-registry placeholder).
 */
const SHIM_SUBSTITUTIONS: Partial<Record<Strategy["id"], readonly (readonly [from: string, to: string])[]>> = {
  "ts-vercel-ai": [
    ['from "ai";', 'from "../support/vercel-shim.js";'],
    ['from "./runtime/llm.js";', 'from "../support/vercel-shim.js";'],
  ],
  "ts-langchain": [
    ['from "@langchain/core/messages";', 'from "../support/langchain-shim.js";'],
    ['from "./runtime/llm.js";', 'from "../support/langchain-shim.js";'],
  ],
};

function substituteShim(code: string, strategy: Strategy | undefined): string {
  const subs = strategy === undefined ? undefined : SHIM_SUBSTITUTIONS[strategy.id];
  if (subs === undefined) return code;
  let out = code;
  for (const [from, to] of subs) out = out.replaceAll(from, to);
  return out;
}

/**
 * Compile `source` (run-view, under `strategy` — defaults to `DEFAULT_STRATEGY`,
 * i.e. ts-langchain, matching every pre-W4 call site) and execute it for real via
 * `tsx`, returning the JSON-round-tripped trailing-expression value. Throws —
 * loudly, never a silent skip — if `tsx` isn't reachable or the process exits
 * non-zero; per the tests rule, a conformance row that can't actually execute must
 * fail red, not pass green on an empty comparison.
 */
export async function runCompiled(source: string, label: string, strategy?: Strategy): Promise<unknown> {
  mkdirSync(tmpDir, { recursive: true });
  const raw = await projectToJs(source, { target: "run", strategy });
  const withPrint = substituteShim(printResult(raw), strategy);
  const file = `${tmpDir}${label}-${counter++}.run.ts`;
  writeFileSync(file, `${SHIM_PREAMBLE}\n${withPrint}\n`, "utf8");
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [resolveTsxCli(), file], {
      cwd: pkgRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `runCompiled(${label}): tsx execution failed\n--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? e.message ?? String(error)}`,
    );
  }
  return JSON.parse(stdout.trim());
}

/** Best-effort cleanup of the scratch directory — not load-bearing (tsconfig.test.
 *  json excludes it from typecheck, and `.gitignore` excludes it from git), but a
 *  clean run leaves no litter. */
export function cleanupCompiledTmp(): void {
  rmSync(tmpDir, { recursive: true, force: true });
}

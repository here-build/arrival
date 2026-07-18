/**
 * The strict gate (design doc R7), forward-verification half — `ts-langchain`'s
 * `rt/*` runtime emitter (`rt-langchain.ts`) is not yet wired into the shared
 * lowering core (see that file's doc comment + the W5 report), so this suite
 * cannot run the existing `.scm` corpus through the real compiler the way
 * `strict-emit.test.ts` does for the bare-identifier baseline. Instead it
 * HAND-ASSEMBLES the artifact each corpus row WOULD emit once wired — module
 * scaffolding (imports, types, the `runtime/llm.ts` / `runtime/mcp.ts` client
 * modules) plus the exact expression `rt-langchain.ts`'s OWN functions produce
 * for that row's `(infer …)` call — and typechecks the result under
 * `tsc --strict`, standalone, exactly like the real gate will once wired.
 *
 * The ambient module declarations below stand in for `@langchain/core`,
 * `@langchain/openai`, `@langchain/mcp-adapters`, `@langchain/langgraph/prebuilt`
 * (none are installed as a devDependency of this package — the emitted PROJECT
 * depends on them, not the compiler, matching the existing split in
 * compile-project.ts's own DEP_VERSIONS table) — shaped from the pinned versions' actual public surface
 * (`ChatOpenAI.invoke`/`.withStructuredOutput`, `BaseMessage` subclasses,
 * `MultiServerMCPClient.getTools`, `createReactAgent`), re-verify against the
 * real package types the day this suite's artifacts are wired into the corpus
 * for real (same "re-verify against the pinned registry versions at
 * implementation time" rule the design doc states for every `rt/*` API name).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import {
  agenticLoop,
  chatMessageCtor,
  chatMessages,
  langchainRuntimeLlmModule,
  mcpClientModule,
  messageTextHelper,
  plainInfer,
  structuredOutput,
} from "../../rt-langchain.js";

const tmpDir = fileURLToPath(new URL(".tmp-strict-langchain/", import.meta.url));

/** The harness contract standing in for the real `@langchain/*` packages — see
 *  the file doc for why an ambient module, not an installed dependency. Deliberately
 *  NOT a module itself (no top-level import/export): a `declare module "specifier"`
 *  block only behaves as a GLOBAL ambient module declaration — satisfying
 *  `import … from "@langchain/openai"` with no real package installed — when the
 *  containing file is a plain SCRIPT; add an `export {}` (as the sibling
 *  `strict-emit.test.ts::AMBIENT` correctly does for its `declare global` case) and
 *  tsc instead treats each block as a LOCAL AUGMENTATION of an already-resolvable
 *  module, which fails to resolve with nothing installed — confirmed empirically
 *  against this package's pinned `typescript@6.0.2` before relying on it here. The
 *  bare \`declare const process\` below is the same reasoning applied to Node's
 *  ambient global (no \`@types/node\` dependency added just for this harness). */
const AMBIENT = `declare const process: { env: Record<string, string | undefined> };

declare module "@langchain/core/messages" {
  export class BaseMessage {
    content: unknown;
    constructor(content: string);
  }
  export class HumanMessage extends BaseMessage {}
  export class SystemMessage extends BaseMessage {}
  export class AIMessage extends BaseMessage {}
}

declare module "@langchain/openai" {
  import type { BaseMessage } from "@langchain/core/messages";
  export class ChatOpenAI {
    constructor(config: { model: string; apiKey?: string; configuration?: { baseURL?: string } });
    invoke(input: string | readonly BaseMessage[]): Promise<{ text: string; content: unknown }>;
    withStructuredOutput<T>(
      schema: import("zod").ZodType<T>,
    ): { invoke(input: string | readonly BaseMessage[]): Promise<T> };
  }
}

declare module "@langchain/mcp-adapters" {
  export class MultiServerMCPClient {
    constructor(servers: Record<string, Record<string, unknown>>);
    getTools(): Promise<unknown[]>;
  }
}

declare module "@langchain/langgraph/prebuilt" {
  import type { BaseMessage } from "@langchain/core/messages";
  export function createReactAgent(config: { llm: unknown; tools: unknown }): {
    invoke(input: { messages: readonly BaseMessage[] }): Promise<{ messages: BaseMessage[] }>;
  };
}
`;

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  skipLibCheck: true,
};

/** All pre-emit diagnostics across every file in `files`, rendered `file:line:col message`. */
function strictDiagnostics(files: readonly string[]): string[] {
  const program = ts.createProgram(files, OPTIONS);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${path.basename(d.file.fileName)}:${line + 1}:${character + 1} ${msg}`;
    }
    return msg;
  });
}

interface Row {
  name: string;
  /** Extra source files this row needs beyond the ambient contract (e.g. the
   *  `runtime/llm.ts` client module every row imports `models` from). */
  files: Record<string, string>;
}

const llm = langchainRuntimeLlmModule();

const ROWS: readonly Row[] = [
  {
    // mirrors corpus/infer-plain.scm — design doc §5 Shape A (bare-string
    // invoke — no HumanMessage import needed, see plainInfer's doc).
    name: "infer-plain.scm's shape, hand-assembled",
    files: {
      [llm.filename]: llm.code,
      "infer-plain.strict.ts": `import { models } from "./${llm.filename.replace(/\.ts$/, ".js")}";

const tagline = async (product: string): Promise<string> =>
  ${plainInfer(`"echo-model"`, `("One tagline for " + product)`)};

await tagline("widget");
`,
    },
  },
  {
    // mirrors corpus/infer-chat.scm — design doc §5 Shape B, no schema.
    name: "infer-chat.scm's shape, hand-assembled",
    files: {
      [llm.filename]: llm.code,
      "infer-chat.strict.ts": (() => {
        const systemMsg = chatMessageCtor("infer/chat/system", `"be terse"`);
        const userMsg = chatMessageCtor("infer/chat/user", "persona");
        const messagesExpr = `[${systemMsg}, ${userMsg}]`;
        return `import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { models } from "./${llm.filename.replace(/\.ts$/, ".js")}";

const reactionOf = async (persona: string): Promise<string> =>
  ${chatMessages(`"echo-model"`, messagesExpr)};

await reactionOf("a skeptical engineer");
`;
      })(),
    },
  },
  {
    // mirrors corpus/infer-schema.scm — design doc §5 Shape B, schema variant.
    name: "infer-schema.scm's shape, hand-assembled",
    files: {
      [llm.filename]: llm.code,
      "infer-schema.strict.ts": `import { z } from "zod";

import { models } from "./${llm.filename.replace(/\.ts$/, ".js")}";

const TriageResultSchema = z.object({ severity: z.enum(["low", "high"]), summary: z.string() });
type TriageResult = z.infer<typeof TriageResultSchema>;

const triage = async (ticket: string): Promise<TriageResult> =>
  ${structuredOutput(`"echo-model"`, "ticket", "TriageResultSchema")};

await triage("the button is broken");
`,
    },
  },
  {
    // mirrors design doc §5 Shape C — no corpus row yet (ROWS has no agentic
    // entry); this is the emitter's own forward probe of rt/agentic-loop +
    // rt/mcp-tools together.
    name: "design doc §5 Shape C — agentic + MCP, hand-assembled",
    files: {
      [llm.filename]: llm.code,
      [mcpClientModule(["github"]).filename]: mcpClientModule(["github"]).code,
      "agentic.strict.ts": `import { HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { models } from "./${llm.filename.replace(/\.ts$/, ".js")}";
import { mcpTools } from "./${mcpClientModule(["github"]).filename.replace(/\.ts$/, ".js")}";

// The existing invariants/preconditions (R3) declaration (assemble.ts::INVARIANT_DECL) —
// duplicated here rather than imported since it's private to that module; a real
// emitted module gets it inlined the same way an R3 precondition already does.
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

${messageTextHelper()}

const run = async (): Promise<string> =>
  ${agenticLoop(`"smart"`, `[new HumanMessage("Find the failing checks and summarize them")]`, "mcpTools")};

await run();
`,
    },
  },
];

describe("mercury conformance (ts-langchain, forward) — rt-langchain.ts's own emissions are tsc-strict clean", () => {
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(ROWS)("$name", ({ files }) => {
    mkdirSync(tmpDir, { recursive: true });
    const ambientPath = `${tmpDir}ambient-langchain.d.ts`;
    writeFileSync(ambientPath, AMBIENT, "utf8");
    const paths: string[] = [ambientPath];
    let artifact = "";
    for (const [name, content] of Object.entries(files)) {
      const p = `${tmpDir}${name}`;
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
      paths.push(p);
      artifact += `\n--- ${name} ---\n${content}`;
    }
    expect(strictDiagnostics(paths), artifact).toEqual([]);
  });
});

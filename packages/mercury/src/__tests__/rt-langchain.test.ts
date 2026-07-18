/**
 * Standalone unit coverage for the `ts-langchain` runtime emitter (`rt-langchain.ts`)
 * — verified directly against the design doc's §5 before/after shapes, since this
 * module is not yet wired into the shared lowering core (see that file's doc
 * comment + the W5 report). Every case here feeds ALREADY-LOWERED JS expression
 * strings, exactly the contract `lower.ts`'s own `lower(node)` would produce.
 */
import { describe, expect, it } from "vitest";

import {
  agenticLoop,
  CHAT_MESSAGE_CTOR_IMPORTS,
  CHAT_MESSAGE_CTOR_VERBS,
  chatMessageCtor,
  chatMessages,
  langchainRuntimeLlmModule,
  mcpClientModule,
  messageTextHelper,
  modelRef,
  plainInfer,
  structuredOutput,
} from "../rt-langchain.js";

describe("modelRef — design doc's two call-site spellings", () => {
  it("a literal string alias → dot access (models.fast)", () => {
    expect(modelRef(`"fast"`)).toBe("models.fast");
  });
  it("a computed expression → bracket access (models[config.model])", () => {
    expect(modelRef("config.model")).toBe("models[config.model]");
  });
  it("a literal that isn't a valid identifier → bracket access", () => {
    expect(modelRef(`"my-model"`)).toBe(`models["my-model"]`);
  });
});

describe("rt/plain-infer — §5 Shape A (bare-string invoke, a verified correction against the doc's HumanMessage-wrap illustration)", () => {
  it('(car (infer "fast" prompt)) → single awaited-and-peeled expression', () => {
    expect(plainInfer(`"fast"`, "`One tagline for ${product}`")).toBe(
      "(await models.fast.invoke(`One tagline for ${product}`)).text",
    );
  });
});

describe("rt/chat-messages — §5 Shape B", () => {
  it("(car (infer/chat model messages)) → invoke(messages).text", () => {
    const messages =
      "[new SystemMessage(config.voice), new HumanMessage(reaction({ product: config.product, role: persona.role, pain: persona.pain }))]";
    expect(chatMessages("config.model", messages)).toBe(`(await models[config.model].invoke(${messages})).text`);
  });
});

describe("rt/structured-output — §5 Shape B schema variant", () => {
  it("plain infer + schema → withStructuredOutput(Schema).invoke(prompt)", () => {
    expect(structuredOutput(`"fast"`, "triagePrompt(ticket)", "TriageResultSchema")).toBe(
      "await models.fast.withStructuredOutput(TriageResultSchema).invoke(triagePrompt(ticket))",
    );
  });
});

describe("chat-message tuple constructors — infer/chat/system|user|assistant", () => {
  it("maps to the framework's own message classes", () => {
    expect(chatMessageCtor("infer/chat/system", "config.voice")).toBe("new SystemMessage(config.voice)");
    expect(chatMessageCtor("infer/chat/user", "persona")).toBe("new HumanMessage(persona)");
    expect(chatMessageCtor("infer/chat/assistant", "prior")).toBe("new AIMessage(prior)");
  });
  it("an unrecognized verb → undefined (a door, not a guess)", () => {
    expect(chatMessageCtor("infer/chat/narrator", "x")).toBeUndefined();
  });
  it("the recognized-verb set and the import list agree", () => {
    expect(new Set(CHAT_MESSAGE_CTOR_VERBS)).toEqual(
      new Set(["infer/chat/system", "infer/chat/user", "infer/chat/assistant"]),
    );
    expect(new Set(CHAT_MESSAGE_CTOR_IMPORTS)).toEqual(new Set(["SystemMessage", "HumanMessage", "AIMessage"]));
  });
});

describe("rt/agentic-loop — §5 Shape C", () => {
  it("createReactAgent(...).invoke(...) peeled through messageText", () => {
    const messages = `[new HumanMessage("Find the failing checks and summarize them")]`;
    expect(agenticLoop(`"smart"`, messages, "mcpTools")).toBe(
      `messageText((await createReactAgent({ llm: models.smart, tools: mcpTools }).invoke({ messages: ${messages} })).messages.at(-1))`,
    );
  });
});

describe("messageTextHelper — the named helper agenticLoop calls", () => {
  it("is a single function declaration, string or JSON-stringified content", () => {
    const helper = messageTextHelper();
    expect(helper).toContain("function messageText(");
    expect(helper).toContain('typeof message.content === "string"');
  });
});

describe("rt/mcp-tools — runtime/mcp.ts", () => {
  it("one entry per server name, tools merged via getTools()", () => {
    const m = mcpClientModule(["github", "linear"]);
    expect(m.filename).toBe("runtime/mcp.ts");
    expect(m.code).toContain(`import { MultiServerMCPClient } from "@langchain/mcp-adapters";`);
    expect(m.code).toContain(`"github": {}`);
    expect(m.code).toContain(`"linear": {}`);
    expect(m.code).toContain("export const mcpTools = await mcpClient.getTools();");
  });
  it("zero servers → an empty client, still valid", () => {
    const m = mcpClientModule([]);
    expect(m.code).toContain("new MultiServerMCPClient({\n\n});");
  });
});

describe("rt/client-module — runtime/llm.ts", () => {
  it('a Proxy registry — models.fast, models["echo-model"], models[expr] all resolve the same way', () => {
    const m = langchainRuntimeLlmModule();
    expect(m.filename).toBe("runtime/llm.ts");
    expect(m.code).toContain(`import { ChatOpenAI } from "@langchain/openai";`);
    expect(m.code).toContain("new Proxy(cache,");
    // eslint-disable-next-line no-secrets/no-secrets -- an env-var NAME, not a secret value
    expect(m.code).toContain("process.env.OPENAI_BASE_URL");
  });
});

import { Environment, execSerialized, sandboxedEnv } from "@here.build/arrival";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";
import invariant from "tiny-invariant";
import type { NonEmptyTuple } from "type-fest";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { format } from "date-fns";

import { ToolInteraction } from "./ToolInteraction";
import { MCPClientInfo } from "./hono/HonoMCPServer";

export interface DiscoveryQuery {
  expr: string;
}

interface RegisteredFunction {
  description: DiscoveryFunctionDescription | (() => DiscoveryFunctionDescription | Promise<DiscoveryFunctionDescription>);
  params: [] | NonEmptyTuple<z.ZodType>;
  handler: (...args: any[]) => any;
}

type DiscoveryFunctionDescription = string | {dynamic: true, value: string}

export abstract class DiscoveryToolInteraction<ExecutionContext extends Record<string, any>> extends ToolInteraction<
  DiscoveryQuery & ExecutionContext
> {
  private readonly MAX_EXECUTION_TIME = 5000; // 5 seconds
  public readonly contextSchema: Record<string, z.ZodType> = {};
  private readonly functions = new Map<string, RegisteredFunction>();

  async getToolDescription(clientInfo?: MCPClientInfo): Promise<Tool> {
    return {
      ...await super.getToolDescription(clientInfo),
      annotations: {
        readOnlyHint: true
      }
    }
  }

  protected getAIPersonalizedName(clientInfo?: MCPClientInfo) {
    switch (clientInfo?.name) {
      case "claude-ai":
        return `Claude`
      default:
        return '';
    }
  }

  async getToolSchema(clientInfo?: MCPClientInfo): Promise<Tool["inputSchema"]> {
    this.registerFunctions();
    const availableFunctions = await this.getAvailableFunctions();
    const availableFunctionStrings = availableFunctions.map(description => typeof description === "object" ? description.value : description);
    const dynamic = availableFunctions.some(description => typeof description === "object" && description.dynamic);
    const now = new Date()
    const aiName = this.getAIPersonalizedName(clientInfo);
    return {
      type: "object",
      properties: {
        expr: {
          type: "string",
          description: [
              dedent`
            S-expressions to evaluate in sandboxed Scheme environment.
            Batching is supported, so there can be multiple root function calls - each result will be returned.
            LIPS/Scheme environment and Ramda/Ramda-applicative implementing Fantasy-land specification are available.

            Use Fantasy Land combinators for compositional queries:
            - (fmap fn structure) - map over Functors
            - (chain structure fn) - flatMap for Monads
            - (filter predicate list) - filter with predicates
            - (compose f g) - function composition

            Domain-specific functions available in sandbox:
            `,
              ...availableFunctionStrings
            ].join("\n")
          + (dynamic
            ? dedent` 
              NOTE${aiName ? ` FOR ${aiName.toUpperCase()}` : ''} ON LIVE DESCRIPTION:
              The data provided above IS NOT STATIC.
              It is dynamically generated at every MCP session start. <timestamp>${format(now, "MMM do, HH:MM X")}</timestamp>

              Some descriptions have user- and session-personalized, actual state at session start directly in description.
              That data is generated dynamically${aiName ? ` (yes, ${aiName}, this tool description is not static and was generated personally for you right now)` : ''} on description fetch to provide instant basic awareness even before session starts.
              Consider it as a dashboard or welcome screen for this MCP application.
            `
            : ''),
        },
        ...Object.fromEntries(
          Object.entries(this.contextSchema).map(([key, value]) => {
            const {$schema, ...schema} = zodToJsonSchema(value) as any;
            return [
              key,
              {
                ...schema,
                description: `Context property${schema.description ? `. ${schema.description}` : ""}`,
              },
            ];
          }),
        ),
      },
      required: ["expr"],
    };
  }

  async executeTool(): Promise<string | string[]> {
    invariant(this.executionContext, "execution context should be provided for tool execution");
    const timeoutRef = { current: false };
    this.registerFunctions();
    const env = this.createEnvironment(timeoutRef);
    setTimeout(() => {
      timeoutRef.current = true;
    }, this.MAX_EXECUTION_TIME);

    // Use the new separate expressions executor that properly handles multiple expressions
    return execSerialized(this.executionContext.expr, { env });
  }

  protected abstract registerFunctions(): void;

  protected registerFunction<T extends [] | NonEmptyTuple<z.ZodType>>(
    name: string,
    description: DiscoveryFunctionDescription | (() => DiscoveryFunctionDescription | Promise<DiscoveryFunctionDescription>),
    params: T,
    handler: (...args: any[]) => any,
  ) {
    this.functions.set(name, { description, params, handler });
  }

  // Note: Manual conversion methods removed - now handled by arrival's Rosetta Environment
  protected getAvailableFunctions(): Promise<DiscoveryFunctionDescription[]> {
    this.registerFunctions();
    return Promise.all([...this.functions.entries()].map(async ([name, { description, params }]) => {
      // Generate signature from Zod schema
      const signature = params
        .map((item: any) => {
          let postfix = "";
          if (item.safeParse(undefined).success) {
            postfix += "?";
          }
          if (item.description) {
            postfix += ` (${item.description})`;
          }
          // Basic type checks
          if (item instanceof z.ZodString) return `string${postfix}`;
          if (item instanceof z.ZodNumber) return `number${postfix}`;
          if (item instanceof z.ZodBoolean) return `boolean${postfix}`;
          if (item instanceof z.ZodArray) return `list${postfix}`;

          // Enum shows possible values
          if (item instanceof z.ZodEnum) {
            return item.options.map((v) => `"${v}"`).join("|");
          }

          // For z.any() or complex types, use generic names
          if (item instanceof z.ZodAny) {
            return `any`;
          }

          return `value${postfix}`;
        })
        .join(" ");

      const resolvedDescription = typeof description === "function" ? await description() : description;
      const dynamic = typeof resolvedDescription === "object" ? resolvedDescription.dynamic : false;
      const descriptionText = typeof resolvedDescription === "object" ? resolvedDescription.value : resolvedDescription;
      const fullDescription = `(${name}${signature ? ` ${signature}` : ""}) - ${descriptionText}`

      return dynamic ? {
        dynamic: true,
        value: fullDescription
      } : fullDescription;
    }));
  }

  private createEnvironment(timeoutRef: { current: boolean }): Promise<any> {
    const env = new Environment({}, sandboxedEnv, "Sandbox");

    // Register functions using arrival's Rosetta Environment for seamless LIPS ↔ JS interop
    for (const [name, { handler, params }] of this.functions.entries()) {
      env.defineRosetta(name, {
        fn: async (...args: any[]) => {
          invariant(!timeoutRef.current, "Timeout");
          try {
            return params.length > 0
              ? handler(...z.tuple(params as [z.ZodType, ...z.ZodType[]]).parse(args))
              : handler();
          } catch (error: any) {
            throw new Error(`${name}: ${error.message}`);
          }
        },
      });
    }

    return env;
  }
}

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";
import { omit, zip } from "lodash-es";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { ToolInteraction } from "./ToolInteraction";
import invariant from "tiny-invariant";
import { MCPClientInfo } from "./hono/HonoMCPServer";

type Dezod<T extends Record<string, z.ZodType>> = {
  [key in keyof T]: Awaited<z.infer<T[key]>>
}

type ActionDeclaration<T, TT extends Record<string, z.ZodType>> = {
  name: string;
  description: string | (() => Promise<string>);
  context?: Array<keyof T>,
  optionalContext?: Array<keyof T>
  props: TT;
  handler: (context: T, props: Dezod<TT>) => any;
};

type ActionDefinition<T, TT extends Record<string, z.ZodType>> = {
  description: string | (() => Promise<string>);
  context: Array<keyof T>;
  optionalContext: Array<keyof T>;
  args: z.ZodType[];
  argNames: string[];
  handler: (context: T, props: Dezod<TT>) => any;
};

export type ActionCall = [string, ...any]

// we may transform values inside context schema, so it's fair to assume that types may change
export abstract class ActionToolInteraction<ExecutionContext extends Record<string, any>, CallContext extends Record<keyof ExecutionContext, any> = ExecutionContext> extends ToolInteraction<Record<keyof CallContext, any> & { actions: ActionCall[] }> {
  declare readonly contextSchema: {
    [key in keyof ExecutionContext]: z.ZodType<ExecutionContext[key], CallContext[key], any>;
  };

  actions: Record<string, ActionDefinition<ExecutionContext, any>> = {};

  registerAction<TT extends Record<string, z.ZodType>>({ name, description, context = [], optionalContext = [], props, handler }: ActionDeclaration<ExecutionContext, TT>) {
    // we have some inheritance issues here
    this.actions ??= {};
    // Process props in a predictable order
    const propEntries = Object.entries(props);

    this.actions[name] = {
      description,
      context,
      optionalContext,
      args: propEntries.map(([key, arg]) => arg),
      argNames: propEntries.map(([key]) => key),
      handler,
    };
  }

  async getToolSchema(): Promise<Tool["inputSchema"]> {
    // bare minimum of props that should be in each call
    const universallyRequiredProps = Object.values(this.actions).reduce(
      (acc, { context }) => acc.intersection(new Set(context)),
      new Set(Object.keys(this.contextSchema)),
    );
    return {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: dedent`
            List of actions to execute within current tool invocation context.
            Actions are invoked in ["actionName", ...arguments] tuples and executed sequentially.

            Context constraint: All actions in a batch share the exactly same context scope.
            Every field in context must be consumable by EVERY action.
            Examples:
            ✓ Valid: {component, actions: [action<component>, action<component>]} - same required context
            ✗ Invalid: {component, item, actions: [action<component, item>, action<component>] - mismatched required context
            ✓ Valid: {component, item, actions: [action<component, item, elementId?>, action<component, item?>] - since all actions are valid with current context, it will be executed.
          `,
          items: {
            type: {
              oneOf: await Promise.all(
                Object.entries(this.actions).map(
                  async ([action, { description, context, optionalContext, args }]) => ({
                    type: "array",
                    description: dedent`
                      ${typeof description === "string" ? description : await description()}.
                      ${context.length > 0 ? `Required context: ${context.join(", ")}` : ''}
                      ${optionalContext.length > 0 ? `Optional context: ${[...optionalContext].join(", ")})` : ""}
                    `,
                    items: [
                      {
                        const: action,
                      },
                      ...args.map((arg) => omit(zodToJsonSchema(arg), "$schema")),
                    ],
                  }),
                ),
              ),
            },
          },
        },
        ...Object.fromEntries(
          this.contextSchema
            ? Object.entries(this.contextSchema).map(([key, value]) => {
              const {$schema, ...schema} = zodToJsonSchema(value) as any;
              return [
                key,
                {
                  ...schema,
                  description: schema.description ? `Context property. ${schema.description}` : 'Context property',
                },
              ];
            })
            : [],
        ),
      },
      required: ["actions", ...universallyRequiredProps],
    };
  }

  // this may be incorrect in parallel computations, but here each interaction gets its own place
  loadingExecutionContext: Partial<ExecutionContext> = {};

  // hook for inherited elements
  protected async beforeAct(context: ExecutionContext) {}

  async executeTool(clientInfo?: MCPClientInfo) {
    invariant(this.executionContext, "execution context should be provided for tool execution");
    const {actions, ...contextInput} = this.executionContext;
    this.loadingExecutionContext = {};

    // Ensure actions are initialized (defensive)
    this.actions ??= {};

    const validationErrors: Array<{ actionIndex: number; action: string; error: string } | { property: keyof ExecutionContext; error: string }> = [];

    for (const [key, validator] of Object.entries(this.contextSchema) as [keyof ExecutionContext, z.ZodType<ExecutionContext[keyof ExecutionContext], CallContext[keyof ExecutionContext], any>][]) {
      try {
        this.loadingExecutionContext[key] = await validator.parseAsync((contextInput as any)[key]); // use parseAsync for async transforms
      } catch (error) {
        validationErrors.push({
          property: key,
          error:
            error instanceof z.ZodError
              ? `Invalid contextual property: ${error.issues.map((e) => e.message).join(", ")}`
              : String(error),
        });
      }
    }

    // Validate and transform all action arguments
    const transformedActionArgs: any[][] = [];

    for (const [i, [actionName, ...actionArgs]] of actions.entries()) {
      const action = this.actions[actionName];
      if (!action) {
        validationErrors.push({
          actionIndex: i,
          action: actionName,
          error: `Unknown action "${actionName}". Available actions: ${Object.keys(this.actions).join(", ")}`,
        });
        transformedActionArgs.push(actionArgs); // Store even if unknown action
        continue;
      }

      if (action.args.length > 0) {
        try {
          // Use parseAsync to handle async transforms, store transformed values
          const transformed = await z.tuple(action.args as any).parseAsync(actionArgs);
          transformedActionArgs.push(transformed);
        } catch (error) {
          validationErrors.push({
            actionIndex: i,
            action: actionName,
            error:
              error instanceof z.ZodError
                ? `Invalid arguments: ${error.issues.map((e) => e.message).join(", ")}`
                : String(error),
          });
          transformedActionArgs.push(actionArgs); // Store untransformed on error
        }
      } else {
        transformedActionArgs.push([]);
      }
    }

    if (validationErrors.length > 0) {
      return {
        success: false,
        validation: "failed",
        errors: validationErrors,
        message: `Validation failed for ${validationErrors.length} action(s). No actions were executed.`,
      } as const;
    }

    const results: any[] = [];

    await this.beforeAct(this.loadingExecutionContext as ExecutionContext);

    for (let i = 0; i < actions.length; i++) {
      const [actionName] = actions[i];
      const actionArgs = transformedActionArgs[i]; // Use transformed args
      const action = this.actions[actionName]!; // We know it exists from validation

      try {
        results.push(
          await action.handler(this.loadingExecutionContext as ExecutionContext, Object.fromEntries(zip(action.argNames, actionArgs)) as any),
        );
      } catch (error) {
        return {
          success: false,
          partial: true,
          executed: i,
          total: actions.length,
          results,
          failedAction: {
            actionIndex: i,
            action: actionName,
            error: error instanceof Error ? error.message : String(error),
          },
          message: `Executed ${i} of ${actions.length} actions before runtime failure`,
        } as const;
      }
    }

    return results;
  }
}

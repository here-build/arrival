import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import dedent from "dedent";
import type { Context } from "hono";
import { zip } from "lodash-es";
import type { NonEmptyTuple } from "type-fest";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { ToolInteraction } from "./ToolInteraction";

type ActionDeclaration<T, TT> = {
  name: string;
  description: string | ((context: Context) => Promise<string>);
  props: {
    [key in keyof TT]: z.ZodType<TT[key]>;
  };
  handler: (context: Omit<T, "actions">, props: Omit<TT, keyof T>) => any;
};

type ActionDefinition<T, TT> = {
  description: string | ((context: Context) => Promise<string>);
  requiredContext: Set<keyof T>;
  optionalContext: Set<keyof T>;
  args: z.ZodType[];
  argNames: string[];
  handler: (context: Omit<T, "actions">, props: Omit<TT, keyof T>) => any;
};

interface RegisteredFunction {
  description: string;
  params: [] | NonEmptyTuple<z.ZodType>;
  handler: (...args: any[]) => any;
}

export abstract class ActionToolInteraction<T extends Record<string, any>> extends ToolInteraction<
  T & { actions: [string, ...any] }
> {
  readonly contextSchema!: {
    [key in keyof T]: z.ZodType<T[key]>;
  };
  readonly actions: Record<string, ActionDefinition<T, any>> = {};
  private readonly functions = new Map<string, RegisteredFunction>();

  registerAction<TT extends Record<string, any>>({ name, description, props, handler }: ActionDeclaration<T, TT>) {
    const requiredContext = new Set<string>();
    const optionalContext = new Set<string>();
    const args: z.ZodType[] = [];
    const argNames: string[] = [];
    // Process props in a predictable order
    const propEntries = Object.entries(props);

    for (const [key, value] of propEntries) {
      if (key in this.contextSchema) {
        if (value.safeParse(undefined).success) {
          optionalContext.add(key);
        } else {
          requiredContext.add(key);
        }
      } else {
        args.push(value);
        argNames.push(key);
      }
    }
    this.actions[name] = {
      description,
      requiredContext,
      optionalContext,
      args,
      argNames,
      handler,
    };
  }

  async getToolSchema(): Promise<Tool["inputSchema"]> {
    const universallyRequiredProps = Object.values(this.actions).reduce(
      (acc, { requiredContext }) => acc.intersection(requiredContext),
      new Set(Object.keys(this.contextSchema)),
    );
    return {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: dedent`
            List of actions to execute within current tool invocation context.
            Actions are invoked in [actionName, ...arguments] tuples and executed sequentially.

            Context constraint: All actions in a batch share the exactly same context scope.
            Every field in context must be consumable by EVERY action.
            Examples:
            ✓ Valid: {componentId, actions: [action<componentId>, action<componentId>]} - same required context
            ✗ Invalid: {componentId, itemId, actions: [action<componentId, itemId>, action<componentId>] - mismatched required context
            ✓ Valid: {componentId, itemId, actions: [action<componentId, itemId, elementId?>, action<componentId, itemId?>] - since all actions are valid with current context, it will be executed.
          `,
          items: {
            type: {
              oneOf: await Promise.all(
                Object.entries(this.actions).map(
                  async ([action, { description, requiredContext, optionalContext, args }]) => {
                    return {
                      type: "array",
                      description: dedent`
                        ${typeof description === "string" ? description : await description(this.context)}.
                        Works in ${[...requiredContext].join(", ")} context ${optionalContext.size > 0 ? `(optionally ${[...optionalContext].join(", ")})` : ""}
                      `,
                      items: [
                        {
                          const: action,
                        },
                        ...args.map((arg) => zodToJsonSchema(arg)),
                      ],
                    };
                  },
                ),
              ),
            },
          },
        },
        ...Object.fromEntries(
          Object.entries(this.contextSchema).map(([key, value]) => {
            const schema = zodToJsonSchema(value) as any;
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
      required: ["actions", ...universallyRequiredProps],
    };
  }

  protected registerFunction<TT extends [] | NonEmptyTuple<z.ZodType>>(
    name: string,
    description: string,
    params: TT,
    handler: (...args: any[]) => any,
  ) {
    this.functions.set(name, { description, params, handler });
  }


  async executeTool({ actions, ...context }: T & { actions: [string, ...any][] }) {
    const validationErrors: Array<{ index: number; action: string; error: string }> = [];

    for (const [i, [actionName, ...actionArgs]] of actions.entries()) {
      const action = this.actions[actionName];
      if (!action) {
        validationErrors.push({
          index: i,
          action: actionName,
          error: `Unknown action "${actionName}". Available actions: ${Object.keys(this.actions).join(", ")}`,
        });
        continue;
      }

      if (action.args.length > 0) {
        try {
          z.tuple(action.args as any).parse(actionArgs);
        } catch (error) {
          validationErrors.push({
            index: i,
            action: actionName,
            error:
              error instanceof z.ZodError
                ? `Invalid arguments: ${error.issues.map((e) => e.message).join(", ")}`
                : String(error),
          });
        }
      }
    }

    if (validationErrors.length > 0) {
      return {
        success: false,
        validation: "failed",
        errors: validationErrors,
        message: `Validation failed for ${validationErrors.length} action(s). No actions were executed.`,
      };
    }

    const results: any[] = [];

    for (let i = 0; i < actions.length; i++) {
      const [actionName, ...actionArgs] = actions[i];
      const action = this.actions[actionName]!; // We know it exists from validation

      try {
        results.push(
          await action.handler(context as Omit<T, "actions">, Object.fromEntries(zip(action.argNames, actionArgs)) as any),
        );
      } catch (error) {
        return {
          partial: true,
          executed: i,
          total: actions.length,
          results,
          failedAction: {
            index: i,
            action: actionName,
            error: error instanceof Error ? error.message : String(error),
          },
          message: `Executed ${i} of ${actions.length} actions before runtime failure`,
        };
      }
    }

    return results;
  }
}

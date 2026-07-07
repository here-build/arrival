import { isToolMisuseError, renderRetryExpr } from "./doors.js";
import { synthesizeExampleCall } from "./example-call.js";
import type { ToolJsonSchema } from "./tool-schema.js";

/** True iff an error message is an argument/validation/kwarg/arity failure — as opposed to a
 *  tool that ran and failed on domain grounds. Default (kwargs world): `isToolMisuseError`'s
 *  `TOOL_MISUSE_SHAPES` regex family. A positional-tuple consumer (arrival-mcp) matches
 *  `z.tuple().parse()`'s error text instead — proven not to overlap the kwargs shapes
 *  (Round 2 probe: "Invalid input: expected number, received…" doesn't match
 *  `TOOL_MISUSE_SHAPES`), confirming this pluggability is load-bearing, not speculative. */
export type IsMisuseErrorStrategy = (message: string) => boolean;

/** Builds a full working example call string from a tool's JSON Schema. Default (kwargs world):
 *  `synthesizeExampleCall`. A positional consumer's variant reuses the same `stubValue` logic
 *  (exported from example-call.ts) via `z.toJSONSchema()` per tuple element, which already
 *  re-emits the exact `JsonSchemaProperty` shape stub-synthesis speaks. */
export type SynthesizeExampleStrategy = (qualifiedName: string, schema: ToolJsonSchema | undefined) => string;

/** The exact retry expr for a bare tool call, or `undefined` when no faithful call exists.
 *  Default (kwargs world): `renderRetryExpr` (interleaved `:key value` kwargs). A positional
 *  consumer renders a plain argument list instead. */
export type RenderRetryExprStrategy = (
  qualifiedName: string,
  args: Record<string, unknown> | undefined,
) => string | undefined;

export interface DoorStrategies {
  isMisuseError: IsMisuseErrorStrategy;
  synthesizeExample: SynthesizeExampleStrategy;
  renderRetryExpr: RenderRetryExprStrategy;
}

/** Default strategies for the conventional keyword-argument tool calling shape. */
export const KWARGS_STRATEGIES: DoorStrategies = {
  isMisuseError: isToolMisuseError,
  synthesizeExample: synthesizeExampleCall,
  renderRetryExpr,
};

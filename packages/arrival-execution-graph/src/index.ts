/**
 * Execution graph: what an arrival program will do over a set of named symbols (potential), and
 * what it has done / is doing (actual) — one component, one graph vocabulary.
 */
export { ExecutionGraph, type ExecutionGraphProps } from "./ExecutionGraph.js";
export { createExecutionCapture, ExecutionCapture } from "./capture.js";
export { loadVocabulary } from "./vocabulary.js";
export { DefaultStepContent, GraphView, type GraphViewProps, type StepContentProps } from "./GraphView.js";
export { createWorkerEngine, defaultEngine, type ElkEngine } from "./elk-engine.js";
export type { GraphMode, RenderGraph, RenderState } from "./types.js";
export type { RunOutcome } from "./progress.js";

// Advanced: the view and the layers, for callers composing their own view.
export { buildPlan, type BuildPlanInput } from "./build-plan.js";
export { attachDataflow } from "./dataflow.js";
export { type Progress, ProgressProjector } from "./progress.js";
export { type RenderGraphOptions, retainedSpans, toRenderGraph } from "./render-graph.js";
export type { PathStep, Plan, Vocabulary, WireShape } from "./plan.js";

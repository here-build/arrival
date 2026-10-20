import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  branchArms,
  callInTrack,
  loopIterations,
  planMapFetchActual,
  planMapFetchPotential,
} from "./__fixtures__/render-graphs.js";
import { GraphView, preview, type StepContentProps } from "./GraphView.js";

const meta: Meta<typeof GraphView> = {
  title: "execution-graph/GraphView",
  component: GraphView,
  argTypes: { mode: { control: "inline-radio", options: ["potential", "actual"] } },
  decorators: [(Story) => <div style={{ width: "100vw", height: "100vh" }}>{Story()}</div>],
};
export default meta;

type Story = StoryObj<typeof GraphView>;

/** `(define plan (ask …)) (define steps (map (lambda (s) (ask s)) (:steps plan))) (fetch (car steps))` before running. */
export const PlanMapFetchPotential: Story = { args: { graph: planMapFetchPotential, mode: "potential" } };

/** The same program mid-run: three tracks (done, running, failed) and the rest summarized. */
export const PlanMapFetchActual: Story = { args: { graph: planMapFetchActual, mode: "actual" } };

/** Named-let refinement: three iterations, each recurring into the next. */
export const LoopIterations: Story = { args: { graph: loopIterations, mode: "actual" } };

/** `if` on a selector step: the taken arm open, the skipped arm collapsed. */
export const BranchArms: Story = { args: { graph: branchArms, mode: "actual" } };

/** A program-defined function inlined as a call frame inside each par track. */
export const CallInTrack: Story = { args: { graph: callInTrack, mode: "actual" } };

/** The potential fixture shown in actual mode (no values yet): sources stand in for values. */
export const PotentialGraphInActualMode: Story = { args: { graph: planMapFetchPotential, mode: "actual" } };

function SymbolBadge({ symbol, output, state }: StepContentProps) {
  return (
    <>
      <span className="eg-label">{symbol}</span>
      <span>{state === "resolved" && output.hasValue ? preview(output.value) : state}</span>
    </>
  );
}

/** A caller-supplied `renderNode`: the box contents are the caller's, chrome and wiring are ours. */
export const CustomRenderNode: Story = { args: { graph: planMapFetchActual, mode: "actual", renderNode: SymbolBadge } };

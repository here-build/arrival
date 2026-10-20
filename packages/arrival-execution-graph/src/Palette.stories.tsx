import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { asPotential, DATAFLOW, DIAGNOSTICS, PALETTE, pick } from "./__fixtures__/palette.js";
import { GraphView, preview, type StepContentProps } from "./GraphView.js";
import type { GraphMode } from "./types.js";

/**
 * The whole visual vocabulary on hand-built graphs (`__fixtures__/palette.ts`, fold model).
 * `mode: potential` shows the same graph before a run; `renderer: custom` swaps the step contents;
 * `diagnostics` raises the badge; `dataflow` raises the partial / unavailable banner. Picker tabs
 * work: a pick pins the tab, "live" unpins it (the hand-built graph paints one instance, so only
 * the strip moves).
 */
interface PaletteProps {
  graph: keyof typeof PALETTE;
  mode: GraphMode;
  renderer: "default" | "custom";
  diagnostics: boolean;
  dataflow: "complete" | keyof typeof DATAFLOW;
}

function SymbolBadge({ symbol, output, state }: StepContentProps) {
  return (
    <>
      <span className="eg-label">{symbol}</span>
      <span>{output.error ?? (output.hasValue ? preview(output.value) : state)}</span>
    </>
  );
}

function Palette({ graph, mode, renderer, diagnostics, dataflow }: PaletteProps) {
  const [picks, setPicks] = useState<[string, number | undefined][]>([]);
  const actual = picks.reduce((g, [id, ordinal]) => pick(g, id, ordinal), PALETTE[graph]);
  const base = mode === "potential" ? asPotential(PALETTE[graph]) : actual;
  const g = {
    ...base,
    diagnostics: {
      ...(diagnostics ? DIAGNOSTICS : base.diagnostics),
      ...(dataflow === "complete" ? {} : { dataflow: DATAFLOW[dataflow] }),
    },
  };
  return (
    <GraphView
      graph={g}
      mode={mode}
      onSelect={(id, ordinal) => setPicks((p) => [...p, [id, ordinal]])}
      {...(renderer === "custom" ? { renderNode: SymbolBadge } : {})}
    />
  );
}

const meta: Meta<typeof Palette> = {
  title: "Execution Graph/Palette",
  component: Palette,
  args: { mode: "actual", renderer: "default", diagnostics: false, dataflow: "complete" },
  argTypes: {
    graph: { control: "select", options: Object.keys(PALETTE) },
    mode: { control: "inline-radio", options: ["potential", "actual"] },
    renderer: { control: "inline-radio", options: ["default", "custom"] },
    diagnostics: { control: "boolean" },
    dataflow: { control: "inline-radio", options: ["complete", ...Object.keys(DATAFLOW)] },
  },
  decorators: [(Story) => <div style={{ width: "100vw", height: "100vh" }}>{Story()}</div>],
};
export default meta;

type Story = StoryObj<typeof Palette>;

/** pending · running · resolved · rejected · cancelled · skipped · unplanned (potential via `mode`);
 *  data / order edges flowed and pending, an operand-source label. */
export const Steps: Story = { args: { graph: "steps" } };

/** Every area kind (sequence, parallel, loop, condition, call, callback) in every state, each
 *  z-frame with the picker strip its state implies; potential via `mode`. */
export const Areas: Story = { args: { graph: "areas" } };

/** z-frames: an 8-track fan with every instance state following live; the same fan pinned on a
 *  failed track; a 25-iteration loop (stepper past the tab cap) with its return contour and the
 *  counter as an `expr` pill; a callback host; a non-tail recursion as depth tabs with its stub. */
export const Fold: Story = { args: { graph: "fold" } };

/** Lanes: taken / not taken (with a projection on the selector), a clause tested and not taken,
 *  undecided; a call and a designated function; guard's on-raise lane. */
export const Control: Story = { args: { graph: "control" } };

/** Transform blocks: a 3-input fan-in with its value, one still waiting (`—`); projection pills
 *  `[0].url` (car, then field) and `[1]` (the selector's `.urgent` is on Control). Potential via `mode`. */
export const Blocks: Story = { args: { graph: "blocks" } };

/** The conservation badge (hover for the notes). */
export const Diagnostics: Story = { args: { graph: "steps", diagnostics: true } };

/** Some dataflow links could not be traced: missing edges are not independence. */
export const DataflowPartial: Story = { args: { graph: "control", dataflow: "partial" } };

/** No dataflow at all (arrival 0.9.9 wireframe refused the program). */
export const DataflowUnavailable: Story = { args: { graph: "steps", dataflow: "unavailable" } };

/** A caller-supplied `renderNode`: contents are the caller's, chrome and wiring stay ours. */
export const CustomRenderNode: Story = { args: { graph: "fold", renderer: "custom" } };

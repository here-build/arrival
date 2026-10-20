import type { Meta, StoryObj } from "@storybook/react-vite";

import { LiveExecutionGraph, liveArgTypes, liveDecorator } from "./__fixtures__/live.js";

/**
 * How a run ends and how the graph copes with size: failure, cancellation, a long fan, a wide
 * sequence, and a program the dataflow layer cannot read (arrival 0.9.9).
 */
const meta: Meta<typeof LiveExecutionGraph> = {
  title: "Execution Graph/Lifecycle",
  component: LiveExecutionGraph,
  args: { mode: "actual", tick: 350 },
  argTypes: { ...liveArgTypes, cancelAfter: { control: "number" } },
  decorators: [liveDecorator],
};
export default meta;

type Story = StoryObj<typeof LiveExecutionGraph>;

/** A step throws: it reads rejected, what never ran reads skipped. */
export const RejectedRun: Story = {
  args: { program: `(let* ((a (ask "first")) (b (boom a))) (ask b))` },
};

/** Cancelled mid-flight by a real `AbortController.abort()`: what was still running reads cancelled. */
export const CancelledRun: Story = {
  args: {
    program: `(let ((xs (map (lambda (s) (ask s)) (list "a" "b" "c" "d" "e"))))
  (fetch (car xs)))`,
    tick: 900,
    cancelAfter: 2500,
  },
};

/** 40 tracks: running and failed first, then the first and last done, the rest in `more`. */
export const LongFan: Story = {
  args: {
    program: `(map (lambda (i) (ask (number->string i))) (iota 40))`,
    tick: 60,
  },
};

/** More than eight sequential steps: the chain wraps instead of one very wide row. */
export const WideSequence: Story = {
  args: {
    program: `(ask "1")
(fetch "2")
(ask "3")
(fetch "4")
(ask "5")
(fetch "6")
(ask "7")
(fetch "8")
(ask "9")
(fetch "10")`,
    tick: 200,
  },
};

/** A top-level value define captured by a later wire: arrival 0.9.9's wireframe refuses it, so
 *  the graph has no dataflow and says why in the diagnostics badge. */
export const TopLevelValueDefine: Story = {
  args: { program: `(define plan (ask "plan"))\n(fetch plan)` },
};

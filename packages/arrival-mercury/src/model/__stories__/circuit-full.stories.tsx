/**
 * `Circuit/Full` — the four canonical campaign/walkthrough programs, each
 * computed LIVE through the real front→coreform→extract pipeline (never a
 * hand-copied mermaid string — a change to classify/extract/circuitToMermaid
 * shows up here immediately instead of silently drifting from a stale
 * fixture) and rendered as the full TD circuit: every StaticProv node, the
 * honest, unabridged attribution tree. Same pipeline shape as
 * `extract-corpus.test.ts`:
 *
 *   classify(desugar(parseSexprs(source))).forms
 *     → extractProgram(forms, defaultRegistry)
 *     → circuitToMermaid(prov)
 *
 * See `circuit-infer.stories.tsx` for the semantic crossing-chain view.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { circuitToMermaid } from "../circuit-mermaid.js";
import { CircuitMermaid } from "./CircuitMermaid.js";

function renderCircuit(source: string): string {
  const { forms } = classify(desugar(parseSexprs(source)));
  const prov = extractProgram(forms, defaultRegistry);
  return circuitToMermaid(prov, {});
}

const meta = {
  title: "Circuit/Full",
  component: CircuitMermaid,
} satisfies Meta<typeof CircuitMermaid>;

export default meta;
type Story = StoryObj<typeof meta>;

const GENUINE = `(let ((e (dict :v (car (infer "m" "v"))))) (number->string (:v e)))`;

const GUARD_SWAP_FORGE = `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`;

const JUDGMENT = `(let ((e (dict :guilty (car (infer "m" "g"))))) (if (:guilty e) "GUILTY" "INNOCENT"))`;

const DECOY = `(let ((e (dict :v (car (infer "m" "v")) :o "FAKE"))) (number->string (:o e)))`;

/** Grounded infer, no fabrication — the value under attribution traces
 *  straight back to a single evidence-class crossing. */
export const Genuine: Story = {
  render: () => <CircuitMermaid mermaid={renderCircuit(GENUINE)} />,
};

/** A `const` literal ("SAFE") reaches the output on one branch of a choice —
 *  the guard-swap forge; the flag-shaped fabrication mark is unmistakable. */
export const GuardSwapForge: Story = {
  render: () => <CircuitMermaid mermaid={renderCircuit(GUARD_SWAP_FORGE)} />,
};

/** A boolean choice grounded in evidence — both the "GUILTY" and "INNOCENT"
 *  alts are `const`, but the CHOICE itself is grounded (its guard traces to
 *  a real crossing), so this is a legitimate decision, not a forge. */
export const Judgment: Story = {
  render: () => <CircuitMermaid mermaid={renderCircuit(JUDGMENT)} />,
};

/** Genuine evidence is present in the circuit (the `:v` crossing) but the
 *  OUTPUT reads `:o` instead — a decoy: real evidence exists, just not on
 *  the path that grounds the actual value returned. */
export const Decoy: Story = {
  render: () => <CircuitMermaid mermaid={renderCircuit(DECOY)} />,
};

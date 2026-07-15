/**
 * `Circuit/Infer` — the semantic view over a 3-hop `infer/chat` chain: keep
 * only the membrane crossings (mints), contract all the plumbing between them
 * to a single wire (circuit-mermaid.ts's `view: "infer"` — see that file's
 * header for the full rationale). Two stories over the SAME circuit:
 *
 *   - `Structure` — wires with no data, the crossing topology alone.
 *   - `WithData` — a mock crossing-cache `dataFor` resolver attached, so
 *     wires carry the sample values that flowed — demonstrating the
 *     wire+storage data-absorption model the `dataFor` seam exists for
 *     ("the dataflow graph is enough, as long as we cache the expensive
 *     points" — circuit-mermaid.ts).
 *
 * See `circuit-full.stories.tsx` for the shared pipeline pattern.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import type { MermaidOptions } from "../circuit-mermaid.js";
import { circuitToMermaid } from "../circuit-mermaid.js";
import type { NodeId } from "../../coreform/types.js";
import { CircuitMermaid } from "./CircuitMermaid.js";

function renderCircuit(source: string, opts: MermaidOptions): string {
  const { forms } = classify(desugar(parseSexprs(source)));
  const prov = extractProgram(forms, defaultRegistry);
  return circuitToMermaid(prov, opts);
}

const meta = {
  title: "Circuit/Infer",
  component: CircuitMermaid,
} satisfies Meta<typeof CircuitMermaid>;

export default meta;
type Story = StoryObj<typeof meta>;

const INFER_CHAIN = `(let* ((labelled (infer/chat "qwen" (dict :user "Label the text." :text (:doc e)))) (rewritten (infer/chat "qwen" (dict :user "Rewrite it" :prev (:label labelled)))) (scored (infer/chat "qwen" (dict :user "Classify precisely" :item (:label rewritten))))) scored)`;

// The crossing sites, discovered by first logging
// `renderCircuit(INFER_CHAIN, { view: "infer" })` structure-only and reading
// the `mint` node ids off the raw StaticProv: site 2 = `labelled` ("Label the
// text."), site 13 = `rewritten` ("Rewrite it"), site 24 = `scored`
// ("Classify precisely") — chronological order of the chain. This map is a
// MOCK standing in for the real content-addressed crossing cache (the thing
// `dataFor`'s doc comment in circuit-mermaid.ts points at) — no probe ran
// here, these are illustrative sample values only.
const MOCK_CROSSING_CACHE: ReadonlyMap<number, string> = new Map([
  [2, "LABEL: negative"],
  [13, "this app changed my life"],
  [24, "score: 1"],
]);

const mockDataFor = (site: NodeId): string | undefined => MOCK_CROSSING_CACHE.get(site as number);

export const Structure: Story = {
  render: () => <CircuitMermaid mermaid={renderCircuit(INFER_CHAIN, { view: "infer" })} />,
};

export const WithData: Story = {
  render: () => <CircuitMermaid mermaid={renderCircuit(INFER_CHAIN, { view: "infer", dataFor: mockDataFor })} />,
};

/**
 * `Circuit/ELK` — the SAME four canonical programs as `circuit-full.stories.tsx`
 * (kept as literal copies here rather than a shared import — those constants
 * are one-line fixtures, not a module worth coupling two story files to),
 * each computed live through the real front→coreform→extract pipeline and
 * then projected through `toWireframe` (model/to-wireframe.ts) and laid out
 * with `WireframeElk`. This is the SECOND canonical view of the same circuit
 * `circuit-full.stories.tsx` renders as a mermaid flowchart — same source,
 * same StaticProv, a different render target (the studio's ELK pane shape,
 * ported standalone — see `WireframeElk.tsx`'s header).
 *
 * See `circuit-full.stories.tsx` for the shared pipeline pattern and the
 * per-program commentary (genuine/forge/judgment/decoy) — unchanged here.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { toWireframe } from "../to-wireframe.js";
import type { WireframeProjection } from "../to-wireframe.js";
import { WireframeElk } from "./WireframeElk.js";

function renderProjection(source: string): WireframeProjection {
  const { forms } = classify(desugar(parseSexprs(source)));
  const prov = extractProgram(forms, defaultRegistry);
  return toWireframe(prov);
}

const meta = {
  title: "Circuit/ELK",
  component: WireframeElk,
} satisfies Meta<typeof WireframeElk>;

export default meta;
type Story = StoryObj<typeof meta>;

const GENUINE = `(let ((e (dict :v (car (infer "m" "v"))))) (number->string (:v e)))`;

const GUARD_SWAP_FORGE = `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`;

const JUDGMENT = `(let ((e (dict :guilty (car (infer "m" "g"))))) (if (:guilty e) "GUILTY" "INNOCENT"))`;

const DECOY = `(let ((e (dict :v (car (infer "m" "v")) :o "FAKE"))) (number->string (:o e)))`;

/** Grounded infer, no OUTPUT-path fabrication — BUT `toWireframe`'s
 *  `sideMaps.fabrication` flags every `const` node in the whole circuit, not
 *  just the ones reachable from the egress: `(infer "m" "v")`'s own two
 *  string arguments are themselves `const` nodes (wired as the mint's
 *  `closed` — the SELECTION channel, `circuit-mermaid.ts`'s dashed edges),
 *  so this story DOES show two red nodes. That is correct, not a bug in this
 *  gallery: a literal has empty where-provenance regardless of which channel
 *  it rides (static-prov.ts's own definition of `const`); what makes this
 *  circuit "genuine" is that its CONTENT path (the value under attribution)
 *  traces to the evidence-class `infer` crossing with no `const` on that
 *  path — verify that by tracing solid-looking edges from the egress, not by
 *  expecting zero red nodes anywhere in frame. */
export const Genuine: Story = {
  render: () => <WireframeElk projection={renderProjection(GENUINE)} />,
};

/** A `const` literal ("SAFE") reaches the output on one branch of a choice —
 *  the guard-swap forge; `toWireframe` projects it `opaque` and marks it in
 *  `sideMaps.fabrication`. The guard's own threshold literal (`1000`) is
 *  ALSO a `const` and also flags red (same channel-blind rule as Genuine's
 *  infer arguments) — two red nodes total, one of them the actual forge. */
export const GuardSwapForge: Story = {
  render: () => <WireframeElk projection={renderProjection(GUARD_SWAP_FORGE)} />,
};

/** A boolean choice grounded in evidence — the "GUILTY"/"INNOCENT" alts are
 *  `const` (fabrication-marked, honestly), but the CHOICE's own guard traces
 *  to a real crossing. Plus the `(infer "m" "g"))` call's own two string
 *  arguments are also `const`-marked (same selection-channel rule as
 *  Genuine) — four red nodes total. Render whatever `toWireframe` produces
 *  honestly; don't suppress any of them to make this "look clean". */
export const Judgment: Story = {
  render: () => <WireframeElk projection={renderProjection(JUDGMENT)} />,
};

/** Genuine evidence is present (the `:v` crossing) but the OUTPUT reads `:o`
 *  instead — a decoy: the `"FAKE"` const on the `:o` path is a red
 *  fabrication node here, plus `infer`'s own two string arguments (same
 *  selection-channel rule as Genuine) — three red nodes total, one of them
 *  (`"FAKE"`) the actual decoy. */
export const Decoy: Story = {
  render: () => <WireframeElk projection={renderProjection(DECOY)} />,
};

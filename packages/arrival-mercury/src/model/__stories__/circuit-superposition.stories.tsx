/**
 * `Circuit/Superposition` — the wind/unwind amendment (invention I4), drawn.
 *
 * A collection under iteration is a SUPERPOSITION: lifted to all element-states
 * at once (the z-axis, first-class). `map`/`filter`/`fold` desugar to a `Fan`
 * over the body, and it renders as a z-STACK — a subgraph holding the
 * per-element body template (one drawn iteration standing for all N), the
 * collection unwound in. A body that is itself a `Fan` nests: nested subgraphs
 * = nested z-axes. And a hand-rolled TCO tail-fold loop lifts to a `Fan` too,
 * so a recursive program renders as the same z-stack instead of opaquing at the
 * recursion — matching the studio region render's own `iterate / map` stacked
 * boxes.
 *
 * Live through the real pipeline (parse → classify → extract → circuitToMermaid),
 * never a stored string.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { circuitToMermaid } from "../circuit-mermaid.js";
import { CircuitMermaid } from "./CircuitMermaid.js";

const renderCircuit = (source: string): string =>
  circuitToMermaid(extractProgram(classify(desugar(parseSexprs(source))).forms, defaultRegistry), {});

const meta = {
  title: "Circuit/Superposition",
  component: CircuitMermaid,
} satisfies Meta<typeof CircuitMermaid>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `(map f coll)` — one z-axis. The body (`number->string (:v x)`) draws once,
 *  inside the `⟳ fan` subgraph; the collection unwinds into it. */
const MAP = `(map (lambda (x) (number->string (:v x))) (:items e))`;

/** Nested fans = nested z-axes: a filter inside a map over a matrix. The inner
 *  axis subgraph sits inside the outer one. */
const NESTED = `(map (lambda (row) (filter (lambda (c) (:ok c)) (:cells row))) (:matrix e))`;

/** A TCO tail-fold loop lifted to a Fan — NOT opaque. Each round re-infers a
 *  better instruction from the last (a refinement loop); the per-round
 *  `infer/chat` crossing sits inside the z-stack, superposed over the rounds. */
const RECURSIVE_INFER = `
(define (refine instr n)
  (if (zero? n)
      instr
      (refine (:instruction (car (infer/chat "qwen"
                                    (list (infer/chat/user (string-append "Improve: " instr)))
                                    (s/object (s/field/string "instruction"))
                                    "improve")))
              (- n 1))))
(refine "Label the text." 3)`;

export const MapZStack: Story = {
  args: { mermaid: renderCircuit(MAP) },
};

export const NestedAxes: Story = {
  args: { mermaid: renderCircuit(NESTED) },
};

/** The payoff: a recursive inference loop rendered as a superposition. The
 *  `iterate`/`refine` recursion lifts to a `Fan{collapse:"lowered"}`, so the
 *  loop draws as a z-stack with the `infer/chat` crossing visible inside — the
 *  same shape the studio shows GEPA's evolutionary loop, from the static
 *  circuit. (`infer/chat/user`/`s/object` render as `opaque` — heads the
 *  registry doesn't model yet; the recursion lift + z-stack are what this
 *  story demonstrates.) */
export const RecursiveInferenceLoop: Story = {
  args: { mermaid: renderCircuit(RECURSIVE_INFER) },
};

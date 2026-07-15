/**
 * `Circuit/ELK` — GEPA, the real algorithm (reflective, Pareto-based prompt
 * evolution), laid out through the same `toWireframe` → `WireframeElk`
 * pipeline `circuit-elk.stories.tsx`'s four canonical programs use. Added to
 * that title (not a separate group) so it sits alongside the canonical
 * genuine/forge/judgment/decoy gallery as the "real program at scale" entry.
 *
 * `buildGepaSource` is a LITERAL duplicate of the same-named function in
 * `gepa-heads.test.ts` (arrival-mercury's own RED-FIRST gate for this
 * program) — not a cross-import, matching this file's sibling
 * `circuit-elk.stories.tsx`'s own documented precedent ("kept as literal
 * copies here … not a module worth coupling two story files to"): a story
 * importing a `.test.ts` module would pull in that file's top-level
 * `describe`/`it` registration calls as an import-time SIDE EFFECT (vitest's
 * exported `describe`/`it` expect to run inside vitest's own suite context),
 * which is exactly the kind of coupling that precedent avoids. See
 * `gepa-heads.test.ts`'s header for the full algorithm provenance (the real
 * `gepa.scm`, via `inhuman/saas/studio/.../gepa-source.ts`, with its two
 * `.prompt` requires inlined as `infer/chat` calls) and for the one finding
 * this registry sweep could not close (a second `infer/chat` crossing stays
 * behind an unrelated ARM-B alias-resolution gap, verified, not assumed).
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
  // GEPA is a causality / teleology view — fabrication (program-text `const`)
  // nodes carry no lineage, so they are hidden by default here; toggle the
  // `hideFabricated` control off to see them painted red (the security reading
  // the `circuit-elk` canonical stories default to).
  args: { hideFabricated: true },
  argTypes: {
    projection: { table: { disable: true } },
    hideFabricated: { control: "boolean" },
  },
} satisfies Meta<typeof WireframeElk>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── the real GEPA program (literal reconstruction — see header) ────────────

const GEPA_LABELS = ["positive", "negative", "neutral"] as const;

const GEPA_EXAMPLES: { input: string; expected: (typeof GEPA_LABELS)[number] }[] = [
  { input: "this app changed my life", expected: "positive" },
  { input: "it crashes every single time", expected: "negative" },
  { input: "the update shipped on tuesday", expected: "neutral" },
  { input: "absolutely love the new design", expected: "positive" },
  { input: "worst purchase i have ever made", expected: "negative" },
  { input: "the meeting is at noon", expected: "neutral" },
  { input: "fantastic support team so helpful", expected: "positive" },
  { input: "billing double charged me again", expected: "negative" },
  { input: "documentation lists the endpoints", expected: "neutral" },
  { input: "genuinely delighted with the results", expected: "positive" },
];

const GEPA_ROUNDS = 4;

/** Builds the exact self-contained Scheme source (the real `gepa.scm`
 *  algorithm, `.prompt` requires inlined as `infer/chat`, examples/rounds
 *  baked in) — see `gepa-heads.test.ts`'s identically-named function for the
 *  full provenance comment; this is a deliberate literal duplicate, not an
 *  import (see this file's header). */
function buildGepaSource(): string {
  const examplesScheme = `(list
${GEPA_EXAMPLES.map((e) => `    (dict :input ${JSON.stringify(e.input)} :expected ${JSON.stringify(e.expected)})`).join("\n")})`;
  return `
(define examples ${examplesScheme})

(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))

(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\\n\\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))

(define (reflect instruction failures)
  (:instruction (car (infer/chat "qwen3.5-9b"
                       (list (infer/chat/user (string-append
                         "Rewrite it to fix the failures"
                         (if (null? failures) "" (string-append " like: " (:input (car failures))))
                         ". Current instruction: " instruction)))
                       (s/object (s/field/string "instruction"))
                       (string-append "improve/" instruction)))))

(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))

(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))

(define (failing candidate) (map car (filter (lambda (pair) (zero? (cadr pair))) (map list examples (:scores candidate)))))

(define (mutate candidate) (assess (reflect (:instruction candidate) (failing candidate))))

(define (dominates? a b)
  (and (every >= (:scores a) (:scores b))
       (some  >  (:scores a) (:scores b))))

(define (frontier pool)
  (filter (lambda (c) (not (some (lambda (other) (dominates? other c)) pool))) pool))

(define (iterate step pool n) (if (zero? n) pool (iterate step (step pool) (- n 1))))

(define (generation pool) (frontier (append pool (map mutate pool))))

(define (gepa seed rounds)
  (max-by (lambda (c) (apply + (:scores c)))
          (iterate generation (list (assess seed)) rounds)))

(gepa "Label the text." ${GEPA_ROUNDS})
`;
}

const GEPA_SOURCE = buildGepaSource();

/** The full GEPA circuit, rendered with `WireframeElk`'s DESCENDED fan
 *  compound nodes (this component no longer holds I5 exterior-collapse —
 *  see its header): the recursion-lifted `iterate` fan, `generation`'s `map`
 *  over the Pareto pool, and `evaluate`'s `map` over the ten literal
 *  `examples` all render as NESTED dashed-border boxes, `⟳ fan · <collapse>`
 *  labeled, one inside the next, 6 levels deep — GEPA's actual evolutionary
 *  loop: the per-round Pareto-frontier fan opening onto the per-example
 *  evaluation fan opening onto the `ask`/`reflect` `infer/chat` crossings
 *  themselves, red `fabrication` markers on the ten-example-literal `const`
 *  leaves throughout.
 *
 *  SHARED-DAG DEDUP (G2, 2026-07-16): before the fix that added this note,
 *  `extract` re-derived a binding's attribution at EVERY `Ref` use (never
 *  memoized), so `examples` — referenced from every inlined call site that
 *  reaches it through the `evaluate`/`failing` chain — was independently
 *  re-walked dozens of times, and this story rendered 23 fan boxes, 25
 *  `infer/chat` crossings, ~3081 total rects (an independent recursive count
 *  over this exact projection, both before and after, is the source of every
 *  number in this comment). `ExtractCtx.memo` (src/extract/index.ts) now
 *  caches a `{tag:"expr"}` Bound's extraction ON THE BOUND OBJECT, so two
 *  Refs to one binding share the identical `StaticProv` object, and
 *  `to-wireframe.ts`'s `project` recognizes that identity instead of
 *  re-projecting the shared subtree once per reference (scoped per graph
 *  level — see that file's own header for the documented cross-fan-boundary
 *  limit). Same program, same real structure, same verdicts (verified by a
 *  dedicated pre/post seal-gate test, `__tests__/extract/circuit-sharing
 *  .test.ts`) — now 13 fan boxes, 15 `infer/chat` crossings, ~811 total
 *  rects: representation collapsed, nothing reachable lost. `GepaOneRound`
 *  below is the same program at 2 examples/1 round instead of 10/4 — same
 *  fan/crossing shape, ~475 rects instead of ~1257, small enough to actually
 *  scroll through. Render whatever `toWireframe` produces honestly, same
 *  rule `circuit-elk.stories.tsx`'s other stories hold — no truncating the
 *  real structure to "look more finished". */
export const Gepa: Story = {
  args: { projection: renderProjection(GEPA_SOURCE) },
};

/** The exact same GEPA algorithm, two examples — checked empirically
 *  (an independent recursive count over `toWireframe`'s output, both here
 *  and for the full `Gepa` story above, post the G2 shared-DAG dedup — see
 *  `Gepa`'s own doc): the fan/source STRUCTURE (13 fans, 15 `infer/chat`
 *  crossings, depth 6) is fixed by the program's recursive SHAPE, not by
 *  `rounds` or example count — `iterate`'s recursion becomes ONE fan
 *  template regardless of how many rounds it is called with (rounds is a
 *  runtime int threaded as an ordinary argument, not something the static
 *  extractor unrolls per call), so shrinking `rounds` changes nothing
 *  render-side. Only the LITERAL `examples` list's length changes total node
 *  count (each entry is its own `const`/`build` leaf pair) — two examples
 *  instead of ten brings the graph from ~811 nodes down to ~475, small
 *  enough to actually scroll through, while the descent depth/shape stays
 *  byte-identical to the full program's. Same `buildGepaSource` shape, fewer
 *  literal examples — not a
 *  different program. */
function buildGepaSourceSmall(): string {
  const examples = GEPA_EXAMPLES.slice(0, 2);
  const examplesScheme = `(list
${examples.map((e) => `    (dict :input ${JSON.stringify(e.input)} :expected ${JSON.stringify(e.expected)})`).join("\n")})`;
  return `
(define examples ${examplesScheme})

(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))

(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\\n\\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))

(define (reflect instruction failures)
  (:instruction (car (infer/chat "qwen3.5-9b"
                       (list (infer/chat/user (string-append
                         "Rewrite it to fix the failures"
                         (if (null? failures) "" (string-append " like: " (:input (car failures))))
                         ". Current instruction: " instruction)))
                       (s/object (s/field/string "instruction"))
                       (string-append "improve/" instruction)))))

(define (evaluate instruction)
  (map (lambda (ex) (metric (ask instruction (:input ex)) (:expected ex))) examples))

(define (assess instruction) (dict :instruction instruction :scores (evaluate instruction)))

(define (failing candidate) (map car (filter (lambda (pair) (zero? (cadr pair))) (map list examples (:scores candidate)))))

(define (mutate candidate) (assess (reflect (:instruction candidate) (failing candidate))))

(define (dominates? a b)
  (and (every >= (:scores a) (:scores b))
       (some  >  (:scores a) (:scores b))))

(define (frontier pool)
  (filter (lambda (c) (not (some (lambda (other) (dominates? other c)) pool))) pool))

(define (iterate step pool n) (if (zero? n) pool (iterate step (step pool) (- n 1))))

(define (generation pool) (frontier (append pool (map mutate pool))))

(define (gepa seed rounds)
  (max-by (lambda (c) (apply + (:scores c)))
          (iterate generation (list (assess seed)) rounds)))

(gepa "Label the text." 1)
`;
}

export const GepaOneRound: Story = {
  args: { projection: renderProjection(buildGepaSourceSmall()) },
};

/** The `ask` crossing pulled OUT of its fan (one instruction/example round,
 *  called directly — no `map` wrapping it), so the infer/chat evidence node
 *  actually appears in the flattened graph instead of being collapsed inside
 *  a fan body: a green `source`/`infer/chat` node (evidence-integrity),
 *  feeding `:label`/`car` muxes, a `string-append` build for the prompt (the
 *  `infer/chat/user` BUILD part keeping its content visible), and the
 *  `s/object` schema arg staying honestly opaque (metadata, never claimed as
 *  evidence). Same evidence path the full `Gepa` story has at scale, just not
 *  hidden behind a collapsed fan node. */
export const GepaAskCrossing: Story = {
  args: {
    projection: renderProjection(`
(define (metric prediction expected) (if (string-ci=? prediction expected) 1 0))
(define (ask instruction input)
  (:label (car (infer/chat "qwen3.5-9b"
                 (list (infer/chat/user (string-append instruction "\\n\\n" input)))
                 (s/object (s/field/string "label"))
                 (string-append "predict/" instruction "/" input)))))
(metric (ask "Label the text." "this app changed my life") "positive")
`),
  },
};

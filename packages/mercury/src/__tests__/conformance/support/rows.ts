/**
 * The shared conformance-corpus row list — ONE definition consumed by both gates
 * over the same programs:
 *  - `agreement.test.ts` — compiled-output semantics ≡ `runProgram` (the law);
 *  - `strict-emit.test.ts` — every emitted artifact typechecks under
 *    `tsc --strict`, standalone (design doc R7's corpus mechanics).
 *
 * The STRATEGY axis (W4): both gates run every row under EVERY entry of
 * {@link STRATEGY_IDS}, not just the default. This is safe and cheap even for
 * rows that never touch `(infer ...)` — the `rt/*` opinions only fire at the
 * infer-family lowering slot (design doc §3's C6 discipline: "axes at fill time,
 * no cross-product"), so a non-infer row's compiled output is strategy-INVARIANT
 * by construction; running it under both strategies is confirmatory coverage of
 * that invariant, not redundant busywork. `infer/agentic/end-to-end` stays
 * absent from `ROWS` deliberately — see `rt-vercel-ai.ts`'s doc comment on why
 * that verb is a documented door, not a corpus row, this wave.
 */
export const STRATEGY_IDS: readonly ("ts-langchain" | "ts-vercel-ai")[] = ["ts-langchain", "ts-vercel-ai"];

export interface Row {
  /** Test title. */
  name: string;
  /** Corpus filename, under `corpus/`. */
  file: string;
}

export const ROWS: readonly Row[] = [
  { name: "boring-parts floor — no infer, plain recursion", file: "boring-parts-floor.scm" },
  { name: "deliberately ugly source", file: "ugly-source.scm" },
  { name: "desugar: cut (SRFI-26)", file: "sugar-cut.scm" },
  { name: "desugar: -> (thread-first)", file: "sugar-thread-first.scm" },
  { name: "desugar: ->> (thread-last)", file: "sugar-thread-last.scm" },
  { name: "desugar: compose (right-to-left)", file: "sugar-compose.scm" },
  { name: "desugar: pipe (left-to-right)", file: "sugar-pipe.scm" },
  { name: "compose result invoked directly (the W2-flagged paren bug, fixed)", file: "compose-call-direct.scm" },
  { name: "control/self-tail-loop: named let → while", file: "self-tail-loop.scm" },
  { name: "invariants/preconditions: max-by entry check is semantically inert", file: "invariant-max-by.scm" },
  { name: "infer: (car (infer ...)) scalar fold", file: "infer-plain.scm" },
  { name: "infer/chat + message constructors", file: "infer-chat.scm" },
  { name: "infer: schema-constrained (structured output)", file: "infer-schema.scm" },
  { name: 'Law T truthiness: (if c …) — only #f is false (0/"" are truthy)', file: "truthiness-if.scm" },
  { name: "Law T truthiness: and/or/not are value-returning, #f-tested", file: "truthiness-logic.scm" },
];

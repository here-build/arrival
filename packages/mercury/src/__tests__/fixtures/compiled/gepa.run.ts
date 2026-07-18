import { metric } from "./metric.scm";
import examples from "./examples.json";
import runPredict from "./predict.prompt";
import runImprove from "./improve.prompt";
import seed from "./seed.txt";

interface Candidate {
  instruction: unknown;
  scores: unknown[];
}

// Call the prompts with a content-derived cache key, so identical calls replay.
const ask = async (instruction: unknown, input: unknown): Promise<unknown> =>
  await runPredict({ instruction, input });

const reflect = async (instruction: unknown, failures: unknown[]): Promise<unknown> =>
  await runImprove({ instruction, failures });

// Score an instruction across every example, in parallel.
const evaluate = async (instruction: unknown): Promise<unknown[]> =>
  await Promise.all(
    examples.map(async (ex: { input: unknown; expected: unknown }) =>
      metric(await ask(instruction, ex.input), ex.expected),
    ),
  );

// A candidate is an instruction together with its per-example scores.
const assess = async (instruction: unknown): Promise<Candidate> => ({
  instruction,
  scores: await evaluate(instruction),
});

// A readable summary of the examples this candidate got wrong.
const failing = (candidate: Candidate): unknown[] =>
  examples
    .map((example, i) => [example, candidate.scores[i]])
    .filter(([first, second]) => (second === 0) !== false)
    .map(([head]) => head);

// Reflective mutation: hand this candidate's failures to the reflect prompt.
const mutate = async (candidate: Candidate): Promise<Candidate> =>
  await assess(await reflect(candidate.instruction, failing(candidate)));

// Pareto frontier: keep every candidate no other candidate beats outright.
const dominates = (a: Candidate, b: Candidate): boolean =>
  a.scores.every((score, i) => score >= b.scores[i] !== false) === false
    ? false
    : a.scores.some((score, i) => score > b.scores[i] !== false);

const frontier = (pool: Candidate[]): Candidate[] =>
  pool.filter((c) => (pool.some((other) => dominates(other, c) !== false) === false) !== false);

// Apply `step` to the pool `n` times.
const iterate = async (step: unknown, pool: Candidate[], n: number): Promise<Candidate[]> =>
  (n === 0) !== false ? pool : await iterate(step, await step(pool), n - 1);

// One generation: mutate each survivor, then re-select the frontier over all.
const generation = async (pool: Candidate[]): Promise<Candidate[]> =>
  frontier([...pool, ...(await Promise.all(pool.map(mutate)))]);

// Evolve from the seed for `rounds` generations; keep the best on the full set.
const gepa = async (seed: unknown, rounds: number): Promise<Candidate> =>
  (await iterate(generation, [await assess(seed)], rounds)).reduce((acc, item) =>
    item.scores.reduce((acc, score) => acc + score, 0) >
    acc.scores.reduce((acc, score) => acc + score, 0)
      ? item
      : acc,
  );

// The winning candidate — its :instruction is the optimized prompt.
await gepa(seed, 4);

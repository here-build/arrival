// decode-tiers.test.ts — REAL-MODEL smoke for the expected-future decode tiers (lookahead / branch).
//
// These two strategies — the contested-step override (lookahead) and the uncertainty fork (branch) —
// were migrated off the inline decode loop onto the shared `greedyDescend` (lookahead via the
// `onContestedPick` hook, branch via `onFork` + the BranchStrategy). Unlike greedy/rollback they have NO
// model-free gate: their override / reversible-probe / fork-and-rewind machinery only runs against a real
// model distribution. This smoke drives each on the real Rnj-1 GGUF and asserts the migrated path still emits
// a STRUCTURALLY VALID program (paren-balanced, non-trivial — i.e. the constraint + the KV management survived
// the migration) with INTERNALLY-CONSISTENT telemetry. It catches a tier wired to pick an infeasible token,
// to corrupt the KV across a `probeSuccessor` rollback (lookahead), or to mis-rewind a branch arm.
//
// SCOPE: the override (lookahead) and fork (branch) paths only engage at a contested / intent-fork step,
// which a DECISIVE task may never reach — there the tier degenerates to greedy, and that is still a valid
// program. So this gates the WIRING + validity on the real model; the risky PRIMITIVES are gated separately
// and deterministically: `probeSuccessor`'s reversible KV rollback by loop-parity's A1==A2 invariant, and
// `backend.rewind` by the model-free rollback-strategy suite. (Telemetry visibility note: vitest swallows
// per-test `console.log` in its worker pool, so this asserts telemetry INVARIANTS rather than printing them.)
//
// Per .claude/rules/tests.md this is `__benchmarks__/`: it loads a real 5GB GGUF and runs Metal inference —
// opt-in via `pnpm benchmarks`, never in default CI (which has no model + no GPU).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeDeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { llamaCppGenerator, LlamaModelHandle } from "../../src/runners/local/llama-cpp-generate.js";
import type { OracleScanner } from "../../src/oracle-types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GGUF_PATH = path.join(here, "..", "..", "models", "EssentialAI_rnj-1-instruct-Q4_K_M.gguf");
const PROMPT = "Text Mom I'll be 10 minutes late.";
const MAX_NEW_TOKENS = 96;

/** A constrained decode always emits a structurally valid program: non-empty, paren-balanced, opening at `(`. */
function isBalancedSchemeForm(s: string): boolean {
  if (s.length === 0 || s[0] !== "(") return false;
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

// branch is inert without a resolver (no fork is ever committed); a trivial tie-to-greedy resolver still
// exercises the fork → per-arm decode → rewind → resolve machinery (decodeArm + backend.rewind run for EVERY
// arm before the verdict), while keeping the committed output equal to greedy so validity holds either way.
const STRATEGIES = [
  { name: "greedy", opts: { decodeStrategy: "greedy" as const } },
  { name: "lookahead", opts: { decodeStrategy: "lookahead" as const } },
  { name: "branch", opts: { decodeStrategy: "branch" as const, branchResolver: () => 0 } },
];

describe("decode tiers smoke: lookahead / branch on the real Rnj-1 GGUF", () => {
  let handle: LlamaModelHandle | null = null;
  let scanner: OracleScanner;

  beforeAll(async () => {
    const sim = await makeDeviceSim();
    scanner = makeOracle(sim.grant);
    if (existsSync(GGUF_PATH)) handle = await LlamaModelHandle.load(GGUF_PATH, 2048);
    else console.warn(`[decode-tiers] GGUF not found at ${GGUF_PATH}; skipping. Download Rnj-1 first.`);
  }, 1_200_000);

  afterAll(async () => {
    if (handle) {
      await handle.context.dispose();
      await handle.model.dispose();
      await handle.llama.dispose();
    }
  });

  it.each(STRATEGIES)(
    "$name emits a valid constrained program (migration intact) + consistent telemetry",
    async ({ name, opts }) => {
      if (handle === null) return; // GGUF absent — skipped (warned in beforeAll).
      const gen = llamaCppGenerator(handle, opts);
      const program = await gen.generate(PROMPT, {
        constrained: true,
        scanner,
        maxNewTokens: MAX_NEW_TOKENS,
        prefill: "(",
      });
      await gen.disposeSequence(); // free the sequence slot before the next strategy acquires its lane.
      const t = gen.telemetry;

      // The migration's core guarantee: every tier still emits a structurally valid, non-trivial program —
      // the oracle constraint and the KV management (commit / probe-rollback / arm-rewind) all survived.
      expect(isBalancedSchemeForm(program), `${name} program must be paren-balanced: ${JSON.stringify(program)}`).toBe(
        true,
      );
      expect(program.length, `${name} expected a non-trivial program`).toBeGreaterThan(2);
      expect(t.generatedTokens, `${name} must have generated tokens`).toBeGreaterThan(0);

      // Telemetry INVARIANTS — they hold whether or not the tier's special path fired this task (all-zero is
      // valid: the tier degenerated to greedy). A violation means the migrated wiring mis-counts: a contested
      // override can only happen at a contested step; a branch override only among opened branches (one verdict
      // per fork); any overrule is one of the generated tokens.
      expect(t.lookaheadOverrides, `${name}: lookahead overrides ≤ contested steps`).toBeLessThanOrEqual(
        t.contestedSteps,
      );
      expect(t.branchOverrides, `${name}: branch overrides ≤ branches opened`).toBeLessThanOrEqual(t.branchesOpened);
      expect(t.overruledSteps, `${name}: overruled ≤ generated`).toBeLessThanOrEqual(t.generatedTokens);
    },
    1_200_000,
  );
});

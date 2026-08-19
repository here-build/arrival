// loop-parity — THE GATE (L3 of the unified-lookahead-branching-decoder plan).
//
// The decode loop's stepping was moved from the `evaluateWithMetadata` GENERATOR to `controlledEvaluate`
// (so the reversible `probeSuccessor` primitive the lookahead/branch tiers need can run mid-decode). This
// test proves that rewrite is BEHAVIOR-PRESERVING: with `decodeStrategy:"greedy"` the new loop must emit
// the TOKEN-IDENTICAL sequence the old generator loop did, on a fixed prompt + grant env, over the REAL
// Rnj-1 GGUF (the only faithful oracle for Metal/llama.cpp numerics).
//
// HOW PARITY IS ISOLATED: the reference path below drives the OLD generator stepping
// (`evaluateWithMetadata` + `.next(tok)`) through the IDENTICAL constrained pick the new loop uses — by
// importing the very same `pickConstrained`, `renderPrompt`, and `buildEosTokens` the library exports.
// The ONLY difference between the reference and `llamaCppGenerator(decodeStrategy:"greedy")` is the
// stepping mechanism (generator vs controlledEvaluate). So a divergence can ONLY be the rewrite — not a
// re-implementation artifact. We compare the per-step chosen-token STRING sequence (the observable the
// loop exposes via `onStep.chosenStr`; greedy is deterministic so the string sequence is 1:1 with the
// token-id sequence) AND the final extracted program.
//
// THE ONE CHARACTERIZED TAIL DIFFERENCE: `evaluateWithMetadata`'s generator has NATIVE EOS-stopping — at a
// closeable prefix where the argmax is EOS it returns `done` rather than yielding that EOS distribution,
// so the old loop never recorded an EOS pick. `controlledEvaluate` has no native stop, so the rewritten
// loop reaches that same EOS-argmax distribution and chooses EOS explicitly (a trailing `chosenStr:""`).
// Same prefix, same program — only a trailing EOS sentinel differs. The gate strips exactly that sentinel
// and asserts the CONTENT-token streams + the extracted programs are byte-identical (a mid-stream
// divergence, or a >1-step gap, still fails hard). This is the benign native-vs-explicit-stop boundary,
// not a decode divergence.
//
// Also asserts the §3a probe-rollback invariant directly: `probeSuccessor` leaves `nextTokenIndex`
// restored and a re-probe returns the identical distribution (A1==A2) — the primitive the whole plan rests
// on.
//
// Per `.claude/rules/tests.md` this is `__benchmarks__/`: it loads a real 5GB GGUF and runs real Metal
// inference — opt-in via `pnpm benchmarks`, never in default CI (which has no model + no GPU). It produces
// a VERDICT (pass/fail), but its model+browser-tooling-free-but-native dependency keeps it out of the
// default `__tests__` gate, exactly like `runner-benchmark.test.ts`.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeOracle } from "@inhuman.tools/arrival/oracle";
import { type Token } from "node-llama-cpp";
import { beforeAll, describe, expect, it } from "vitest";

import { makeDeviceSim } from "../../src/runners/fixtures/apple-intents/sim.js";
import { CHAT_TEMPLATES } from "../../src/runners/chat-template.js";
import {
  buildEosTokens,
  llamaCppGenerator,
  LlamaModelHandle,
  pickConstrained,
  probeSuccessor,
  renderPrompt,
  type StepMetric,
} from "../../src/runners/local/llama-cpp-generate.js";
import type { OracleScanner } from "../../src/oracle-types.js";
import { extractSchemeForm } from "../../src/runners/generate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GGUF_PATH = path.join(here, "..", "..", "models", "EssentialAI_rnj-1-instruct-Q4_K_M.gguf");

// A fixed prompt + the apple-intents grant env. This task exercises a multi-arg call (tool name + a
// contact + a free-text body) so the constrained walk is non-trivial — closers, content, and the Σ gate
// all fire across the program.
const FIXED_PROMPT = "Text Mom I'll be 10 minutes late.";
const PREFILL = "(";
const MAX_NEW_TOKENS = 96;

let SCANNER: OracleScanner;
beforeAll(async () => {
  const probe = await makeDeviceSim();
  SCANNER = makeOracle(probe.grant);
});

/**
 * The REFERENCE decoder: the OLD `evaluateWithMetadata` generator stepping, calling the EXACT same
 * constrained pick the rewritten loop uses (`pickConstrained`, greedy/temperature 0). Returns the chosen
 * CONTENT token ids + their detokenized strings per step and the final extracted program. This is the
 * pre-rewrite behavior, reconstructed from the library's own exported pieces so it cannot drift from the
 * loop under test except in the stepping mechanism.
 *
 * It records CONTENT tokens only and breaks on an EOS pick WITHOUT recording it — faithfully mirroring the
 * generator's native EOS-stop (the generator returns `done` at that point, so the old loop never recorded
 * an EOS step). The new loop's trailing EOS sentinel is reconciled against this at the call site.
 */
async function referenceGeneratorDecode(
  handle: LlamaModelHandle,
  scanner: OracleScanner,
): Promise<{ chosenStrs: string[]; chosenToks: Token[]; program: string }> {
  const { model, context } = handle;
  const eosTokens = buildEosTokens(model, CHAT_TEMPLATES.llama3.turnTerminator);
  const seq = context.getSequence();
  try {
    const { systemText, tailText } = renderPrompt(FIXED_PROMPT, undefined, PREFILL);
    const systemTokens = model.tokenize(systemText, true);
    const tailTokens = model.tokenize(tailText, true);
    const promptTokens = [...systemTokens, ...tailTokens];

    let prefix = PREFILL;
    const chosenStrs: string[] = [];
    const chosenToks: Token[] = [];

    const generator = seq.evaluateWithMetadata(promptTokens, { probabilities: true });
    let result = await generator.next(); // prefill to the first distribution.

    for (let step = 0; step < MAX_NEW_TOKENS; step++) {
      if (result.done) break;
      const probabilities = result.value.probabilities;
      const top1 = probabilities.entries().next().value;
      if (top1 === undefined) break;

      const closeable = scanner.analyze(prefix).closeable;
      // The greedy constrained pick — the IDENTICAL function the rewritten loop calls (temperature 0,
      // the unused sampling rng is never consulted on the greedy branch).
      const picked = pickConstrained(
        scanner,
        prefix,
        probabilities,
        eosTokens,
        closeable,
        256,
        1024,
        model,
        0,
        () => 0,
      );
      const chosenTok = picked.token;
      const chosenStr = picked.str;

      // Record CONTENT tokens only (the generator NEVER yields an EOS step — see the note below): on the
      // step where EOS would be chosen, the generator has already returned `done` one step earlier, so the
      // old loop simply broke. We mirror that exactly: break on an EOS pick WITHOUT recording it.
      if (eosTokens.has(chosenTok)) break;
      chosenStrs.push(chosenStr);
      chosenToks.push(chosenTok);
      prefix += chosenStr;
      result = await generator.next(chosenTok);
    }
    return { chosenStrs, chosenToks, program: extractSchemeForm(prefix) };
  } finally {
    seq.dispose(); // LlamaContextSequence.dispose() is sync (void) — no await.
  }
}

describe("loop parity: controlledEvaluate stepping ≡ the generator loop (greedy, Rnj-1 GGUF)", () => {
  it("probeSuccessor leaves the sequence EXACTLY as found (index restored, A1==A2)", async () => {
    if (!existsSync(GGUF_PATH)) {
      console.warn(`[loop-parity] GGUF not found at ${GGUF_PATH}; skipping. Download Rnj-1 first.`);
      return;
    }
    const handle = await LlamaModelHandle.load(GGUF_PATH, 2048);
    const seq = handle.context.getSequence();
    try {
      const { systemText, tailText } = renderPrompt(FIXED_PROMPT, undefined, PREFILL);
      const promptTokens = [...handle.model.tokenize(systemText, true), ...handle.model.tokenize(tailText, true)];
      // Prefill to a real decode position (so probing happens mid-sequence, not at index 0).
      const out = await seq.controlledEvaluate([
        ...promptTokens.slice(0, -1),
        [promptTokens.at(-1)!, { generateNext: { probabilities: true } }],
      ]);
      const baseDist = out.at(-1)!.next.probabilities!;
      const indexBefore = seq.nextTokenIndex;
      const probeTok = baseDist.entries().next().value![0]; // the model's top pick — a real candidate.

      const a1 = await probeSuccessor(seq, probeTok);
      // INVARIANT 1: the index is restored — the probe left no committed token behind.
      expect(seq.nextTokenIndex, "nextTokenIndex must be restored after probeSuccessor").toBe(indexBefore);

      const a2 = await probeSuccessor(seq, probeTok);
      // INVARIANT 2: re-probing the same token after rollback returns the IDENTICAL distribution — no KV
      // drift across the rollback (the de-risking measurement the plan's §2 relies on).
      expect(seq.nextTokenIndex, "nextTokenIndex must be restored after the second probe").toBe(indexBefore);
      expect(a1, "first probe returned no distribution").toBeDefined();
      expect(a2, "second probe returned no distribution").toBeDefined();
      expect(a2!.size, "A1 and A2 must have the same vocab size").toBe(a1!.size);
      const top1A1 = a1!.entries().next().value as [Token, number];
      const top1A2 = a2!.entries().next().value as [Token, number];
      expect(top1A2[0], "A1==A2: same argmax token").toBe(top1A1[0]);
      expect(top1A2[1], "A1==A2: same argmax probability").toBe(top1A1[1]);
    } finally {
      seq.dispose(); // LlamaContextSequence.dispose() is sync (void) — no await.
      await handle.context.dispose();
      await handle.model.dispose();
      await handle.llama.dispose();
    }
  }, 1_200_000);

  it("strategy=greedy is TOKEN-IDENTICAL to the generator path on a fixed prompt", async () => {
    if (!existsSync(GGUF_PATH)) {
      console.warn(`[loop-parity] GGUF not found at ${GGUF_PATH}; skipping. Download Rnj-1 first.`);
      return;
    }
    const handle = await LlamaModelHandle.load(GGUF_PATH, 2048);
    try {
      // NEW path: the rewritten controlledEvaluate loop, explicit greedy strategy. Capture chosenStr
      // per step via the metrics tap and the returned program.
      const newSteps: StepMetric[] = [];
      const gen = llamaCppGenerator(handle, {
        decodeStrategy: "greedy",
        onStep: (m) => newSteps.push(m),
      });
      const newProgram = await gen.generate(FIXED_PROMPT, {
        constrained: true,
        scanner: SCANNER,
        maxNewTokens: MAX_NEW_TOKENS,
        prefill: PREFILL,
      });
      const newChosen = newSteps.map((m) => m.chosenStr);
      // Free the new path's sequence slot before the reference acquires its own lane.
      await gen.disposeSequence();

      // REFERENCE path: the old generator stepping, identical pick.
      const ref = await referenceGeneratorDecode(handle, SCANNER);

      // THE ONE FAIR ADJUSTMENT (and the only divergence the rewrite introduces — fully characterized):
      // `evaluateWithMetadata`'s generator has NATIVE EOS-stopping — when the model's argmax is EOS at a
      // closeable prefix, it returns `done` instead of yielding that EOS distribution, so the old loop
      // never recorded an EOS pick. `controlledEvaluate` has NO native stop — it returns the EOS
      // distribution like any other, so the rewritten loop chooses EOS explicitly (recording a trailing
      // `chosenStr:""` via `onStep`) at the SAME prefix the generator stopped at. The emitted program is
      // byte-identical; the sole observable difference is this trailing EOS sentinel. We strip it (only
      // when it IS the natural-EOS tail) and then assert the CONTENT-token sequences match exactly — any
      // real mid-stream divergence still fails the equality below.
      const newContent = newChosen.length > 0 && newChosen.at(-1) === "" ? newChosen.slice(0, -1) : newChosen;
      // The stripped tail must be at most ONE EOS sentinel — never more. A larger gap would mean a
      // genuine step-count divergence, not the benign native-vs-explicit stop.
      expect(
        newChosen.length - newContent.length,
        "the only extra step over the generator path must be a single trailing EOS sentinel",
      ).toBeLessThanOrEqual(1);

      // THE GATE: the content-token sequence (every token that becomes part of the program) is IDENTICAL
      // to the generator path, and the extracted program is byte-identical. (Greedy is deterministic; the
      // chosen-token STRING sequence is 1:1 with the token-id sequence since each step emits exactly one
      // detokenized token from the identically-ordered distribution.)
      expect(newContent.length, "content-token count must match the generator path").toBe(ref.chosenStrs.length);
      expect(newContent, "per-step content-token sequence must be identical to the generator path").toEqual(
        ref.chosenStrs,
      );
      expect(newProgram, "the extracted program must be identical to the generator path").toBe(ref.program);
      // Sanity: the run actually generated a real multi-token program (not an empty/degenerate parity).
      expect(newContent.length, "expected a real multi-token program").toBeGreaterThan(2);
    } finally {
      await handle.context.dispose();
      await handle.model.dispose();
      await handle.llama.dispose();
    }
  }, 1_200_000);
});

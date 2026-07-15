/**
 * The J1 gate — extract vs the dual-use fixture corpus (G1, 2026-07-15).
 *
 * A row runs `it.fails` until its `landed` flag flips (the arms' machinery for
 * it merged and verified), then plain `it` — FOREVER. The flip is DATA in
 * fixture-corpus.ts, and flipping is the merge owner's act, never an arm
 * agent's: a row that STAYS red at its flip is a real extract defect, and a
 * row that goes green EARLY means a stub stopped being a stub without the
 * merge owner knowing (stop and ping the flip owner — do not self-flip).
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { FIXTURE_CORPUS, mismatch } from "./fixture-corpus.js";

describe("extract() vs the fixture corpus (J1 gate — it.fails until each row lands)", () => {
  for (const row of FIXTURE_CORPUS) {
    const runner = row.landed ? it : it.fails;
    runner(`${row.name}: ${row.why.slice(0, 80)}…`, () => {
      const { forms } = classify(desugar(parseSexprs(row.source)));
      const prov = extractProgram(forms, defaultRegistry);
      expect(mismatch(prov, row.expected)).toBeNull();
    });
  }
});

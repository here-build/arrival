/**
 * The J1 gate — extract vs the dual-use fixture corpus (G1, 2026-07-15).
 *
 * Every row runs `it.fails` while the arms are G1 stubs (everything lifts to
 * `opaque("unimplemented/…")`, which is I1-sound and corpus-red). At J1 (the
 * three arms merged), the merge owner flips `.fails` off row by row — a row
 * that STAYS red at J1 is a real extract defect, and a row that goes green
 * EARLY means a stub stopped being a stub without the merge owner knowing.
 * Do not flip these in arm branches; the flip is the J1 act itself.
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { FIXTURE_CORPUS, mismatch } from "./fixture-corpus.js";

describe("extract() vs the fixture corpus (J1 gate — it.fails until the arms land)", () => {
  for (const row of FIXTURE_CORPUS) {
    it.fails(`${row.name}: ${row.why.slice(0, 80)}…`, () => {
      const { forms } = classify(desugar(parseSexprs(row.source)));
      const prov = extractProgram(forms, defaultRegistry);
      expect(mismatch(prov, row.expected)).toBeNull();
    });
  }
});

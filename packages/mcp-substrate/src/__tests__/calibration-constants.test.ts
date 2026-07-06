// CALIBRATION-CONSTANT DEFAULT-VALUE TABLE — the drift guard for "constant → injected option"
// (docs/working-proposals/arrival-manifold-package-split-2026-07-05.md, round 1's "MODEL-AGNOSTIC
// / HARNESS-AGNOSTIC AUDIT" + "Test safety net" gap #6). Round 1 mandates that every calibration
// constant become an injected runner option, defaulted to TODAY'S value, once the doors-steering-
// runner is extracted — a classic site for a default to silently drift during that conversion
// (`10`→`8`, `0.7`→`0.75`, …). Some constants were already pinned (manifold-tool.test.ts pins the
// response-size/attachments SCHEMA defaults verbatim) — this file adds the ones that were not:
// futility.ts's RING_SIZE, and doors.ts's TIER3_TOP/isCloseName distance-gate constants.
// (competence.ts's WINDOW_SIZE/STABLE_THRESHOLD were pinned here too until 2026-07-06, when the
// whole COMPETENCE v2 remedy-gradient mechanism was removed alongside the truncation banner it
// fed — a measured null effect on task pass-rate.)
//
// THIS FILE ADDS `export` TO PREVIOUSLY MODULE-PRIVATE CONSTANTS (futility.ts's RING_SIZE,
// doors.ts's TIER3_TOP) AND ONE FUNCTION (doors.ts's isCloseName) — see each symbol's own doc
// comment for the one-line justification. This is the ONLY production-code touch anywhere in
// this test-safety-net batch: purely additive (an `export` keyword), zero behavior change, and
// it is exactly what Round 1 already calls for as a first, minimal step toward "these become
// injected options" — done here as "these become OBSERVABLE" only, deliberately stopping short
// of actually wiring them as options (that is real design work for the migration itself, not a
// side effect of writing a test).

import { describe, expect, it } from "vitest";

import type { BoundTool } from "../bound-tool.js";
import { isCloseName, TIER3_TOP } from "../doors.js";
import { RING_SIZE } from "../futility.js";

describe("calibration-constant registry — today's documented defaults, pinned literally", () => {
  it("futility.ts", () => {
    expect(RING_SIZE).toBe(6);
  });

  it("doors.ts — TIER3_TOP", () => {
    expect(TIER3_TOP).toBe(10);
  });

  describe("doors.ts — isCloseName's embedded distance-gate constants (1, 2, 8)", () => {
    // isCloseName(attempted, candidate, tools) — tools maps the candidate's qualified name to
    // its BoundTool; an empty map makes `candidate` its own bare form (the module's own
    // documented fallback), which is all these boundary probes need.
    const noParts = new Map<string, BoundTool>();

    it("edit distance 1 is ALWAYS close, regardless of length (the tight bar) — isolated from the prefix-relation branch", () => {
      // "quux"/"quuz": one substitution, neither string is a prefix of the other (so this
      // isolates the DISTANCE branch specifically, not the separate prefixPair branch).
      expect(isCloseName("quux", "quuz", noParts)).toBe(true);
    });

    it("edit distance 2 on a SHORT (<8 char) name is NOT close — the length gate bites", () => {
      // "never" (5) vs "every" (5): substituting n→e is distance... let's use an unambiguous
      // distance-2 pair with no prefix relation: "abcde" vs "abfge" (2 substitutions), length 5.
      expect(isCloseName("abcde", "abfge", noParts)).toBe(false);
    });

    it("edit distance 2 on a LONG (>=8 char) name IS close — the widened bar for realistic tool names", () => {
      // "search_files" (12) vs "search_fales" (2 substitutions: i->a, e removed/added — construct
      // a clean 2-edit pair): "directory_tree" (14) vs "directery_tred" (2 substitutions), both >=8.
      expect(isCloseName("directery_tred", "directory_tree", noParts)).toBe(true);
    });

    it("edit distance 3 is NEVER close, even for a long name", () => {
      expect(isCloseName("xxxdirectory_tree", "directory_tree", noParts)).toBe(false);
    });
  });
});

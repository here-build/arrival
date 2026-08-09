// CALIBRATION-CONSTANT DEFAULT-VALUE TABLE — pins today's value of every calibration constant
// that is not already covered elsewhere (manifold-tool.test.ts pins the response-size/attachments
// SCHEMA defaults). Currently: futility.ts's RING_SIZE, and doors.ts's TIER3_TOP/isCloseName
// distance-gate constants. The guard exists because these constants are candidates to become
// injected runner options — a classic site for a default to silently drift during that kind of
// conversion (`10`→`8`, `0.7`→`0.75`, …); pinning them literally here makes any such drift fail
// loudly instead of shipping silently.
//
// futility.ts's RING_SIZE and doors.ts's TIER3_TOP/isCloseName are exported here purely so this
// file can observe them — a strictly additive `export`, zero behavior change to the modules
// themselves. They are not yet wired as configurable options; that remains real design work.

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
      // "abcde" vs "abfge": 2 substitutions, no prefix relation, length 5 — isolates the
      // length-gate boundary from the separate prefixPair branch.
      expect(isCloseName("abcde", "abfge", noParts)).toBe(false);
    });

    it("edit distance 2 on a LONG (>=8 char) name IS close — the widened bar for realistic tool names", () => {
      // "directory_tree" (14) vs "directery_tred" (2 substitutions), both >=8 chars — the
      // widened bar applies at this length.
      expect(isCloseName("directery_tred", "directory_tree", noParts)).toBe(true);
    });

    it("edit distance 3 is NEVER close, even for a long name", () => {
      expect(isCloseName("xxxdirectory_tree", "directory_tree", noParts)).toBe(false);
    });
  });
});

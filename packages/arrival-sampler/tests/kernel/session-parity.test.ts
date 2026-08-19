// session-parity.test.ts — node S1's CORRECTNESS CONTRACT, executable.
//
// The kernel's per-candidate liveness check has two paths (the historical "lazy processor" design):
//   - RE-SCAN: `isCandidateLive(scanner, prefix, str)` — re-`analyze`/`feasible` the whole
//     `prefix + str` per candidate (O(prefix) each, correctness-first).
//   - SESSION: open ONE `OracleSession` over `prefix`, then `clone().advance(str)` per candidate and
//     read the verdict off the clone's `state` (O(str) each — the perf win).
//
// The HARD CONTRACT (README + roadmap S1): the session path MUST yield the IDENTICAL kept set /
// verdict as the re-scan path. This file proves it two ways, with the REAL `makeOracle` scanner:
//   1. CLASSIFIER parity — `classifyCandidateSession` === `classifyCandidate` for every (prefix,
//      candidate) in a corpus spanning operator/argument/mid-symbol/structural/sigma/closeable cases,
//      across structural AND Σ-live scanners.
//   2. Kept-set parity for the bounded path with the session optimization (default)
//      keeps EXACTLY the same id set as the same processor forced onto the re-scan path
//      (`forceRescan: true`), over a corpus of (prefix, top-K logits).
//
// It is genuinely RED if the session path diverges: assertion 1 compares the session verdict against
// the canonical `classifyCandidate`, NOT against itself.

// Resolved to arrival SOURCE via vitest alias (see vitest.config.ts) — the REAL oracle.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import { classifyCandidate, classifyCandidateSession, type CandidateClass } from "../../src/mask-compiler.js";
import type { OracleScanner } from "../../src/oracle-types.js";
import { selectConstrainedStep } from "../../src/select-constrained-step.js";

const callable = (x: unknown): unknown => x;
/** A grant env binding car/cdr/some-bound-op as callables — Σ-live, multi-char prefix coverage. */
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({ car: callable, cdr: callable, "some-bound-op": callable });
}

// ── 1. CLASSIFIER parity ───────────────────────────────────────────────────────────────────────────
// A corpus of (prefix, candidate) pairs deliberately hitting every verdict branch.
const CASES: { prefix: string; cand: string; note: string }[] = [
  // operator slot
  { prefix: "(", cand: "car", note: "bound operator (feasible)" },
  { prefix: "(", cand: "ca", note: "bound operator prefix (feasible)" },
  { prefix: "(", cand: "nonexistent-tool", note: "unbound operator (sigma)" },
  { prefix: "(", cand: "1", note: "number at operator (sigma)" },
  { prefix: "(", cand: "#", note: "#-literal at operator (sigma)" },
  { prefix: "(", cand: ":Field", note: ":-keyword at operator (feasible)" },
  { prefix: "(", cand: ")", note: "immediate close at operator" },
  // argument slot
  { prefix: "(car ", cand: ":", note: ":-keyword at argument (feasible)" },
  { prefix: "(car ", cand: ":Field", note: ":Field at argument (feasible)" },
  { prefix: "(some-bound-op ", cand: "#t", note: "#t at argument (feasible)" },
  { prefix: "(some-bound-op ", cand: "5", note: "number at argument (feasible)" },
  { prefix: "(some-bound-op ", cand: "nope", note: "unbound atom at argument (sigma)" },
  // mid-symbol continuations
  { prefix: "(ca", cand: "r", note: "mid-symbol completing car (feasible)" },
  { prefix: "(ne", cand: "t", note: "mid-symbol unbound (sigma)" },
  // structural closers / over-close
  { prefix: "(car 5", cand: ")", note: "structural close (feasible)" },
  { prefix: "(car 5)", cand: ")", note: "over-close (structural reject)" },
  { prefix: "", cand: ")", note: "leading close (structural reject)" },
  // closeable forms + whitespace + nesting
  { prefix: "(car 5)", cand: " ", note: "trailing space after closed form" },
  { prefix: "(", cand: "(", note: "sub-application head — R-HEAD-IS-SYMBOL masks (structural, both paths agree)" },
  { prefix: "(car (cdr ", cand: ":Field", note: "nested argument :-keyword (feasible)" },
  { prefix: "(car ", cand: "(", note: "open nested form at argument" },
];

describe.each([undefined, grantEnv()] as const)(
  "session-parity — classifyCandidateSession === classifyCandidate (the IDENTICAL-verdict contract) [%s]",
  (grant) => {
    const label = grant ? "Σ-live" : "structural";
    const scanner = makeOracle(grant);
    // The real scanners expose session(); guard so the test is meaningful (not silently skipped).
    it(`[${label}] makeOracle exposes session() (S1 perf seam present)`, () => {
      expect(typeof scanner.session, "real makeOracle scanner must expose session() for S1").toBe("function");
    });

    it.each(CASES)(`[${label}] $prefix + $cand — $note`, ({ prefix, cand }) => {
      const rescanVerdict: CandidateClass = classifyCandidate(scanner, prefix, cand);
      const session = scanner.session!(prefix);
      const sessionVerdict: CandidateClass = classifyCandidateSession(session, prefix, cand);
      expect(
        sessionVerdict,
        `session verdict "${sessionVerdict}" != re-scan verdict "${rescanVerdict}" for ${JSON.stringify(
          prefix,
        )} + ${JSON.stringify(cand)}`,
      ).toBe(rescanVerdict);
    });
  },
);

// ── 2. PROCESSOR kept-set parity (session default vs forceRescan) ───────────────────────────────────
const TOKENS: { id: number; str: string }[] = [
  { id: 0, str: "(" },
  { id: 1, str: ")" },
  { id: 2, str: "car" },
  { id: 3, str: "cdr" },
  { id: 4, str: "foo" },
  { id: 5, str: "5" },
  { id: 6, str: " " },
  { id: 7, str: ":" },
  { id: 8, str: "#t" },
];
const EOS_ID = 9;
// The candidate ids in the model-preference (descending-logit) order the old fakeLogits encoded — a
// perverse-but-fixed ranking that stresses the masking order (the keepN=1 pick is rank-sensitive). EOS
// (id 9) ranks last; it carries no string, so the walk skips it and the kernel admits it via eos.addId.
const RANKED_IDS = [4, 2, 3, 0, 5, 1, 7, 8, 6, 9];

/** The kernel's kept-id SET at `prefix` for the given path/keepN — the migration of the old
 *  (historical) `LazyOracleConstraintProcessor._call` + `Tensor` mask: `keepSet` IS the ids the old lazy path would have kept
 *  have left un-masked. `forceRescan` toggles the kernel's session vs re-scan path INTERNALLY
 *  (select-constrained-step.ts:149-150), so the parity assertion now compares those two paths directly. */
function keptIds(scanner: OracleScanner, prefix: string, opts: { forceRescan: boolean; keepN: number }): Set<number> {
  const idToStr = new Map(TOKENS.map((t) => [t.id, t.str]));
  const prefixState = scanner.analyze(prefix);
  const slotState =
    prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
      ? scanner.analyze(`${prefix} `)
      : prefixState;
  const { keepSet } = selectConstrainedStep({
    scanner,
    prefix,
    rankedIds: () => RANKED_IDS,
    idToString: (id) => idToStr.get(id),
    allIds: () => idToStr.keys(),
    slotState,
    closeable: prefixState.closeable,
    keepN: opts.keepN,
    topK: RANKED_IDS.length,
    wideK: RANKED_IDS.length,
    eos: { addId: EOS_ID },
    forceRescan: opts.forceRescan,
  });
  return keepSet;
}

// NOTE: `((` is intentionally absent — R-HEAD-IS-SYMBOL makes it an unreachable dead-end (a sub-application
// head can never be committed, so every continuation of `((` is masked). The `(` + `(` masking is covered as a
// reachable CASE above; here we keep only reachable prefixes (a clean committed prefix never contains `((`).
const PREFIXES = ["", "(", "(car", "(car ", "(car 5", "(car 5)", "(cdr ", "(car (cdr "];
describe.each([undefined, grantEnv()] as const)(
  "session-parity — processor kept set: session path === forceRescan path [%s]",
  (grant) => {
    const label = grant ? "Σ-live" : "structural";
    describe.each([1, Infinity])(`[${label}] keepN=%s`, (keepN) => {
      it.each(PREFIXES)(`[${label}] keepN=${keepN} prefix %j: kept sets identical`, (prefix) => {
        const scanner = makeOracle(grant);
        const sessionKept = keptIds(scanner, prefix, { forceRescan: false, keepN });
        const rescanKept = keptIds(scanner, prefix, { forceRescan: true, keepN });
        expect([...sessionKept].toSorted((a, b) => a - b)).toEqual([...rescanKept].toSorted((a, b) => a - b));
      });
    });
  },
);

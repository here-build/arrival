// session-perf.test.ts — node S1's PERF property, as a call-count assertion (not wall-clock).
//
// The re-scan path calls the stateless oracle (`analyze`/`feasible`) ONCE PER CANDIDATE over the
// whole `prefix + str` — O(K · prefix) full-prefix scans. The session path opens ONE session over
// `prefix` (one full-prefix scan) and then does K cheap `clone().advance(str)` resumes — O(prefix) +
// O(K · str). We assert the inequality on COUNTS: the session path makes materially FEWER
// stateless full-prefix `analyze`/`feasible` calls than the re-scan path.
//
// We wrap the real scanner to count: stateless `analyze`/`feasible` (the O(prefix) ops we want to
// avoid per-candidate) vs `session` opens and per-clone `advance` calls.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import type { OracleScanner, OracleSession } from "../../src/oracle-types.js";
import { selectConstrainedStep } from "../../src/select-constrained-step.js";

const callable = (x: unknown): unknown => x;
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({ car: callable, cdr: callable });
}

interface Counts {
  statelessScans: number; // stateless analyze + feasible (the O(prefix) per-candidate cost we kill)
  sessionOpens: number; // session(prefix) opens
  advances: number; // per-clone advance() calls (the O(str) resumes)
}

/** Wrap a real scanner, counting stateless scans vs session opens / advances. */
function countingScanner(inner: OracleScanner): { scanner: OracleScanner; counts: Counts } {
  const counts: Counts = { statelessScans: 0, sessionOpens: 0, advances: 0 };
  const scanner: OracleScanner = {
    analyze: (p) => {
      counts.statelessScans++;
      return inner.analyze(p);
    },
    feasible: (p) => {
      counts.statelessScans++;
      return inner.feasible(p);
    },
    session: inner.session
      ? (prefix?: string) => {
          counts.sessionOpens++;
          const real = inner.session!(prefix);
          const wrap = (s: OracleSession): OracleSession => ({
            advance: (text) => {
              counts.advances++;
              s.advance(text);
            },
            clone: () => wrap(s.clone()),
            get state() {
              return s.state;
            },
          });
          return wrap(real);
        }
      : undefined,
  };
  return { scanner, counts };
}

const TOKENS: { id: number; str: string }[] = [
  { id: 0, str: "(" },
  { id: 1, str: ")" },
  { id: 2, str: "car" },
  { id: 3, str: "cdr" },
  { id: 4, str: "foo" },
  { id: 5, str: "5" },
  { id: 6, str: " " },
];
const EOS_ID = 7;
// The candidate ids in the model-preference (descending-logit) order the old fakeLogits encoded. keepN=∞
// walks every candidate, so the order does not change the asserted COUNTS; preserved for fidelity. EOS
// (id 7) carries no string, so the walk skips it (no advance) and the kernel admits it via eos.addId.
const RANKED_IDS = [4, 2, 3, 0, 5, 1, 6, 7];

/** Run ONE shared-kernel step over the toy vocab at `prefix` — the migration of the old
 *  `LazyOracleConstraintProcessor._call` + `Tensor`. The kernel makes the SAME scanner calls the processor
 *  drove (the processor only wrapped it: one `analyze(prefix)` for closeable, then the session/re-scan
 *  candidate sweep), so the counting wrapper observes the identical session-open / advance / stateless-scan
 *  profile. `forceRescan` toggles the kernel's session vs re-scan path. */
function runStep(scanner: OracleScanner, prefix: string, forceRescan: boolean): void {
  const idToStr = new Map(TOKENS.map((t) => [t.id, t.str]));
  const prefixState = scanner.analyze(prefix);
  const slotState =
    prefixState.midToken && (prefixState.position === "argument" || prefixState.position === "operator")
      ? scanner.analyze(`${prefix} `)
      : prefixState;
  selectConstrainedStep({
    scanner,
    prefix,
    rankedIds: () => RANKED_IDS,
    idToString: (id) => idToStr.get(id),
    allIds: () => idToStr.keys(),
    slotState,
    closeable: prefixState.closeable,
    keepN: Number.POSITIVE_INFINITY,
    topK: RANKED_IDS.length,
    wideK: RANKED_IDS.length,
    eos: { addId: EOS_ID },
    forceRescan,
  });
}

describe("session-perf — session path makes far fewer full-prefix stateless scans than re-scan", () => {
  // A non-trivial prefix so per-candidate re-scans are genuinely O(prefix) > O(str).
  const prefix = "(car (cdr ";

  it("session path: ONE session open, K advances, NO per-candidate stateless analyze/feasible", () => {
    const { scanner, counts } = countingScanner(makeOracle(grantEnv()));
    runStep(scanner, prefix, false);
    // Exactly one session opened for the candidate sweep this step.
    expect(counts.sessionOpens, "session path should open exactly one session for the candidate sweep").toBe(1);
    // One advance per candidate clone (K candidates walked).
    expect(counts.advances, "session path should advance once per candidate").toBeGreaterThan(0);
    // The whole point: candidate liveness no longer goes through the stateless O(prefix) scanner.
    // (The processor still calls analyze(prefix) ONCE for `closeable` — that's a single fixed cost,
    //  not per-candidate.) So statelessScans is tiny and constant, not ~K.
    expect(counts.statelessScans, "session path must NOT re-scan the whole prefix per candidate").toBeLessThanOrEqual(
      1,
    );
  });

  it("re-scan path: stateless full-prefix scans scale with the candidate count (the cost we remove)", () => {
    const { scanner, counts } = countingScanner(makeOracle(grantEnv()));
    runStep(scanner, prefix, true);
    expect(counts.sessionOpens, "re-scan path opens no sessions").toBe(0);
    // Each candidate triggers feasible(next) (+ analyze(next) on the structurally-OK ones) — far more
    // than the session path's ≤1.
    expect(counts.statelessScans, "re-scan path re-scans the whole prefix per candidate").toBeGreaterThan(
      TOKENS.length,
    );
  });

  it("the headline: session path makes STRICTLY FEWER full-prefix scans than the re-scan path", () => {
    const sessionRun = countingScanner(makeOracle(grantEnv()));
    runStep(sessionRun.scanner, prefix, false);
    const rescanRun = countingScanner(makeOracle(grantEnv()));
    runStep(rescanRun.scanner, prefix, true);
    expect(sessionRun.counts.statelessScans).toBeLessThan(rescanRun.counts.statelessScans);
  });
});

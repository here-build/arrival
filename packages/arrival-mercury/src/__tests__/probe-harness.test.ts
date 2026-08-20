/**
 * The hermetic probe harness's own contract
 * (docs/foundations/arrival-scheme/provenance-by-perturbation.md §2). Proves
 * the mechanism — capability substitution at exactly one recorded crossing,
 * re-run, marks read off the result — on trivial programs, per §2.2's own
 * examples:
 *
 *   - a crossing whose output flows straight to the result  ⇒ content
 *   - a literal, unrelated to any crossing                  ⇒ ungrounded
 *   - a crossing feeding only a guard                        ⇒ selection
 *   - P4's floor: a single witness can miss a real dependence (the guard's
 *     predicate happens to hold for every witness on ONE axis); a second
 *     witness on a DIFFERENT axis is what proves it — "two is a floor, not a
 *     bound" is not decoration, it is load-bearing for this exact case.
 *
 * `attemptAll` (below) is this suite's own orchestration glue — `session.ts`
 * only runs (and throws on failure), `verdict.ts` only classifies given
 * outcomes; turning a thrown/timed-out `probe()` into a structural
 * `ProbeOutcome` is policy that belongs to whoever drives the probes, not to
 * either mechanism module.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probe, recordRun, type CallRef, type ProbeSession, type ProbeTable } from "../probe/session.js";
import { openRunnerProbeSession } from "./runner-plane.js";
import { leafVerdicts, type ProbeAttempt } from "../probe/verdict.js";
import { witnessesFor, type Witness } from "../probe/witness.js";

/** Run every witness's probe against ONE target, converting a thrown/timed-out
 *  attempt into `{ kind: "indeterminate" }` — P3's "a failed probe is
 *  indeterminate, never independent", applied at the call site that actually
 *  sees the throw. */
async function attemptAll(
  session: ProbeSession,
  source: string,
  table: ProbeTable,
  target: CallRef,
  witnesses: readonly Witness[],
): Promise<ProbeAttempt[]> {
  const attempts: ProbeAttempt[] = [];
  for (const witness of witnesses) {
    try {
      const { value } = await probe(session, source, table, target, witness.value);
      attempts.push({ witness, outcome: { kind: "value", value } });
    } catch (e) {
      attempts.push({ witness, outcome: { kind: "indeterminate", reason: e instanceof Error ? e.message : String(e) } });
    }
  }
  return attempts;
}

describe("probe harness — provenance by perturbation, Phase A", () => {
  let session: ProbeSession;

  beforeAll(async () => {
    session = await openRunnerProbeSession();
  }, 60_000);

  afterAll(async () => {
    await session.dispose();
  }, 30_000);

  it(
    "content: a crossing whose output flows straight to the result",
    { timeout: 30_000 },
    async () => {
      const table: ProbeTable = [{ call: { model: "m", prompt: "echo", schema: null, cacheKey: null }, result: "recorded-value" }];
      const source = `(infer "m" "echo")`;

      const baseline = await recordRun(session, source, table);
      // `(infer …)` egresses as a 1-element list (`arrivalInferCapability`'s
      // `inferList` wrapping) — a 1-element JS array on this side of the membrane.
      expect(baseline.value).toEqual(["recorded-value"]);
      expect(baseline.calls).toHaveLength(1);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor("recorded-value");
      expect(witnesses.length).toBeGreaterThanOrEqual(2); // P4's floor, satisfied by construction

      const attempts = await attemptAll(session, source, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.path).toEqual([0]);
      expect(verdicts[0]!.verdict).toBe("content");
      expect(verdicts[0]!.marks).toHaveLength(1);
    },
  );

  it(
    "ungrounded: a crossing that fires but never reaches the observable result",
    { timeout: 30_000 },
    async () => {
      const table: ProbeTable = [{ call: { model: "m", prompt: "unused", schema: null, cacheKey: null }, result: "recorded-value" }];
      // Two top-level forms: the FIRST fires the crossing (so a CallRef exists to
      // target); the run's observable value is the trailing LITERAL, wholly
      // independent of it — §2.2's own "a literal ⇒ ungrounded" example, and the
      // per-form eval loop (`state.values.at(-1)`) is exactly what discards the
      // first form's value while still recording its crossing.
      const source = `(infer "m" "unused")\n"constant-result"`;

      const baseline = await recordRun(session, source, table);
      expect(baseline.value).toBe("constant-result");
      expect(baseline.calls).toHaveLength(1);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor("recorded-value");
      expect(witnesses.length).toBeGreaterThanOrEqual(2);

      const attempts = await attemptAll(session, source, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);

      expect(verdicts).toHaveLength(1); // a bare string result — one leaf, the empty path
      expect(verdicts[0]!.path).toEqual([]);
      expect(verdicts[0]!.verdict).toBe("ungrounded");
      expect(verdicts[0]!.marks).toBeUndefined();
    },
  );

  it(
    "selection: a crossing feeding only a guard",
    { timeout: 30_000 },
    async () => {
      const table: ProbeTable = [{ call: { model: "m", prompt: "flag", schema: null, cacheKey: null }, result: true }];
      // `car` extracts the boolean itself — the bare `(infer …)` list is always a
      // non-empty (truthy) pair regardless of its content, so `if` must test the
      // unwrapped value for the guard to be sensitive to it at all.
      const source = `(if (car (infer "m" "flag")) "YES" "NO")`;

      const baseline = await recordRun(session, source, table);
      expect(baseline.value).toBe("YES");
      expect(baseline.calls).toHaveLength(1);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(true); // booleans admit exactly one axis: the flip
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]!.marks).toEqual([]); // no material a boolean could ever carry

      const attempts = await attemptAll(session, source, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.path).toEqual([]);
      // Selection is a PROOF too — one witness suffices, same as content (§0's
      // asymmetry table draws the proof/refutation line at "positive vs negative",
      // not at "content vs selection").
      expect(verdicts[0]!.verdict).toBe("selection");
    },
  );

  it(
    "P4: a single witness can miss a numeric guard; a second witness on a different axis proves it",
    { timeout: 30_000 },
    async () => {
      const table: ProbeTable = [{ call: { model: "m", prompt: "count", schema: null, cacheKey: null }, result: 5 }];
      const source = `(if (>= (car (infer "m" "count")) 0) "POS" "NEG")`;

      const baseline = await recordRun(session, source, table);
      expect(baseline.value).toBe("POS");

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(5); // number witnesses: [content: positive sentinel, shape: negative sentinel]
      expect(witnesses.map((w) => w.axis)).toEqual(["content", "shape"]);

      // A CONTENT-ONLY probe: the content witness is (by construction) still a
      // positive sentinel, so `(>= … 0)` stays true — "POS" never moves. Read in
      // isolation this looks like "ungrounded", which would be WRONG: the leaf
      // genuinely depends on the crossing, just not on its CONTENT.
      const contentOnly = await attemptAll(session, source, table, target, [witnesses[0]!]);
      const contentOnlyVerdicts = leafVerdicts(baseline.value, contentOnly);
      expect(contentOnlyVerdicts[0]!.verdict).toBe("ungrounded");

      // Add the SHAPE witness (the sign flip): the guard now flips to "NEG" — a
      // real dependence, proved, with no mark material present (selection, not
      // content — the guard chose between the program's own two string constants).
      const both = await attemptAll(session, source, table, target, witnesses);
      const bothVerdicts = leafVerdicts(baseline.value, both);
      expect(bothVerdicts[0]!.verdict).toBe("selection");
    },
  );
});

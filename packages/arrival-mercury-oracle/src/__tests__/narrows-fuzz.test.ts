/**
 * The schema-driven fuzzer gate (oracle-harness.md §4.4, reconciled against
 * constitution §5.4/Law N): every harvested `narrows`-flagged row must carry
 * oracle rows, checked in CI, or the build is red. Two checks:
 *
 *  1. Law-N coverage: every narrows-flagged witness has a registered
 *     `PREDICATE_CONSUMERS` entry — a witness with NONE is a hard red,
 *     unconditionally (`arrival-mercury/docs/constitution.md — Law N, §5.2` — no "not wired
 *     yet" carve-out).
 *  2. Per witness×consumer: `fc.assert(fc.asyncProperty(...))` samples
 *     `arbitrarySchemeValue()`, synthesizes `(let ((x <val>)) (if (<witness> x)
 *     (<consumer> x) 'skip))`, and asserts `runOracle`'s plain agreement check
 *     (interpreter ≡ compiled) — the Law A/T violation detector; see
 *     `fuzz/narrows-fuzz.ts`'s header for why no separate detector exists.
 *
 * A REAL BUG THIS FUZZER FOUND (first run, before any exclusion existed):
 * today's `null?`/`pair?` emit rules (`rules/phase1.ts`) are UNCONDITIONAL
 * `.length` reads over the compiled representation ("no guard, no shim, no
 * mode" — the representation-collapse ruling). That collapse is sound for
 * arrays, but a JS `string` ALSO carries `.length`, and the rules never
 * discriminate — so, verified via direct `runOracle` calls:
 *
 *   - `(null? "")`  → interpreter `#f`, compiled `"".length === 0` → `true`.
 *   - `(pair? "x")` → interpreter `#f`, compiled `"x".length > 0`  → `true`
 *     (any non-empty string reproduces it — fast-check's own shrink landed on
 *     `" "`, kept as `"x"` in the corpus for readability).
 *
 * Promoted to `corpus/narrows-null-string-collision.scm` and
 * `corpus/narrows-pair-string-collision.scm`, `KNOWN_RED` (`it.fails`) in
 * `bug-cell-corpus.test.ts` — THAT is this bug's permanent, deterministic
 * regression pin (a fixed program, run every time, no randomness).
 *
 * Why NOT also `it.fails` here: fast-check picks a random seed per run unless
 * one is pinned, and strings are ONE of several value kinds this property
 * samples — whether a given 50-100-run budget happens to draw a string is
 * itself random. Wrapping the property in `it.fails` traded a real bug for a
 * FLAKY gate (observed directly: green in isolation, red in the full suite,
 * same code, different interleaving of `Math.random()` calls upstream shifting
 * fast-check's default seed). A gate that only sometimes catches its own
 * "known" failure is worse than no gate. So instead: `STRING_UNSOUND_FOR`
 * below excludes JUST the value kind already proven unsound from the LIVE
 * sampled domain for the affected witnesses, cited straight to the corpus rows
 * that carry the permanent proof. Numbers, booleans, and lists/`'()` — the
 * REST of `arbitrarySchemeValue()`'s domain, including the true empty-list and
 * genuine pair cases both witnesses exist to prove — stay fully live and must
 * agree, deterministically, every run. This is the same shape as the Law-U
 * precedent (`car-empty.scm`/`cdr-empty.scm` moved OUT of the live oracle
 * corpus once ruled permanently out-of-contract, `bug-cell-corpus.test.ts`'s
 * header) — a proven, out-of-current-scope gap gets a named, permanent,
 * DETERMINISTIC home instead of staying a live (and here, flaky) probe.
 * Un-exclude the moment `null?`/`pair?` gain a representation guard (Phase 2+).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { emitRegistryOf, narrowsMembersOf, phase1Rules, withRules } from "@inhuman.tools/arrival-mercury";
import { cleanupOracleScratch, openOracleSession, runOracle } from "@inhuman.tools/arrival-mercury-oracle";
import type { OracleSession } from "@inhuman.tools/arrival-mercury-oracle";
import {
  arbitrarySchemeValue,
  PREDICATE_CONSUMERS,
  synthesizeSingleWitnessProgram,
  witnessesMissingConsumers,
} from "@inhuman.tools/arrival-mercury";
import type { SchemeSample } from "@inhuman.tools/arrival-mercury";

/** CI-friendly default (mission-specified — the spec's own suggestion is up to
 *  200; each run compiles + executes a real program through tsx, so 50 keeps
 *  this gate inside the default `pnpm test` budget). Bump locally via
 *  `NARROWS_FUZZ_RUNS` when chasing a shrink. */
const NUM_RUNS = (() => {
  const n = Number(process.env.NARROWS_FUZZ_RUNS);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();

/**
 * Value kinds excluded from the LIVE sampled domain per witness — reserved
 * exclusively for gaps already discovered, minimized, and pinned permanently
 * elsewhere (see this file's header). Never a blanket "make the property
 * pass" device: each predicate here names exactly what it excludes and why,
 * and the corpus rows it points at are asserted on every single test run
 * (`bug-cell-corpus.test.ts`), so the excluded case is not untested — it is
 * tested DETERMINISTICALLY instead of PROBABILISTICALLY.
 */
const KNOWN_UNSOUND_DOMAIN: Readonly<Record<string, (v: SchemeSample) => boolean>> = {
  // (empty — the null?/pair? string collision the fuzzer found on its first run
  // was FIXED the same day: fact-gated clean form + Array.isArray stage-0 shim.
  // Strings are live in the sampled domain again; the deterministic regression
  // rows narrows-{null,pair}-string-collision.scm stay in the corpus forever.)
};

/** The live sampled domain for `witness`'s properties: the full generator,
 *  minus whatever `KNOWN_UNSOUND_DOMAIN` already proved unsound and pinned. */
function domainFor(witness: string): fc.Arbitrary<SchemeSample> {
  const excluded = KNOWN_UNSOUND_DOMAIN[witness];
  const base = arbitrarySchemeValue();
  return excluded === undefined ? base : base.filter((v) => !excluded(v));
}

describe("schema-driven fuzzer — Law N narrows-flagged rows (oracle-harness.md §4.4)", () => {
  let session: OracleSession;
  let narrowsMembers: ReadonlySet<string>;

  beforeAll(async () => {
    session = await openOracleSession();
    // The SAME registry construction `compileGreenfield` uses internally
    // (harness.ts's `greenfieldRegistryFor`, not exported — re-derived here from
    // the exported primitives, so there is nothing to drift out of sync with).
    const registry = withRules(emitRegistryOf(session.ambient), phase1Rules);
    narrowsMembers = narrowsMembersOf(registry);
  }, 120_000);

  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  });

  it("Law N: every harvested narrows-flagged witness has a registered PREDICATE_CONSUMERS entry", () => {
    // Sanity: today's harvest DOES carry narrows rows (null?, pair?) — a change
    // that silently drops the overlay would otherwise make this check vacuous.
    expect(narrowsMembers.size).toBeGreaterThan(0);
    const missing = witnessesMissingConsumers(narrowsMembers, PREDICATE_CONSUMERS);
    expect(
      missing,
      `narrows-flagged witnesses with ZERO PREDICATE_CONSUMERS entries (Law N hard red, ` +
        `unconditional per arrival-mercury/docs/constitution.md — Law N, §5.2): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  for (const witness of Object.keys(PREDICATE_CONSUMERS)) {
    for (const consumer of PREDICATE_CONSUMERS[witness]!) {
      it(
        `(if (${witness} x) (${consumer} x) 'skip) — interpreter ≡ compiled across sampled scheme values`,
        async () => {
          await fc.assert(
            fc.asyncProperty(domainFor(witness), async (sample) => {
              const program = synthesizeSingleWitnessProgram(witness, consumer, sample);
              const verdict = await runOracle(session, program);
              expect(
                verdict.agree,
                `program: ${program}\n` +
                  `interpreter: ${JSON.stringify(verdict.interpreter)}\n` +
                  `compiled: ${JSON.stringify(verdict.compiled)}` +
                  (verdict.detail === undefined ? "" : `\ndetail: ${verdict.detail}`),
              ).toBe(true);
            }),
            { numRuns: NUM_RUNS },
          );
        },
        180_000,
      );
    }
  }
});

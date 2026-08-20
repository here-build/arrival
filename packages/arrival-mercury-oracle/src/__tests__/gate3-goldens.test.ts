/**
 * Gate 3 (quality) — full-pipeline emitted TEXT goldens for the constitution's
 * named hard cases (§9: "goldens vs the `goldenEpoch: 1` baseline on the hard
 * cases: multi-list map, first-class car via eta — the instantiated-signature
 * golden, async-map→`Promise.all`, `apply` patterns, short-circuit").
 *
 * Each fixture runs through `compileGreenfield` — the SAME gate-authoritative
 * subject the oracle's bug-cell corpus executes (constitution §9's dual-path
 * rule) — and its committed `.golden.ts` snapshot is the observed bytes,
 * verbatim. This is deliberately NOT `cross-pass-fixtures.test.ts`'s slice
 * (facts → residual via bare `walk()`/`render()`, no FRAME/ASYNC-IFY, no
 * oracle wrap): Gate 3 pins what the REAL emitted artifact looks like,
 * imports and async plane included, where cross-pass pins the type-facts→
 * residual DECISION in isolation. Two different questions, two different
 * fixture directories, no collision — see `fixtures/gate3/REBASE_LOG.md`
 * (this suite's own rebase log, separate from `fixtures/cross-pass/
 * REBASE_LOG.md`).
 *
 * Fixtures are fs-based: `fixtures/gate3/<name>.scm` is a leading `;`-comment
 * header (prose only, ignored by the parser) followed by the scheme program
 * verbatim. `import.meta.glob` loads every `.scm` in the directory eagerly as
 * raw text — no inline-string fixture modules, no hand-maintained case list.
 *
 * A byte-change to any committed `.golden.ts` snapshot below is a REVIEWED
 * diff, never silent drift (constitution §8's regenerable-by-design stance):
 * re-run with `-u`, confirm the new bytes are the intended lens/rule flip,
 * and log it in REBASE_LOG.md before committing the updated fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileGreenfield } from "@inhuman.tools/arrival-mercury-oracle";
import type { OracleSession } from "@inhuman.tools/arrival-mercury-oracle";
import { openRunnerOracleSession } from "./runner-plane.js";

const sources = import.meta.glob("./fixtures/gate3/*.scm", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const nameOf = (path: string): string => path.replace(/^.*\//, "").replace(/\.scm$/, "");

const sourceByName: Record<string, string> = Object.fromEntries(
  Object.entries(sources).map(([path, source]) => [nameOf(path), source]),
);
const sourceNamed = (name: string): string => {
  const source = sourceByName[name];
  if (source === undefined) {
    throw new Error(`gate3 fixture "${name}" not found — was fixtures/gate3/${name}.scm renamed or removed?`);
  }
  return source;
};

describe("Gate 3 — full-pipeline emitted TEXT goldens", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openRunnerOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  for (const [path, source] of Object.entries(sources)) {
    const name = nameOf(path);
    it(`${name} matches its committed golden`, async () => {
      await expect(compileGreenfield(session, source)).toMatchFileSnapshot(path.replace(/\.scm$/, ".golden.ts"));
    });
  }

  it("every case actually exercises the pattern it claims to (a golden that silently degrades to a door is not a golden)", () => {
    const multiListMap = compileGreenfield(session, sourceNamed("multi-list-map"));
    const asyncMapPromiseAll = compileGreenfield(session, sourceNamed("async-map-promise-all"));
    const applyPlus = compileGreenfield(session, sourceNamed("apply-plus"));
    const applyMapTranspose = compileGreenfield(session, sourceNamed("apply-map-transpose"));
    const shortCircuitOr = compileGreenfield(session, sourceNamed("short-circuit-or"));
    const firstClassCarHof = compileGreenfield(session, sourceNamed("first-class-car-hof"));
    const legibilityDestructure = compileGreenfield(session, sourceNamed("legibility-destructure"));

    expect(multiListMap).toContain(".map((__item, __i) =>");
    // goldenEpoch 4 (R-G3): the tail-await elision drops the outer `await`
    // (nothing downstream of OracleMain's own return observes the resolved
    // value) — `Promise.all(` alone still proves the .map collapse fired
    // rather than silently degrading to a plain, unbatched `.map`.
    expect(asyncMapPromiseAll).toContain("Promise.all(");
    expect(applyPlus).toContain(".reduce(");
    // E2 ingestion fold (engine plan §2 E2): the transposed list-of-lists
    // is now a literal array chunk, not a `list(...)` call — the spread
    // still spreads a genuine array, `apply`'s own pattern under test
    // (never degrading to a door) is unaffected.
    expect(applyMapTranspose).toContain("...[");
    // goldenEpoch 5 (R-G6): static prevaluation folds the whole three-operand
    // `or` to its one live value — there is no runtime guard left to assert
    // on. The honest non-degradation check flips from "the guard shape is
    // there" to "the dead branch is truly GONE, not merely unreached at
    // runtime": no `error` survives anywhere in the output (import or call),
    // and the surviving literal is exactly the provably-true second operand.
    expect(shortCircuitOr).not.toContain("error");
    expect(shortCircuitOr).toContain('return "a"');
    // goldenEpoch 2 (R5c): eta now expands `car` inline — the pattern under test
    // flipped from "eta degrades to shim" to "eta actually fires", so the honest
    // non-degradation check is the opposite shape: no bare `car` shim survives
    // (neither as an import nor as a value-position reference), AND the eta-built
    // arrow is really there.
    expect(firstClassCarHof).not.toContain("car");
    expect(firstClassCarHof).toContain(".map(([head]) => head)");
    expect(legibilityDestructure).toContain("([first, second]) => first + second");
  });
});

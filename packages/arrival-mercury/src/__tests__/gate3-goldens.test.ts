/**
 * Gate 3 (quality) — full-pipeline emitted TEXT goldens for the constitution's
 * named hard cases (§9: "goldens vs the `goldenEpoch: 1` baseline on the hard
 * cases: multi-list map, first-class car via eta — the instantiated-signature
 * golden, async-map→`Promise.all`, `apply` patterns, short-circuit").
 *
 * Each fixture runs through `compileGreenfield` — the SAME gate-authoritative
 * subject the oracle's bug-cell corpus executes (constitution §9's dual-path
 * rule) — and its committed `golden` is the observed bytes, verbatim. This is
 * deliberately NOT `cross-pass-fixtures.test.ts`'s slice (facts → residual via
 * bare `walk()`/`render()`, no FRAME/ASYNC-IFY, no oracle wrap): Gate 3 pins
 * what the REAL emitted artifact looks like, imports and async plane included,
 * where cross-pass pins the type-facts→residual DECISION in isolation. Two
 * different questions, two different fixture directories, no collision — see
 * `fixtures/gate3/REBASE_LOG.md` (this suite's own rebase log, separate from
 * `fixtures/cross-pass/REBASE_LOG.md`).
 *
 * A byte-change to any committed golden below is a REVIEWED diff, never
 * silent drift (constitution §8's regenerable-by-design stance): re-run,
 * confirm the new bytes are the intended lens/rule flip, and log it in
 * REBASE_LOG.md before committing the updated fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileGreenfield, openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";
import * as applyMapTranspose from "./fixtures/gate3/apply-map-transpose.golden.js";
import * as applyPlus from "./fixtures/gate3/apply-plus.golden.js";
import * as asyncMapPromiseAll from "./fixtures/gate3/async-map-promise-all.golden.js";
import * as firstClassCarHof from "./fixtures/gate3/first-class-car-hof.golden.js";
import * as multiListMap from "./fixtures/gate3/multi-list-map.golden.js";
import * as shortCircuitOr from "./fixtures/gate3/short-circuit-or.golden.js";

const CASES = [
  { name: "multi-list map (the zip bridge)", fixture: multiListMap },
  { name: "async-map → Promise.all (Law W's .map collapse)", fixture: asyncMapPromiseAll },
  { name: "apply patterns: apply-plus reduce", fixture: applyPlus },
  { name: "apply patterns: apply-map-transpose", fixture: applyMapTranspose },
  { name: "short-circuit or-chain (guarded cascade, nested)", fixture: shortCircuitOr },
  { name: "first-class car in HOF position (eta degrades to shim, today)", fixture: firstClassCarHof },
] as const;

describe("Gate 3 — full-pipeline emitted TEXT goldens", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  for (const { name, fixture } of CASES) {
    it(`${name} matches its committed golden`, () => {
      expect(compileGreenfield(session, fixture.source)).toBe(fixture.golden);
    });
  }

  it("every case actually exercises the pattern it claims to (a golden that silently degrades to a door is not a golden)", () => {
    expect(multiListMap.golden).toContain(".map((__item, __i) =>");
    expect(asyncMapPromiseAll.golden).toContain("await Promise.all(");
    expect(applyPlus.golden).toContain(".reduce(");
    expect(applyMapTranspose.golden).toContain("...list(");
    expect(shortCircuitOr.golden).toContain("!== false ?");
    expect(firstClassCarHof.golden).toContain(".map(car)");
  });
});

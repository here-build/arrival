/**
 * Determinism law (constitution §8): pure functions over the greenfield
 * pipeline → same bytes. CI: compile twice, byte-compare.
 *
 * Gate-authoritative subject only: `compileGreenfield` (classify → model views
 * → walk → materialize → render). The string emit path is deleted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileGreenfield } from "@inhuman.tools/arrival-mercury-oracle";
import type { OracleSession } from "@inhuman.tools/arrival-mercury-oracle";
import { openRunnerOracleSession } from "./runner-plane.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const read = (name: string): string => readFileSync(`${corpusDir}${name}.scm`, "utf8");

const SUBJECTS = ["truthy-zero-then", "quotient-neg", "apply-map-transpose"] as const;

describe("determinism — greenfield double-compile byte-compare", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openRunnerOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  for (const subject of SUBJECTS) {
    it(
      `${subject} — greenfield pipeline`,
      () => {
        const source = read(subject);
        const first = compileGreenfield(session, source);
        const second = compileGreenfield(session, source);
        expect(second).toBe(first);
      },
      120_000,
    );
  }
});

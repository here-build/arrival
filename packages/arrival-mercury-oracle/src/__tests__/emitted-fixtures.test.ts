/**
 * FS-BASED EMISSION FIXTURES — every corpus program's compiled artifact as a real,
 * committed, browsable `.ts` file (constitution §8: emitted output is a regenerable
 * artifact; churn reviews like lockfile churn — a residual flip in a diff is
 * information, not noise).
 *
 * Layout: for each `corpus/<name>.scm` and `fixtures/gate1-corpus/<name>.scm`,
 * the greenfield pipeline's emission lands at `fixtures/emitted/<name>.ts`
 * (or `<name>.error.txt` when the program doors/throws at compile time —
 * a door is an artifact too).
 *
 * Workflow:
 *   - add a case: drop a `.scm` into corpus/ — the fixture materializes on the
 *     next `pnpm test -u` and the suite fails until it's committed.
 *   - regenerate after an emitter change: `pnpm test -u`, review the diff like
 *     a lockfile (every changed byte is a residual decision that moved).
 *   - CI: a missing or stale fixture is a hard red (vitest file snapshots
 *     never auto-write in CI).
 *
 * This doubles as the Gate-3 sign-off surface: read fixtures/emitted/ as a PR.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupOracleScratch, compileGreenfield, openOracleSession } from "@inhuman.tools/arrival-mercury-oracle";
import type { OracleSession } from "@inhuman.tools/arrival-mercury-oracle";

const dirOf = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const casesFrom = (rel: string): { name: string; source: string }[] =>
  readdirSync(dirOf(rel))
    .filter((f) => f.endsWith(".scm"))
    .sort()
    .map((f) => ({
      name: f.slice(0, -".scm".length),
      source: readFileSync(dirOf(rel) + f, "utf8"),
    }));

const CASES = [...casesFrom("corpus/"), ...casesFrom("../../../arrival-mercury/src/__tests__/fixtures/gate1-corpus/")];
if (CASES.length === 0) throw new Error("emitted-fixtures: no .scm cases found — corpus/ and gate1-corpus/ are empty?");

let session: OracleSession;
beforeAll(async () => {
  session = await openOracleSession();
}, 120_000);
afterAll(async () => {
  await session.dispose();
  cleanupOracleScratch();
});

describe("emitted fixtures — one committed .ts per corpus program", () => {
  for (const { name, source } of CASES) {
    it(
      name,
      async () => {
        let emitted: string;
        let doored: string | undefined;
        try {
          emitted = compileGreenfield(session, source);
        } catch (e) {
          // A compile-time refusal is itself the artifact: snapshot the message
          // (first line — stable teaching text; stacks would churn meaninglessly).
          doored = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
          emitted = "";
        }
        if (doored !== undefined) {
          await expect(`${doored}\n`).toMatchFileSnapshot(dirOf(`fixtures/emitted/${name}.error.txt`));
        } else {
          await expect(emitted).toMatchFileSnapshot(dirOf(`fixtures/emitted/${name}.ts`));
        }
      },
      120_000,
    );
  }
});

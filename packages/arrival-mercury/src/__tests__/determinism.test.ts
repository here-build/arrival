/**
 * Determinism law (constitution §8, Phase-0 checklist item 6): "within a
 * compile: pure functions over (CoreForm, facts, config) → same bytes. CI:
 * compile twice, byte-compare." String identity IS the byte compare — same
 * code units.
 *
 * TWO subjects, mirroring the oracle's §9 dual-path rule:
 *
 * 1. GREENFIELD (gate-authoritative) — `compileGreenfield`, the exact
 *    classify → extractFacts → walk → ASYNC-IFY → FRAME → render pipeline the
 *    oracle executes, byte-compared across two compiles under ONE session
 *    (same harvested registry — determinism *within* a registry is the §8
 *    claim; cross-session identity is the type-snapshot-hash story).
 * 2. LEGACY (production bridge, kept as-is) — mercury's `projectToJs` (read
 *    view + run view under every registered strategy) and `compileProject`
 *    (the multi-file emitter, so EVERY emitted file is compared).
 *
 * Subjects are corpus programs chosen for distinct lowering paths: `if`
 * lowering (Law T guard), BINOP/Math.trunc, and the apply/map transpose
 * (quote datum + generic-spread apply + shim imports through FRAME).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject, projectToJs, STRATEGIES } from "@inhuman.tools/mercury";
import type { EmittedFile } from "@inhuman.tools/mercury";

import { compileGreenfield, openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const read = (name: string): string => readFileSync(`${corpusDir}${name}.scm`, "utf8");

const SUBJECTS = ["truthy-zero-then", "quotient-neg", "apply-map-transpose"] as const;
const STRATEGY_ENTRIES = Object.entries(STRATEGIES).sort(([a], [b]) => a.localeCompare(b));

describe("determinism — greenfield double-compile byte-compare", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
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

describe("determinism — legacy double-compile byte-compare", () => {
  for (const subject of SUBJECTS) {
    it(
      `${subject} — read view`,
      async () => {
        const source = read(subject);
        const first = await projectToJs(source, { target: "read" });
        const second = await projectToJs(source, { target: "read" });
        expect(second).toBe(first);
      },
      120_000,
    );

    for (const [id, strategy] of STRATEGY_ENTRIES) {
      it(
        `${subject} — run view, ${id}`,
        async () => {
          const source = read(subject);
          const first = await projectToJs(source, { target: "run", strategy });
          const second = await projectToJs(source, { target: "run", strategy });
          expect(second).toBe(first);
        },
        120_000,
      );
    }
  }

  it(
    "compileProject — every emitted file byte-identical across two compiles",
    async () => {
      const files = { "main.scm": read("apply-map-transpose") };
      const byPath = (emitted: EmittedFile[]): EmittedFile[] =>
        [...emitted].sort((a, b) => a.path.localeCompare(b.path));
      const first = byPath(await compileProject(files, "main.scm", {}));
      const second = byPath(await compileProject(files, "main.scm", {}));
      expect(second.map((f) => f.path)).toEqual(first.map((f) => f.path));
      for (const [i, f] of first.entries()) {
        expect(second[i]!.content, `content drift in ${f.path}`).toBe(f.content);
      }
    },
    180_000,
  );
});

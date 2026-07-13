/**
 * Determinism law (constitution §8, Phase-0 checklist item 6): "within a
 * compile: pure functions over (CoreForm, facts, config) → same bytes. CI:
 * compile twice, byte-compare." Subject is the Phase-0 production bridge —
 * mercury's `projectToJs` (read view + run view under every registered
 * strategy) and `compileProject` (the multi-file emitter, so EVERY emitted
 * file is compared). String identity IS the byte compare — same code units.
 *
 * Subjects are corpus programs that compile under today's emitters, chosen
 * for distinct lowering paths: `if` lowering, BINOP/Math.trunc, and the
 * apply/map transpose emitter.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject, projectToJs, STRATEGIES } from "@inhuman.tools/mercury";
import type { EmittedFile } from "@inhuman.tools/mercury";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const read = (name: string): string => readFileSync(`${corpusDir}${name}.scm`, "utf8");

const SUBJECTS = ["truthy-zero-then", "quotient-neg", "apply-map-transpose"] as const;
const STRATEGY_ENTRIES = Object.entries(STRATEGIES).sort(([a], [b]) => a.localeCompare(b));

describe("determinism — double-compile byte-compare", () => {
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

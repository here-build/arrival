/**
 * INV-6 — path-univalence (field-granular-access.md §7, README.md §4): for
 * every build-decomposable path, the RUN VALUE read at that path is the
 * runtime value `extract` attributed there. This promotes `seal()`'s cited-
 * but-untested egress convention (attest-provider.ts's `staticLeavesOf` "WHY
 * THIS IS SOUND, NOT INVENTED" block: `BuildProv.parts[i].key` === the
 * runtime egress address, cons→2-array, dict→object) from a comment to a
 * green corpus sweep — the single biggest trusted-base reduction the whole
 * lens buys.
 *
 * Method: for each small corpus program, run it for REAL
 * (`probe/session.ts`'s `recordRun`, over `@inhuman.tools/arrival`'s own
 * interpreter — the SAME mechanism `probe-harness.test.ts` exercises) to get
 * the baseline egress value, walk its EXTRACTED circuit's `BuildProv` parts
 * recursively (mirrors mcp-worker's `attest-provider.ts::staticLeavesOf` —
 * reimplemented locally here, never imported: this package must never
 * depend on mcp-worker) to enumerate every build-decomposable leaf path,
 * then INDEPENDENTLY re-run just that leaf's own subexpression (a
 * "projection" — the exact source snippet `extract` attributed to that
 * path, authored by hand alongside the main program, never a hand-derived
 * JS value) over the SAME probe table and compare via a local `readAtPath`.
 * Two real interpreter runs agreeing at a path is a stronger proof than
 * comparing against an author-asserted constant: it holds regardless of
 * whatever wrapping/egress convention either run happens to use — the
 * convention is OBSERVED, never assumed.
 *
 * Every mismatch found by this sweep is a REAL finding (a `descend`/extract
 * disagreement about where a value lives) — report it, never paper over it
 * with a `toContain`/partial match.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { extractProgram } from "../../extract/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import type { StaticProv } from "../../model/static-prov.js";
import { recordRun, type ProbeSession, type ProbeTable } from "../../probe/session.js";
import { openRunnerProbeSession } from "../runner-plane.js";
import { fieldProv, type FieldPath } from "../../verdict/field-prov.js";

const extractOf = (src: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(src)));
  return extractProgram(forms, defaultRegistry);
};

interface BuildLeaf {
  readonly path: FieldPath;
  readonly prov: StaticProv;
}

/** Mirrors mcp-worker's `attest-provider.ts::staticLeavesOf` exactly — walk
 *  `BuildProv` parts recursively, stopping at the first non-build kind.
 *  Reimplemented locally (this package must never import mcp-worker; the
 *  point of this sweep is an INDEPENDENT walk, not a shared one). */
function enumerateBuildPaths(prov: StaticProv, path: FieldPath = []): readonly BuildLeaf[] {
  if (prov.kind === "build") {
    return prov.parts.flatMap((part) => enumerateBuildPaths(part.prov, [...path, part.key]));
  }
  return [{ path, prov }];
}

const ABSENT = Symbol("path-univalence:absent-path");

/** A tiny local `readAtPath` over the interpreter's egress JS values — object
 *  keys and array indexes — mirroring attest-provider.ts's own (private to
 *  that module) helper and probe/verdict.ts's `readPath`. Reimplemented here
 *  per this suite's own charge ("implement a tiny local readAtPath"). */
function readAtPath(value: unknown, path: FieldPath): unknown {
  let cur: unknown = value;
  for (const step of path) {
    if (Array.isArray(cur) && typeof step === "number") {
      if (step < 0 || step >= cur.length) return ABSENT;
      cur = cur[step];
    } else if (typeof cur === "object" && cur !== null && !Array.isArray(cur) && typeof step === "string") {
      if (!Object.hasOwn(cur, step)) return ABSENT;
      cur = (cur as Record<string, unknown>)[step];
    } else {
      return ABSENT;
    }
  }
  return cur;
}

interface CorpusCase {
  readonly name: string;
  readonly source: string;
  readonly table: ProbeTable;
  /** One projection per EXPECTED build-decomposable leaf — the exact source
   *  snippet `extract` attributed to that path (never a hand-derived JS
   *  value), run standalone over the SAME table. */
  readonly projections: readonly { readonly path: FieldPath; readonly source: string }[];
}

const CORPUS: readonly CorpusCase[] = [
  {
    name: "flat dict — literal + define/overridable input + infer crossing",
    source: `(define/overridable e (s/string) "hello-input")\n(dict :label "FIXED-LITERAL" :echoed e :fromCrossing (infer "m" "p"))`,
    table: [{ call: { model: "m", prompt: "p", schema: null, cacheKey: null }, result: "CROSSING-VALUE" }],
    projections: [
      { path: ["label"], source: `"FIXED-LITERAL"` },
      { path: ["echoed"], source: `(define/overridable e (s/string) "hello-input")\ne` },
      { path: ["fromCrossing"], source: `(infer "m" "p")` },
    ],
  },
  {
    name: "nested dict-of-dict + list — recursive build decomposition",
    source: `(define/overridable count (s/number) 3)\n(dict :meta (dict :version "v1" :count count) :items (list "a" "b" (infer "m2" "q")))`,
    table: [{ call: { model: "m2", prompt: "q", schema: null, cacheKey: null }, result: "M2-RESULT" }],
    projections: [
      { path: ["meta", "version"], source: `"v1"` },
      { path: ["meta", "count"], source: `(define/overridable count (s/number) 3)\ncount` },
      { path: ["items", 0], source: `"a"` },
      { path: ["items", 1], source: `"b"` },
      { path: ["items", 2], source: `(infer "m2" "q")` },
    ],
  },
  {
    name: "cons pair — pins cons→[head,tail]",
    source: `(cons "HEAD-LIT" (infer "m3" "r"))`,
    table: [{ call: { model: "m3", prompt: "r", schema: null, cacheKey: null }, result: "M3-RESULT" }],
    projections: [
      { path: [0], source: `"HEAD-LIT"` },
      { path: [1], source: `(infer "m3" "r")` },
    ],
  },
];

describe("INV-6 — path-univalence sweep", () => {
  let session: ProbeSession;

  beforeAll(async () => {
    session = await openRunnerProbeSession();
  }, 60_000);

  afterAll(async () => {
    await session.dispose();
  }, 30_000);

  for (const testCase of CORPUS) {
    it(
      `${testCase.name} — every build-decomposable path's egress value agrees with an independent projection run`,
      { timeout: 30_000 },
      async () => {
        const circuit = extractOf(testCase.source);
        const leaves = enumerateBuildPaths(circuit);

        // Self-check: the corpus entry's declared projections must cover
        // EXACTLY the paths extract's own circuit produces — a mismatch
        // here is itself a finding (either the corpus is stale, or extract's
        // key-minting alphabet moved under it).
        const expectedPaths = testCase.projections.map((p) => JSON.stringify(p.path)).sort();
        const actualPaths = leaves.map((l) => JSON.stringify(l.path)).sort();
        expect(actualPaths).toEqual(expectedPaths);

        const baseline = await recordRun(session, testCase.source, testCase.table);

        for (const { path, source: projectionSource } of testCase.projections) {
          const projected = await recordRun(session, projectionSource, testCase.table);
          const atPath = readAtPath(baseline.value, path);
          expect(atPath === undefined ? "<absent>" : atPath, `path ${JSON.stringify(path)} in "${testCase.name}"`).toEqual(
            projected.value === undefined ? "<absent>" : projected.value,
          );
        }
      },
    );
  }

  // ── pin the egress faces (§7/README §4's cited convention, checked directly) ──

  it("cons egresses as a 2-element array — the cons→[head,tail] face", async () => {
    const consCase = CORPUS[2]!;
    const baseline = await recordRun(session, consCase.source, consCase.table);
    expect(Array.isArray(baseline.value)).toBe(true);
    expect(baseline.value).toHaveLength(2);
  });

  it("dict egresses as a plain object, never an array — the dict→object face", async () => {
    const dictCase = CORPUS[0]!;
    const baseline = await recordRun(session, dictCase.source, dictCase.table);
    expect(Array.isArray(baseline.value)).toBe(false);
    expect(typeof baseline.value).toBe("object");
    expect(baseline.value).not.toBeNull();
  });

  it("list egresses as a JS array, by position — the list→array face", async () => {
    const listCase = CORPUS[1]!;
    const baseline = await recordRun(session, listCase.source, listCase.table);
    const items = (baseline.value as Record<string, unknown>)["items"];
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(3);
  });

  // ── the frontier — reading PAST a build-decomposable leaf, via fieldProv ────

  it("frontier: fieldProv stops at the mint, but the FULL path still reads the crossing's recorded value (§2.4/§4.1's 'static-coarse, dynamic-exact')", async () => {
    const dictCase = CORPUS[0]!;
    const circuit = extractOf(dictCase.source);
    const result = fieldProv(circuit, ["fromCrossing", 0]);
    expect(result.kind).toBe("cone");
    if (result.kind !== "cone") throw new Error("unreachable — asserted above");
    expect(result.cone.kind).toBe("mint");
    expect(result.frontier).toEqual({ remainder: [0] });

    const baseline = await recordRun(session, dictCase.source, dictCase.table);
    // The static plane stopped at the mint (a compound-or-not runtime value
    // it cannot see inside); the DYNAMIC leg still reads the FULL original
    // path against the real value — here, index 0 of the wrapped crossing —
    // landing exactly on the table's own recorded result.
    expect(readAtPath(baseline.value, ["fromCrossing", 0])).toBe("CROSSING-VALUE");
  });
});

/**
 * Cross-pass fixtures (constitution §5.3, ⚖️ owned by typefacts-extraction): per
 * representative corpus row, the (virtual-TS snippet, extracted facts, chosen
 * residual) triple — the first two columns are `extractFacts`' own outputs; the
 * residual is a READ-ONLY third column produced by the SAME
 * classify→extractFacts→walk→render slice `walker.test.ts` exercises directly
 * (never a re-derivation of the oracle's own `(define (__oracle-main) …)`-wrapped
 * pipeline — the oracle stays black-box; the two suites share only the
 * `corpus/*.scm` TEXT, per the constitution's "two tests, one corpus, two
 * owners"). A lens/registry change that silently shifts a fact→residual decision
 * must surface here as a committed-golden diff — not hide inside a still-green
 * oracle row that only checks the final VALUE.
 *
 * goldenEpoch: 1 — constitution §9's golden discipline: a byte-change to any
 * fixture below needs a `fixtures/cross-pass/REBASE_LOG.md` entry, never a
 * silent overwrite.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractFacts, narrowsMembersOf, render, walk } from "@inhuman.tools/arrival-mercury";
import { cleanupOracleScratch, greenfieldRegistryFor } from "@inhuman.tools/arrival-mercury-oracle";
import type { ClassifyResult, CoreForm, FactsExtraction, HoleReason, NodeId, TypeFacts } from "@inhuman.tools/arrival-mercury";
import type { OracleSession } from "@inhuman.tools/arrival-mercury-oracle";
import { openRunnerOracleSession } from "./runner-plane.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const fixturesDir = fileURLToPath(new URL("fixtures/cross-pass/", import.meta.url));

/** The eight representative rows named by the mission — reused verbatim from the
 *  oracle's own `corpus/*.scm` (never copied: a corpus edit updates both suites'
 *  input in lockstep, exactly the "one corpus, two owners" contract). */
const ROWS = [
  "truthy-zero-then",
  "filter-truthy-zero",
  "modulo-neg",
  "multi-list-map",
  "or-in-define",
  "quotient-neg",
  "apply-plus",
  "member-assoc",
] as const;

// This suite owns no public walker (mirrors typefacts.test.ts's own `allNodes`
// helper) — a tiny local structural traversal, span + kind only, no scope.
function allNodes(classified: ClassifyResult): CoreForm[] {
  const out: CoreForm[] = [];
  const visit = (n: CoreForm): void => {
    out.push(n);
    switch (n.kind) {
      case "Define":
        visit(n.value);
        if (n.overridableType) visit(n.overridableType);
        break;
      case "DefineFn":
      case "Lambda":
        n.body.forEach(visit);
        break;
      case "If":
        visit(n.cond);
        visit(n.then);
        visit(n.else);
        break;
      case "And":
      case "Or":
        n.args.forEach(visit);
        break;
      case "Let":
      case "NamedLet":
        for (const b of n.bindings) visit(b.init);
        n.body.forEach(visit);
        break;
      case "Begin":
        n.body.forEach(visit);
        break;
      case "App":
        visit(n.fn);
        n.positionalArgs.forEach(visit);
        for (const kw of n.kwargs) visit(kw.value);
        break;
      case "Dict":
        for (const e of n.entries) visit(e.value);
        break;
      default:
        break; // Ref | Lit | Quote | Require | Door — leaves
    }
  };
  classified.forms.forEach(visit);
  return out;
}

interface FactRow {
  readonly span: readonly [number, number];
  readonly text: string;
  readonly kind: string;
  readonly fact?: TypeFacts;
  readonly hole?: HoleReason;
}

/** Every QUERIED node that carries a fact OR a hole — the decision points the
 *  emit pass actually reads (Law A/Law F) — keyed by SPAN, not raw NodeId: ids
 *  are a deterministic function of a fixed source's traversal order (verified by
 *  typefacts.test.ts's own determinism row), but a benign internal reordering of
 *  that traversal would renumber them without changing any real decision. Span +
 *  source text is the stable, human-legible identity a golden diff should key on. */
function factsReport(source: string, extraction: FactsExtraction): FactRow[] {
  const byId = new Map(allNodes(extraction.classified!).map((n) => [n.id, n]));
  const ids = new Set<NodeId>([...extraction.facts.keys(), ...extraction.holes.keys()]);
  const rows: FactRow[] = [...ids].map((id) => {
    const n = byId.get(id)!;
    const fact = extraction.facts.get(id);
    const hole = extraction.holes.get(id);
    return {
      span: n.span,
      text: source.slice(n.span[0], n.span[1]),
      kind: n.kind,
      ...(fact !== undefined ? { fact } : {}),
      ...(hole !== undefined ? { hole } : {}),
    };
  });
  rows.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
  return rows;
}

interface CrossPassFixture {
  readonly goldenEpoch: 1;
  readonly row: string;
  readonly source: string;
  readonly virtualTs: string;
  readonly facts: readonly FactRow[];
  readonly residual: string;
}

describe("cross-pass fixtures — (virtual-TS, facts, residual) per corpus row (constitution §5.3)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openRunnerOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  });

  for (const rowName of ROWS) {
    it(`${rowName} — (virtualTs, facts, residual) matches the committed golden`, () => {
      // The oracle's own `greenfieldRegistryFor` (harvest + srfi-1's static merge +
      // Phase-1 overlay — oracle/harness.ts's own note on the merge), now exported
      // for exactly this reason: this file used to re-derive the same composition
      // inline via `withRules(emitRegistryOf(session.ambient), phase1Rules)`, which
      // silently fell out of step the moment the real function grew the srfi-1 merge
      // (the ambient-gap fix) — one function, one registry, no second copy to drift.
      const registry = greenfieldRegistryFor(session);
      const narrowsMembers = narrowsMembersOf(registry);
      const source = readFileSync(`${corpusDir}${rowName}.scm`, "utf8");

      const extraction = extractFacts(source, { narrowsMembers });
      expect(extraction.parseFailure, `${rowName}: corpus row failed to parse`).toBe(false);
      const unit = walk(extraction.classified!, { registry, facts: extraction.facts, register: "run" });

      const fixture: CrossPassFixture = {
        goldenEpoch: 1,
        row: rowName,
        source,
        virtualTs: extraction.virtualTs,
        facts: factsReport(source, extraction),
        residual: render(unit),
      };

      const goldenPath = `${fixturesDir}${rowName}.golden.json`;
      const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as CrossPassFixture;
      expect(fixture).toEqual(golden);
    });
  }
});

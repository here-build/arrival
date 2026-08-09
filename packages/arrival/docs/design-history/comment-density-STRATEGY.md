# Comment density rework — guidelines (W13)

**Goal:** cut comment volume in `packages/arrival` by **≥50%** without losing load-bearing knowledge.  
**Mode:** human-quality adjudication per file. **No automated strippers.**  
**Law:** `~/.claude/skills/production-writing/SKILL.md` (single source).

## Findings that drive this

From the **comment-blind audit** (worktree dropped 2026-07-24):

1. **Specialness survives total strip** — doors, provenance, membrane brands, capabilities, dual-face contracts, RunContext show up in types, law tests, and error messages.
2. **Teaching doors already carry “why”** — duplicating door essays in file preambles is double bookkeeping.
3. **Dangling journal is worse than silence** — cites to deleted `docs/plans/*` / vanished design paths are STALE debt.
4. **Blind strip is not the production move** — would erase KEEP with JOURNAL. This campaign rewrites, not erases wholesale.

Baseline (non-test `src/`, ~2026-07-24): **~21.5k comment lines / ~29.4k code (~42%)**. Target: **≤ ~10.7k comments** or **≤ ~21% share**.

## Iron rules for every agent

1. **Comments only.** Zero logic/type/export changes. Whitespace only where a deleted comment leaves a blank-line mess (collapse 3+ blanks → 2).
2. **Verification:** stripping comments from before/after must leave **byte-identical code tokens** (imports, statements, signatures unchanged).
3. **Extract before delete.** If a KEEP constraint has no other home (type, test name, door `publicMessage`, `docs/*.md` §ANCHOR), rewrite it as a short present-tense pin **in-file** or note “needs law promotion” — do not silently drop.
4. **Present tense.** No “now / previously / we migrated / Stage C / ruling dated.”
5. **Do not invent new abstraction names.** Use existing vocabulary.

## Verdicts (adjudicate every comment unit)

| Verdict | Action |
|---|---|
| **KEEP** | Timeless invariant, rejected alternative with failure mode, load-bearing number, named law, R7RS/SRFI pin, intentional/deferred with why. Leave (or tighten wording only). |
| **JOURNAL** | Migration, stage/wave/cut, “we decided”, agent/swarm, export-restructure narrative, “byte-identical to the old…”, dated stamps. Extract any embedded constraint → **delete rest**. |
| **HYBRID** | Real invariant buried in plan narration. **Rewrite** as 1–5 present-tense lines; delete the essay wrapper. Main work. |
| **STALE** | Wrong about current code or cites missing paths. Fix rule in present tense or delete. |
| **NOISE** | Restates the next line, the type, or the export list. Delete. |

## What survives as body comments (five forms only)

1. Spec anchor — `// R7RS §6.2.6`
2. Drift-alarm pin — deliberate duplication / dep internal, with cite
3. Field/param constraint — units, ownership, lifecycle the type cannot show
4. Step-state in irreducible choreography
5. Intentionality / deferred — `// deferred: … why` or `// intentional, NOT a TODO: …`

Everything else body-length → code rename, or fold into **file preamble**.

## Placement ladder

1. Code itself (rename / structure)
2. One-line pin
3. Short body (local only)
4. File preamble (concept, guarantees, rejected alternatives, math)
5. `.md` only if cross-module (prefer existing `docs/environments.md`, `membrane.md`, `execution.md`, …)

**Generating-rule fold:** one rule in preamble; body sites become `// see preamble, <ANCHOR>` or nothing if obvious.

## Scrub-list (always JOURNAL unless constraint extracted)

- Stage / Wave / Phase / Cut tags; `docs/plans/*`
- “export restructure”, “Stage C”, “corpse-deletion”, “for existing importers”
- “migrated / formerly / used to / previously / no longer / landed”
- Process attribution (“we decided”, “V’s ruling” as narration — restate as rule+argument)
- Audit forensics (“grep-verified”, “N-agent”)
- Gravestones for deleted code; reassurance against vanished past

## KEEP anchors (do not gut)

- Named laws (clone law, CallCtx honesty, membrane region, purity doors, …)
- Contour vs crossing / brand bans
- Ordering and non-local choreography (init, bind, bake, C3)
- Load-bearing numbers with derivation
- Rejected alternatives **with failure modes**
- Pins to **live** docs: `docs/environments.md`, `membrane.md`, `execution.md`, `static-plane.md`, `PROVENANCE.md`, `PRINCIPLES.md`, `grammar.md`

## Density guidance

- Density ∝ invisibility — mechanical code → near-zero prose; invisible choreography may stay denser.
- **“Halve overall” is package diagnostic**, not “every file −50%”. Journal-heavy barrels may compress 5×; pure-law files barely at all.
- Public barrels (`index.ts`, `*-internals`, `capabilities/*`): map + one concept, **not** stage novels. Prefer ≤ ~25 lines preamble after rework when content allows.

## Agent deliverable (per file batch)

For each file:

1. Brief before/after comment-line count (rough is fine).
2. 3–8 bullet log: what was JOURNAL deleted / HYBRID rewritten / KEEP retained.
3. Flag any constraint that needs promotion to a named law or `docs/*.md` (do not invent the doc in-pass unless trivial one-liner in preamble).

## Out of scope

- `vendor/`, generated carriers, test fixture markdown-as-data
- `*.test.ts` / `*.test-d.ts` (unless a file is pure comment-novel setup with zero law value — skip by default)
- Code refactors “to make comments unnecessary” (separate campaign)
- Auto strip scripts

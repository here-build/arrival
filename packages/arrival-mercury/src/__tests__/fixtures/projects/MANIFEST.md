# fixtures/projects — canonical sample-program tree

Gathered 2026-07-20. Follow-up (not this task) rewires tests to read from here.

**Rules used when gathering:**
- Only writes under `fixtures/projects/`.
- Content is byte-identical to its origin (gate1 mains, multi-file companions, or
  template-evaluated inline sources for `gepa-soul` / `assess` / `canonical-four`).
- Probe-scale `src/__tests__/corpus/*.scm` is **not** copied (stays put).
- `fixtures/build-faces/*` is **not** moved (already per-project multi-file; listed as
  consolidation candidates below).

---

## Projects

### `ai-winter-ebl-investigation`

| | |
|---|---|
| **Files** | `ai-winter-ebl-investigation.scm` |
| **Gathered from** | `src/__tests__/fixtures/gate1-corpus/ai-winter-ebl-investigation.scm` |
| **Upstream origin (gate1 COPY-AS-CHUNK)** | `inhuman/examples/ai-winter-thawed/scm/ebl-investigation.scm` |
| **Description** | One worked EBL investigation over image A; the only gate1 program with a literal top-level `(infer …)` call. |
| **Consumers to rewire** | `src/gate1/measure.ts` (manifest), `src/__tests__/gate1-measure.test.ts`, `src/__tests__/emitted-fixtures.test.ts` (+ `fixtures/emitted/ai-winter-ebl-investigation.ts`) |

---

### `inhuman-gepa-full`

| | |
|---|---|
| **Files** | `inhuman-gepa-full.scm` (entry), `metric.scm`, `examples.json`, `analyze-seed.txt`, `decide-seed.txt`, `analyze.prompt`, `decide.prompt`, `reflect.prompt` |
| **Gathered from** | Entry: `src/__tests__/fixtures/gate1-corpus/inhuman-gepa-full.scm`. Companions: `inhuman/examples/inhuman-gepa-full/{metric.scm,examples.json,analyze-seed.txt,decide-seed.txt,analyze.prompt,decide.prompt,reflect.prompt}` |
| **Upstream origin (gate1 COPY-AS-CHUNK body)** | `inhuman/examples/inhuman-gepa-full/gepa.scm` |
| **Description** | Full genetic+bandit GEPA (reflective prompt evolution with efficiency engine). Densest gate1 program historically; multi-module via `require` of metric/examples/prompts. |
| **Consumers to rewire** | `src/gate1/measure.ts`, `src/__tests__/gate1-measure.test.ts`, `src/__tests__/emitted-fixtures.test.ts` (+ `fixtures/emitted/inhuman-gepa-full.ts`), comments in `src/rules/phase1.ts` |

---

### `mercury-fixture-gepa`

| | |
|---|---|
| **Files** | `mercury-fixture-gepa.scm` (entry), `metric.scm`, `examples.json`, `seed.txt`, `predict.prompt`, `improve.prompt` |
| **Gathered from** | Entry: `src/__tests__/fixtures/gate1-corpus/mercury-fixture-gepa.scm`. Companions: `inhuman/examples/inhuman-gepa/{metric.scm,examples.json,seed.txt,predict.prompt,improve.prompt}` |
| **Upstream origin (gate1 COPY-AS-CHUNK)** | Documented as `inhuman/public-packages/mercury/src/__tests__/fixtures/sources/gepa.scm` (path **absent on main tree**; present in a worktree and byte-matches `inhuman/examples/inhuman-gepa/gepa.scm`) |
| **Description** | Short/"soul" GEPA variant with `.prompt` requires — different control flow from `inhuman-gepa-full`; carries first-class `car` in HOF position + two-list `map` zip. |
| **Consumers to rewire** | `src/gate1/measure.ts`, `src/__tests__/gate1-measure.test.ts`, `src/__tests__/emitted-fixtures.test.ts` (+ `fixtures/emitted/mercury-fixture-gepa.ts`) |
| **Note** | Distinct from `gepa-soul` (below): this one uses `require` of prompts/metric; `gepa-soul` inlines `infer/chat` and examples. |

---

### `inhuman-custdev-best-tagline`

| | |
|---|---|
| **Files** | `inhuman-custdev-best-tagline.scm` (entry), `config.scm`, `_util.scm`, `personas.yaml`, `povs.yaml`, `summary-of-persona.hbs`, `triage.prompt`, `tagline-reaction.prompt`, `reflection.prompt`, `merge.prompt`, `consolidation.prompt` |
| **Gathered from** | Entry: `src/__tests__/fixtures/gate1-corpus/inhuman-custdev-best-tagline.scm`. Companions: `inhuman/examples/inhuman-custdev/{config.scm,_util.scm,personas.yaml,povs.yaml,summary-of-persona.hbs,triage.prompt,tagline-reaction.prompt,reflection.prompt,merge.prompt,consolidation.prompt}` |
| **Upstream origin** | `inhuman/examples/inhuman-custdev/best-tagline.scm` |
| **Description** | GEPA-style hill-climb for best tagline with hierarchical audience-split / worklist recursion. |
| **Consumers to rewire** | `src/gate1/measure.ts`, `src/__tests__/gate1-measure.test.ts`, `src/__tests__/emitted-fixtures.test.ts` (+ `fixtures/emitted/inhuman-custdev-best-tagline.error.txt`) |
| **Sibling programs not gathered as separate projects** | Same directory also has `audience-loop.scm`, `generate-personas.scm`, `herebuild-react.scm`, `herebuild-multi.scm` — not currently gate1/emitted consumers. |

---

### `inhuman-geo`

| | |
|---|---|
| **Files** | `inhuman-geo.scm` (entry), `data.scm`, `persona-search.prompt`, `extract-rank.prompt`, `mutate-meta.prompt`, `honesty-judge.prompt`, `audit.prompt` |
| **Gathered from** | Entry: `src/__tests__/fixtures/gate1-corpus/inhuman-geo.scm`. Companions: `inhuman/examples/inhuman-geo/{data.scm,persona-search.prompt,extract-rank.prompt,mutate-meta.prompt,honesty-judge.prompt,audit.prompt}` |
| **Upstream origin** | `inhuman/examples/inhuman-geo/geo.scm` |
| **Description** | GEO/LLEO convergence loop with honesty judge and tiered audit. |
| **Consumers to rewire** | `src/gate1/measure.ts`, `src/__tests__/gate1-measure.test.ts`, `src/__tests__/emitted-fixtures.test.ts` (+ `fixtures/emitted/inhuman-geo.error.txt`) |

---

### `inhuman-reference-interview`

| | |
|---|---|
| **Files** | `inhuman-reference-interview.scm` (entry), `personas.scm`, `data.scm`, `interview-features.prompt`, `interview-dealbreakers.prompt`, `extract-list.prompt`, `consolidate-most.prompt`, `consolidate-variants.prompt`, `audit.prompt` |
| **Gathered from** | Entry: `src/__tests__/fixtures/gate1-corpus/inhuman-reference-interview.scm`. Companions from `inhuman/examples/inhuman-reference/` (scm + prompts that exist on disk). |
| **Upstream origin** | `inhuman/examples/inhuman-reference/interview.scm` |
| **Description** | Stateless interview → consolidate dealbreakers → audit pipeline (file 2 of the reference example). |
| **Consumers to rewire** | `src/gate1/measure.ts`, `src/__tests__/gate1-measure.test.ts`, `src/__tests__/emitted-fixtures.test.ts` (+ `fixtures/emitted/inhuman-reference-interview.error.txt`) |
| **Missing companions (required by source, absent upstream)** | `interview-explain.prompt`, `describe-dealbreaker.prompt`, `discriminate-case.prompt`, `synthesize-category.prompt` — referenced by `(require …)` but not present under `inhuman/examples/inhuman-reference/` (or elsewhere under `inhuman/`). Gate1 classifies the entry as a single file with inert `Require` leaves. |

---

### `gepa-soul`

| | |
|---|---|
| **Files** | `gepa-soul.scm` |
| **Gathered from (inline copies)** | Materialized by evaluating `buildGepaSource()` from: <br>• `src/__tests__/extract/gepa-heads.test.ts` (**canonical** — exported) <br>• `src/__tests__/model/collapse-view.test.ts` (byte-identical scheme output) <br>• `src/model/__stories__/circuit-gepa.stories.tsx` (byte-identical scheme output) <br>• Algorithm origin documented as `inhuman/saas/studio/src/workbench/trace/__fixtures__/gepa-source.ts` (`GEPA_FIXTURE.program` / same examples+rounds; not a free-standing `.scm`) |
| **Description** | Self-contained GEPA algorithm with `infer/chat` inlined (no `.prompt` requires), 10 examples, 4 rounds. The extraction/circuit "soul" used by GEPA-heads, collapse-view, circuit-sharing, and Storybook. |
| **Consumers to rewire** | `src/__tests__/extract/gepa-heads.test.ts`, `src/__tests__/extract/circuit-sharing.test.ts`, `src/__tests__/model/collapse-view.test.ts`, `src/model/__stories__/circuit-gepa.stories.tsx` |
| **Drift** | See [Drift log](#drift-log). Canonical scheme is the gepa-heads / collapse-view / stories materialization. |

Stories also define `buildGepaSourceSmall()` (2 examples, 1 round) — intentionally smaller for Storybook scrollability; **not** harvested as a separate project (subset of the same program).

---

### `assess`

| | |
|---|---|
| **Files** | `assess.scm` |
| **Gathered from (inline)** | `const ASSESS` in `src/__tests__/model/collapse-view.test.ts` and `src/__tests__/model/compose-template.test.ts` (byte-identical after template evaluation) |
| **Description** | 12-line assess fragment: examples + metric + ask + evaluate + assess; the GEPA inner loop without mutate/frontier/iterate. |
| **Consumers to rewire** | `src/__tests__/model/collapse-view.test.ts`, `src/__tests__/model/compose-template.test.ts` |

---

### `canonical-four`

| | |
|---|---|
| **Files** | `genuine.scm`, `guard-swap-forge.scm`, `judgment.scm`, `decoy.scm` |
| **Gathered from (inline)** | Corpus rows `canonical/genuine`, `canonical/guardSwapForge`, `canonical/judgment`, `canonical/decoy` in `src/__tests__/model/collapse-view.test.ts` and `src/__tests__/model/compose-template.test.ts` (byte-identical between the two files). Also referenced as "canonical four" in `src/__tests__/extract/circuit-sharing.test.ts` (duplicated literals). |
| **Description** | Four one-liner judgment/provenance probes: genuine evidence path, guard-swap forge, judgment branch, decoy opaque path. |
| **Consumers to rewire** | `src/__tests__/model/collapse-view.test.ts`, `src/__tests__/model/compose-template.test.ts`, `src/__tests__/extract/circuit-sharing.test.ts` |

---

### `inhuman-taglines`

| | |
|---|---|
| **Files** | `main.scm`, `taglines.scm`, `config.scm`, `personas.json`, `reaction.hbs` |
| **Gathered from** | `inhuman/examples/inhuman-taglines/*` |
| **Description** | Multi-module tagline generation demo (not currently an arrival-mercury gate1/emitted consumer). |
| **Consumers to rewire** | none in arrival-mercury yet (monorepo demo harvest) |

---

### `inhuman-personas`

| | |
|---|---|
| **Files** | `pipeline.scm`, `inhuman.config.json`, and all `*.prompt` siblings from the example |
| **Gathered from** | `inhuman/examples/inhuman-personas/*` |
| **Description** | Multi-stage persona landscape/embody/profile pipeline (~211 LOC entry). |
| **Consumers to rewire** | none in arrival-mercury yet (monorepo demo harvest) |

---

### `inhuman-shapes`

| | |
|---|---|
| **Files** | `01-linear-chain.scm` … `10-loop-refine.scm`, `digest.prompt`, `refine.prompt`, `spark.prompt` |
| **Gathered from** | `inhuman/examples/inhuman-shapes/*` |
| **Description** | Ten small shape demos (linear / map fanout / branch / cond / loop) sharing prompt companions — project-scale as a suite, not as individual gate probes. |
| **Consumers to rewire** | none in arrival-mercury yet (monorepo demo harvest) |

---

### `arrival-cli-with-require`

| | |
|---|---|
| **Files** | `main.scm`, `lib.scm` |
| **Gathered from** | `packages/arrival-cli/src/__tests__/fixtures/with-require/{main.scm,lib.scm}` |
| **Description** | Minimal multi-module require demo (`lib.scm` greets; `main.scm` requires + calls). |
| **Consumers to rewire** | none in arrival-mercury (lives under arrival-cli tests); harvested as the only multi-module sample from arrival-cli fixtures |

---

## Drift log

### `gepa-soul` — four inline `buildGepaSource` copies

| Source | Materialized scheme vs canonical |
|---|---|
| `gepa-heads.test.ts` | **canonical** (exported `buildGepaSource`) |
| `collapse-view.test.ts` | **byte-identical** to canonical |
| `circuit-gepa.stories.tsx` | **byte-identical** to canonical |
| `circuit-sharing.test.ts` | **whitespace drift only**: same tokens / examples / rounds (`4`), but **omits blank lines between top-level `define`s** (canonical 56 lines / 2576 bytes; circuit-sharing 43 lines / 2563 bytes; 13 blank-line difference). Type annotation on `GEPA_EXAMPLES` also differs (`readonly {…}[]` vs `{…}[]` / `typeof GEPA_LABELS`) — TS-only, does not affect scheme. |

Harvest chose the gepa-heads materialization (3 of 4 copies). Do **not** silently normalize circuit-sharing when rewiring — either point it at the canonical file or keep its compact variant intentionally.

### `assess`

collapse-view and compose-template: **byte-identical** after template evaluation (incl. `"\n\n"` escapes).

### `canonical-four`

collapse-view and compose-template: **byte-identical** one-liner strings. No trailing newline in the TS literals (files written without trailing newline to stay exact).

---

## Not copied (by design)

### `src/__tests__/corpus/*.scm` — probe-scale, stay put

~67 one-to-four-line bug-cell / semantics probes (max 4 lines: `cxr-compound-accessors.scm`). Matched 1:1 by `fixtures/emitted/<name>.ts`. **Not project-scale.** List largest for completeness:

| Lines | Name |
|------:|------|
| 4 | `cxr-compound-accessors.scm` |
| 3 | various `*-unproven-shim.scm`, `lt-nil-tolerance.scm`, … |
| 1–2 | remainder |

No corpus file is clearly a multi-module project.

### `fixtures/gate3/*.scm` — short gate-3 goldens (7 files, ≤34 lines)

Stay under `gate3/`; not promoted to projects.

### `fixtures/build-faces/*` — candidates for later consolidation

Already multi-file per face; leave in place. Projects:

| Dir | Role |
|---|---|
| `bound-require-function-face/` | `lib2.scm` + `main2.scm` |
| `bound-require-value-face/` | `lib3.scm` + `main3.scm` + `config.json` |
| `export-shape-face-kind/` | `entry.scm` + `prog.scm` + `data.json` |
| `flow-up-knobs-distinct/` | `main.scm` + `a/metric.scm` + `b/metric.scm` |
| `module-face-trailing-expression/` | `mod.scm` |
| `pipeline-face-no-suffix/` | `lib.scm` + `main.scm` |

Consumer today: `src/__tests__/build-faces.test.ts`.

### arrival-cli single-file probes (not multi-module)

`ok.scm`, `unbound.scm`, `uses-greet.scm`, `uses-config-greet.scm` — trivial; only `with-require/` harvested.

### Vendor / non-fixture scheme

`packages/arrival/vendor/**` (chibi stdlib) excluded. R7RS schemeSpec fixtures under `packages/arrival/src/__tests__/schemeSpec/` are interpreter conformance, not mercury project fixtures.

---

## Looked for but could not find / incomplete

| Wanted | Result |
|---|---|
| Source `.scm` for every `fixtures/emitted/*.ts` | All present: either `corpus/<name>.scm` or `gate1-corpus/<name>.scm`. Error-only emitted rows (`inhuman-*.error.txt`) pair with gate1 entries. |
| `inhuman/public-packages/mercury/src/__tests__/fixtures/sources/gepa.scm` on main | **Absent** on main tree; gate1 header still cites it. Worktree copy matches `inhuman/examples/inhuman-gepa/gepa.scm`. |
| Free-standing `.scm` for `gepa-source.ts` | Never a `.scm` file — TS regenerator with template-interpolated program. Algorithm harvested as `gepa-soul`. |
| `interview-explain.prompt`, `describe-dealbreaker.prompt`, `discriminate-case.prompt`, `synthesize-category.prompt` | Required by `inhuman-reference-interview` entry; **missing upstream** under `inhuman/examples/inhuman-reference/`. |
| `here.build/e2e-monorepo-tests/arrival-mercury/**/*.scm` | No scheme fixtures (harness/tests only). |

---

## Verification

- Gate1 entry files: `cmp` equal to `fixtures/gate1-corpus/*`.
- Multi-file companions: `cmp` equal to `inhuman/examples/...` origins.
- `gepa-soul.scm` / `assess.scm`: equal to `new Function`-evaluated template literals from sources above (correct `"\n\n"` escapes).
- `npx tsc --noEmit` in `packages/arrival-mercury`: **passes** (`tsconfig` includes only `src/**/*.ts` and excludes `__tests__`; projects tree is `.scm`/`.md`/companions only).

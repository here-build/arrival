# Test redundancy receipts — pre-delete audit (2026-07-25)

Artifacts that close eng-review G1–G4 and longcat Attacks 1–6 for
`docs/working-proposals/arrival-test-redundancy-2026-07-25.md`.

**No migration files deleted yet.** This document is the gate for PR1.

Companion: `src/env/__tests__/define-bake-roster.harvest.test.ts` (real pack bake + roster meta-gate).

---

## 1. Harvest specification (G2 / Attack 1 / Attack 6)

| Requirement | Implementation |
|-------------|----------------|
| Real pack instantiation | `buildVocabulary([cap], undefined, evalScheme)` per real export |
| Not synthetic | No hand-built `(define x 1)` — uses pack default exports |
| Pack set | `BASE_ROSTER ∪` migration Appendix A packs (deduped by `cap.name`) |
| Opt-ins included | `arrival/overridable`, `arrival/schema` always in harvest |
| Meta: roster drift | Fails if any `BASE_ROSTER` name missing from harvest set |
| Structural pin | Asserts `cap.spec.prelude === undefined` for each pack |

**Does not cover (must not claim):**
- Semantic verb equivalence (behavior suites)
- Negative pre-fix throw shapes (see §2 NEG rows — must move home before delete)

---

## 2. Migration row provenance (G1 / Attack 2)

### Legend

| Tag | Meaning | Delete-safe? |
|-----|---------|--------------|
| **BAKE** | `buildVocabulary` / no-throw bake | **YES** → harvest |
| **STRUCT** | no prelude, kind census, exports surface | **YES** → harvest + pack structural if any |
| **NEG** | pre-fix throw / local repro of broken shape | **NO** until moved to law or pack behavior |
| **SEM** | verb behavior / standalone exec product | **NO** if only home; keep file or move to `*.test.ts` |
| **WIRE** | schema/overridable wire format | **NO** — product behavior |

### Disposition policy (revised after audit)

| File class | Disposition |
|------------|-------------|
| Pure STRUCT+BAKE+NEG only, SEM empty or thin | After NEG home: **RETIRE** file |
| Hybrid SEM-heavy (srfi-1, srfi-189, srfi-235, schema, syntax, polyglot, overridable) | **RENAME** to pack behavior suite (drop `-symbol-define-migration` suffix), drop only BAKE/STRUCT rows once harvest covers them |
| Doors-only (control, binding, srfi-8, strings census) | Thin to door inventory in pack behavior or **KEEP** short structural file |

### Per-file map

#### Pure / thin migration (primary RETIRE candidates after NEG move)

| File | Rows | BAKE/STRUCT | NEG homes | SEM homes | Pre-delete action |
|------|-----:|-------------|-----------|-----------|-------------------|
| `core-symbol-define-migration.test.ts` | 6 | harvest | **MOVE** pre-fix pair?/not → law or core behavior | true/false/NaN → **KEEP** as core constants behavior | Split: constants → `core.behavior.test.ts`; NEG → law |
| `binding-symbol-define-migration.test.ts` | 4 | harvest | bake no-throw → harvest | doors census | RETIRE after door census in binding pack test if missing |
| `control-symbol-define-migration.test.ts` | 14 | harvest | bake no-throw → harvest | door inventory, map/for-each not here | RETIRE or thin to door teaching inventory |
| `srfi-8-symbol-define.test.ts` | 4 | harvest | bake no-throw → harvest | receive purity door | RETIRE after purity door exists in doors suite |

#### Hybrid — **do not wholesale delete**

| File | ~SEM/behavior load | Surviving home plan |
|------|-------------------:|---------------------|
| `srfi-235-symbol-define.test.ts` | **ONLY** srfi-235 behavior suite in tree | **RENAME** → `srfi-235.test.ts`; drop BAKE/NEG after harvest + NEG→law |
| `srfi-1-symbol-define.test.ts` | Large behavior (take/drop/any/zip/…) | **RENAME** → absorb into `srfi-behavior` or `srfi-1.test.ts`; drop BAKE only |
| `srfi-189-symbol-define.test.ts` | maybe/either semantics | **RENAME** → `srfi-189.test.ts` |
| `srfi-128-symbol-define.test.ts` | comparator suite | **RENAME** → `srfi-128.test.ts` |
| `srfi-43-symbol-define.test.ts` | vector-fold suite | **RENAME** → `srfi-43.test.ts` |
| `srfi-26-symbol-define.test.ts` | cut/cute suite | **RENAME** → `srfi-26.test.ts` |
| `schema-symbol-define-migration.test.ts` | **WIRE** s/* formats (product bar) | **RENAME** → `schema-wire-format.test.ts`; drop BAKE only |
| `overridable-symbol-define.test.ts` | override wins / default / staticValidation | Merge unique rows into `overridable.test.ts`; drop BAKE |
| `polyglot-symbol-define.test.ts` | threading / dialect alone / BASE_PACKS order | Keep as `polyglot-migration-behavior.test.ts` or split into dialect tests |
| `lists-symbol-define-migration.test.ts` | kind census + car/cdr kernel | Thin STRUCT → harvest; keep car/cdr kernel pin if not elsewhere |
| `strings-symbol-define-migration.test.ts` | 32-name census, string-append smoke | Keep census in strings-contract-precision or strings behavior |
| `syntax-symbol-define-migration.test.ts` | define-syntax / let-syntax product | **RENAME** → `syntax-macros.test.ts` |

### NEG rows that need an explicit home before any delete

| Source file | NEG row (summary) | Target home |
|-------------|-------------------|-------------|
| `srfi-235-symbol-define.test.ts` | PRE-FIX undeclared deps throws `DefineLocalityError` | `symbol-define.law` (extend with “pack-shaped free compose/not”) or keep one NEG in renamed behavior file |
| `srfi-1 / 43 / 128 / 189` | same PRE-FIX local repro pattern | Same: **one** parameterized NEG in law covering “define body with free `not`/`compose` and no deps” |
| `core-symbol-define-migration.test.ts` | pair?/not free without deps | Same parameterized NEG |
| `schema-…` | bake never throws FV errors | Covered by harvest positive; optional law |
| `overridable-…` | never throws bake FV doors | harvest |

**DONE:** law row shipped in `symbol-define.law.test.ts`:

```text
it("PRE-FIX pack shape: define body free on stdlib `not` with NO deps throws DefineLocalityError")
```

Canonical NEG home for migration PRE-FIX pins. Pack-local PRE-FIX repros may remain until hybrid rename; they are no longer the only home.

---

## 3. Contract-precision central vs packs (Attack 3)

| Central pin | Inputs | Pack home today | Unique? |
|-------------|--------|-----------------|---------|
| for-each rest list | `[fn, list]✓ [fn,nil]✓ [fn,"not-a-list"]✗` | `lists-contract-precision` lines 287–289 (same) | **NO — pack owns** |
| string-map rest AString | `[fn, AString]✓ [fn, raw string]✗` | `strings-contract-precision` regression pin 179–181 | **NO — pack owns** |
| string-for-each | same | **DONE** — strings-contract-precision regression pin covers map **and** for-each | pack owns |
| filter 2-tuple arity | `[fn,list]✓ [fn,list,extra]✗` | **DONE** — `srfi-1-contract-precision` runtime section | pack owns |
| symbol=? | array of symbols | **still only central** | MOVE before central delete |
| boolean=? | reject raw JS bool | **still only central** | MOVE before central delete |

### PR2 order (locked)

1. ~~strings for-each~~ **DONE**  
2. ~~filter arity~~ **DONE**  
3. Move symbol=? + boolean=? into equality precision (or keep central until then)  
4. Delete `contract-precision-fixes.test.ts` when central has zero unique pins  
5. Done-when: `rg contract-precision-fixes` empty; pack precision green  

---

## 4. lineage-assumptions row annotation (G3 / Attack 4)

| Row | Property asserted | Twin in golden-*? | Disposition |
|-----|-------------------|-------------------|-------------|
| A11a pure op empty prov | mint only at rosetta | golden-infer / arithmetic | **TWIN** — prefer golden |
| A11b pure propagates | same | golden-infer | **TWIN** |
| A12 arithmetic merge | both sources | golden-fan / arithmetic | **TWIN** |
| **A4 let transparent** | let cone ≡ inlined | **golden-prov-special-forms** same program | **TWIN — DELETE** after golden green |
| map→reduce / filter→length … | capability pipeline values | golden-fan adjacent | Overlap value-level; keep one family |
| A4-classifier let/if | classify handles special forms | golden has A4-classifier row | Near-twin; keep **one** classifier pin |
| A21 surface AST | no macro-expansion for classify | unique? | **KEEP** if no golden twin |
| G6-eager-golden SchemeVector | vector-map grouping | lineage + golden overlap | Prefer golden / conservation |
| **it.todo A10, A3, A9, A19, A-uneval, A16, G1–G5, G7…** | future design | not in golden | **KEEP file for todos** — do **not** delete file |

**Locked rule:** never delete `lineage-assumptions.test.ts` while `.todo` rows remain. Delete only live **TWIN** rows after golden ownership confirmed.

---

## 5. membrane-symmetry nil-clone vs identity.law (Attack 5)

| Site | identity.law? | membrane-symmetry? |
|------|---------------|-------------------|
| `isSchemeValue(nil-clone)` | **YES** — `membrane.ts — isSchemeValue(nil-clone)` | YES (admitted duplicate) |
| `toJS(nil-clone)` | YES | — |
| `schemeToJs(nil-clone)` | YES — rosetta section | — |
| `schemeToJs(Pair(1, nil-clone))` | YES | — |

**Verdict:** identity.law **does** exercise the membrane `isSchemeValue` path that membrane-symmetry duplicates. Safe to delete membrane-symmetry Nil-clone case **only**. Other membrane-symmetry cases stay.

---

## 6. Re-add prevention (G4 / Attack 7)

ESLint `no-restricted-syntax` is awkward for filenames. Gate is a **vitest allowlist** in the harvest file (or sibling):

```ts
// After retirement, ALLOWED_MIGRATION_RECEIPTS = []
// Until then, list current paths; fail if a NEW *symbol-define* file appears outside allowlist.
```

See `define-bake-roster.harvest.test.ts` companion describe `"migration-receipt filename gate"` (added below).

Also: note in env-capability-authoring skill after PR1.

---

## 7. Checklist status

| Item | Status |
|------|--------|
| Real harvest + BASE_ROSTER meta-gate | **DONE** — harvest file green (**67** tests) |
| Row provenance table | **DONE** — §2 |
| Precision input diff | **DONE** — §3 |
| filter arity + string-for-each in pack precision | **DONE** |
| symbol=? / boolean=? moved from central | **OPEN** |
| PRE-FIX NEG canonical home | **DONE** — `symbol-define.law` free-`not` PRE-FIX row |
| lineage annotation | **DONE** — §4; keep file for todos |
| identity.law covers membrane isSchemeValue | **DONE** — §5; membrane-symmetry nil-clone **removed** |
| Filename allowlist gate | **DONE** |
| SEM/census homes for pure-thin RETIRE | **OPEN** (eng-review G5) |

**Still blocked for bulk Appendix A `git rm`:** hybrid renames; pure-thin SEM/census homes; symbol=?/boolean=?.  
**Unblocked:** hybrid renames + BAKE thinning; A4 lineage twin delete; membrane nil-clone (done).
